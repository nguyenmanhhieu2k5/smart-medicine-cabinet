"""Chuyển dữ liệu từ CSDL SQLite của phiên bản 1.x sang PostgreSQL — bảo toàn, kiểm tra, chạy lại được."""
from __future__ import annotations

import hashlib
import json
import sqlite3

import pytest
from sqlalchemy import func, select

from app.models import Alert, CabinetItem, DeviceTelemetry, HistoryEvent, InventoryLog, Reminder, ReminderLog, Setting
from app.services.sqlite_migration import MigrationError, SqliteMigrator

from .conftest import AUGMENTIN_625, png_bytes

# Lược đồ SQLite của phiên bản 1.0.0 (rút gọn đúng các cột mà bản cũ dùng).
OLD_SCHEMA = """
CREATE TABLE catalog_medicines (id INTEGER PRIMARY KEY, ten_thuoc TEXT);
CREATE TABLE cabinet_items (id INTEGER PRIMARY KEY, catalog_id INTEGER, name TEXT, ingredient TEXT, strength TEXT,
  dosage_form TEXT, registration_no TEXT, manufacturer TEXT, quantity FLOAT, unit VARCHAR(24), expiry_date DATE,
  expiry_source VARCHAR(16), lot_number VARCHAR(64), low_stock_threshold FLOAT, location TEXT, note TEXT, image_path TEXT,
  source VARCHAR(16), created_at DATETIME, updated_at DATETIME);
CREATE TABLE reminders (id INTEGER PRIMARY KEY, cabinet_item_id INTEGER, medicine_name TEXT, dose_text TEXT, dose_quantity FLOAT,
  times JSON, frequency VARCHAR(16), days_of_week JSON, interval_days INTEGER, start_date DATE, end_date DATE, enabled BOOLEAN,
  note TEXT, created_at DATETIME, updated_at DATETIME);
CREATE TABLE reminder_logs (id INTEGER PRIMARY KEY, reminder_id INTEGER, scheduled_for DATETIME, status VARCHAR(12),
  acted_at DATETIME, notified_at DATETIME);
CREATE TABLE alerts (id INTEGER PRIMARY KEY, category VARCHAR(16), type VARCHAR(32), severity VARCHAR(12), title TEXT, message TEXT,
  dedupe_key VARCHAR(96), status VARCHAR(16), data JSON, created_at DATETIME, updated_at DATETIME, resolved_at DATETIME, notified_at DATETIME);
CREATE TABLE history_events (id INTEGER PRIMARY KEY, grp VARCHAR(16), type VARCHAR(32), title TEXT, description TEXT, data JSON,
  image_path TEXT, created_at DATETIME);
CREATE TABLE settings (key VARCHAR(64) PRIMARY KEY, value JSON, updated_at DATETIME);
CREATE TABLE sensor_readings (id INTEGER PRIMARY KEY, recorded_at DATETIME, temperature FLOAT, humidity FLOAT, simulated BOOLEAN, extra JSON);
"""


@pytest.fixture
def old_db(tmp_path):
    image = tmp_path / "old-images" / "cabinet_7.jpg"
    image.parent.mkdir()
    image.write_bytes(png_bytes())
    path = tmp_path / "cabinet.db"
    conn = sqlite3.connect(path)
    conn.executescript(OLD_SCHEMA)
    conn.executemany("INSERT INTO cabinet_items VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", [
        (7, AUGMENTIN_625, "Augmentin 625mg tablets", "Amoxicillin; Clavulanate", "500mg/125mg", "Viên nén", "VN-20169-16", "GSK",
         14.0, "viên", "2027-06-15", "ocr_confirmed", "L01", None, "Ngăn trên", None, str(image), "scan",
         "2026-11-01 08:00:00.000000", "2026-11-02 09:30:00.000000"),
        (9, 999999999, "Thuốc có mã danh mục đã mất", None, None, None, None, None, 3.5, "gói", None, None, None, 2, None,
         "ghi chú", None, "manual", "2026-11-03 10:00:00", "2026-11-03 10:00:00"),
    ])
    conn.execute("INSERT INTO reminders VALUES (3, 7, 'Augmentin', '1 viên sau ăn', 1, ?, 'daily', '[]', 1, '2026-11-01', NULL, 1, NULL,"
                 " '2026-11-01 08:00:00', '2026-11-01 08:00:00')", (json.dumps(["08:00", "20:00"]),))
    conn.execute("INSERT INTO reminder_logs VALUES (1, 3, '2026-11-02 08:00:00', 'taken', '2026-11-02 08:05:00', NULL)")
    conn.execute("INSERT INTO alerts VALUES (4, 'medicine', 'expiring', 'warning', 'Sắp hết hạn', 'Còn 20 ngày', 'med:expiring:9',"
                 " 'active', '{\"days\": 20}', '2026-11-03 10:00:00', '2026-11-03 10:00:00', NULL, NULL)")
    conn.execute("INSERT INTO history_events VALUES (11, 'cabinet', 'cabinet_add', 'Thêm thuốc', 'Đã lưu Augmentin', '{\"id\": 7}', NULL,"
                 " '2026-11-01 08:00:00')")
    conn.executemany("INSERT INTO settings VALUES (?,?,?)", [
        ("expiry_warning_days", "45", "2026-11-01 08:00:00"), ("theme", '"dark"', "2026-11-01 08:00:00"),
        ("esp32_host", '"192.168.1.50"', "2026-11-01 08:00:00"), ("_catalog_normalizer_version", '"2"', "2026-11-01 08:00:00"),
    ])
    conn.execute("INSERT INTO sensor_readings VALUES (1, '2026-11-02 07:00:00', 26.4, 58.0, 0, NULL)")
    conn.commit()
    conn.close()
    return path


