"""12. Ngưỡng môi trường · 13. Lưu cảnh báo · 14. Mất kết nối ESP32."""
from __future__ import annotations

import asyncio

import httpx
import pytest
from sqlalchemy import func, select

from app.models import Alert, SensorReading
from app.schemas.settings import AppSettings
from app.services import settings_store
from app.services.alerts import engine as alert_engine
from app.services.esp32.adapter import DeviceConfig, DeviceError, HttpPollingAdapter, normalize_host, parse_status_payload
from app.services.esp32.monitor import DeviceMonitor


class FakeDevice:
    """ESP32 giả lập bằng httpx.MockTransport — CHỈ dùng trong kiểm thử."""

    def __init__(self):
        self.payload: dict | None = {"temperature": 26.4, "humidity": 58.0, "simulated": True, "capabilities": ["buzzer"]}
        self.status = 200
        self.offline = False
        self.commands: list[dict] = []

    def handler(self, request: httpx.Request) -> httpx.Response:
        if self.offline:
            raise httpx.ConnectError("no route to host")
        if request.url.path == "/api/command":
            import json

            self.commands.append(json.loads(request.content))
            return httpx.Response(200, json={"ok": True})
        if self.payload is None:
            return httpx.Response(200, text="<html>not json</html>")
        return httpx.Response(self.status, json=self.payload)

    def factory(self, config: DeviceConfig) -> HttpPollingAdapter:
        return HttpPollingAdapter(config, transport=httpx.MockTransport(self.handler))


def run(coro):
    return asyncio.run(coro)


def configure(db, device: FakeDevice, **overrides) -> tuple[DeviceMonitor, AppSettings]:
    values = {"esp32_enabled": True, "esp32_host": "192.168.1.50", "temp_min": 15, "temp_max": 30, "humidity_min": 30, "humidity_max": 75} | overrides
    with db.session() as s:
        settings = settings_store.save_settings(s, values)
    monitor = DeviceMonitor(db, device.factory)
    return monitor, settings


def open_alerts(db) -> dict[str, str]:
    with db.session() as s:
        rows = s.scalars(select(Alert).where(Alert.status.in_(alert_engine.OPEN_STATUSES))).all()
        return {a.type: a.severity for a in rows}


async def poll(monitor: DeviceMonitor, settings: AppSettings, times: int = 1) -> dict:
    await monitor.configure(settings)
    state = {}
    for _ in range(times):
        state = await monitor.poll_once()
    await monitor.stop()
    return state


# ---- Phân tích dữ liệu thiết bị ---------------------------------------------- #
def test_parse_payload_variants():
    flat = parse_status_payload({"temperature": "26.44", "humidity": 58})
    assert (flat.temperature, flat.humidity, flat.simulated) == (26.44, 58.0, False)
    nested = parse_status_payload({"sensors": {"temp": 5.5, "hum": 45}, "firmware": "1.0", "capabilities": ["fan", "buzzer"]})
    assert (nested.temperature, nested.humidity, nested.capabilities, nested.device) == (5.5, 45.0, ["fan", "buzzer"], {"firmware": "1.0"})
    broken = parse_status_payload({"temperature": None, "humidity": "nan"})
    assert broken.temperature is None and broken.humidity is None
    assert parse_status_payload({"temperature": 999, "humidity": 140}).temperature is None  # ngoài khoảng vật lý
    with pytest.raises(DeviceError):
        parse_status_payload({"uptime": 1})
    with pytest.raises(DeviceError):
        parse_status_payload([1, 2])
    assert normalize_host(" http://192.168.1.50/api ") == "192.168.1.50"


# ---- 12. Ngưỡng --------------------------------------------------------------- #
@pytest.mark.parametrize(
    ("temp", "hum", "code", "alerts"),
    [
        (26.4, 58.0, "normal", {}),
        (30.0, 75.0, "normal", {}),  # đúng bằng ngưỡng vẫn là bình thường
        (31.0, 58.0, "out_of_range", {"temp_high": "warning"}),
        (33.5, 58.0, "out_of_range", {"temp_high": "danger"}),  # vượt hơn 2 °C
        (12.0, 58.0, "out_of_range", {"temp_low": "danger"}),
        (26.0, 78.0, "out_of_range", {"humidity_high": "warning"}),
        (26.0, 20.0, "out_of_range", {"humidity_low": "danger"}),
        (35.0, 90.0, "out_of_range", {"temp_high": "danger", "humidity_high": "danger"}),
    ],
)
def test_thresholds_produce_expected_alerts(db, temp, hum, code, alerts):
    device = FakeDevice()
    device.payload = {"temperature": temp, "humidity": hum}
    monitor, settings = configure(db, device)
    state = run(poll(monitor, settings))
    assert state["state"] == "connected" and (state["temperature"], state["humidity"]) == (temp, hum)
    assert alert_engine.environment_status(state, settings)["code"] == code
    assert open_alerts(db) == alerts


def test_alert_resolves_when_value_returns_to_range_and_is_not_duplicated(db):
    device = FakeDevice()
    device.payload = {"temperature": 31.0, "humidity": 50}
    monitor, settings = configure(db, device)

    async def scenario():
        await monitor.configure(settings)
        await monitor.poll_once()
        await monitor.poll_once()  # cùng điều kiện → không tạo cảnh báo thứ hai
        first = open_alerts(db)
        device.payload = {"temperature": 34.0, "humidity": 50}
        await monitor.poll_once()  # nặng hơn → nâng mức, vẫn một cảnh báo
        escalated = open_alerts(db)
        device.payload = {"temperature": 25.0, "humidity": 50}
        await monitor.poll_once()
        await monitor.stop()
        return first, escalated

    first, escalated = run(scenario())
    assert first == {"temp_high": "warning"} and escalated == {"temp_high": "danger"}
    assert open_alerts(db) == {}
    with db.session() as s:
        assert s.scalar(select(func.count()).select_from(Alert)) == 1
        assert s.scalars(select(Alert)).one().status == "resolved"


