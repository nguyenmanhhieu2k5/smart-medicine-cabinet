"""Tự thoát khi tiến trình cha (ứng dụng Electron) không còn.

Bình thường Electron dừng backend khi thoát. Nếu Electron bị tắt đột ngột (treo, bị kết thúc từ Task Manager),
backend sẽ mồ côi và giữ cổng + file SQLite. Luồng theo dõi này kiểm tra định kỳ PID của tiến trình cha
(biến môi trường ``SMC_PARENT_PID``) và kết thúc backend khi tiến trình đó biến mất.
"""
from __future__ import annotations

import logging
import os
import sys
import threading
import time
from typing import Callable

log = logging.getLogger(__name__)


def process_alive(pid: int) -> bool:
    """Tiến trình ``pid`` còn chạy hay không (Windows + POSIX)."""
    if pid <= 0:
        return False
    if sys.platform == "win32":
        import ctypes
        from ctypes import wintypes

        PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
        STILL_ACTIVE = 259
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel32.OpenProcess.restype = wintypes.HANDLE
        kernel32.OpenProcess.argtypes = (wintypes.DWORD, wintypes.BOOL, wintypes.DWORD)
        handle = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
        if not handle:
            return False
        try:
            code = wintypes.DWORD()
            if not kernel32.GetExitCodeProcess(handle, ctypes.byref(code)):
                return False
            return code.value == STILL_ACTIVE
        finally:
            kernel32.CloseHandle(handle)
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    # Tiến trình "zombie" vẫn còn PID nhưng đã kết thúc.
    try:
        with open(f"/proc/{pid}/stat", encoding="utf-8", errors="replace") as handle:
            return handle.read().rsplit(")", 1)[-1].split()[0] != "Z"
    except OSError:
        return True


def start_parent_watch(
    parent_pid: int | None = None,
    interval: float = 2.0,
    on_parent_exit: Callable[[], None] | None = None,
) -> threading.Thread | None:
    """Bắt đầu theo dõi tiến trình cha. Không làm gì nếu không có ``SMC_PARENT_PID``."""
    if parent_pid is None:
        raw = os.environ.get("SMC_PARENT_PID", "").strip()
        if not raw.isdigit():
            return None
        parent_pid = int(raw)
    if parent_pid <= 0 or parent_pid == os.getpid():
        return None

    def _exit() -> None:
        log.warning("Tiến trình cha (PID %s) đã dừng — backend tự thoát.", parent_pid)
        os._exit(0)  # thoát ngay cả khi luồng OCR đang bận

    callback = on_parent_exit or _exit

    def _watch() -> None:
        while True:
            time.sleep(interval)
            if not process_alive(parent_pid):
                callback()
                return

    thread = threading.Thread(target=_watch, name="smc-parent-watch", daemon=True)
    thread.start()
    return thread