def migrator(db, tmp_path) -> SqliteMigrator:
    return SqliteMigrator(db, data_dir=tmp_path / "srv", images_dir=tmp_path / "srv" / "images", backups_dir=tmp_path / "srv" / "backups")


def digest(path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def test_migration_copies_verifies_and_preserves_source(db, tmp_path, old_db):
    before = digest(old_db)
    report = migrator(db, tmp_path).run(old_db)
    assert report.ok, report.to_dict()
    assert digest(old_db) == before  # file gốc không bị sửa
    assert (tmp_path / "srv" / "backups").iterdir().__next__().name.startswith("pre-postgres-")
    assert report.counts["cabinet_medicines"] == {"source": 2, "inserted": 2, "present": 2}
    assert report.images_copied == 1 and any("mã danh mục" in w or "id danh mục" in w for w in report.warnings)
    with db.session() as s:
        items = {i.id: i for i in s.scalars(select(CabinetItem)).all()}
        assert items[7].catalog_id == AUGMENTIN_625 and items[7].quantity == 14 and str(items[7].expiry_date) == "2027-06-15"
        assert items[7].image_path.endswith("cabinet_7.jpg") and items[7].created_at.hour == 8
        assert items[9].catalog_id is None and items[9].unit == "gói"  # giữ lại thuốc dù danh mục không còn mã
        reminder = s.get(Reminder, 3)
        assert reminder.times == ["08:00", "20:00"] and reminder.cabinet_item_id == 7 and reminder.enabled is True
        assert s.get(ReminderLog, 1).status == "taken"
        assert s.get(Alert, 4).data == {"days": 20}
        assert s.get(HistoryEvent, 11).group == "cabinet"
        assert s.get(Setting, "expiry_warning_days").value == 45 and s.get(Setting, "esp32_host") is None
        assert s.scalar(select(func.count()).select_from(DeviceTelemetry)) == 1
        assert s.scalar(select(func.count()).select_from(InventoryLog).where(InventoryLog.action == "migrate")) == 2
    # Id mới cấp sau khi chuyển không đụng id cũ (sequence đã được đặt lại).
    with db.session() as s:
        new = CabinetItem(name="Mới", quantity=1, unit="viên", source="manual", created_at=items[7].created_at, updated_at=items[7].created_at)
        s.add(new)
        s.flush()
        assert new.id > 9


def test_migration_is_idempotent(db, tmp_path, old_db):
    first = migrator(db, tmp_path).run(old_db)
    second = migrator(db, tmp_path).run(old_db)
    assert first.ok and second.ok
    assert all(c.get("inserted", 0) == 0 for c in second.counts.values())
    with db.session() as s:
        assert s.scalar(select(func.count()).select_from(CabinetItem)) == 2
        assert s.scalar(select(func.count()).select_from(DeviceTelemetry)) == 1


def test_dry_run_writes_nothing(db, tmp_path, old_db):
    report = migrator(db, tmp_path).run(old_db, dry_run=True)
    assert report.dry_run and report.checks == {}
    with db.session() as s:
        assert s.scalar(select(func.count()).select_from(CabinetItem)) == 0


def test_rejects_files_that_are_not_cabinet_databases(db, tmp_path):
    other = tmp_path / "other.db"
    sqlite3.connect(other).execute("CREATE TABLE x(a)").connection.close()
    with pytest.raises(MigrationError, match="không phải CSDL"):
        migrator(db, tmp_path).run(other)
    with pytest.raises(MigrationError, match="Không tìm thấy"):
        migrator(db, tmp_path).run(tmp_path / "khong-co.db")


def test_refuses_to_mix_a_second_sqlite_source(db, tmp_path, old_db):
    """Hai CSDL SQLite cũ (vd. bản dev và bản cài) đều đánh id từ 1 → không được trộn nhầm."""
    assert migrator(db, tmp_path).run(old_db).ok
    other = tmp_path / "khac" / "cabinet.db"
    other.parent.mkdir()
    other.write_bytes(old_db.read_bytes())
    with pytest.raises(MigrationError, match="đã nhận dữ liệu từ"):
        migrator(db, tmp_path).run(other)
    forced = migrator(db, tmp_path).run(other, allow_other_source=True)
    assert all(c.get("inserted", 0) == 0 for c in forced.counts.values())  # trùng id → bỏ qua, không ghi đè
