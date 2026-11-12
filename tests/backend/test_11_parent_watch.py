"""Vòng đời backend: tự thoát khi ứng dụng desktop (tiến trình cha) biến mất."""
from __future__ import annotations

import os
import subprocess
import sys
import threading

from app.core.parent_watch import process_alive, start_parent_watch


def test_process_alive_for_current_and_dead_process():
    assert process_alive(os.getpid()) is True
    child = subprocess.Popen([sys.executable, "-c", "pass"])
    child.wait(timeout=30)
    assert process_alive(child.pid) is False
    assert process_alive(0) is False
    assert process_alive(-5) is False


def test_watch_fires_when_parent_exits():
    fired = threading.Event()
    parent = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(0.4)"])
    thread = start_parent_watch(parent.pid, interval=0.1, on_parent_exit=fired.set)
    assert thread is not None
    assert not fired.is_set()  # cha còn sống thì chưa thoát
    parent.wait(timeout=30)
    assert fired.wait(timeout=5), "luồng theo dõi không phát hiện tiến trình cha đã dừng"


def test_watch_stays_quiet_while_parent_alive():
    fired = threading.Event()
    thread = start_parent_watch(os.getppid(), interval=0.05, on_parent_exit=fired.set)
    assert thread is not None
    assert not fired.wait(timeout=0.4)


def test_watch_disabled_without_parent_pid(monkeypatch):
    monkeypatch.delenv("SMC_PARENT_PID", raising=False)
    assert start_parent_watch() is None
    monkeypatch.setenv("SMC_PARENT_PID", "khong-phai-so")
    assert start_parent_watch() is None
    assert start_parent_watch(os.getpid()) is None  # không tự theo dõi chính mình
