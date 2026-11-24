"""Thiết bị ESP32 (kênh Admin): trạng thái, số đo, quản lý thiết bị, lệnh điều khiển qua Internet + ACK."""
from __future__ import annotations

import uuid
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field
from sqlalchemy import select

from app.api.deps import bad_request, get_ctx, not_found
from app.auth.deps import client_ip, require
from app.auth.ratelimit import RateLimitExceeded
from app.auth.service import Principal, audit
from app.core import clock
from app.core.context import AppContext
from app.iot import actions
from app.iot.hub import command_public, device_public
from app.models import Device, DeviceCommand, DeviceCommandAck, FINAL_COMMAND_STATUSES
from app.services import history, settings_store
from app.services.alerts import engine as alert_engine

router = APIRouter(tags=["device"])
read_devices = require("devices:manage")
manage_devices = require("devices:manage")
send_commands = require("device:command")


class DeviceCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=80)
    note: str | None = Field(None, max_length=500)


class DevicePatch(BaseModel):
    name: str | None = Field(None, min_length=1, max_length=80)
    note: str | None = Field(None, max_length=500)
    is_active: bool | None = None
    is_primary: bool | None = None


class CommandCreate(BaseModel):
    action: str = Field(..., min_length=1, max_length=40, pattern=r"^[a-z0-9_]+$")
    payload: dict[str, Any] = Field(default_factory=dict)
    ttl_seconds: int | None = Field(None, ge=10, le=3600)


def _connection_info(ctx: AppContext) -> dict[str, Any]:
    base = (ctx.settings.public_base_url or "").rstrip("/")
    ws = (base.replace("https://", "wss://").replace("http://", "ws://") + "/api/v1/device/ws") if base else None
    return {"websocket_url": ws, "public_base_url": base or None,
            "note": None if base else "Chưa cấu hình SMC_PUBLIC_BASE_URL (địa chỉ Tailscale Funnel hoặc Cloudflare Tunnel) trên máy chủ."}


def _device(s, device_id: uuid.UUID) -> Device:
    device = s.get(Device, device_id)
    if device is None:
        raise not_found("Không tìm thấy thiết bị.")
    return device


# --------------------------------------------------------------------------- #
# Trạng thái tủ chính (tương thích màn hình Trang chủ / Môi trường)
# --------------------------------------------------------------------------- #
@router.get("/device/status")
def status(ctx: AppContext = Depends(get_ctx), _: Principal = Depends(read_devices)) -> dict:
    snapshot = ctx.devices.snapshot()
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


@router.get("/device/readings")
def readings(
    hours: int = Query(24, ge=1, le=24 * 90), device_id: uuid.UUID | None = None,
    ctx: AppContext = Depends(get_ctx), _: Principal = Depends(read_devices),
) -> dict:
    return {"hours": hours, "items": ctx.devices.recent_readings(hours, device_id)}


@router.get("/device/actions")
def action_catalog(_: Principal = Depends(read_devices)) -> dict:
    return {"items": actions.catalog()}


# --------------------------------------------------------------------------- #
# Quản lý thiết bị
# --------------------------------------------------------------------------- #
@router.get("/devices")
def list_devices(ctx: AppContext = Depends(get_ctx), _: Principal = Depends(read_devices)) -> dict:
    with ctx.db.session() as s:
        rows = s.scalars(select(Device).order_by(Device.is_primary.desc(), Device.created_at)).all()
        return {"items": [device_public(d, ctx.devices.is_online(d.id)) for d in rows], "connection": _connection_info(ctx)}


@router.post("/devices", status_code=201)
def create_device(body: DeviceCreate, request: Request, ctx: AppContext = Depends(get_ctx),
                  principal: Principal = Depends(manage_devices)) -> dict:
    with ctx.db.session() as s:
        device, token = ctx.devices.create_device(s, name=body.name, created_by=principal.user_id, note=body.note)
        audit(s, "device.create", channel="admin", user_id=principal.user_id, actor=principal.email,
              resource_type="device", resource_id=str(device.id), ip=client_ip(request), detail={"name": device.name})
        history.record(s, "device", "device_create", "Thêm thiết bị", f"Đã thêm thiết bị {device.name}", {"device_id": str(device.id)})
        data = device_public(device, False)
    # Token chỉ hiển thị MỘT lần; máy chủ chỉ lưu băm SHA-256.
    return {"device": data, "token": token, "connection": _connection_info(ctx)}


