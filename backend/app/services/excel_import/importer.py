"""Nhập danh mục thuốc từ Excel (DAV_unique.xlsx) vào SQLite.

Quy trình: đọc Excel theo luồng (openpyxl) → làm sạch theo lô (pandas) →
chuẩn hóa trường tìm kiếm → upsert theo `id` → cập nhật bảng số đăng ký và
chỉ mục FTS5. Nhập lại cùng một file không tạo bản ghi trùng; file thay đổi
thì chỉ các dòng khác đi mới được ghi lại.
"""
from __future__ import annotations

import hashlib
import math
from dataclasses import asdict, dataclass, field
from datetime import date, datetime
from pathlib import Path
from typing import Any, Callable, Iterator

import pandas as pd
from openpyxl import load_workbook
from sqlalchemy import func, insert, select, text, update

from app.core import clock
from app.database.session import Database
from app.models.catalog import BOOLEAN_COLUMNS, CATALOG_COLUMNS, CatalogImport, CatalogMedicine, CatalogReg
from app.models.misc import Setting
from app.services.medicine_matcher.normalize import (
    clean_cell,
    fts_safe,
    name_core,
    normalize_text,
    parse_shelf_life_months,
    split_reg_field,
    strength_tokens,
)

REQUIRED_COLUMNS = ("id", "tenThuoc")
# Tăng số này mỗi khi quy tắc chuẩn hóa thay đổi để lần nhập kế tiếp tính lại trường dẫn xuất.
NORMALIZER_VERSION = "2"
_VERSION_KEY = "_catalog_normalizer_version"
CHUNK_ROWS = 4000
ProgressCallback = Callable[["ImportProgress"], None]


class CatalogImportError(Exception):
    """Lỗi có thể hiển thị cho người dùng (file sai định dạng, thiếu cột…)."""


@dataclass
class ImportProgress:
    stage: str = "idle"  # idle | hashing | reading | indexing | done | failed | skipped
    rows_read: int = 0
    rows_total: int | None = None
    message: str = ""

    @property
    def percent(self) -> float | None:
        if self.stage in ("done", "skipped"):
            return 100.0
        if self.stage == "indexing":
            return 92.0
        if self.stage == "reading" and self.rows_total:
            return round(min(90.0, 90.0 * self.rows_read / self.rows_total), 1)
        return None


@dataclass
class ImportResult:
    status: str
    file_name: str
    rows_total: int = 0
    inserted: int = 0
    updated: int = 0
    unchanged: int = 0
    skipped: int = 0
    removed: int = 0
    duplicate_ids: int = 0
    missing_columns: list[str] = field(default_factory=list)
    extra_columns: list[str] = field(default_factory=list)
    message: str = ""
    import_id: int | None = None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def file_sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def _vn(n: int) -> str:
    """Định dạng số kiểu Việt Nam: 55005 → "55.005"."""
    return f"{n:,}".replace(",", ".")


def _count_sheet_rows(path: Path, sheet_xml: str | None) -> int:
    """Đếm nhanh số thẻ <row> trong XML của sheet (khi file không ghi kích thước)."""
    if not sheet_xml:
        return 0
    import zipfile

    count, tail = 0, b""
    try:
        with zipfile.ZipFile(path) as zf, zf.open(sheet_xml.lstrip("/")) as f:
            for block in iter(lambda: f.read(1 << 20), b""):
                data = tail + block
                count += data.count(b"<row ") + data.count(b"<row>")
                tail = data[-5:]
                count -= tail.count(b"<row ") + tail.count(b"<row>")
    except (KeyError, OSError, zipfile.BadZipFile):
        return 0
    return count


def _to_text(value: Any) -> str | None:
    """Đưa giá trị ô Excel về chuỗi gốc (không làm mất thông tin)."""
    if value is None:
        return None
    if isinstance(value, bool):
        return "True" if value else "False"
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        if math.isnan(value):
            return None
        return str(int(value)) if value.is_integer() else repr(value)
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    s = str(value).strip()
    return s or None


def _to_bool(value: str | None) -> bool | None:
    if value is None:
        return None
    v = value.strip().lower()
    if v in ("true", "1", "yes", "x", "có", "co"):
        return True
    if v in ("false", "0", "no", "không", "khong"):
        return False
    return None


def _parse_id(value: str | None) -> int | None:
    if not value:
        return None
    try:
        n = int(float(value))
    except (TypeError, ValueError):
        return None
    return n if n >= 0 else None


