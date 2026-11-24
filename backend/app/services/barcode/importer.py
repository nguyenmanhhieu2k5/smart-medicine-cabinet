"""Nhập liên kết mã vạch → thuốc từ file Excel/CSV (ví dụ danh mục hàng hóa xuất từ phần mềm nhà thuốc).

Nguyên tắc:
- Mỗi mã vạch chỉ được gắn vào thuốc ĐÃ CÓ trong danh mục DAV (55.005 thuốc) — không bao giờ tạo thuốc mới.
- Ghép theo SỐ ĐĂNG KÝ trước (cả số mới, số cũ, mọi cách viết: "VD-12345-22", "vd 12345 22"…); nếu một số đăng ký
  ứng với nhiều bản ghi thì phân định bằng tên + hàm lượng. Không có/không khớp số đăng ký → chỉ ghép theo tên +
  hàm lượng khi ra DUY NHẤT một thuốc. Mọi trường hợp không chắc chắn đều báo lại, không tự đoán.
- Chạy thử (dry_run) trả báo cáo mà không ghi gì; mã đã gắn với thuốc khác thì báo xung đột, không ghi đè.
- Truy vấn theo lô (= ANY(:list)), không tải cả danh mục về Python.
"""
from __future__ import annotations

import csv
import io
from collections import defaultdict
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable

from openpyxl import load_workbook
from sqlalchemy import select, text

from app.core import clock
from app.database.session import Database
from app.models.catalog import BarcodeImport, CatalogBarcode
from app.services.barcode.gs1 import parse_code, split_codes
from app.services.medicine_matcher.normalize import clean_cell, fold, name_core, normalize_text, split_reg_field, strength_tokens

MAX_ROWS = 200_000
MAX_ISSUES = 300
HEADER_SCAN_ROWS = 20

# Tên cột (đã bỏ dấu, chữ thường, bỏ ký tự không phải chữ/số) → vai trò.
_HEADERS: dict[str, tuple[str, ...]] = {
    "barcode": ("mavach", "barcode", "gtin", "ean", "ean13", "mavachsanpham", "mavachhanghoa", "mavachthuoc", "upc"),
    "registration": ("sodangky", "sdk", "sodk", "sogiayphepluuhanh", "giayphepluuhanh", "sogplh", "sogpl", "sodangkyluuhanh",
                     "registration", "registrationnumber", "regno", "visa", "sodangkythuoc"),
    "name": ("tenthuoc", "tenhang", "tenhanghoa", "tensanpham", "tenbietduoc", "tenthuongmai", "productname", "name", "ten"),
    "strength": ("hamluong", "nongdohamluong", "hamluongnongdo", "strength"),
    "unit": ("dvt", "donvitinh", "donvi", "unit", "quycach", "capdonggoi"),
    # Không nhận "NSX" (trên vỏ hộp thường là NGÀY sản xuất).
    "manufacturer": ("hangsanxuat", "nhasanxuat", "congtysanxuat", "tencongtysanxuat", "hangsx", "hang", "manufacturer"),
}
# Chứa các cụm này cũng tính (khi tên cột dài: "Mã vạch (EAN-13)", "Số đăng ký/GPLH").
_CONTAINS: dict[str, tuple[str, ...]] = {
    "barcode": ("mavach", "barcode", "gtin"),
    "registration": ("sodangky", "giayphepluuhanh", "sdk"),
    "name": ("tenthuoc", "tenhang", "tensanpham"),
    "strength": ("hamluong",),
    "manufacturer": ("hangsanxuat", "nhasanxuat", "congtysanxuat", "manufactur"),  # không bắt "Ngày/Nước sản xuất"
}
# Từ chung trong tên công ty — bỏ đi để so "Merck Sharp & Dohme Corp" với "Merck Sharp Dohme B.V." là cùng hãng.
_MAKER_STOP = frozenset(
    "cong ty co phan tnhh mtv duoc pham trach nhiem huu han mot thanh vien chi nhanh tap doan nha may xi nghiep "
    "san xuat co so dong goi cap dung moi va xuong thuong mai dau tu vat tu y te quoc te viet nam "
    "pharmaceutical pharmaceuticals pharma pharm laboratories laboratory labs lab industries industry industrial "
    "company co ltd limited corp corporation inc incorporated gmbh ag sa s a spa srl bv b v nv llc plc jsc pvt private "
    "group holding holdings international the of and de du la des et kg healthcare health care products manufacturer".split()
)


