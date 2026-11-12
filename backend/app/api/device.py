"""Thiết bị tủ thuốc (ESP32): trạng thái, thử kết nối, lịch sử số đo, lệnh."""
from __future__ import annotations

from typing import Any, Literal

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, Field

from app.api.deps import bad_request, get_ctx
from app.core.context import AppContext
from app.services import settings_store
from app.services.alerts import engine as alert_engine
from app.services.esp32.adapter import DeviceConfig, DeviceError

router = APIRouter(prefix="/device", tags=["device"])


class DeviceTest(BaseModel):
    mode: Literal["http", "websocket"] = "http"
    host: str = Field(..., max_length=255)
    port: int = Field(80, ge=1, le=65535)
    path: str = Field("/api/status", max_length=200)
    timeout: float = Field(3.0, ge=0.5, le=30)
    token: str | None = Field(None, max_length=200)


class DeviceCommand(BaseModel):
    command: str = Field(..., min_length=1, max_length=40, pattern=r"^[a-z0-9_]+$")
    value: Any = None


@router.get("/status")
def status(ctx: AppContext = Depends(get_ctx)) -> dict:
    snapshot = ctx.device.snapshot()
    with ctx.db.session() as s:
        settings = settings_store.load_settings(s)
        unhandled = alert_engine.unhandled_count(s)
    environment = alert_engine.environment_status(snapshot, settings)
    return {
        **snapshot,
        "environment": environment,
        "thresholds": {
            "temp_min": settings.temp_min, "temp_max": settings.temp_max,
            "humidity_min": settings.humidity_min, "humidity_max": settings.humidity_max,
        },
        "unhandled_alerts": unhandled,
    }


@router.post("/refresh")
async def refresh(ctx: AppContext = Depends(get_ctx)) -> dict:
    """Đọc thiết bị ngay (không chờ chu kỳ kế tiếp)."""
    await ctx.device.poll_once()
    return ctx.device.snapshot()


@router.post("/test")
async def test(body: DeviceTest, ctx: AppContext = Depends(get_ctx)) -> dict:
    return await ctx.device.test(
        DeviceConfig(mode=body.mode, host=body.host, port=body.port, path=body.path, timeout=body.timeout, token=body.token)
    )


@router.get("/readings")
def readings(hours: int = Query(24, ge=1, le=24 * 30), ctx: AppContext = Depends(get_ctx)) -> dict:
    return {"hours": hours, "items": ctx.device.recent_readings(hours)}


@router.post("/command")
async def command(body: DeviceCommand, ctx: AppContext = Depends(get_ctx)) -> dict:
    """Chỉ gửi lệnh mà chính thiết bị khai báo trong `capabilities`."""
    try:
        return {"ok": True, "response": await ctx.device.send_command(body.command, body.value)}
    except DeviceError as exc:
        raise bad_request(str(exc)) from exc
