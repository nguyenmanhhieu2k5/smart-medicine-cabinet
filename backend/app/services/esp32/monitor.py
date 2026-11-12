"""Theo dõi thiết bị nền: đọc định kỳ, lưu số đo thật, phát hiện mất kết nối."""
from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timedelta
from typing import Any, Callable

from sqlalchemy import delete, select

from app.core import clock
from app.database.session import Database
from app.models import SensorReading
from app.schemas.settings import AppSettings
from app.services import settings_store
from app.services.alerts import engine as alert_engine
from app.services.esp32.adapter import DeviceAdapter, DeviceConfig, DeviceError, WebSocketAdapter, create_adapter

log = logging.getLogger("smc.device")

STORE_EVERY = timedelta(seconds=60)  # lưu tối đa một số đo mỗi phút
KEEP_READINGS = timedelta(days=30)
FAILURES_BEFORE_DISCONNECT = 2


class DeviceMonitor:
    def __init__(self, db: Database, adapter_factory: Callable[[DeviceConfig], DeviceAdapter] = create_adapter):
        self.db = db
        self._adapter_factory = adapter_factory
        self._adapter: DeviceAdapter | None = None
        self._config: DeviceConfig | None = None
        self._enabled = False
        self._poll_seconds = 5
        self._stale_seconds = 30
        self._task: asyncio.Task[None] | None = None
        self._wake = asyncio.Event()
        self._failures = 0
        self._last_stored: datetime | None = None
        self._state: dict[str, Any] = self._blank_state()

    @staticmethod
    def _blank_state() -> dict[str, Any]:
        return {
            "enabled": False, "configured": False, "mode": "http", "state": "disabled",
            "temperature": None, "humidity": None, "last_update": None, "last_attempt": None,
            "last_error": None, "simulated": False, "capabilities": [], "device": {},
            "ever_connected": False, "address": None,
        }

    # ------------------------------------------------------------------ #
    def snapshot(self) -> dict[str, Any]:
        return dict(self._state)

    async def configure(self, settings: AppSettings) -> None:
        """Áp dụng cấu hình mới (gọi khi khởi động và mỗi lần cài đặt thay đổi)."""
        config = DeviceConfig(
            mode=settings.esp32_mode, host=settings.esp32_host, port=settings.esp32_port,
            path=settings.esp32_path, timeout=settings.esp32_timeout_seconds, token=settings.esp32_token,
        )
        changed = config != self._config or settings.esp32_enabled != self._enabled
        self._poll_seconds = settings.esp32_poll_seconds
        self._stale_seconds = settings.esp32_stale_seconds
        if not changed:
            return
        if self._adapter is not None:
            await self._adapter.close()
            self._adapter = None
        self._config = config
        self._enabled = settings.esp32_enabled
        self._failures = 0
        self._state = self._blank_state()
        self._state.update(enabled=self._enabled, configured=config.configured, mode=config.mode)
        if self._enabled and config.configured:
            self._state.update(state="connecting", address=config.base("ws" if config.mode == "websocket" else "http"))
            self._adapter = self._adapter_factory(config)
        elif self._enabled:
            self._state.update(state="disconnected", last_error="Chưa nhập địa chỉ thiết bị.")
        self._wake.set()

    # ------------------------------------------------------------------ #
    async def poll_once(self) -> dict[str, Any]:
        """Đọc thiết bị một lần và cập nhật trạng thái + cảnh báo."""
        now = clock.now()
        if not self._enabled or self._adapter is None:
            await asyncio.to_thread(self._evaluate_alerts)
            return self.snapshot()
        self._state["last_attempt"] = now.isoformat()
        try:
            reading = await self._adapter.read()
        except DeviceError as exc:
            self._failures += 1
            self._state["last_error"] = str(exc)
            if self._failures >= FAILURES_BEFORE_DISCONNECT or not self._state["ever_connected"]:
                # Không giữ lại số đo cũ như thể còn đang đo.
                self._state.update(state="disconnected", temperature=None, humidity=None)
            await asyncio.to_thread(self._evaluate_alerts)
            return self.snapshot()

        self._failures = 0
        stale = False
        if isinstance(self._adapter, WebSocketAdapter):
            age = self._adapter.seconds_since_message()
            stale = age is not None and age > self._stale_seconds
        self._state.update(
            state="stale" if stale else "connected",
            temperature=None if stale else reading.temperature,
            humidity=None if stale else reading.humidity,
            simulated=reading.simulated, capabilities=reading.capabilities, device=reading.device,
            last_error=None, ever_connected=True,
        )
        if not stale:
            self._state["last_update"] = now.isoformat()
            await asyncio.to_thread(self._store, now, reading.temperature, reading.humidity, reading.simulated)
        await asyncio.to_thread(self._evaluate_alerts)
        return self.snapshot()

    def _store(self, now: datetime, temperature: float | None, humidity: float | None, simulated: bool) -> None:
        if temperature is None and humidity is None:
            return
        if self._last_stored is not None and now - self._last_stored < STORE_EVERY:
            return
        with self.db.session() as s:
            s.add(SensorReading(recorded_at=now, temperature=temperature, humidity=humidity, simulated=simulated))
            s.execute(delete(SensorReading).where(SensorReading.recorded_at < now - KEEP_READINGS))
        self._last_stored = now

    def _evaluate_alerts(self) -> None:
        try:
            with self.db.session() as s:
                settings = settings_store.load_settings(s)
                alert_engine.evaluate_environment(s, settings, self.snapshot())
        except Exception:  # không để lỗi cảnh báo làm dừng vòng đọc thiết bị
            log.exception("Không đánh giá được cảnh báo môi trường")

    # ------------------------------------------------------------------ #
    async def send_command(self, command: str, value: Any = None) -> dict[str, Any]:
        if self._adapter is None or self._state["state"] != "connected":
            raise DeviceError("Thiết bị chưa kết nối.")
        if command not in self._state["capabilities"]:
            raise DeviceError(f"Thiết bị không khai báo hỗ trợ lệnh “{command}”.")
        return await self._adapter.send_command(command, value)

    async def test(self, config: DeviceConfig) -> dict[str, Any]:
        """Thử kết nối với cấu hình tạm (không lưu, không đổi trạng thái)."""
        if not config.configured:
            return {"ok": False, "error": "Chưa nhập địa chỉ thiết bị."}
        adapter = self._adapter_factory(config)
        try:
            reading = await adapter.read()
            return {
                "ok": True, "temperature": reading.temperature, "humidity": reading.humidity,
                "simulated": reading.simulated, "capabilities": reading.capabilities, "device": reading.device,
            }
        except DeviceError as exc:
            return {"ok": False, "error": str(exc)}
        finally:
            await adapter.close()

    # ------------------------------------------------------------------ #
    async def _run(self) -> None:
        while True:
            try:
                await self.poll_once()
            except asyncio.CancelledError:
                raise
            except Exception:
                log.exception("Lỗi vòng đọc thiết bị")
            self._wake.clear()
            # Khi tắt/không cấu hình thì ngủ dài để không tốn CPU.
            delay = self._poll_seconds if (self._enabled and self._adapter) else 3600
            try:
                await asyncio.wait_for(self._wake.wait(), timeout=delay)
            except asyncio.TimeoutError:
                pass

    def start(self) -> None:
        if self._task is None:
            self._task = asyncio.create_task(self._run(), name="device-monitor")

    async def stop(self) -> None:
        if self._task is not None:
            self._task.cancel()
            try:
                await self._task
            except (asyncio.CancelledError, Exception):
                pass
            self._task = None
        if self._adapter is not None:
            await self._adapter.close()
            self._adapter = None

    # ------------------------------------------------------------------ #
    def recent_readings(self, hours: int = 24) -> list[dict[str, Any]]:
        since = clock.now() - timedelta(hours=hours)
        with self.db.session() as s:
            rows = s.scalars(
                select(SensorReading).where(SensorReading.recorded_at >= since).order_by(SensorReading.recorded_at)
            ).all()
            return [
                {"recorded_at": r.recorded_at.isoformat(), "temperature": r.temperature, "humidity": r.humidity, "simulated": r.simulated}
                for r in rows
            ]