def build_record(raw: dict[str, str | None]) -> dict[str, Any] | None:
    """Dòng Excel (đã về chuỗi) → bản ghi SQLite kèm trường chuẩn hóa.

    Trả về None nếu dòng không dùng được (thiếu id hoặc tên thuốc).
    """
    med_id = _parse_id(raw.get("id"))
    name = clean_cell(raw.get("tenThuoc"))
    if med_id is None or not name:
        return None

    record: dict[str, Any] = {}
    for excel_col, db_col in CATALOG_COLUMNS.items():
        record[db_col] = raw.get(excel_col)
    record["id"] = med_id
    record["ten_thuoc"] = raw.get("tenThuoc") or name
    for col in BOOLEAN_COLUMNS:
        record[col] = _to_bool(record[col])

    ingredient = clean_cell(raw.get("hoatChatChinh"))
    strength = clean_cell(raw.get("hamLuong"))
    hash_src = NORMALIZER_VERSION + "\x1f" + "\x1f".join("" if raw.get(c) is None else str(raw.get(c)) for c in CATALOG_COLUMNS)
    record.update(
        name_norm=normalize_text(name),
        name_core=name_core(name),
        ingredient_norm=normalize_text(ingredient)[:600],
        strength_norm=" ".join(strength_tokens(strength, ingredient, name)),
        form_norm=normalize_text(clean_cell(raw.get("dangBaoChe")))[:200],
        shelf_life_months=parse_shelf_life_months(clean_cell(raw.get("tuoiTho"))),
        row_hash=hashlib.sha1(hash_src.encode("utf-8")).hexdigest(),
        in_source=True,
    )
    return record


def record_regs(record: dict[str, Any]) -> list[tuple[str, str]]:
    """[(reg_norm, kind)] cho một bản ghi — gồm số hiện tại, số cũ và số trong ngoặc."""
    out: dict[str, str] = {}
    for reg in split_reg_field(clean_cell(record.get("so_dang_ky"))):
        out.setdefault(reg[:40], "current")
    for reg in split_reg_field(clean_cell(record.get("so_dang_ky_cu"))):
        out.setdefault(reg[:40], "old")
    return list(out.items())


def fts_row(record: dict[str, Any], regs: list[tuple[str, str]]) -> dict[str, Any]:
    ingredient = record["ingredient_norm"]
    return {
        "rowid": record["id"],
        "name": fts_safe(record["name_norm"]),
        "ingredient": fts_safe(ingredient),
        "strength": fts_safe(record["strength_norm"]),
        "form": fts_safe(record["form_norm"]),
        "reg": " ".join(r for r, _ in regs),
        "trgm_name": record["name_core"] or record["name_norm"],
        "trgm_ingredient": ingredient[:160],
    }


