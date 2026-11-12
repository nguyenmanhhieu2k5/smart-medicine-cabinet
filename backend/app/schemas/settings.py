"""Cấu hình người dùng (lưu trong bảng `settings`)."""
from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field, model_validator

from app.core.runtime import paddle_bundled

OcrEngineName = Literal["onnxruntime", "paddle"]
OcrProfileName = Literal["v6_small", "v6_tiny", "v6_medium", "v5_latin"]
OcrDeviceName = Literal["auto", "gpu", "cpu"]


def _default_ocr_engine() -> str:
    # Bản cài đặt có kèm PaddlePaddle mặc định dùng engine Paddle (GPU nếu có); còn lại dùng ONNX Runtime.
    return "paddle" if paddle_bundled() else "onnxruntime"


def _default_ocr_profile() -> str:
    # Bản kèm PaddlePaddle đóng gói sẵn mô hình medium (định dạng Paddle); bản thường kèm small (ONNX).
    return "v6_medium" if paddle_bundled() else "v6_small"


class AppSettings(BaseModel):
    # --- Camera ---
    camera_device_id: str | None = None

    # --- Ngưỡng môi trường (giá trị khởi tạo; người dùng đặt theo hướng dẫn bảo quản trên bao bì) ---
    temp_min: float = Field(15.0, ge=-20, le=60)
    temp_max: float = Field(30.0, ge=-20, le=60)
    humidity_min: float = Field(30.0, ge=0, le=100)
    humidity_max: float = Field(75.0, ge=0, le=100)

    # --- Ngưỡng thuốc ---
    expiry_warning_days: int = Field(30, ge=1, le=365)
    low_stock_threshold: float = Field(5.0, ge=0, le=100000)

    # --- ESP32 ---
    esp32_enabled: bool = False
    esp32_mode: Literal["http", "websocket"] = "http"
    esp32_host: str = Field("", max_length=255)
    esp32_port: int = Field(80, ge=1, le=65535)
    esp32_path: str = Field("/api/status", max_length=200)
    esp32_poll_seconds: int = Field(5, ge=1, le=600)
    esp32_timeout_seconds: float = Field(3.0, ge=0.5, le=30)
    esp32_stale_seconds: int = Field(30, ge=5, le=3600)
    esp32_token: str | None = Field(None, max_length=200)

    # --- OCR ---
    ocr_engine: OcrEngineName = Field(default_factory=_default_ocr_engine)
    ocr_profile: OcrProfileName = Field(default_factory=_default_ocr_profile)
    # Thiết bị cho engine Paddle: auto = GPU nếu có (CUDA), không có thì CPU. ONNX Runtime luôn chạy CPU.
    ocr_device: OcrDeviceName = "auto"
    ocr_det_limit_side_len: int = Field(960, ge=320, le=2560)
    ocr_auto_enhance: bool = True
    ocr_use_textline_orientation: bool = False
    ocr_cpu_threads: int = Field(0, ge=0, le=64)  # 0 = tự chọn
    ocr_save_scan_images: bool = False

    # --- Thông báo ---
    notify_environment: bool = True
    notify_reminders: bool = True
    notify_windows: bool = True
    sound_enabled: bool = True
    minimize_to_tray: bool = True

    # --- Giọng đọc ---
    tts_enabled: bool = True
    tts_voice: str | None = None
    tts_rate: float = Field(1.0, ge=0.5, le=2.0)

    # --- Giao diện ---
    theme: Literal["light", "dark", "system"] = "light"
    language: Literal["vi", "en"] = "vi"

    # --- Danh mục ---
    catalog_source_path: str | None = None

    # --- Hồ sơ cục bộ ---
    profile_name: str = Field("", max_length=80)
    profile_email: str = Field("", max_length=120)
    profile_role: str = Field("Người dùng", max_length=60)
    profile_avatar: str | None = None

    @model_validator(mode="after")
    def _ranges(self) -> "AppSettings":
        if self.temp_min >= self.temp_max:
            raise ValueError("Ngưỡng nhiệt độ tối thiểu phải nhỏ hơn tối đa.")
        if self.humidity_min >= self.humidity_max:
            raise ValueError("Ngưỡng độ ẩm tối thiểu phải nhỏ hơn tối đa.")
        return self


class SettingsPatch(BaseModel):
    """Cập nhật một phần: chỉ các khóa được gửi lên mới thay đổi."""

    model_config = {"extra": "forbid"}

    camera_device_id: str | None = None
    temp_min: float | None = None
    temp_max: float | None = None
    humidity_min: float | None = None
    humidity_max: float | None = None
    expiry_warning_days: int | None = None
    low_stock_threshold: float | None = None
    esp32_enabled: bool | None = None
    esp32_mode: Literal["http", "websocket"] | None = None
    esp32_host: str | None = None
    esp32_port: int | None = None
    esp32_path: str | None = None
    esp32_poll_seconds: int | None = None
    esp32_timeout_seconds: float | None = None
    esp32_stale_seconds: int | None = None
    esp32_token: str | None = None
    ocr_engine: OcrEngineName | None = None
    ocr_profile: OcrProfileName | None = None
    ocr_device: OcrDeviceName | None = None
    ocr_det_limit_side_len: int | None = None
    ocr_auto_enhance: bool | None = None
    ocr_use_textline_orientation: bool | None = None
    ocr_cpu_threads: int | None = None
    ocr_save_scan_images: bool | None = None
    notify_environment: bool | None = None
    notify_reminders: bool | None = None
    notify_windows: bool | None = None
    sound_enabled: bool | None = None
    minimize_to_tray: bool | None = None
    tts_enabled: bool | None = None
    tts_voice: str | None = None
    tts_rate: float | None = None
    theme: Literal["light", "dark", "system"] | None = None
    language: Literal["vi", "en"] | None = None
    catalog_source_path: str | None = None
    profile_name: str | None = None
    profile_email: str | None = None
    profile_role: str | None = None
