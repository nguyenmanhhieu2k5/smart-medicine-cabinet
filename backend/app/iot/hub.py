"""IoT hub: ESP32 tự kết nối RA NGOÀI tới Mini PC qua WSS (Tailscale Funnel hoặc Cloudflare Tunnel) — không cần chung Wi-Fi.

Giao thức (JSON, mỗi bản tin một khung văn bản) — xem docs/ESP32_PROTOCOL.md:

thiết bị → máy chủ
  {"type":"hello","firmware":"2.0.0","capabilities":["buzzer","read_now",...],"state":{...}}
  {"type":"telemetry","temperature":26.4,"humidity":58,"sensor_ok":true,"buzzer_on":false,"uptime_ms":...}
  {"type":"ack","command_id":"<uuid>","status":"received|applied|failed","message":"...","result":{...}}
  {"type":"pong"}
máy chủ → thiết bị
  {"type":"welcome","device_id":"...","server_time":"...","thresholds":{...}}
  {"type":"command","command_id":"<uuid>","action":"buzzer","payload":{"on":true},"expires_in_s":55}
  {"type":"ping"}

Lệnh chỉ được coi là thành công khi chính thiết bị gửi ACK "applied" — không bao giờ chỉ vì máy chủ đã gửi đi.
"""
from __future__ import annotations

import asyncio
import json
import logging
import math
import time
import uuid
from collections import deque
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Any

from sqlalchemy import delete, exists, select, update
from sqlalchemy.orm import Session
from starlette.websockets import WebSocket, WebSocketDisconnect, WebSocketState

from app.auth import tokens
from app.auth.service import audit
from app.core import clock
from app.core.config import Settings
from app.database.session import Database, iso_local
from app.iot.actions import ACTIONS, CommandRejected, validate_action
from app.models import Device, DeviceCommand, DeviceCommandAck, DeviceTelemetry, FINAL_COMMAND_STATUSES
from app.services import history, settings_store
from app.services.alerts import engine as alert_engine

log = logging.getLogger("smc.iot")

STORE_EVERY = timedelta(seconds=60)  # lưu tối đa một số đo mỗi phút cho mỗi thiết bị
KEEP_TELEMETRY = timedelta(days=90)
PING_INTERVAL = 20.0  # < 100 s để proxy (Cloudflare…) không cắt kết nối WebSocket nhàn rỗi
MAINTENANCE_INTERVAL = 5.0
MAX_MESSAGE_BYTES = 8192
MAX_MESSAGES_PER_10S = 60
ACTIVE_COMMAND_STATUSES = ("pending", "sent", "acknowledged")

_TEMP_KEYS = ("temperature", "temperature_c", "temp", "temp_c", "t")
_HUM_KEYS = ("humidity", "humidity_percent", "hum", "rh", "h")


def _number(value: Any, low: float, high: float) -> float | None:
    if isinstance(value, bool) or value is None:
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if math.isnan(number) or math.isinf(number) or not (low <= number <= high):
        return None  # ngoài khoảng vật lý → coi như không có số đo
    return round(number, 1)


def parse_reading(msg: dict[str, Any]) -> tuple[float | None, float | None]:
    sources = [msg] + [msg[k] for k in ("sensors", "data", "reading") if isinstance(msg.get(k), dict)]
    temp = hum = None
    for src in sources:
        if temp is None:
            temp = next((v for v in (_number(src.get(k), -40, 85) for k in _TEMP_KEYS if k in src) if v is not None), None)
        if hum is None:
            hum = next((v for v in (_number(src.get(k), 0, 100) for k in _HUM_KEYS if k in src) if v is not None), None)
    return temp, hum