class CatalogImporter:
    def __init__(self, db: Database):
        self.db = db

    # ------------------------------------------------------------------ #
    def _iter_chunks(self, path: Path, progress: ImportProgress, notify: Callable[[], None]) -> Iterator[tuple[list[str], pd.DataFrame]]:
        try:
            wb = load_workbook(path, read_only=True, data_only=True)
        except Exception as exc:  # file hỏng / không phải xlsx
            raise CatalogImportError(f"Không mở được file Excel: {exc}") from exc
        try:
            sheet = None
            header: list[str] = []
            for ws in wb.worksheets:
                first = next(ws.iter_rows(min_row=1, max_row=1, values_only=True), None)
                names = [str(c).strip() if c is not None else "" for c in (first or ())]
                if all(col in names for col in REQUIRED_COLUMNS):
                    sheet, header = ws, names
                    break
            if sheet is None:
                raise CatalogImportError(
                    "File Excel không có các cột bắt buộc: " + ", ".join(REQUIRED_COLUMNS)
                )
            total = (sheet.max_row or 0) - 1
            if total <= 0:
                total = _count_sheet_rows(path, getattr(sheet, "_worksheet_path", None)) - 1
            progress.rows_total = total if total > 0 else None
            progress.stage = "reading"
            notify()

            chunk: list[tuple[Any, ...]] = []
            for row in sheet.iter_rows(min_row=2, values_only=True):
                chunk.append(tuple(row[: len(header)]) + (None,) * max(0, len(header) - len(row)))
                if len(chunk) >= CHUNK_ROWS:
                    yield header, pd.DataFrame(chunk, columns=header)
                    chunk = []
            if chunk:
                yield header, pd.DataFrame(chunk, columns=header)
        finally:
            wb.close()

    # ------------------------------------------------------------------ #
    def run(self, path: Path | str, *, force: bool = False, progress_cb: ProgressCallback | None = None) -> ImportResult:
        path = Path(path)
        progress = ImportProgress()

        def notify() -> None:
            if progress_cb:
                progress_cb(progress)

        if not path.is_file():
            raise CatalogImportError(f"Không tìm thấy file: {path}")
        if path.suffix.lower() not in (".xlsx", ".xlsm"):
            raise CatalogImportError("Chỉ hỗ trợ file Excel .xlsx")

        result = ImportResult(status="running", file_name=path.name)
        progress.stage, progress.message = "hashing", "Đang kiểm tra file nguồn"
        notify()
        digest = file_sha256(path)

        with self.db.session() as s:
            catalog_count = s.scalar(select(func.count()).select_from(CatalogMedicine)) or 0
            last_ok = s.scalar(
                select(CatalogImport).where(CatalogImport.status == "success").order_by(CatalogImport.id.desc()).limit(1)
            )
            version_row = s.get(Setting, _VERSION_KEY)
            same_rules = version_row is not None and version_row.value == NORMALIZER_VERSION
            if not force and same_rules and last_ok is not None and last_ok.file_hash == digest and catalog_count > 0:
                result.status = "skipped"
                result.rows_total = last_ok.rows_total
                result.unchanged = catalog_count
                result.message = "File nguồn không thay đổi so với lần nhập trước."
                progress.stage, progress.message = "skipped", result.message
                notify()
                return result
            imp = CatalogImport(
                file_path=str(path), file_name=path.name, file_hash=digest,
                file_size=path.stat().st_size, status="running", started_at=clock.now(),
            )
            s.add(imp)
            s.flush()
            import_id = imp.id
        result.import_id = import_id

        try:
            self._import(path, import_id, result, progress, notify)
            result.status = "success"
            result.message = (
                f"Đã nhập {_vn(result.rows_total)} dòng: {_vn(result.inserted)} mới, "
                f"{_vn(result.updated)} cập nhật, {_vn(result.unchanged)} không đổi."
            )
            progress.stage, progress.message = "done", result.message
        except Exception as exc:
            result.status = "failed"
            result.message = str(exc)
            progress.stage, progress.message = "failed", result.message
            self._finish(import_id, result)
            notify()
            if isinstance(exc, CatalogImportError):
                raise
            raise CatalogImportError(f"Nhập dữ liệu thất bại: {exc}") from exc
        self._finish(import_id, result)
        notify()
        return result

    def _finish(self, import_id: int, result: ImportResult) -> None:
        with self.db.session() as s:
            imp = s.get(CatalogImport, import_id)
            if imp is None:
                return
            imp.status = result.status
            imp.rows_total = result.rows_total
            imp.inserted, imp.updated, imp.unchanged = result.inserted, result.updated, result.unchanged
            imp.skipped, imp.removed, imp.duplicate_ids = result.skipped, result.removed, result.duplicate_ids
            imp.message = result.message
            imp.finished_at = clock.now()
            if result.status == "success":
                row = s.get(Setting, _VERSION_KEY)
                if row is None:
                    s.add(Setting(key=_VERSION_KEY, value=NORMALIZER_VERSION, updated_at=clock.now()))
                else:
                    row.value, row.updated_at = NORMALIZER_VERSION, clock.now()

    # ------------------------------------------------------------------ #
    def _import(self, path: Path, import_id: int, result: ImportResult, progress: ImportProgress, notify: Callable[[], None]) -> None:
        table = CatalogMedicine.__table__
        with self.db.engine.begin() as conn:
            existing: dict[int, str] = dict(conn.execute(select(table.c.id, table.c.row_hash)).all())
            conn.execute(text("CREATE TEMP TABLE IF NOT EXISTS _seen_ids(id INTEGER PRIMARY KEY)"))
            conn.execute(text("DELETE FROM _seen_ids"))
            seen: set[int] = set()
            changed_fts: dict[int, dict[str, Any]] = {}
            changed_regs: dict[int, list[tuple[str, str]]] = {}
            header_checked = False

            for header, df in self._iter_chunks(path, progress, notify):
                if not header_checked:
                    result.missing_columns = [c for c in CATALOG_COLUMNS if c not in header]
                    result.extra_columns = [c for c in header if c and c not in CATALOG_COLUMNS]
                    header_checked = True
                df = df.reindex(columns=list(CATALOG_COLUMNS))
                mapper = df.map if hasattr(df, "map") else df.applymap  # pandas < 2.1
                df = mapper(_to_text)
                df = df.astype(object).where(df.notna(), None)

                inserts: list[dict[str, Any]] = []
                updates: list[dict[str, Any]] = []
                for raw in df.to_dict(orient="records"):
                    result.rows_total += 1
                    record = build_record(raw)
                    if record is None:
                        result.skipped += 1
                        continue
                    med_id = record["id"]
                    if med_id in seen:
                        result.duplicate_ids += 1
                    record["import_id"] = import_id
                    old_hash = existing.get(med_id)
                    if old_hash is None:
                        # id trùng trong cùng một lô: dòng sau ghi đè dòng trước
                        inserts = [r for r in inserts if r["id"] != med_id] if med_id in seen else inserts
                        inserts.append(record)
                        if med_id not in seen:
                            result.inserted += 1
                    elif old_hash != record["row_hash"]:
                        record["b_id"] = med_id
                        updates.append(record)
                        if med_id not in seen or med_id not in changed_fts:
                            result.updated += 1
                    else:
                        if med_id not in seen:
                            result.unchanged += 1
                        seen.add(med_id)
                        continue
                    seen.add(med_id)
                    regs = record_regs(record)
                    changed_regs[med_id] = regs
                    changed_fts[med_id] = fts_row(record, regs)

                if inserts:
                    conn.execute(insert(table), inserts)
                    for r in inserts:
                        existing[r["id"]] = r["row_hash"]
                if updates:
                    for r in updates:
                        values = {k: v for k, v in r.items() if k not in ("id", "b_id")}
                        conn.execute(update(table).where(table.c.id == r["b_id"]).values(**values))
                        existing[r["b_id"]] = r["row_hash"]
                progress.rows_read = result.rows_total
                notify()

            if result.rows_total == 0:
                raise CatalogImportError("File Excel không có dòng dữ liệu nào.")

            progress.stage, progress.message = "indexing", "Đang tạo chỉ mục tìm kiếm"
            notify()

            # Đánh dấu bản ghi đã biến mất khỏi file nguồn (không xóa vì tủ thuốc có thể đang tham chiếu).
            seen_list = list(seen)
            for i in range(0, len(seen_list), 5000):
                conn.execute(text("INSERT OR IGNORE INTO _seen_ids(id) VALUES (:id)"), [{"id": x} for x in seen_list[i : i + 5000]])
            removed = conn.execute(
                text("UPDATE catalog_medicines SET in_source = 0 WHERE in_source = 1 AND id NOT IN (SELECT id FROM _seen_ids)")
            ).rowcount
            conn.execute(
                text("UPDATE catalog_medicines SET in_source = 1 WHERE in_source = 0 AND id IN (SELECT id FROM _seen_ids)")
            )
            result.removed = max(0, removed or 0)

            if changed_fts:
                ids = [{"id": i} for i in changed_fts]
                for i in range(0, len(ids), 5000):
                    part = ids[i : i + 5000]
                    conn.execute(text("DELETE FROM catalog_fts WHERE rowid = :id"), part)
                    conn.execute(text("DELETE FROM catalog_trgm WHERE rowid = :id"), part)
                    conn.execute(text("DELETE FROM catalog_regs WHERE medicine_id = :id"), part)
                rows = list(changed_fts.values())
                for i in range(0, len(rows), 5000):
                    part = rows[i : i + 5000]
                    conn.execute(
                        text("INSERT INTO catalog_fts(rowid, name, ingredient, strength, form, reg) VALUES (:rowid, :name, :ingredient, :strength, :form, :reg)"),
                        part,
                    )
                    conn.execute(
                        text("INSERT INTO catalog_trgm(rowid, name, ingredient) VALUES (:rowid, :trgm_name, :trgm_ingredient)"),
                        part,
                    )
                reg_rows = [
                    {"reg_norm": reg, "medicine_id": med_id, "kind": kind}
                    for med_id, regs in changed_regs.items()
                    for reg, kind in regs
                ]
                reg_table = CatalogReg.__table__
                for i in range(0, len(reg_rows), 5000):
                    conn.execute(insert(reg_table).prefix_with("OR IGNORE"), reg_rows[i : i + 5000])
                if len(rows) > 2000:
                    conn.execute(text("INSERT INTO catalog_fts(catalog_fts) VALUES ('optimize')"))
                    conn.execute(text("INSERT INTO catalog_trgm(catalog_trgm) VALUES ('optimize')"))
            conn.execute(text("DROP TABLE IF EXISTS _seen_ids"))
