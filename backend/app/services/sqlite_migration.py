"""Chuyển dữ liệu từ CSDL SQLite cũ (phiên bản 1.x, chạy kèm ứng dụng Windows) sang PostgreSQL.

Nguyên tắc bảo toàn dữ liệu:
1. Chép nguyên file SQLite (+ -wal, -shm) vào ``backups/pre-postgres-<thời gian>/`` trước; chỉ đọc từ bản chép.
   File gốc không bao giờ bị sửa hay xóa.
2. Giữ nguyên ``id`` cũ của thuốc trong tủ, lời nhắc, cảnh báo, lịch sử → chạy lại nhiều lần không tạo bản ghi trùng
   (``ON CONFLICT DO NOTHING``).
3. Danh mục thuốc lấy từ Excel DAV_unique.xlsx (cùng ``id`` của Cục Quản lý Dược); thuốc trong tủ tham chiếu tới
   ``id`` không còn trong danh mục được giữ lại với ``catalog_id = NULL`` và được báo cáo.
4. Sau khi chép: so số dòng và tổng kiểm tra từng bảng giữa hai CSDL; báo cáo mọi khác biệt.
"""
from __future__ import annotations

import hashlib
import json
import shutil
import sqlite3
from dataclasses import dataclass, field
from datetime import date, datetime
from pathlib import Path
from typing import Any, Callable

from sqlalchemy import func, select, text
from sqlalchemy.dialects.postgresql import insert as pg_insert

from app.auth import tokens
from app.core import clock
from app.database.session import Database
from app.models import (
    Alert, CabinetItem, CatalogMedicine, Device, DeviceTelemetry, HistoryEvent, InventoryLog, Reminder, ReminderLog, Setting,
)

OLD_TABLES = ("cabinet_items", "reminders", "reminder_logs", "alerts", "history_events", "settings")
SKIP_SETTINGS_PREFIX = ("esp32_", "_catalog_normalizer")
LEGACY_DEVICE_NAME = "ESP32 cũ (LAN) — số đo chuyển từ SQLite"


class MigrationError(Exception):
    pass


@dataclass
class MigrationReport:
    source: str
    backup_dir: str | None = None
    dry_run: bool = False
    counts: dict[str, dict[str, int]] = field(default_factory=dict)  # bảng → {source, inserted, present}
    checks: dict[str, bool] = field(default_factory=dict)
    warnings: list[str] = field(default_factory=list)
    images_copied: int = 0

    @property
    def ok(self) -> bool:
        return all(self.checks.values()) if self.checks else False

    def to_dict(self) -> dict[str, Any]:
        return {"source": self.source, "backup_dir": self.backup_dir, "dry_run": self.dry_run, "counts": self.counts,
                "checks": self.checks, "warnings": self.warnings, "images_copied": self.images_copied, "ok": self.ok}


def _dt(value: Any) -> datetime | None:
    if value in (None, ""):
        return None
    if isinstance(value, datetime):
        return value
    text_value = str(value).replace("T", " ")
    try:
        return datetime.fromisoformat(text_value)
    except ValueError:
        return datetime.strptime(text_value[:19], "%Y-%m-%d %H:%M:%S")


def _date(value: Any) -> date | None:
    if value in (None, ""):
        return None
    if isinstance(value, date):
        return value
    return date.fromisoformat(str(value)[:10])


def _json(value: Any) -> Any:
    if value is None or isinstance(value, (dict, list)):
        return value
    try:
        return json.loads(value)
    except (TypeError, ValueError):
        return value


def _bool(value: Any) -> bool | None:
    return None if value is None else bool(value)


def _checksum(rows: list[tuple]) -> str:
    h = hashlib.sha256()
    for row in sorted(rows, key=lambda r: str(r[0])):
        h.update(json.dumps([str(v) for v in row], ensure_ascii=False).encode("utf-8"))
    return h.hexdigest()