def device_public(device: Device, live: bool) -> dict[str, Any]:
    return {
        "id": str(device.id),
        "name": device.name,
        "token_hint": "…" + device.token_hint,
        "firmware": device.firmware,
        "capabilities": list(device.capabilities or []),
        "supported_actions": [a for a in (device.capabilities or []) if a in ACTIONS],
        "is_active": device.is_active,
        "is_primary": device.is_primary,
        "online": live,
        "last_seen_at": iso_local(device.last_seen_at),
        "last_ip": device.last_ip,
        "last_state": device.last_state,
        "note": device.note,
        "created_at": iso_local(device.created_at),
    }


def command_public(cmd: DeviceCommand, acks: list[DeviceCommandAck] | None = None) -> dict[str, Any]:
    data = {
        "id": str(cmd.id),
        "device_id": str(cmd.device_id),
        "action": cmd.action,
        "action_label": ACTIONS.get(cmd.action, {}).get("label", cmd.action),
        "payload": cmd.payload,
        "status": cmd.status,
        "created_at": iso_local(cmd.created_at),
        "expires_at": iso_local(cmd.expires_at),
        "sent_at": iso_local(cmd.sent_at),
        "acknowledged_at": iso_local(cmd.acknowledged_at),
        "completed_at": iso_local(cmd.completed_at),
        "attempts": cmd.attempts,
        "error": cmd.error,
        "result": cmd.result,
        "final": cmd.status in FINAL_COMMAND_STATUSES,
    }
    if acks is not None:
        data["acks"] = [
            {"status": a.status, "message": a.message, "payload": a.payload, "received_at": iso_local(a.received_at)} for a in acks
        ]
    return data


@dataclass
class LiveConnection:
    device_id: uuid.UUID
    websocket: WebSocket
    ip: str | None
    connected_at: datetime
    last_message_at: datetime
    loop: asyncio.AbstractEventLoop | None = None  # vòng lặp sở hữu socket (mọi thao tác gửi/đóng phải chạy ở đó)
    send_lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    recent: deque = field(default_factory=lambda: deque(maxlen=MAX_MESSAGES_PER_10S + 1))
    last_ping: float = field(default_factory=time.monotonic)

    async def run_in_owner_loop(self, coro_factory):  # noqa: ANN001, ANN201
        """Chạy coroutine trên vòng lặp của socket (an toàn khi gọi từ vòng lặp/luồng khác)."""
        try:
            current = asyncio.get_running_loop()
        except RuntimeError:  # pragma: no cover
            current = None
        if self.loop is None or self.loop is current:
            return await coro_factory()
        future = asyncio.run_coroutine_threadsafe(coro_factory(), self.loop)
        return await asyncio.wrap_future(future)