@router.get("/devices/{device_id}")
def get_device(device_id: uuid.UUID, ctx: AppContext = Depends(get_ctx), _: Principal = Depends(read_devices)) -> dict:
    with ctx.db.session() as s:
        device = _device(s, device_id)
        return {"device": device_public(device, ctx.devices.is_online(device.id)), "snapshot": ctx.devices.snapshot(device.id),
                "connection": _connection_info(ctx)}


@router.patch("/devices/{device_id}")
async def update_device(device_id: uuid.UUID, body: DevicePatch, request: Request, ctx: AppContext = Depends(get_ctx),
                        principal: Principal = Depends(manage_devices)) -> dict:
    changes = body.model_dump(exclude_unset=True)
    deactivated = False
    with ctx.db.session() as s:
        device = _device(s, device_id)
        if "name" in changes and changes["name"]:
            device.name = changes["name"].strip()
        if "note" in changes:
            device.note = changes["note"]
        if "is_active" in changes and changes["is_active"] is not None:
            deactivated = device.is_active and not changes["is_active"]
            device.is_active = bool(changes["is_active"])
        if changes.get("is_primary"):
            ctx.devices.set_primary(s, device)
        device.updated_at = clock.now()
        audit(s, "device.update", channel="admin", user_id=principal.user_id, actor=principal.email,
              resource_type="device", resource_id=str(device.id), ip=client_ip(request), detail=changes)
        data = device_public(device, ctx.devices.is_online(device.id))
    if deactivated:
        await ctx.devices.disconnect(device_id, "deactivated")
    return {"device": data}


@router.post("/devices/{device_id}/token")
async def rotate_token(device_id: uuid.UUID, request: Request, ctx: AppContext = Depends(get_ctx),
                       principal: Principal = Depends(manage_devices)) -> dict:
    with ctx.db.session() as s:
        device = _device(s, device_id)
        token = ctx.devices.rotate_token(s, device)
        audit(s, "device.rotate_token", channel="admin", user_id=principal.user_id, actor=principal.email,
              resource_type="device", resource_id=str(device.id), ip=client_ip(request))
        data = device_public(device, False)
    await ctx.devices.disconnect(device_id, "token rotated")  # token cũ hết hiệu lực ngay
    return {"device": data, "token": token, "connection": _connection_info(ctx)}


@router.delete("/devices/{device_id}")
async def delete_device(device_id: uuid.UUID, request: Request, ctx: AppContext = Depends(get_ctx),
                        principal: Principal = Depends(manage_devices)) -> dict:
    await ctx.devices.disconnect(device_id, "deleted")
    with ctx.db.session() as s:
        device = _device(s, device_id)
        name = device.name
        audit(s, "device.delete", channel="admin", user_id=principal.user_id, actor=principal.email,
              resource_type="device", resource_id=str(device_id), ip=client_ip(request), detail={"name": name})
        s.delete(device)
        history.record(s, "device", "device_delete", "Xóa thiết bị", f"Đã xóa thiết bị {name}", {"device_id": str(device_id)})
    return {"deleted": True}


@router.get("/devices/{device_id}/telemetry")
def device_telemetry(device_id: uuid.UUID, hours: int = Query(24, ge=1, le=24 * 90), ctx: AppContext = Depends(get_ctx),
                     _: Principal = Depends(read_devices)) -> dict:
    return {"hours": hours, "items": ctx.devices.recent_readings(hours, device_id)}


# --------------------------------------------------------------------------- #
# Lệnh điều khiển
# --------------------------------------------------------------------------- #
@router.get("/devices/{device_id}/commands")
def list_commands(device_id: uuid.UUID, limit: int = Query(30, ge=1, le=200), ctx: AppContext = Depends(get_ctx),
                  _: Principal = Depends(read_devices)) -> dict:
    with ctx.db.session() as s:
        rows = s.scalars(
            select(DeviceCommand).where(DeviceCommand.device_id == device_id).order_by(DeviceCommand.created_at.desc()).limit(limit)
        ).all()
        return {"items": [command_public(c) for c in rows]}


