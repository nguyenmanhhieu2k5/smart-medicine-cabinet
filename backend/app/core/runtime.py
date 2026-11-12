"""Thông tin về môi trường đang chạy: mã nguồn hay bản đóng gói, bản đóng gói có kèm PaddlePaddle không."""
from __future__ import annotations

import importlib.util
import sys
from functools import lru_cache


def is_frozen() -> bool:
    """Đang chạy từ bản đóng gói PyInstaller (smc-backend.exe)."""
    return bool(getattr(sys, "frozen", False))


@lru_cache(maxsize=1)
def paddle_bundled() -> bool:
    """Bản đóng gói được build với SMC_BUNDLE_PADDLE=1 (có kèm engine PaddlePaddle).

    Chỉ kiểm tra sự tồn tại của gói, không import (import paddle mất vài giây).
    Khi chạy từ mã nguồn luôn trả về False để cấu hình mặc định không phụ thuộc máy lập trình viên.
    """
    return is_frozen() and importlib.util.find_spec("paddle") is not None
