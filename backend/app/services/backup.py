"""Sao lưu và khôi phục dữ liệu NGƯỜI DÙNG (tủ thuốc, lời nhắc, lịch sử, cài đặt…).

Danh mục thuốc (~55.000 dòng) không nằm trong bản sao lưu vì luôn có thể nhập
lại từ file Excel; nhờ vậy file sao lưu nhỏ và khôi phục nhanh.
"""
from __future__ import annotations

import re
import sqlite3
from datetime import datetime
from pathlib import Path
from typing import Any

from app import __version__
from app.core import clock
from app.database.session import Database

USER_TABLES = (
    "cabinet_items", "reminders", "reminder_logs", "alerts", "history_events", "settings", "sensor_readings",
)
_NAME_RE = re.compile(r"^[A-Za-z0-9_.-]+\.smcbak$")


class BackupError(Exception):
    pass


def _columns(conn: sqlite3.Connection, schema: str, table: str) -> list[str]:
    return [row[1] for row in conn.execute(f"PRAGMA {schema}.table_info({table})")]


def create_backup(db: Database, backups_dir: Path, label: str = "manual") -> dict[str, Any]:
    backups_dir.mkdir(parents=True, exist_ok=True)
    stamp = clock.now().strftime("%Y%m%d-%H%M%S")
    safe_label = re.sub(r"[^A-Za-z0-9_-]", "", label) or "manual"
    path = backups_dir / f"tu-thuoc-{stamp}-{safe_label}.smcbak"
    counter = 2
    while path.exists():  # hai bản sao lưu trong cùng một giây
        path = backups_dir / f"tu-thuoc-{stamp}-{counter}-{safe_label}.smcbak"
        counter += 1
    conn = sqlite3.connect(db.db_path)
    try:
        conn.execute("ATTACH DATABASE ? AS bak", (str(path),))
        counts: dict[str, int] = {}
        for table in USER_TABLES:
            conn.execute(f"CREATE TABLE bak.{table} AS SELECT * FROM main.{table}")
            counts[table] = conn.execute(f"SELECT COUNT(*) FROM bak.{table}").fetchone()[0]
        conn.execute("CREATE TABLE bak.backup_meta(key TEXT PRIMARY KEY, value TEXT)")
        conn.executemany(
            "INSERT INTO bak.backup_meta(key, value) VALUES (?, ?)",
            [("app", "SmartMedicineCabinet"), ("version", __version__), ("created_at", clock.now().isoformat())],
        )
        conn.commit()
        conn.execute("DETACH DATABASE bak")
    except sqlite3.Error as exc:
        conn.close()
        path.unlink(missing_ok=True)
        raise BackupError(f"Không tạo được bản sao lưu: {exc}") from exc
    conn.close()
    return describe(path) | {"counts": counts}


def describe(path: Path) -> dict[str, Any]:
    stat = path.stat()
    return {
        "name": path.name,
        "size": stat.st_size,
        "created_at": datetime.fromtimestamp(stat.st_mtime).replace(microsecond=0).isoformat(),
    }


def list_backups(backups_dir: Path) -> list[dict[str, Any]]:
    if not backups_dir.is_dir():
        return []
    files = sorted(backups_dir.glob("*.smcbak"), key=lambda p: p.stat().st_mtime, reverse=True)
    return [describe(p) for p in files]


def resolve_backup(backups_dir: Path, name: str) -> Path:
    if not _NAME_RE.match(name):
        raise BackupError("Tên file sao lưu không hợp lệ.")
    path = (backups_dir / name).resolve()
    if path.parent != backups_dir.resolve() or not path.is_file():
        raise BackupError("Không tìm thấy bản sao lưu.")
    return path


def validate_backup(path: Path) -> dict[str, str]:
    try:
        conn = sqlite3.connect(f"file:{path.as_posix()}?mode=ro", uri=True)
        try:
            meta = dict(conn.execute("SELECT key, value FROM backup_meta").fetchall())
            tables = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        finally:
            conn.close()
    except sqlite3.Error as exc:
        raise BackupError("File không phải bản sao lưu hợp lệ của ứng dụng.") from exc
    if meta.get("app") != "SmartMedicineCabinet" or "cabinet_items" not in tables:
        raise BackupError("File không phải bản sao lưu hợp lệ của ứng dụng.")
    return meta


def restore_backup(db: Database, backups_dir: Path, path: Path) -> dict[str, Any]:
    """Thay dữ liệu người dùng bằng nội dung bản sao lưu (tự tạo bản an toàn trước)."""
    meta = validate_backup(path)
    safety = create_backup(db, backups_dir, label="truoc-khi-khoi-phuc")
    conn = sqlite3.connect(db.db_path, timeout=30)
    restored: dict[str, int] = {}
    try:
        conn.execute("PRAGMA foreign_keys=OFF")
        conn.execute("ATTACH DATABASE ? AS bak", (str(path),))
        conn.execute("BEGIN IMMEDIATE")
        bak_tables = {r[0] for r in conn.execute("SELECT name FROM bak.sqlite_master WHERE type='table'")}
        for table in USER_TABLES:
            conn.execute(f"DELETE FROM main.{table}")
            if table not in bak_tables:
                restored[table] = 0
                continue
            shared = [c for c in _columns(conn, "main", table) if c in set(_columns(conn, "bak", table))]
            cols = ", ".join(shared)
            conn.execute(f"INSERT INTO main.{table} ({cols}) SELECT {cols} FROM bak.{table}")
            restored[table] = conn.execute(f"SELECT COUNT(*) FROM main.{table}").fetchone()[0]
        # Danh mục hiện tại có thể khác lúc sao lưu: gỡ liên kết tới bản ghi không còn tồn tại.
        conn.execute(
            "UPDATE cabinet_items SET catalog_id = NULL "
            "WHERE catalog_id IS NOT NULL AND catalog_id NOT IN (SELECT id FROM catalog_medicines)"
        )
        conn.commit()
        conn.execute("DETACH DATABASE bak")
    except sqlite3.Error as exc:
        conn.rollback()
        conn.close()
        raise BackupError(f"Khôi phục thất bại, dữ liệu hiện tại được giữ nguyên: {exc}") from exc
    conn.close()
    db.engine.dispose()  # buộc các kết nối mới đọc dữ liệu vừa khôi phục
    return {"restored": restored, "backup_version": meta.get("version"), "safety_backup": safety["name"]}
