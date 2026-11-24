"""Danh mục lệnh điều khiển ESP32 mà máy chủ chấp nhận.

Chỉ gồm các chức năng phần cứng thật sự có trên mạch mẫu (cảm biến DHT22 + còi) và được
firmware ``firmware/esp32_cabinet`` khai báo trong ``capabilities``. Một lệnh chỉ được gửi khi
CẢ máy chủ (danh mục này) VÀ chính thiết bị (capabilities) đều hỗ trợ.
"""
from __future__ import annotations

from typing import Any

from pydantic import BaseModel, ConfigDict, Field, ValidationError, model_validator


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class BuzzerPayload(_Strict):
    on: bool
    duration_s: int | None = Field(None, ge=1, le=300, description="Tự tắt sau N giây (chỉ khi bật)")


class EmptyPayload(_Strict):
    pass


class ThresholdPayload(_Strict):
    temp_min: float = Field(..., ge=-20, le=60)
    temp_max: float = Field(..., ge=-20, le=60)
    humidity_min: float = Field(..., ge=0, le=100)
    humidity_max: float = Field(..., ge=0, le=100)

    @model_validator(mode="after")
    def _order(self) -> "ThresholdPayload":
        if self.temp_min >= self.temp_max or self.humidity_min >= self.humidity_max:
            raise ValueError("Ngưỡng tối thiểu phải nhỏ hơn ngưỡng tối đa.")
        return self


class AlarmPayload(_Strict):
    enabled: bool


class IntervalPayload(_Strict):
    seconds: int = Field(..., ge=5, le=3600)


ACTIONS: dict[str, dict[str, Any]] = {
    "buzzer": {"label": "Bật/tắt còi", "model": BuzzerPayload},
    "read_now": {"label": "Đọc cảm biến ngay", "model": EmptyPayload},
    "set_thresholds": {"label": "Cập nhật ngưỡng cảnh báo cục bộ", "model": ThresholdPayload},
    "set_alarm": {"label": "Bật/tắt còi cảnh báo tự động khi vượt ngưỡng", "model": AlarmPayload},
    "set_interval": {"label": "Đổi chu kỳ gửi số đo", "model": IntervalPayload},
}


class CommandRejected(ValueError):
    pass


def validate_action(action: str, payload: dict[str, Any] | None, capabilities: list[str] | None) -> dict[str, Any]:
    """Kiểm tra lệnh; trả về payload đã chuẩn hóa hoặc ném CommandRejected (thông báo tiếng Việt)."""
    spec = ACTIONS.get(action)
    if spec is None:
        raise CommandRejected(f"Máy chủ không hỗ trợ lệnh “{action}”.")
    if action not in (capabilities or []):
        raise CommandRejected(f"Thiết bị không khai báo hỗ trợ lệnh “{action}” (cập nhật firmware hoặc chờ thiết bị kết nối).")
    try:
        model = spec["model"](**(payload or {}))
    except ValidationError as exc:
        first = exc.errors()[0]
        field = ".".join(str(p) for p in first.get("loc", ()))
        msg = str(first.get("msg", "không hợp lệ")).replace("Value error, ", "")
        raise CommandRejected(f"Tham số lệnh không hợp lệ{(' (' + field + ')') if field else ''}: {msg}") from exc
    data = model.model_dump(exclude_none=True)
    return data


def catalog() -> list[dict[str, Any]]:
    return [{"action": k, "label": v["label"], "schema": v["model"].model_json_schema()} for k, v in ACTIONS.items()]
