"""Sao lưu / khôi phục PostgreSQL bằng pg_dump / pg_restore (định dạng custom, nén).

- Bản sao lưu gồm TOÀN BỘ CSDL (danh mục thuốc, tủ thuốc, tài khoản, OCR, thiết bị, nhật ký).
- Bản tự động hằng ngày có nhãn ``auto`` và chỉ giữ ``backup_keep`` bản mới nhất; bản thủ công giữ tới khi xóa.
- Nếu cấu hình ``SMC_BACKUP_COPY_DIR`` (ổ ngoài, thư mục đồng bộ OneDrive…), mỗi bản được chép thêm sang đó.
- Khôi phục chỉ qua dòng lệnh trên Mini PC (``python -m app.cli backup restore``), luôn tạo bản an toàn trước.
"""
from __future__ import annotations

import os
import re
import shutil
import subprocess
import sys
from datetime import datetime
from pathlib import Path
from typing import Any

from sqlalchemy.engine import make_url

from app.core import clock
from app.database.cluster import find_pg_bin
from app.database.session import iso_local

_NAME_RE = re.compile(r"^smart_medicine-\d{8}-\d{6}(?:-\d+)?-[A-Za-z0-9_-]{1,32}\.dump$")


class BackupError(Exception):
    pass


def _bin(pg_bin: Path | None, tool: str) -> str:
    folder = pg_bin or find_pg_bin()
    exe = folder / (tool + (".exe" if sys.platform == "win32" else ""))
    if not exe.is_file():
        raise BackupError(f"Không tìm thấy {tool} trong {folder}.")
    return str(exe)


def _conn_args(database_url: str) -> tuple[list[str], dict[str, str]]:
    url = make_url(database_url)
    args = ["-h", url.host or "127.0.0.1", "-p", str(url.port or 5432), "-U", url.username or "postgres", "-d", url.database or "postgres"]
    env = dict(os.environ)
    if url.password:
        env["PGPASSWORD"] = str(url.password)
    env.setdefault("PGCONNECT_TIMEOUT", "10")
    return args, env


def _run(cmd: list[str], env: dict[str, str], timeout: int = 1800) -> subprocess.CompletedProcess[str]:
    try:
        return subprocess.run(cmd, env=env, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=timeout)
    except subprocess.TimeoutExpired as exc:
        raise BackupError(f"{Path(cmd[0]).name} chạy quá lâu.") from exc


def describe(path: Path) -> dict[str, Any]:
    stat = path.stat()
    label = path.stem.rsplit("-", 1)[-1]
    return {
        "name": path.name,
        "size": stat.st_size,
        "created_at": iso_local(datetime.fromtimestamp(stat.st_mtime)),
        "label": label,
        "automatic": label == "auto",
    }


def create_backup(database_url: str, backups_dir: Path, *, label: str = "manual", pg_bin: Path | None = None,
                  copy_dir: Path | None = None, keep_auto: int = 14) -> dict[str, Any]:
    backups_dir.mkdir(parents=True, exist_ok=True)
    stamp = clock.now().strftime("%Y%m%d-%H%M%S")
    safe_label = re.sub(r"[^A-Za-z0-9_-]", "", label)[:32] or "manual"
    path = backups_dir / f"smart_medicine-{stamp}-{safe_label}.dump"
    counter = 2
    while path.exists():
        path = backups_dir / f"smart_medicine-{stamp}-{counter}-{safe_label}.dump"
        counter += 1
    args, env = _conn_args(database_url)
    tmp = path.with_suffix(".partial")
    result = _run([_bin(pg_bin, "pg_dump"), *args, "--format=custom", "--compress=6", "--no-owner", "--no-privileges",
                   "--file", str(tmp)], env)
    if result.returncode != 0:
        tmp.unlink(missing_ok=True)
        raise BackupError("pg_dump thất bại: " + (result.stderr.strip()[-600:] or f"mã {result.returncode}"))
    tmp.replace(path)
    verify_backup(path, pg_bin=pg_bin)
    info = describe(path)
    if copy_dir:
        try:
            copy_dir.mkdir(parents=True, exist_ok=True)
            shutil.copy2(path, copy_dir / path.name)
            info["copied_to"] = str(copy_dir)
        except OSError as exc:
            info["copy_error"] = str(exc)
    if safe_label == "auto":
        info["pruned"] = prune(backups_dir, keep_auto)
    return info


def verify_backup(path: Path, *, pg_bin: Path | None = None) -> int:
    """Đọc mục lục của bản sao lưu; trả về số mục. Ném BackupError nếu file hỏng."""
    result = _run([_bin(pg_bin, "pg_restore"), "--list", str(path)], dict(os.environ), timeout=300)
    if result.returncode != 0:
        raise BackupError("Bản sao lưu không hợp lệ: " + result.stderr.strip()[-400:])
    entries = [ln for ln in result.stdout.splitlines() if ln and not ln.startswith(";")]
    if not any(" TABLE DATA " in ln for ln in entries):
        raise BackupError("Bản sao lưu không chứa dữ liệu bảng.")
    return len(entries)


def restore_backup(database_url: str, path: Path, *, pg_bin: Path | None = None) -> None:
    """Khôi phục vào CSDL đang dùng (xóa đối tượng cũ rồi tạo lại) trong MỘT transaction."""
    verify_backup(path, pg_bin=pg_bin)
    args, env = _conn_args(database_url)
    result = _run([_bin(pg_bin, "pg_restore"), *args, "--clean", "--if-exists", "--no-owner", "--no-privileges",
                   "--single-transaction", "--exit-on-error", str(path)], env, timeout=3600)
    if result.returncode != 0:
        raise BackupError("pg_restore thất bại (CSDL giữ nguyên trạng thái cũ): " + result.stderr.strip()[-800:])


def list_backups(backups_dir: Path) -> list[dict[str, Any]]:
    if not backups_dir.is_dir():
        return []
    items = [describe(p) for p in backups_dir.glob("*.dump") if _NAME_RE.match(p.name)]
    return sorted(items, key=lambda i: i["name"], reverse=True)


def resolve_backup(backups_dir: Path, name: str) -> Path:
    if not _NAME_RE.match(name or ""):
        raise BackupError("Tên bản sao lưu không hợp lệ.")
    path = backups_dir / name
    if not path.is_file():
        raise BackupError("Không tìm thấy bản sao lưu.")
    return path


def prune(backups_dir: Path, keep_auto: int) -> int:
    autos = sorted((p for p in backups_dir.glob("*-auto.dump") if _NAME_RE.match(p.name)), key=lambda p: p.name, reverse=True)
    removed = 0
    for old in autos[max(1, keep_auto):]:
        try:
            old.unlink()
            removed += 1
        except OSError:
            pass
    return removed
