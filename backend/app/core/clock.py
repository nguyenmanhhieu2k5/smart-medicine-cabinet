"""Đồng hồ ứng dụng (giờ địa phương, không kèm múi giờ).

Ứng dụng chạy trên một máy tính duy nhất nên mọi mốc thời gian được lưu theo
giờ địa phương. Kiểm thử có thể thay hàm `now` để cố định thời gian.
"""
from __future__ import annotations

from datetime import date, datetime
from typing import Callable

_now_fn: Callable[[], datetime] = datetime.now


def now() -> datetime:
    return _now_fn().replace(microsecond=0)


def today() -> date:
    return now().date()


def set_now_fn(fn: Callable[[], datetime] | None) -> None:
    global _now_fn
    _now_fn = fn or datetime.now
