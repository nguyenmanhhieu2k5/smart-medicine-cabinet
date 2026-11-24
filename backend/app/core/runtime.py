"""Thông tin về môi trường đang chạy: mã nguồn hay bản đóng gói, có PaddlePaddle không."""
from __future__ import annotations

import importlib.util
import os
import sys
from functools import lru_cache


def is_frozen() -> bool:
    """Đang chạy từ bản đóng gói PyInstaller."""
    return bool(getattr(sys, "frozen", False))


@lru_cache(maxsize=1)
def paddle_bundled() -> bool:
    """Engine OCR mặc định là PaddlePaddle?

    ``SMC_OCR_DEFAULT_ENGINE=paddle|onnxruntime`` ép giá trị (kiểm thử dùng để kết quả ổn định);
    không đặt thì dùng Paddle khi máy có cài PaddlePaddle (Mini PC: paddlepaddle-gpu). Chỉ kiểm tra
    sự tồn tại của gói, không import (import paddle mất vài giây).
    """
    forced = os.environ.get("SMC_OCR_DEFAULT_ENGINE", "").strip().lower()
    if forced in ("paddle", "onnxruntime"):
        return forced == "paddle"
    return importlib.util.find_spec("paddle") is not None