class DeviceHub:
    def __init__(self, db: Database, settings: Settings):
        self.db = db
        self.settings = settings
        self._live: dict[uuid.UUID, LiveConnection] = {}
        self._telemetry: dict[uuid.UUID, dict[str, Any]] = {}
        self._last_stored: dict[uuid.UUID, datetime] = {}
        self._started_at = clock.now()
        self._task: asyncio.Task[None] | None = None
        self._last_cleanup = 0.0

    @property
    def stale_after(self) -> timedelta:
        return timedelta(seconds=self.settings.device_stale_seconds)

    def is_online(self, device_id: uuid.UUID) -> bool:
        return device_id in self._live

    # ------------------------------------------------------------------ #
    # Quản lý thiết bị (đồng bộ, dùng trong session của API quản trị)
    # ------------------------------------------------------------------ #
    def create_device(self, s: Session, *, name: str, created_by: uuid.UUID | None, note: str | None = None) -> tuple[Device, str]:
        token = tokens.new_device_token()
        now = clock.now()
        has_primary = s.scalar(select(exists().where(Device.is_primary.is_(True))))
        device = Device(
            name=name.strip()[:80], token_hash=tokens.sha256_hex(token), token_hint=token[-6:], capabilities=[],
            is_active=True, is_primary=not has_primary, created_by=created_by, created_at=now, updated_at=now, note=note,
        )
        s.add(device)
        s.flush()
        return device, token

    def rotate_token(self, s: Session, device: Device) -> str:
        token = tokens.new_device_token()
        device.token_hash, device.token_hint, device.updated_at = tokens.sha256_hex(token), token[-6:], clock.now()
        return token

    def set_primary(self, s: Session, device: Device) -> None:
        s.execute(update(Device).where(Device.id != device.id, Device.is_primary.is_(True)).values(is_primary=False))
        s.flush()
        device.is_primary = True

    def _auth(self, token: str | None) -> Device | None:
        if not token or not token.startswith("smcdev_"):
            return None
        with self.db.session() as s:
            device = s.scalar(select(Device).where(Device.token_hash == tokens.sha256_hex(token)))
            return device if device is not None and device.is_active else None

    def primary_device(self, s: Session) -> Device | None:
        device = s.scalar(select(Device).where(Device.is_primary.is_(True), Device.is_active.is_(True)))
        if device is None:
            device = s.scalar(select(Device).where(Device.is_active.is_(True)).order_by(Device.created_at).limit(1))
        return device

    async def disconnect(self, device_id: uuid.UUID, reason: str = "revoked") -> None:
        live = self._live.get(device_id)
        if live is not None:
            await self._close(live, 4403, reason)

    # ------------------------------------------------------------------ #
    # Kết nối WebSocket của thiết bị
    # ------------------------------------------------------------------ #
    async def serve(self, websocket: WebSocket, ip: str | None) -> None:
        header = websocket.headers.get("authorization", "")
        token = header[7:].strip() if header[:7].lower() == "bearer " else websocket.query_params.get("token")
        device = await asyncio.to_thread(self._auth, token)
        if device is None:
            await asyncio.to_thread(self._audit_rejected, ip)
            await websocket.close(code=1008)  # trước accept → bắt tay bị từ chối (HTTP 403)
            return
        await websocket.accept()
        previous = self._live.get(device.id)
        if previous is not None:  # kết nối mới thay thế kết nối cũ (thiết bị khởi động lại)
            await self._close(previous, 4000, "replaced")
        now = clock.now()
        live = LiveConnection(device_id=device.id, websocket=websocket, ip=ip, connected_at=now, last_message_at=now,
                              loop=asyncio.get_running_loop())
        self._live[device.id] = live
        await asyncio.to_thread(self._mark_online, device.id, ip)
        try:
            thresholds = await asyncio.to_thread(self._thresholds)
            await self._send(live, {
                "type": "welcome", "device_id": str(device.id), "name": device.name,
                "server_time": iso_local(clock.now()), "thresholds": thresholds,
                "ping_interval_s": int(PING_INTERVAL),
            })
            while True:
                message = await websocket.receive()
                if message["type"] == "websocket.disconnect":
                    break
                raw = message.get("text")
                if raw is None and message.get("bytes") is not None:
                    raw = message["bytes"].decode("utf-8", errors="replace")
                if raw is None:
                    continue
                if len(raw) > MAX_MESSAGE_BYTES:
                    await websocket.close(code=1009)
                    break
                stamp = time.monotonic()
                live.recent.append(stamp)
                if len(live.recent) > MAX_MESSAGES_PER_10S and stamp - live.recent[0] < 10:
                    await websocket.close(code=1008, reason="rate limit")
                    break
                live.last_message_at = clock.now()
                await self._handle(live, raw)
        except WebSocketDisconnect:
            pass
        except Exception:  # noqa: BLE001
            log.exception("Lỗi kết nối thiết bị %s", device.id)
        finally:
            if self._live.get(device.id) is live:
                del self._live[device.id]
                await asyncio.to_thread(self._mark_offline, device.id)

    async def _send(self, live: LiveConnection, payload: dict[str, Any]) -> bool:
        text = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))

        async def _do() -> bool:
            if live.websocket.application_state != WebSocketState.CONNECTED:
                return False
            async with live.send_lock:
                try:
                    await live.websocket.send_text(text)
                    return True
                except Exception:  # noqa: BLE001
                    return False

        try:
            return await live.run_in_owner_loop(_do)
        except Exception:  # noqa: BLE001 — vòng lặp của socket đã đóng
            return False

    @staticmethod
    async def _close(live: LiveConnection, code: int, reason: str = "") -> None:
        async def _do() -> None:
            try:
                await live.websocket.close(code=code, reason=reason)
            except Exception:  # noqa: BLE001
                pass

        try:
            await live.run_in_owner_loop(_do)
        except Exception:  # noqa: BLE001
            pass

    async def _handle(self, live: LiveConnection, raw: str) -> None:
        try:
            msg = json.loads(raw)
        except ValueError:
            await self._send(live, {"type": "error", "message": "bad json"})
            return
        if not isinstance(msg, dict):
            return
        kind = msg.get("type")
        if kind == "hello":
            await asyncio.to_thread(self._apply_hello, live.device_id, msg)
            await self.resend_pending(live.device_id)
        elif kind == "telemetry":
            await asyncio.to_thread(self._apply_telemetry, live.device_id, msg)
        elif kind == "ack":
            await asyncio.to_thread(self._apply_ack, live.device_id, msg)
        elif kind == "ping":
            await self._send(live, {"type": "pong"})
        elif kind == "pong":
            pass
        else:
            await self._send(live, {"type": "error", "message": f"unknown type: {kind}"})

    # ---- xử lý bản tin (chạy trong luồng phụ) ------------------------ #
    def _thresholds(self) -> dict[str, float]:
        with self.db.session() as s:
            st = settings_store.load_settings(s)
        return {"temp_min": st.temp_min, "temp_max": st.temp_max, "humidity_min": st.humidity_min, "humidity_max": st.humidity_max}

    def _audit_rejected(self, ip: str | None) -> None:
        with self.db.session() as s:
            audit(s, "device.connect", channel="device", actor="device:unknown", success=False, ip=ip,
                  detail={"reason": "invalid_token"})

    def _mark_online(self, device_id: uuid.UUID, ip: str | None) -> None:
        with self.db.session() as s:
            device = s.get(Device, device_id)
            if device is None:
                return
            was_seen = device.last_seen_at
            device.last_seen_at, device.last_ip, device.updated_at = clock.now(), ip, clock.now()
            history.record(s, "device", "device_online", "Thiết bị kết nối", f"{device.name} đã kết nối tới máy chủ.",
                           {"device_id": str(device_id), "ip": ip, "first_time": was_seen is None})

    def _mark_offline(self, device_id: uuid.UUID) -> None:
        self._telemetry.pop(device_id, None)
        with self.db.session() as s:
            device = s.get(Device, device_id)
            if device is None:
                return
            device.last_seen_at = clock.now()
            history.record(s, "device", "device_offline", "Thiết bị mất kết nối", f"{device.name} đã ngắt kết nối.",
                           {"device_id": str(device_id)})
        self.evaluate_alerts()

    def _apply_hello(self, device_id: uuid.UUID, msg: dict[str, Any]) -> None:
        caps = msg.get("capabilities") or []
        capabilities = [str(c)[:40] for c in caps if isinstance(c, str)][:32]
        with self.db.session() as s:
            device = s.get(Device, device_id)
            if device is None:
                return
            device.capabilities = capabilities
            if isinstance(msg.get("firmware"), str):
                device.firmware = msg["firmware"][:32]
            if isinstance(msg.get("state"), dict):
                device.last_state = msg["state"]
            device.last_seen_at = device.updated_at = clock.now()

    def _apply_telemetry(self, device_id: uuid.UUID, msg: dict[str, Any]) -> None:
        now = clock.now()
        temp, hum = parse_reading(msg)
        sensor_ok = msg.get("sensor_ok")
        simulated = bool(msg.get("simulated", False))
        extra = {k: msg[k] for k in ("buzzer_on", "alarm_enabled", "uptime_ms", "rssi", "local_alarm", "interval_s") if k in msg}
        self._telemetry[device_id] = {
            "temperature": temp, "humidity": hum, "sensor_ok": sensor_ok if isinstance(sensor_ok, bool) else None,
            "simulated": simulated, "updated_at": now, "extra": extra,
        }
        last = self._last_stored.get(device_id)
        store = (temp is not None or hum is not None) and (last is None or now - last >= STORE_EVERY)
        with self.db.session() as s:
            device = s.get(Device, device_id)
            if device is not None:
                device.last_seen_at = now
                if extra:
                    device.last_state = {**(device.last_state or {}), **extra}
            if store:
                s.add(DeviceTelemetry(device_id=device_id, recorded_at=now, temperature=temp, humidity=hum,
                                      sensor_ok=sensor_ok if isinstance(sensor_ok, bool) else None,
                                      simulated=simulated, extra=extra or None))
                self._last_stored[device_id] = now
        self.evaluate_alerts()

    def _apply_ack(self, device_id: uuid.UUID, msg: dict[str, Any]) -> None:
        status = msg.get("status")
        try:
            command_id = uuid.UUID(str(msg.get("command_id")))
        except ValueError:
            return
        if status not in ("received", "applied", "failed"):
            return
        now = clock.now()
        with self.db.session() as s:
            cmd = s.get(DeviceCommand, command_id)
            if cmd is None or cmd.device_id != device_id:
                log.warning("ACK cho lệnh không thuộc thiết bị %s: %s", device_id, command_id)
                return
            message = str(msg.get("message"))[:500] if msg.get("message") is not None else None
            result = msg.get("result") if isinstance(msg.get("result"), dict) else None
            s.add(DeviceCommandAck(command_id=cmd.id, status=status, message=message, payload=result, received_at=now))
            if status == "received":
                if cmd.status in ("pending", "sent"):
                    cmd.status, cmd.acknowledged_at = "acknowledged", now
            elif cmd.status not in ("applied", "failed", "cancelled"):
                late = cmd.status == "timed_out"
                cmd.status = "applied" if status == "applied" else "failed"
                cmd.completed_at = now
                cmd.acknowledged_at = cmd.acknowledged_at or now
                cmd.result = {**(result or {}), **({"late": True} if late else {})} or None
                if status == "failed":
                    cmd.error = message or "Thiết bị báo không thực hiện được lệnh."
                label = ACTIONS.get(cmd.action, {}).get("label", cmd.action)
                history.record(
                    s, "device", f"command_{cmd.status}",
                    "Thiết bị đã thực hiện lệnh" if cmd.status == "applied" else "Thiết bị không thực hiện được lệnh",
                    label + (f" — {cmd.error}" if cmd.status == "failed" else ""),
                    {"command_id": str(cmd.id), "device_id": str(device_id), "action": cmd.action},
                )

    # ------------------------------------------------------------------ #
    # Lệnh
    # ------------------------------------------------------------------ #
    def create_command(
        self, s: Session, *, device: Device, action: str, payload: dict[str, Any] | None,
        user_id: uuid.UUID | None, ttl_seconds: int | None = None,
    ) -> DeviceCommand:
        if not device.is_active:
            raise CommandRejected("Thiết bị đã bị vô hiệu hóa.")
        clean = validate_action(action, payload, device.capabilities)
        now = clock.now()
        ttl = max(10, min(int(ttl_seconds or self.settings.command_ttl_seconds), 3600))
        cmd = DeviceCommand(
            device_id=device.id, action=action, payload=clean, status="pending", created_by=user_id,
            created_at=now, expires_at=now + timedelta(seconds=ttl), attempts=0,
        )
        s.add(cmd)
        s.flush()
        return cmd

    async def dispatch(self, command_id: uuid.UUID) -> bool:
        """Gửi lệnh nếu thiết bị đang kết nối. Trả về True nếu đã ghi được xuống socket."""
        cmd = await asyncio.to_thread(self._load_command, command_id)
        if cmd is None or cmd.status not in ("pending", "sent") or cmd.expires_at <= clock.now():
            return False
        live = self._live.get(cmd.device_id)
        if live is None:
            return False
        remaining = max(1, int((cmd.expires_at - clock.now()).total_seconds()))
        ok = await self._send(live, {
            "type": "command", "command_id": str(cmd.id), "action": cmd.action, "payload": cmd.payload,
            "expires_in_s": remaining,
        })
        if ok:
            await asyncio.to_thread(self._mark_sent, cmd.id)
        return ok

    def _load_command(self, command_id: uuid.UUID) -> DeviceCommand | None:
        with self.db.session() as s:
            return s.get(DeviceCommand, command_id)

    def _mark_sent(self, command_id: uuid.UUID) -> None:
        with self.db.session() as s:
            cmd = s.get(DeviceCommand, command_id)
            if cmd is None:
                return
            cmd.attempts += 1
            if cmd.status == "pending":
                cmd.status, cmd.sent_at = "sent", clock.now()

    async def resend_pending(self, device_id: uuid.UUID) -> int:
        """Khi thiết bị (kết nối lại và) chào: gửi các lệnh còn hạn chưa được thiết bị xác nhận."""
        def _ids() -> list[uuid.UUID]:
            with self.db.session() as s:
                return list(s.scalars(
                    select(DeviceCommand.id).where(
                        DeviceCommand.device_id == device_id, DeviceCommand.status.in_(("pending", "sent")),
                        DeviceCommand.expires_at > clock.now(),
                    ).order_by(DeviceCommand.created_at)
                ).all())

        sent = 0
        for cid in await asyncio.to_thread(_ids):
            if await self.dispatch(cid):
                sent += 1
        return sent

    def expire_commands(self) -> int:
        now = clock.now()
        with self.db.session() as s:
            result = s.execute(
                update(DeviceCommand)
                .where(DeviceCommand.status.in_(ACTIVE_COMMAND_STATUSES), DeviceCommand.expires_at <= now)
                .values(status="timed_out", completed_at=now,
                        error="Hết thời gian chờ: thiết bị không xác nhận đã thực hiện lệnh.")
            )
            return result.rowcount or 0

    # ------------------------------------------------------------------ #
    # Trạng thái + cảnh báo môi trường (định dạng tương thích ứng dụng quản trị)
    # ------------------------------------------------------------------ #
    def snapshot(self, device_id: uuid.UUID | None = None) -> dict[str, Any]:
        with self.db.session() as s:
            device = s.get(Device, device_id) if device_id else self.primary_device(s)
            if device is None:
                return {
                    "enabled": False, "configured": False, "mode": "wss", "state": "disabled", "temperature": None,
                    "humidity": None, "last_update": None, "last_attempt": None, "last_error": None, "simulated": False,
                    "capabilities": [], "device": {}, "ever_connected": False, "address": None, "device_id": None,
                }
            now = clock.now()
            live = self._live.get(device.id)
            reading = self._telemetry.get(device.id)
            fresh = reading is not None and now - reading["updated_at"] <= self.stale_after
            last_error = None
            if live is not None:
                if fresh:
                    state = "connected"
                elif reading is None and now - live.connected_at <= self.stale_after:
                    state = "connecting"
                else:
                    state = "stale"
            elif now - self._started_at <= self.stale_after and device.last_seen_at is not None:
                state = "connecting"  # vừa khởi động máy chủ: chờ thiết bị kết nối lại
            else:
                state = "disconnected"
                last_error = (
                    f"Thiết bị ngoại tuyến từ {device.last_seen_at.strftime('%H:%M %d/%m/%Y')}." if device.last_seen_at
                    else "Thiết bị chưa từng kết nối tới máy chủ."
                )
            show = state == "connected" and reading is not None
            return {
                "enabled": device.is_active,
                "configured": True,
                "mode": "wss",
                "state": state if device.is_active else "disabled",
                "temperature": reading["temperature"] if show else None,
                "humidity": reading["humidity"] if show else None,
                "last_update": iso_local(reading["updated_at"]) if reading else None,
                "last_attempt": None,
                "last_error": last_error,
                "simulated": bool(reading and reading["simulated"]),
                "capabilities": list(device.capabilities or []),
                "device": {"id": str(device.id), "name": device.name, "firmware": device.firmware,
                           **((reading or {}).get("extra") or {})},
                "ever_connected": device.last_seen_at is not None,
                "address": device.last_ip,
                "device_id": str(device.id),
            }

    def evaluate_alerts(self) -> None:
        try:
            snap = self.snapshot()
            with self.db.session() as s:
                alert_engine.evaluate_environment(s, settings_store.load_settings(s), snap)
        except Exception:  # noqa: BLE001 — không để lỗi cảnh báo làm dừng hub
            log.exception("Không đánh giá được cảnh báo môi trường")

    def recent_readings(self, hours: int = 24, device_id: uuid.UUID | None = None) -> list[dict[str, Any]]:
        since = clock.now() - timedelta(hours=hours)
        with self.db.session() as s:
            device = s.get(Device, device_id) if device_id else self.primary_device(s)
            if device is None:
                return []
            rows = s.scalars(
                select(DeviceTelemetry).where(DeviceTelemetry.device_id == device.id, DeviceTelemetry.recorded_at >= since)
                .order_by(DeviceTelemetry.recorded_at)
            ).all()
            return [
                {"recorded_at": iso_local(r.recorded_at), "temperature": r.temperature, "humidity": r.humidity,
                 "simulated": r.simulated}
                for r in rows
            ]

    # ------------------------------------------------------------------ #
    # Vòng bảo trì nền
    # ------------------------------------------------------------------ #
    async def maintenance_once(self) -> None:
        await asyncio.to_thread(self.expire_commands)
        now = clock.now()
        for live in list(self._live.values()):
            if now - live.last_message_at > self.stale_after * 2:
                # Không có bản tin nào (kể cả pong) quá lâu → kết nối đã chết dù TCP chưa báo.
                await self._close(live, 4408, "idle")
                continue
            if time.monotonic() - live.last_ping >= PING_INTERVAL:
                live.last_ping = time.monotonic()
                await self._send(live, {"type": "ping"})
        await asyncio.to_thread(self.evaluate_alerts)
        if time.monotonic() - self._last_cleanup > 3600:
            self._last_cleanup = time.monotonic()
            await asyncio.to_thread(self._cleanup)

    def _cleanup(self) -> None:
        cutoff = clock.now() - KEEP_TELEMETRY
        with self.db.session() as s:
            s.execute(delete(DeviceTelemetry).where(DeviceTelemetry.recorded_at < cutoff))

    async def _run(self) -> None:
        while True:
            try:
                await self.maintenance_once()
            except asyncio.CancelledError:
                raise
            except Exception:  # noqa: BLE001
                log.exception("Lỗi vòng bảo trì thiết bị")
            await asyncio.sleep(MAINTENANCE_INTERVAL)

    def start(self) -> None:
        if self._task is None:
            self._task = asyncio.create_task(self._run(), name="device-hub")

    async def stop(self) -> None:
        if self._task is not None:
            self._task.cancel()
            try:
                await self._task
            except (asyncio.CancelledError, Exception):  # noqa: BLE001
                pass
            self._task = None
        for live in list(self._live.values()):
            await self._close(live, 1001, "server shutdown")
        self._live.clear()


__all__ = ["DeviceHub", "CommandRejected", "command_public", "device_public", "parse_reading"]
