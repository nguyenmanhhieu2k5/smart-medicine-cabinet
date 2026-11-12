"""Lớp kết nối phần cứng — độc lập với giao diện.

Giao thức mặc định (xem docs/ESP32_PROTOCOL.md): máy tính là *client*, ESP32 là
*server* trong mạng LAN.

    GET  http://<esp32>/api/status      → JSON số đo hiện tại
    WS   ws://<esp32>/ws                → ESP32 đẩy cùng định dạng JSON
    POST http://<esp32>/api/command     → chỉ gọi khi thiết bị khai báo capability

Ứng dụng không giả định firmware đã có sẵn endpoint nào: mọi lỗi kết nối đều
được báo là "mất kết nối", và lệnh điều khiển chỉ được gửi nếu chính thiết bị
liệt kê lệnh đó trong `capabilities`.
"""
from __future__ import annotations

import asyncio
import json
import math
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any

import httpx


class DeviceError(Exception):
    """Không đọc được dữ liệu từ thiết bị (mất kết nối, sai định dạng…)."""


@dataclass
class DeviceReading:
    temperature: float | None
    humidity: float | None
    simulated: bool = False
    capabilities: list[str] = field(default_factory=list)
    device: dict[str, Any] = field(default_factory=dict)
    raw: dict[str, Any] = field(default_factory=dict)


_TEMP_KEYS = ("temperature", "temperature_c", "temp", "temp_c", "t")
_HUM_KEYS = ("humidity", "humidity_percent", "hum", "rh", "h")


def _number(value: Any, low: float, high: float) -> float | None:
    """Số hợp lệ trong khoảng vật lý, ngược lại None (cảm biến lỗi/NaN)."""
    if value is None or isinstance(value, bool):
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if math.isnan(number) or math.isinf(number) or not (low <= number <= high):
        return None
    return round(number, 2)


def parse_status_payload(payload: Any) -> DeviceReading:
    """Chuyển JSON trạng thái của thiết bị thành DeviceReading.

    Chấp nhận dạng phẳng `{"temperature": 26.4, "humidity": 58}` hoặc lồng
    trong `sensors` / `data`. Giá trị thiếu hoặc ngoài khoảng vật lý → None.
    """
    if not isinstance(payload, dict):
        raise DeviceError("Thiết bị trả về dữ liệu không phải JSON object.")
    source: dict[str, Any] = payload
    for key in ("sensors", "data", "reading"):
        if isinstance(payload.get(key), dict):
            source = {**payload, **payload[key]}
            break
    temperature = next((_number(source[k], -40.0, 85.0) for k in _TEMP_KEYS if k in source), None)
    humidity = next((_number(source[k], 0.0, 100.0) for k in _HUM_KEYS if k in source), None)
    if not any(k in source for k in _TEMP_KEYS + _HUM_KEYS):
        raise DeviceError("Dữ liệu thiết bị không có trường nhiệt độ/độ ẩm.")
    capabilities = payload.get("capabilities")
    device = payload.get("device") if isinstance(payload.get("device"), dict) else {}
    for key in ("firmware", "uptime_ms", "name", "door_open", "fan_on", "sensor_ok"):
        if key in payload and key not in device:
            device[key] = payload[key]
    return DeviceReading(
        temperature=temperature,
        humidity=humidity,
        simulated=bool(payload.get("simulated", False)),
        capabilities=[str(c) for c in capabilities] if isinstance(capabilities, list) else [],
        device=device,
        raw=payload,
    )


def normalize_host(host: str) -> str:
    host = (host or "").strip()
    for prefix in ("http://", "https://", "ws://", "wss://"):
        if host.lower().startswith(prefix):
            host = host[len(prefix):]
    return host.split("/")[0].strip()


@dataclass
class DeviceConfig:
    mode: str = "http"
    host: str = ""
    port: int = 80
    path: str = "/api/status"
    timeout: float = 3.0
    token: str | None = None

    @property
    def configured(self) -> bool:
        return bool(normalize_host(self.host))

    def base(self, scheme: str) -> str:
        host = normalize_host(self.host)
        if ":" in host:  # người dùng nhập kèm cổng
            return f"{scheme}://{host}"
        return f"{scheme}://{host}:{self.port}"

    @property
    def status_path(self) -> str:
        path = (self.path or "/api/status").strip()
        return path if path.startswith("/") else "/" + path