@router.post("/devices/{device_id}/commands", status_code=202)
async def send_command(device_id: uuid.UUID, body: CommandCreate, request: Request, ctx: AppContext = Depends(get_ctx),
                       principal: Principal = Depends(send_commands)) -> dict:
    try:
        ctx.limiter.hit("device_command_user", str(principal.user_id))
    except RateLimitExceeded as exc:
        raise HTTPException(429, str(exc), headers={"Retry-After": str(exc.retry_after)}) from exc
    with ctx.db.session() as s:
        device = _device(s, device_id)
        try:
            cmd = ctx.devices.create_command(s, device=device, action=body.action, payload=body.payload,
                                             user_id=principal.user_id, ttl_seconds=body.ttl_seconds)
        except actions.CommandRejected as exc:
            audit(s, "device.command", channel="admin", user_id=principal.user_id, actor=principal.email,
                  resource_type="device", resource_id=str(device_id), success=False, ip=client_ip(request),
                  detail={"action": body.action, "error": str(exc)})
            s.commit()
            raise bad_request(str(exc)) from exc
        audit(s, "device.command", channel="admin", user_id=principal.user_id, actor=principal.email,
              resource_type="device_command", resource_id=str(cmd.id), ip=client_ip(request),
              detail={"device_id": str(device_id), "action": cmd.action, "payload": cmd.payload})
        command_id = cmd.id
    delivered = await ctx.devices.dispatch(command_id)
    with ctx.db.session() as s:
        cmd = s.get(DeviceCommand, command_id)
        data = command_public(cmd)
    data["delivered"] = delivered
    if not delivered:
        data["note"] = "Thiết bị đang ngoại tuyến — lệnh sẽ được gửi khi thiết bị kết nối lại (nếu chưa hết hạn)."
    return data


@router.get("/commands/{command_id}")
def get_command(command_id: uuid.UUID, ctx: AppContext = Depends(get_ctx), _: Principal = Depends(read_devices)) -> dict:
    with ctx.db.session() as s:
        cmd = s.get(DeviceCommand, command_id)
        if cmd is None:
            raise not_found("Không tìm thấy lệnh.")
        acks = s.scalars(select(DeviceCommandAck).where(DeviceCommandAck.command_id == cmd.id).order_by(DeviceCommandAck.id)).all()
        return command_public(cmd, list(acks))


@router.post("/commands/{command_id}/cancel")
def cancel_command(command_id: uuid.UUID, request: Request, ctx: AppContext = Depends(get_ctx),
                   principal: Principal = Depends(send_commands)) -> dict:
    with ctx.db.session() as s:
        cmd = s.get(DeviceCommand, command_id)
        if cmd is None:
            raise not_found("Không tìm thấy lệnh.")
        if cmd.status in FINAL_COMMAND_STATUSES:
            raise bad_request("Lệnh đã kết thúc, không hủy được.")
        if cmd.status == "acknowledged":
            raise bad_request("Thiết bị đã nhận lệnh, không hủy được nữa.")
        cmd.status, cmd.completed_at, cmd.error = "cancelled", clock.now(), "Đã hủy bởi quản trị viên."
        audit(s, "device.command_cancel", channel="admin", user_id=principal.user_id, actor=principal.email,
              resource_type="device_command", resource_id=str(cmd.id), ip=client_ip(request))
        return command_public(cmd)


@router.post("/device/refresh")
async def refresh(ctx: AppContext = Depends(get_ctx), principal: Principal = Depends(send_commands)) -> dict:
    """Yêu cầu tủ chính gửi số đo ngay (lệnh read_now) nếu thiết bị hỗ trợ."""
    with ctx.db.session() as s:
        device = ctx.devices.primary_device(s)
        if device is None:
            raise bad_request("Chưa có thiết bị nào.")
        try:
            cmd = ctx.devices.create_command(s, device=device, action="read_now", payload={}, user_id=principal.user_id, ttl_seconds=30)
        except actions.CommandRejected as exc:
            raise bad_request(str(exc)) from exc
        command_id = cmd.id
    await ctx.devices.dispatch(command_id)
    return ctx.devices.snapshot()