def maker_tokens(text: str | None) -> frozenset[str]:
    words = "".join(ch if ch.isalnum() else " " for ch in fold(text or "")).split()
    return frozenset(w for w in words if len(w) > 1 and w not in _MAKER_STOP)


def same_maker(a: frozenset[str], b: frozenset[str]) -> bool:
    """Hai cách ghi tên nhà sản xuất có phải cùng một hãng (≥ một nửa từ đặc trưng trùng nhau)."""
    if not a or not b:
        return False
    return len(a & b) / min(len(a), len(b)) >= 0.5


def _key(header: object) -> str:
    return "".join(ch for ch in fold(str(header or "")) if ch.isalnum())


def detect_columns(header: list[object]) -> dict[str, int]:
    keys = [_key(h) for h in header]
    found: dict[str, int] = {}
    for role, names in _HEADERS.items():
        for i, k in enumerate(keys):
            if k and k in names and i not in found.values():
                found[role] = i
                break
    for role, parts in _CONTAINS.items():
        if role in found:
            continue
        for i, k in enumerate(keys):
            if i not in found.values() and any(p in k for p in parts):
                found[role] = i
                break
    return found


class BarcodeImportError(Exception):
    """Lỗi hiển thị được cho quản trị viên (file sai định dạng, thiếu cột…)."""


@dataclass
class SourceRow:
    row: int  # số dòng trong file (đếm từ 1, như Excel)
    codes: list[str]
    registration: str | None
    name: str | None
    strength: str | None
    unit: str | None
    manufacturer: str | None = None


@dataclass
class Sheet:
    name: str
    columns: dict[str, str]  # vai trò → tên cột trong file
    rows: list[SourceRow]


def _rows_from_matrix(matrix: Iterable[tuple[Any, ...]], sheet_name: str) -> Sheet | None:
    buffered: list[tuple[Any, ...]] = []
    it = iter(matrix)
    header_idx, cols = -1, {}
    for i, values in enumerate(it):
        buffered.append(values)
        cols = detect_columns(list(values))
        if "barcode" in cols and ("registration" in cols or "name" in cols):
            header_idx = i
            break
        if i >= HEADER_SCAN_ROWS:
            return None
    if header_idx < 0:
        return None
    header = buffered[header_idx]
    rows: list[SourceRow] = []

    def cell(values: tuple[Any, ...], role: str) -> Any:
        idx = cols.get(role)
        return values[idx] if idx is not None and idx < len(values) else None

    for offset, values in enumerate(it, start=header_idx + 2):
        if len(rows) >= MAX_ROWS:
            raise BarcodeImportError(f"File quá lớn (tối đa {MAX_ROWS:,} dòng).".replace(",", "."))
        if values is None or all(v is None or str(v).strip() == "" for v in values):
            continue
        rows.append(SourceRow(
            row=offset,
            codes=split_codes(cell(values, "barcode")),
            registration=clean_cell(cell(values, "registration")),
            name=clean_cell(cell(values, "name")),
            strength=clean_cell(cell(values, "strength")),
            unit=clean_cell(cell(values, "unit")),
            manufacturer=clean_cell(cell(values, "manufacturer")),
        ))
    names = {role: str(header[idx]).strip() for role, idx in cols.items() if idx < len(header)}
    return Sheet(name=sheet_name, columns=names, rows=rows)