class DeviceAdapter(ABC):
    """Giao diện chung cho mọi cách kết nối thiết bị."""

    def __init__(self, config: DeviceConfig):
        self.config = config

    @abstractmethod
    async def read(self) -> DeviceReading: ...

    async def send_command(self, command: str, value: Any = None) -> dict[str, Any]:
        raise DeviceError("Kiểu kết nối này không hỗ trợ gửi lệnh.")

    async def close(self) -> None:  # noqa: B027
        return None

    def _headers(self) -> dict[str, str]:
        return {"X-Device-Token": self.config.token} if self.config.token else {}


class HttpPollingAdapter(DeviceAdapter):
    """Máy tính định kỳ gọi GET /api/status trên ESP32."""

    def __init__(self, config: DeviceConfig, transport: httpx.AsyncBaseTransport | None = None):
        super().__init__(config)
        self._client = httpx.AsyncClient(timeout=config.timeout, transport=transport, trust_env=False)

    async def read(self) -> DeviceReading:
        url = self.config.base("http") + self.config.status_path
        try:
            response = await self._client.get(url, headers=self._headers())
        except httpx.TimeoutException as exc:
            raise DeviceError(f"Thiết bị không phản hồi trong {self.config.timeout:g} giây.") from exc
        except httpx.HTTPError as exc:
            raise DeviceError(f"Không kết nối được tới {url}: {exc.__class__.__name__}") from exc
        if response.status_code != 200:
            raise DeviceError(f"Thiết bị trả về mã HTTP {response.status_code}.")
        try:
            payload = response.json()
        except (json.JSONDecodeError, ValueError) as exc:
            raise DeviceError("Thiết bị trả về dữ liệu không phải JSON.") from exc
        return parse_status_payload(payload)

    async def send_command(self, command: str, value: Any = None) -> dict[str, Any]:
        url = self.config.base("http") + "/api/command"
        try:
            response = await self._client.post(url, json={"command": command, "value": value}, headers=self._headers())
        except httpx.HTTPError as exc:
            raise DeviceError(f"Không gửi được lệnh tới thiết bị: {exc.__class__.__name__}") from exc
        if response.status_code >= 400:
            raise DeviceError(f"Thiết bị từ chối lệnh (HTTP {response.status_code}).")
        try:
            return response.json()
        except ValueError:
            return {"ok": True}

    async def close(self) -> None:
        await self._client.aclose()


class WebSocketAdapter(DeviceAdapter):
    """ESP32 đẩy số đo qua WebSocket; adapter giữ bản tin mới nhất."""

    def __init__(self, config: DeviceConfig):
        super().__init__(config)
        self._ws: Any = None
        self._latest: DeviceReading | None = None
        self._latest_at: float = 0.0
        self._reader: asyncio.Task[None] | None = None
        self._error: str | None = None

    async def _connect(self) -> None:
        import websockets

        url = self.config.base("ws") + self.config.status_path
        try:
            self._ws = await asyncio.wait_for(
                websockets.connect(url, additional_headers=self._headers() or None, open_timeout=self.config.timeout),
                timeout=self.config.timeout + 1,
            )
        except Exception as exc:  # websockets ném nhiều kiểu lỗi khác nhau
            self._ws = None
            raise DeviceError(f"Không mở được WebSocket tới {url}: {exc.__class__.__name__}") from exc
        self._error = None
        self._reader = asyncio.create_task(self._read_loop())

    async def _read_loop(self) -> None:
        try:
            async for message in self._ws:
                try:
                    self._latest = parse_status_payload(json.loads(message))
                    self._latest_at = asyncio.get_running_loop().time()
                except (DeviceError, ValueError):
                    continue  # bỏ qua bản tin không hợp lệ
        except Exception as exc:
            self._error = f"WebSocket bị ngắt: {exc.__class__.__name__}"
        finally:
            self._ws = None

    async def read(self) -> DeviceReading:
        if self._ws is None:
            await self._connect()
        loop = asyncio.get_running_loop()
        deadline = loop.time() + self.config.timeout
        while self._latest is None and loop.time() < deadline and self._ws is not None:
            await asyncio.sleep(0.05)
        if self._ws is None and self._latest is None:
            raise DeviceError(self._error or "WebSocket đã đóng.")
        if self._latest is None:
            raise DeviceError("Chưa nhận được số đo nào qua WebSocket.")
        return self._latest

    def seconds_since_message(self) -> float | None:
        if not self._latest_at:
            return None
        return asyncio.get_running_loop().time() - self._latest_at

    async def close(self) -> None:
        if self._reader:
            self._reader.cancel()
        if self._ws is not None:
            try:
                await self._ws.close()
            except Exception:
                pass
        self._ws = None


def create_adapter(config: DeviceConfig) -> DeviceAdapter:
    if config.mode == "websocket":
        return WebSocketAdapter(config)
    return HttpPollingAdapter(config)