# ---- 14. Mất kết nối ----------------------------------------------------------- #
def test_not_configured_shows_no_readings_and_no_alerts(db):
    monitor = DeviceMonitor(db, FakeDevice().factory)
    with db.session() as s:
        settings = settings_store.load_settings(s)
    state = run(poll(monitor, settings))
    assert state["state"] == "disabled" and state["temperature"] is None and state["humidity"] is None
    assert alert_engine.environment_status(state, settings) == {"code": "not_configured", "label": "Chưa kết nối", "temperature": None, "humidity": None}
    assert open_alerts(db) == {}
    with db.session() as s:
        assert s.scalar(select(func.count()).select_from(SensorReading)) == 0  # không có số đo giả


def test_device_offline_from_the_start(db):
    device = FakeDevice()
    device.offline = True
    monitor, settings = configure(db, device)
    state = run(poll(monitor, settings))
    assert state["state"] == "disconnected" and state["temperature"] is None
    assert "Không kết nối được" in state["last_error"]
    assert alert_engine.environment_status(state, settings)["label"] == "Chưa kết nối"
    assert open_alerts(db) == {"device_disconnected": "warning"}


def test_connection_lost_clears_stale_values_then_recovers(db):
    device = FakeDevice()
    monitor, settings = configure(db, device)

    async def scenario():
        await monitor.configure(settings)
        ok = await monitor.poll_once()
        device.offline = True
        one_miss = await monitor.poll_once()  # một lần lỗi: chưa kết luận mất kết nối
        lost = await monitor.poll_once()
        alerts_lost = open_alerts(db)
        device.offline = False
        back = await monitor.poll_once()
        await monitor.stop()
        return ok, one_miss, lost, alerts_lost, back

    ok, one_miss, lost, alerts_lost, back = run(scenario())
    assert ok["state"] == "connected" and ok["temperature"] == 26.4 and ok["simulated"] is True
    assert one_miss["state"] == "connected"
    assert lost["state"] == "disconnected" and lost["temperature"] is None and lost["humidity"] is None
    assert alert_engine.environment_status(lost, settings)["label"] == "Mất kết nối"
    assert alerts_lost == {"device_disconnected": "warning"}
    assert back["state"] == "connected" and back["temperature"] == 26.4
    assert open_alerts(db) == {}


@pytest.mark.parametrize("payload,status", [(None, 200), ({"temperature": 20, "humidity": 50}, 500)])
def test_bad_responses_count_as_disconnected(db, payload, status):
    device = FakeDevice()
    device.payload, device.status = payload, status
    monitor, settings = configure(db, device)
    assert run(poll(monitor, settings))["state"] == "disconnected"


def test_sensor_fault_reports_data_lost(db):
    device = FakeDevice()
    device.payload = {"temperature": None, "humidity": None}
    monitor, settings = configure(db, device)
    state = run(poll(monitor, settings))
    assert state["state"] == "connected"
    assert alert_engine.environment_status(state, settings)["code"] == "no_data"
    assert open_alerts(db) == {"sensor_data_lost": "warning"}


def test_real_readings_are_stored_at_most_once_per_minute(db):
    device = FakeDevice()
    monitor, settings = configure(db, device)
    run(poll(monitor, settings, times=3))
    with db.session() as s:
        rows = s.scalars(select(SensorReading)).all()
        assert len(rows) == 1 and rows[0].temperature == 26.4 and rows[0].simulated is True


def test_commands_only_for_declared_capabilities(db):
    device = FakeDevice()
    monitor, settings = configure(db, device)

    async def scenario():
        await monitor.configure(settings)
        with pytest.raises(DeviceError, match="chưa kết nối"):
            await monitor.send_command("buzzer", True)
        await monitor.poll_once()
        ok = await monitor.send_command("buzzer", True)
        with pytest.raises(DeviceError, match="không khai báo"):
            await monitor.send_command("unlock_door", True)
        await monitor.stop()
        return ok

    assert run(scenario()) == {"ok": True}
    assert device.commands == [{"command": "buzzer", "value": True}]


# ---- API ----------------------------------------------------------------------- #
def test_device_api_reports_not_connected_without_fake_numbers(client):
    status = client.get("/api/device/status").json()
    assert status["state"] == "disabled" and status["temperature"] is None and status["humidity"] is None
    assert status["environment"]["label"] == "Chưa kết nối"
    assert status["thresholds"] == {"temp_min": 15.0, "temp_max": 30.0, "humidity_min": 30.0, "humidity_max": 75.0}
    assert client.get("/api/device/readings").json()["items"] == []
    assert client.post("/api/device/command", json={"command": "fan", "value": 1}).status_code == 400
    test = client.post("/api/device/test", json={"host": ""}).json()
    assert test == {"ok": False, "error": "Chưa nhập địa chỉ thiết bị."}


def test_settings_validate_threshold_ranges(client):
    bad = client.patch("/api/settings", json={"temp_min": 40, "temp_max": 30})
    assert bad.status_code == 400 and "nhỏ hơn" in bad.json()["detail"]
    ok = client.patch("/api/settings", json={"temp_min": 2, "temp_max": 8, "humidity_max": 60}).json()["settings"]
    assert (ok["temp_min"], ok["temp_max"], ok["humidity_max"]) == (2, 8, 60)
    assert client.get("/api/device/status").json()["thresholds"]["temp_max"] == 8
    assert client.patch("/api/settings", json={"khong_ton_tai": 1}).status_code == 422