def read_source(path: Path) -> Sheet:
    """Đọc trang tính đầu tiên có cột mã vạch + (số đăng ký hoặc tên thuốc); dòng tiêu đề có thể không ở dòng 1."""
    suffix = path.suffix.lower()
    if suffix in (".xlsx", ".xlsm"):
        try:
            wb = load_workbook(path, read_only=True, data_only=True)
        except Exception as exc:  # noqa: BLE001 — file hỏng/không phải xlsx
            raise BarcodeImportError(f"Không mở được file Excel: {exc}") from exc
        try:
            for ws in wb.worksheets:
                sheet = _rows_from_matrix(ws.iter_rows(values_only=True), ws.title)
                if sheet is not None:
                    return sheet
        finally:
            wb.close()
    elif suffix in (".csv", ".txt"):
        raw = path.read_bytes()
        for encoding in ("utf-8-sig", "cp1258", "cp1252"):
            try:
                content = raw.decode(encoding)
                break
            except UnicodeDecodeError:
                continue
        else:  # pragma: no cover
            raise BarcodeImportError("Không đọc được bảng mã ký tự của file CSV (hãy lưu dạng UTF-8).")
        try:
            dialect = csv.Sniffer().sniff(content[:4096], delimiters=",;\t")
        except csv.Error:
            dialect = csv.excel
        sheet = _rows_from_matrix((tuple(r) for r in csv.reader(io.StringIO(content), dialect)), path.name)
        if sheet is not None:
            return sheet
    elif suffix == ".xls":
        raise BarcodeImportError("File .xls (Excel cũ) chưa hỗ trợ — hãy mở bằng Excel và lưu lại dạng .xlsx.")
    else:
        raise BarcodeImportError("Chỉ hỗ trợ file Excel .xlsx hoặc .csv.")
    raise BarcodeImportError(
        "Không tìm thấy cột mã vạch. File cần có cột “Mã vạch” (hoặc Barcode/GTIN) và cột “Số đăng ký” hoặc “Tên thuốc”."
    )


# --------------------------------------------------------------------------- #
# Ghép với danh mục
# --------------------------------------------------------------------------- #
@dataclass
class Candidate:
    id: int
    ten_thuoc: str
    name_norm: str
    name_core: str
    strength: set[str]
    valid: bool  # số đăng ký còn hiệu lực, chưa bị rút
    maker: frozenset[str] = frozenset()


@dataclass
class Report:
    dry_run: bool
    file_name: str
    sheet: str = ""
    columns: dict[str, str] = field(default_factory=dict)
    catalog_total: int = 0
    rows_total: int = 0
    rows_with_barcode: int = 0
    codes_total: int = 0
    matched_rows: int = 0
    by_registration: int = 0
    by_name: int = 0
    linked: int = 0  # mã mới gắn (hoặc sẽ gắn nếu chạy thử)
    unchanged: int = 0  # đã gắn đúng thuốc từ trước
    conflicts: int = 0
    ambiguous: int = 0
    unmatched: int = 0
    invalid: int = 0
    internal: int = 0
    import_id: int | None = None
    issues: list[dict[str, Any]] = field(default_factory=list)
    samples: list[dict[str, Any]] = field(default_factory=list)

    def issue(self, row: SourceRow, reason: str, message: str, code: str | None = None) -> None:
        if len(self.issues) < MAX_ISSUES:
            self.issues.append({"row": row.row, "barcode": code or ", ".join(row.codes), "registration": row.registration,
                                "name": row.name, "reason": reason, "message": message})


def _pick(pool: list[Candidate], row: SourceRow) -> tuple[Candidate | None, int]:
    """Chọn đúng MỘT thuốc trong nhóm ứng viên bằng tên + hàm lượng; (None, số ứng viên còn lại) nếu không chắc."""
    unique = list({c.id: c for c in pool}.values())
    if len(unique) <= 1:
        return (unique[0] if unique else None), len(unique)
    norm, core = normalize_text(row.name), name_core(row.name)
    strength = set(strength_tokens(row.strength, None, row.name)) if (row.strength or row.name) else set()
    narrowed = unique
    if norm or core:
        exact = [c for c in narrowed if norm and c.name_norm == norm]
        by_core = [c for c in narrowed if core and c.name_core == core]
        narrowed = exact or by_core or narrowed
    if strength and len(narrowed) > 1:
        narrowed = [c for c in narrowed if strength <= c.strength] or narrowed
    maker = maker_tokens(row.manufacturer)
    if maker and len(narrowed) > 1:  # file có cột nhà sản xuất
        narrowed = [c for c in narrowed if same_maker(maker, c.maker)] or narrowed
    if len(narrowed) > 1 and all(same_maker(narrowed[0].maker, c.maker) for c in narrowed[1:]):
        # Cùng tên, cùng hàm lượng, CÙNG HÃNG, khác số đăng ký = một sản phẩm được đăng ký lại → lấy bản còn hiệu lực.
        # Khác hãng thì KHÔNG chọn (cùng tên thuốc nhưng là sản phẩm của công ty khác).
        valid = [c for c in narrowed if c.valid]
        narrowed = valid if len(valid) == 1 else narrowed
    return (narrowed[0] if len(narrowed) == 1 else None), len(narrowed)