class SqliteMigrator:
    def __init__(self, db: Database, *, data_dir: Path, images_dir: Path, backups_dir: Path,
                 progress: Callable[[str], None] | None = None):
        self.db = db
        self.data_dir = data_dir
        self.images_dir = images_dir
        self.backups_dir = backups_dir
        self.progress = progress or (lambda _msg: None)

    # ------------------------------------------------------------------ #
    def backup_source(self, source: Path) -> Path:
        stamp = clock.now().strftime("%Y%m%d-%H%M%S")
        folder = self.backups_dir / f"pre-postgres-{stamp}"
        counter = 2
        while folder.exists():  # hai lần chạy trong cùng một giây
            folder = self.backups_dir / f"pre-postgres-{stamp}-{counter}"
            counter += 1
        folder.mkdir(parents=True)
        for suffix in ("", "-wal", "-shm"):
            src = Path(str(source) + suffix)
            if src.is_file():
                shutil.copy2(src, folder / (source.name + suffix))
        return folder / source.name

    def _open(self, path: Path) -> sqlite3.Connection:
        conn = sqlite3.connect(str(path))
        conn.row_factory = sqlite3.Row
        tables = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        missing = [t for t in OLD_TABLES if t not in tables]
        if missing:
            conn.close()
            raise MigrationError("File không phải CSDL Tủ thuốc thông minh 1.x (thiếu bảng: " + ", ".join(missing) + ").")
        return conn

    # ------------------------------------------------------------------ #
    def run(self, source: Path, *, dry_run: bool = False, allow_other_source: bool = False) -> MigrationReport:
        source = Path(source)
        if not source.is_file():
            raise MigrationError(f"Không tìm thấy file: {source}")
        with self.db.session() as s:
            previous = s.get(Setting, "_sqlite_migration")
            previous_source = (previous.value or {}).get("source") if previous is not None else None
        if previous_source and Path(previous_source).resolve() != source.resolve() and not allow_other_source:
            # Mỗi CSDL SQLite cũ đánh id riêng từ 1 → trộn hai nguồn sẽ trùng id. Chỉ chuyển MỘT nguồn.
            raise MigrationError(
                f"PostgreSQL đã nhận dữ liệu từ {previous_source}. Không chuyển thêm nguồn khác để tránh trộn/trùng dữ liệu "
                "(thêm --allow-other-source nếu thật sự muốn; bản ghi trùng id sẽ bị bỏ qua và được báo cáo)."
            )
        report = MigrationReport(source=str(source.resolve()), dry_run=dry_run)
        copy = self.backup_source(source)
        report.backup_dir = str(copy.parent)
        self.progress(f"Đã sao lưu file gốc vào {copy.parent}")
        conn = self._open(copy)
        try:
            self._migrate(conn, report, dry_run)
            if not dry_run:
                self._verify(conn, report)
        finally:
            conn.close()
        return report

    def _rows(self, conn: sqlite3.Connection, table: str) -> list[sqlite3.Row]:
        return conn.execute(f"SELECT * FROM {table} ORDER BY 1").fetchall()

    def _migrate(self, conn: sqlite3.Connection, report: MigrationReport, dry_run: bool) -> None:
        with self.db.session() as s:
            catalog_ids = set(s.scalars(select(CatalogMedicine.id)).all())
            if not catalog_ids:
                report.warnings.append("Danh mục thuốc trên PostgreSQL đang trống — nên chạy `python -m app.cli import-catalog` trước.")

            # ---- settings ------------------------------------------------ #
            rows = self._rows(conn, "settings")
            values = [
                {"key": r["key"], "value": _json(r["value"]), "updated_at": _dt(r["updated_at"]) or clock.now()}
                for r in rows if not r["key"].startswith(SKIP_SETTINGS_PREFIX)
            ]
            inserted = self._insert(s, Setting, values, ["key"], dry_run)
            report.counts["settings"] = {"source": len(values), "inserted": inserted}

            # ---- thuốc trong tủ ------------------------------------------ #
            items = []
            orphan = 0
            for r in self._rows(conn, "cabinet_items"):
                catalog_id = r["catalog_id"]
                if catalog_id is not None and catalog_id not in catalog_ids:
                    orphan += 1
                    catalog_id = None
                image = self._copy_image(r["image_path"], r["id"], dry_run, report)
                items.append({
                    "id": r["id"], "catalog_id": catalog_id, "name": r["name"], "ingredient": r["ingredient"],
                    "strength": r["strength"], "dosage_form": r["dosage_form"], "registration_no": r["registration_no"],
                    "manufacturer": r["manufacturer"], "quantity": max(0.0, float(r["quantity"] or 0)), "unit": r["unit"] or "viên",
                    "expiry_date": _date(r["expiry_date"]), "expiry_source": r["expiry_source"], "lot_number": r["lot_number"],
                    "low_stock_threshold": r["low_stock_threshold"], "location": r["location"], "note": r["note"],
                    "image_path": image, "source": r["source"] if r["source"] in ("scan", "manual") else "manual",
                    "created_at": _dt(r["created_at"]) or clock.now(), "updated_at": _dt(r["updated_at"]) or clock.now(),
                })
            if orphan:
                report.warnings.append(f"{orphan} thuốc trong tủ tham chiếu tới id danh mục không còn → giữ lại, bỏ liên kết danh mục.")
            inserted = self._insert(s, CabinetItem, items, ["id"], dry_run)
            report.counts["cabinet_medicines"] = {"source": len(items), "inserted": inserted}
            if inserted and not dry_run:
                migrated_ids = {i["id"] for i in items}
                already = set(s.scalars(select(InventoryLog.cabinet_medicine_id).where(InventoryLog.action == "migrate")).all())
                for item in items:
                    if item["id"] in migrated_ids - already:
                        s.add(InventoryLog(cabinet_medicine_id=item["id"], medicine_name=item["name"], action="migrate",
                                           quantity_before=None, quantity_after=item["quantity"], delta=None, unit=item["unit"],
                                           note="Chuyển từ CSDL SQLite phiên bản 1.x", created_at=clock.now()))

            # ---- lời nhắc ------------------------------------------------- #
            cabinet_ids = {i["id"] for i in items} | set(s.scalars(select(CabinetItem.id)).all())
            reminders = [{
                "id": r["id"], "cabinet_item_id": r["cabinet_item_id"] if r["cabinet_item_id"] in cabinet_ids else None,
                "medicine_name": r["medicine_name"], "dose_text": r["dose_text"], "dose_quantity": r["dose_quantity"],
                "times": _json(r["times"]) or [], "frequency": r["frequency"] or "daily", "days_of_week": _json(r["days_of_week"]) or [],
                "interval_days": r["interval_days"] or 1, "start_date": _date(r["start_date"]), "end_date": _date(r["end_date"]),
                "enabled": bool(r["enabled"]), "note": r["note"], "created_at": _dt(r["created_at"]) or clock.now(),
                "updated_at": _dt(r["updated_at"]) or clock.now(),
            } for r in self._rows(conn, "reminders")]
            inserted = self._insert(s, Reminder, reminders, ["id"], dry_run)
            report.counts["reminders"] = {"source": len(reminders), "inserted": inserted}
            reminder_ids = {r["id"] for r in reminders}
            logs = [{
                "id": r["id"], "reminder_id": r["reminder_id"], "scheduled_for": _dt(r["scheduled_for"]), "status": r["status"],
                "acted_at": _dt(r["acted_at"]), "notified_at": _dt(r["notified_at"]),
            } for r in self._rows(conn, "reminder_logs") if r["reminder_id"] in reminder_ids]
            inserted = self._insert(s, ReminderLog, logs, ["id"], dry_run)
            report.counts["reminder_logs"] = {"source": len(logs), "inserted": inserted}

            # ---- cảnh báo, lịch sử ---------------------------------------- #
            alerts = [{
                "id": r["id"], "category": r["category"], "type": r["type"], "severity": r["severity"], "title": r["title"],
                "message": r["message"], "dedupe_key": r["dedupe_key"], "status": r["status"], "data": _json(r["data"]),
                "created_at": _dt(r["created_at"]), "updated_at": _dt(r["updated_at"]), "resolved_at": _dt(r["resolved_at"]),
                "notified_at": _dt(r["notified_at"]),
            } for r in self._rows(conn, "alerts")]
            inserted = self._insert(s, Alert, alerts, ["id"], dry_run)
            report.counts["alerts"] = {"source": len(alerts), "inserted": inserted}
            events = [{
                "id": r["id"], "group": r["grp"], "type": r["type"], "title": r["title"], "description": r["description"],
                "data": _json(r["data"]), "image_path": None, "created_at": _dt(r["created_at"]),
            } for r in self._rows(conn, "history_events")]
            inserted = self._insert(s, HistoryEvent, events, ["id"], dry_run)
            report.counts["history_events"] = {"source": len(events), "inserted": inserted}

            # ---- số đo cảm biến cũ ---------------------------------------- #
            tables = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            readings = self._rows(conn, "sensor_readings") if "sensor_readings" in tables else []
            report.counts["device_telemetry"] = {"source": len(readings), "inserted": 0}
            if readings and not dry_run:
                device = s.scalar(select(Device).where(Device.name == LEGACY_DEVICE_NAME))
                if device is None:
                    token = tokens.new_device_token()  # không hiển thị: thiết bị chỉ để giữ số đo cũ, đã vô hiệu hóa
                    device = Device(name=LEGACY_DEVICE_NAME, token_hash=tokens.sha256_hex(token), token_hint=token[-6:],
                                    capabilities=[], is_active=False, is_primary=False, created_at=clock.now(), updated_at=clock.now(),
                                    note="Tạo tự động khi chuyển dữ liệu từ SQLite.")
                    s.add(device)
                    s.flush()
                    s.add_all(DeviceTelemetry(
                        device_id=device.id, recorded_at=_dt(r["recorded_at"]), temperature=r["temperature"], humidity=r["humidity"],
                        simulated=bool(r["simulated"]), extra={"migrated_id": r["id"]},
                    ) for r in readings)
                    report.counts["device_telemetry"]["inserted"] = len(readings)

            if not dry_run:
                for table in ("cabinet_medicines", "reminders", "reminder_logs", "alerts", "history_events", "medicine_inventory_logs"):
                    s.execute(text(
                        f"SELECT setval(pg_get_serial_sequence('{table}', 'id'), GREATEST((SELECT COALESCE(max(id), 0) FROM {table}), 1))"
                    ))
                s.add(Setting(key="_sqlite_migration", value={"source": report.source, "at": clock.now().isoformat(),
                                                              "backup_dir": report.backup_dir}, updated_at=clock.now())) \
                    if s.get(Setting, "_sqlite_migration") is None else None
            else:
                s.rollback()

    def _insert(self, s, model, rows: list[dict[str, Any]], key: list[str], dry_run: bool) -> int:  # noqa: ANN001
        if not rows or dry_run:
            return 0
        table = model.__table__
        # RETURNING để đếm chính xác số dòng thật sự được chèn (rowcount của executemany không đáng tin).
        stmt = pg_insert(table).on_conflict_do_nothing(index_elements=key).returning(*[table.c[k] for k in key])
        total = 0
        for i in range(0, len(rows), 1000):
            total += len(s.execute(stmt, self._to_columns(model, rows[i:i + 1000])).all())
        return total

    @staticmethod
    def _to_columns(model, rows: list[dict[str, Any]]) -> list[dict[str, Any]]:  # noqa: ANN001
        # Tên thuộc tính ORM → tên cột (vd. HistoryEvent.group → cột "grp").
        mapper = model.__mapper__
        out = []
        for row in rows:
            out.append({mapper.attrs[k].columns[0].name if k in mapper.attrs else k: v for k, v in row.items()})
        return out

    def _copy_image(self, path: str | None, item_id: int, dry_run: bool, report: MigrationReport) -> str | None:
        if not path:
            return None
        src = Path(path)
        if not src.is_file():
            report.warnings.append(f"Không tìm thấy ảnh của thuốc #{item_id}: {path}")
            return None
        target = self.images_dir / f"cabinet_{item_id}.jpg"
        if not dry_run:
            self.images_dir.mkdir(parents=True, exist_ok=True)
            if not target.exists():
                shutil.copy2(src, target)
                report.images_copied += 1
        return str(target)

    # ------------------------------------------------------------------ #
    def _verify(self, conn: sqlite3.Connection, report: MigrationReport) -> None:
        """So khớp dữ liệu nguồn với PostgreSQL (theo id) bằng tổng kiểm tra."""
        specs = {
            "cabinet_medicines": ("SELECT id, name, quantity, unit, expiry_date FROM cabinet_items",
                                  "SELECT id, name, quantity, unit, expiry_date FROM cabinet_medicines WHERE id = ANY(:ids)"),
            "reminders": ("SELECT id, medicine_name, frequency, start_date FROM reminders",
                          "SELECT id, medicine_name, frequency, start_date FROM reminders WHERE id = ANY(:ids)"),
            "alerts": ("SELECT id, type, status, dedupe_key FROM alerts",
                       "SELECT id, type, status, dedupe_key FROM alerts WHERE id = ANY(:ids)"),
            "history_events": ("SELECT id, grp, type, title FROM history_events",
                               "SELECT id, grp, type, title FROM history_events WHERE id = ANY(:ids)"),
        }

        def norm(row: tuple) -> tuple:
            out = []
            for v in row:
                if isinstance(v, float) or (isinstance(v, str) and v.replace(".", "", 1).isdigit() and "." in v):
                    out.append(str(round(float(v), 3)))
                elif isinstance(v, (date, datetime)):
                    out.append(v.isoformat()[:10])
                elif isinstance(v, str) and len(v) >= 10 and v[4] == "-" and v[7] == "-":
                    out.append(v[:10])
                else:
                    out.append(v)
            return tuple(out)

        with self.db.session() as s:
            for name, (sqlite_sql, pg_sql) in specs.items():
                source_rows = [norm(tuple(r)) for r in conn.execute(sqlite_sql).fetchall()]
                ids = [r[0] for r in source_rows]
                target_rows = [norm(tuple(r)) for r in s.execute(text(pg_sql), {"ids": ids}).all()] if ids else []
                same = len(source_rows) == len(target_rows) and _checksum(source_rows) == _checksum(target_rows)
                report.checks[name] = same
                report.counts.setdefault(name, {})["present"] = len(target_rows)
                if not same:
                    report.warnings.append(f"Bảng {name}: dữ liệu trên PostgreSQL khác nguồn ({len(target_rows)}/{len(source_rows)} dòng).")
            settings_ok = s.scalar(select(func.count()).select_from(Setting)) >= report.counts["settings"]["source"]
            report.checks["settings"] = bool(settings_ok)