class BarcodeImporter:
    def __init__(self, db: Database):
        self.db = db

    def _load_candidates(self, s, ids: set[int]) -> dict[int, Candidate]:  # noqa: ANN001
        if not ids:
            return {}
        rows = s.execute(text(
            "SELECT id, ten_thuoc, name_norm, name_core, strength_norm, ten_cong_ty_san_xuat, "
            "coalesce(is_het_han, false) OR coalesce(is_da_rut_so_dang_ky, false) AS invalid "
            "FROM medicine_catalog WHERE id = ANY(:ids)"
        ), {"ids": list(ids)}).all()
        return {r.id: Candidate(r.id, r.ten_thuoc, r.name_norm, r.name_core, set(r.strength_norm.split()), not r.invalid,
                                maker_tokens(r.ten_cong_ty_san_xuat)) for r in rows}

    def run(self, path: Path, *, file_name: str | None = None, dry_run: bool = True, started_by: str | None = None) -> Report:
        sheet = read_source(path)
        report = Report(dry_run=dry_run, file_name=file_name or path.name, sheet=sheet.name, columns=sheet.columns,
                        rows_total=len(sheet.rows))
        with self.db.session() as s:
            report.catalog_total = s.execute(text("SELECT count(*) FROM medicine_catalog")).scalar_one()
            if report.catalog_total == 0:
                raise BarcodeImportError("Danh mục thuốc đang trống — hãy nhập DAV_unique.xlsx trước.")

            # 1) Số đăng ký → id (một truy vấn cho cả file).
            regs_by_row = {r.row: split_reg_field(r.registration) for r in sheet.rows}
            all_regs = sorted({reg[:40] for regs in regs_by_row.values() for reg in regs})
            reg_ids: dict[str, set[int]] = defaultdict(set)
            for i in range(0, len(all_regs), 5000):
                for reg, mid in s.execute(text(
                    "SELECT reg_norm, medicine_id FROM medicine_catalog_regs WHERE reg_norm = ANY(:regs)"
                ), {"regs": all_regs[i:i + 5000]}):
                    reg_ids[reg].add(mid)
            # 2) Tên → id cho các dòng cần ghép theo tên.
            names = {normalize_text(r.name) for r in sheet.rows if r.name} - {""}
            cores = {name_core(r.name) for r in sheet.rows if r.name} - {""}
            name_ids: dict[str, set[int]] = defaultdict(set)
            name_list, core_list = sorted(names), sorted(cores)
            for i in range(0, max(len(name_list), len(core_list)), 5000):
                for mid, nn, nc in s.execute(text(
                    "SELECT id, name_norm, name_core FROM medicine_catalog WHERE name_norm = ANY(:names) OR name_core = ANY(:cores)"
                ), {"names": name_list[i:i + 5000], "cores": core_list[i:i + 5000]}):
                    name_ids["n:" + nn].add(mid)
                    name_ids["c:" + nc].add(mid)
            wanted = {mid for ids in reg_ids.values() for mid in ids} | {mid for ids in name_ids.values() for mid in ids}
            cands = self._load_candidates(s, wanted)

            # 3) Mã vạch → thuốc theo từng dòng.
            planned: dict[str, tuple[int, SourceRow, str]] = {}
            clash: set[str] = set()
            for row in sheet.rows:
                if not row.codes:
                    continue
                report.rows_with_barcode += 1
                regs = regs_by_row.get(row.row, [])
                medicine, method = None, ""
                if regs:
                    pool = [cands[mid] for reg in regs for mid in reg_ids.get(reg[:40], ()) if mid in cands]
                    medicine, left = _pick(pool, row)
                    if medicine:
                        method = "registration"
                    elif left > 1:
                        report.ambiguous += 1
                        report.issue(row, "ambiguous", f"Số đăng ký {row.registration} ứng với {left} thuốc trong danh mục, "
                                                       "tên/hàm lượng không đủ để phân biệt.")
                        continue
                if medicine is None and row.name:
                    ids = name_ids.get("n:" + normalize_text(row.name), set()) | name_ids.get("c:" + name_core(row.name), set())
                    medicine, left = _pick([cands[mid] for mid in ids if mid in cands], row)
                    if medicine:
                        method = "name"
                    elif left > 1:
                        report.ambiguous += 1
                        report.issue(row, "ambiguous", f"Tên “{row.name}” ứng với {left} thuốc — cần số đăng ký để phân biệt.")
                        continue
                if medicine is None:
                    report.unmatched += 1
                    why = (f"Số đăng ký {row.registration} không có trong danh mục {report.catalog_total:,} thuốc".replace(",", ".")
                           if regs else "Thiếu số đăng ký và tên không khớp duy nhất một thuốc trong danh mục")
                    report.issue(row, "unmatched", why + ".")
                    continue
                report.matched_rows += 1
                if method == "registration":
                    report.by_registration += 1
                else:
                    report.by_name += 1
                for code in row.codes:
                    report.codes_total += 1
                    parsed = parse_code(code)
                    if parsed.kind == "internal":
                        report.internal += 1
                        report.issue(row, "internal", parsed.message, code)
                        continue
                    if parsed.kind != "gtin" or not parsed.gtin:
                        report.invalid += 1
                        msg = parsed.message
                        if "e+" in code.lower():
                            msg = "Excel đã đổi mã vạch thành số dạng 8.93E+12 (mất chữ số) — hãy định dạng cột mã vạch là Text rồi xuất lại."
                        report.issue(row, "invalid", msg, code)
                        continue
                    gtin = parsed.gtin
                    prev = planned.get(gtin)
                    if prev and prev[0] != medicine.id:
                        clash.add(gtin)
                        report.issue(row, "conflict", f"Mã {parsed.display} xuất hiện ở dòng {prev[1].row} với thuốc khác trong cùng file.", code)
                        continue
                    planned.setdefault(gtin, (medicine.id, row, method))
                    if len(report.samples) < 8:
                        report.samples.append({"row": row.row, "barcode": parsed.display, "medicine_id": medicine.id,
                                               "medicine_name": medicine.ten_thuoc, "method": method})
            for gtin in clash:  # mã trỏ tới 2 thuốc trong cùng file: không gắn mã nào cả
                planned.pop(gtin, None)
                report.conflicts += 1

            # 4) So với dữ liệu đã có (không ghi đè liên kết sang thuốc khác).
            existing = {b.gtin: b.medicine_id for b in s.scalars(
                select(CatalogBarcode).where(CatalogBarcode.gtin.in_(list(planned)))
            )} if planned else {}
            to_insert: list[dict[str, Any]] = []
            for gtin, (mid, row, method) in planned.items():
                if gtin in existing:
                    if existing[gtin] == mid:
                        report.unchanged += 1
                    else:
                        report.conflicts += 1
                        report.issue(row, "conflict", f"Mã {gtin.lstrip('0') or gtin} đã gắn với thuốc khác (id {existing[gtin]}) — "
                                                      "giữ nguyên, hãy gỡ liên kết cũ nếu nó sai.", gtin)
                    continue
                to_insert.append({"gtin": gtin, "medicine_id": mid, "unit": (row.unit or None) and row.unit[:60],
                                  "source": "excel", "match_method": method})
            report.linked = len(to_insert)

            if not dry_run:
                record = BarcodeImport(
                    file_name=report.file_name, rows_total=report.rows_total, linked=report.linked, unchanged=report.unchanged,
                    conflicts=report.conflicts, unmatched=report.unmatched + report.ambiguous,
                    invalid=report.invalid + report.internal, started_by=started_by, created_at=clock.now(),
                )
                s.add(record)
                s.flush()
                now = clock.now()
                s.add_all(CatalogBarcode(**item, import_id=record.id, created_at=now) for item in to_insert)
                report.import_id = record.id
        return report
