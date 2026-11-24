"""ESP32 qua Internet: thiết bị tự kết nối WSS tới máy chủ, gửi số đo, nhận lệnh và trả ACK.

Kiểm thử dùng WebSocket thật của FastAPI (TestClient) đóng vai ESP32 — giao thức giống hệt
firmware/esp32_cabinet. Không dùng phần cứng thật.
"""
from __future__ import annotations

import time
from datetime import timedelta

import pytest
from sqlalchemy import func, select
from starlette.websockets import WebSocketDisconnect

from app.core import clock
from app.iot.hub import parse_reading
from app.models import Alert, AuditLog, DeviceCommand, DeviceTelemetry
from app.schemas.settings import AppSettings
from app.services.alerts import engine as alert_engine

from .conftest import FROZEN_NOW

WS = "/api/v1/device/ws"
CAPS = ["buzzer", "read_now", "set_thresholds", "set_alarm", "set_interval"]


@pytest.fixture
def move_clock():
    state = {"now": FROZEN_NOW}
    clock.set_now_fn(lambda: state["now"])

    def advance(seconds: float) -> None:
        state["now"] = state["now"] + timedelta(seconds=seconds)

    return advance


def wait_for(predicate, timeout: float = 5.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        value = predicate()
        if value:
            return value
        time.sleep(0.05)
    raise AssertionError("Hết thời gian chờ điều kiện")


@pytest.fixture
def device(client):
    r = client.post("/api/devices", json={"name": "Tủ thuốc phòng khách"})
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["token"].startswith("smcdev_") and body["device"]["is_primary"] is True
    return body


def connect(public_client, token: str):
    return public_client.websocket_connect(WS, headers={"Authorization": f"Bearer {token}"})


def hello(ws, caps=CAPS):
    welcome = ws.receive_json()
    assert welcome["type"] == "welcome" and "thresholds" in welcome
    ws.send_json({"type": "hello", "firmware": "2.0.0", "capabilities": caps})
    return welcome


# --------------------------------------------------------------------------- #
def test_parse_reading_variants():
    assert parse_reading({"temperature": 26.44, "humidity": 58}) == (26.4, 58.0)
    assert parse_reading({"sensors": {"temp": "25.5", "hum": 40}}) == (25.5, 40.0)
    assert parse_reading({"t": 120, "h": -3}) == (None, None)  # ngoài khoảng vật lý → không có số đo
    assert parse_reading({"temperature": None, "humidity": float("nan")}) == (None, None)
    assert parse_reading({"temperature": True}) == (None, None)


@pytest.mark.parametrize(
    "temp,hum,alerts",
    [(25.0, 55.0, set()), (33.5, 55.0, {"temp_high"}), (10.0, 55.0, {"temp_low"}), (25.0, 85.0, {"humidity_high"}),
     (25.0, 20.0, {"humidity_low"}), (None, None, {"sensor_data_lost"})],
)
def test_thresholds_produce_expected_alerts(db, temp, hum, alerts):
    snapshot = {"enabled": True, "state": "connected", "temperature": temp, "humidity": hum, "ever_connected": True}
    with db.session() as s:
        alert_engine.evaluate_environment(s, AppSettings(), snapshot)
    with db.session() as s:
        active = {a.type for a in s.scalars(select(Alert).where(Alert.status == "active")).all()}
    assert active == alerts


def test_invalid_device_token_is_rejected_and_audited(public_client, ctx):
    for headers in ({}, {"Authorization": "Bearer smcdev_sai"}, {"Authorization": "Bearer khong-phai-token"}):
        with pytest.raises(WebSocketDisconnect):
            with public_client.websocket_connect(WS, headers=headers) as ws:
                ws.receive_json()
    with ctx.db.session() as s:
        assert s.scalar(select(func.count()).select_from(AuditLog).where(AuditLog.action == "device.connect", AuditLog.success.is_(False))) == 3


@pytest.mark.parametrize("header", ["CF-Connecting-IP", "X-Forwarded-For"])
def test_device_socket_records_real_ip_behind_tunnel(public_client, ctx, header):
    """Qua Cloudflare Tunnel (CF-Connecting-IP) hay Tailscale Funnel (X-Forwarded-For), nhật ký ghi IP thật của thiết bị."""
    with pytest.raises(WebSocketDisconnect):
        with public_client.websocket_connect(WS, headers={"Authorization": "Bearer smcdev_sai", header: "203.0.113.9, 10.0.0.1"}) as ws:
            ws.receive_json()
    with ctx.db.session() as s:
        ip = s.scalar(select(AuditLog.ip).where(AuditLog.action == "device.connect").order_by(AuditLog.id.desc()).limit(1))
    assert ip == "203.0.113.9"


def test_admin_channel_does_not_expose_device_socket(client, device):
    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect("/api/v1/device/ws", headers={"Authorization": f"Bearer {device['token']}"}) as ws:
            ws.receive_json()


def test_telemetry_is_stored_and_disconnect_is_reported_without_fake_values(client, public_client, ctx, device, move_clock):
    before = client.get("/api/device/status").json()
    assert before["state"] == "disconnected" and before["temperature"] is None and before["ever_connected"] is False
    with connect(public_client, device["token"]) as ws:
        hello(ws)
        ws.send_json({"type": "telemetry", "temperature": 26.4, "humidity": 58.0, "sensor_ok": True, "buzzer_on": False})
        status = wait_for(lambda: (r := client.get("/api/device/status").json())["state"] == "connected" and r)
        assert (status["temperature"], status["humidity"]) == (26.4, 58.0)
        assert status["environment"]["code"] == "normal" and status["capabilities"] == CAPS
        ws.send_json({"type": "telemetry", "temperature": 26.6, "humidity": 58.2, "sensor_ok": True})  # < 60 s → không lưu thêm
        wait_for(lambda: client.get("/api/device/status").json()["temperature"] == 26.6)
        move_clock(61)
        ws.send_json({"type": "telemetry", "temperature": 27.0, "humidity": 57.0, "sensor_ok": True})
        wait_for(lambda: client.get("/api/device/status").json()["temperature"] == 27.0)
    with ctx.db.session() as s:
        rows = s.scalars(select(DeviceTelemetry).order_by(DeviceTelemetry.recorded_at)).all()
        assert [(r.temperature, r.humidity, r.simulated) for r in rows] == [(26.4, 58.0, False), (27.0, 57.0, False)]
    move_clock(120)  # quá thời gian chờ thiết bị kết nối lại sau khi máy chủ khởi động
    after = wait_for(lambda: (r := client.get("/api/device/status").json())["state"] == "disconnected" and r)
    assert after["temperature"] is None and after["humidity"] is None and after["ever_connected"] is True
    ctx.devices.evaluate_alerts()
    alerts = client.get("/api/alerts").json()
    assert any(a["type"] == "device_disconnected" for a in alerts["items"])
    readings = client.get("/api/device/readings?hours=24").json()["items"]
    assert len(readings) == 2  # chỉ số đo thật đã lưu, không có số đo giả lúc mất kết nối


def test_out_of_range_alert_raises_and_resolves(client, public_client, device, move_clock):
    with connect(public_client, device["token"]) as ws:
        hello(ws)
        ws.send_json({"type": "telemetry", "temperature": 34.0, "humidity": 60.0})
        wait_for(lambda: any(a["type"] == "temp_high" and a["status"] == "active" for a in client.get("/api/alerts").json()["items"]))
        ws.send_json({"type": "telemetry", "temperature": 25.0, "humidity": 60.0})
        wait_for(lambda: all(a["type"] != "temp_high" or a["status"] == "resolved" for a in client.get("/api/alerts?status=all").json()["items"]))


def test_command_lifecycle_reports_success_only_after_device_applies(client, public_client, device):
    device_id = device["device"]["id"]
    with connect(public_client, device["token"]) as ws:
        hello(ws)
        wait_for(lambda: client.get(f"/api/devices/{device_id}").json()["device"]["capabilities"] == CAPS)
        r = client.post(f"/api/devices/{device_id}/commands", json={"action": "buzzer", "payload": {"on": True, "duration_s": 5}})
        assert r.status_code == 202, r.text
        cmd = r.json()
        assert cmd["delivered"] is True and cmd["status"] == "sent" and cmd["final"] is False  # đã gửi ≠ thành công
        msg = ws.receive_json()
        assert msg == {"type": "command", "command_id": cmd["id"], "action": "buzzer", "payload": {"on": True, "duration_s": 5},
                       "expires_in_s": msg["expires_in_s"]}
        ws.send_json({"type": "ack", "command_id": cmd["id"], "status": "received"})
        wait_for(lambda: client.get(f"/api/commands/{cmd['id']}").json()["status"] == "acknowledged")
        ws.send_json({"type": "ack", "command_id": cmd["id"], "status": "applied", "result": {"buzzer_on": True}})
        done = wait_for(lambda: (c := client.get(f"/api/commands/{cmd['id']}").json())["status"] == "applied" and c)
    assert done["final"] is True and done["result"] == {"buzzer_on": True}
    assert [a["status"] for a in done["acks"]] == ["received", "applied"]
    history = client.get("/api/history?group=device").json()["items"]
    assert any(h["type"] == "command_applied" for h in history)


def test_device_failure_is_reported_as_failed(client, public_client, device):
    device_id = device["device"]["id"]
    with connect(public_client, device["token"]) as ws:
        hello(ws)
        wait_for(lambda: client.get(f"/api/devices/{device_id}").json()["device"]["capabilities"])
        cmd = client.post(f"/api/devices/{device_id}/commands", json={"action": "read_now"}).json()
        ws.receive_json()
        ws.send_json({"type": "ack", "command_id": cmd["id"], "status": "failed", "message": "Cảm biến DHT22 không phản hồi"})
        failed = wait_for(lambda: (c := client.get(f"/api/commands/{cmd['id']}").json())["status"] == "failed" and c)
    assert failed["error"] == "Cảm biến DHT22 không phản hồi"


def test_commands_are_validated_against_server_and_device_capabilities(client, public_client, device):
    device_id = device["device"]["id"]
    # Thiết bị chưa từng chào → chưa khai báo capability nào.
    r = client.post(f"/api/devices/{device_id}/commands", json={"action": "buzzer", "payload": {"on": True}})
    assert r.status_code == 400 and "không khai báo" in r.json()["detail"]
    with connect(public_client, device["token"]) as ws:
        hello(ws, caps=["buzzer"])
        wait_for(lambda: client.get(f"/api/devices/{device_id}").json()["device"]["capabilities"] == ["buzzer"])
        assert client.post(f"/api/devices/{device_id}/commands", json={"action": "set_interval", "payload": {"seconds": 30}}).status_code == 400
        assert client.post(f"/api/devices/{device_id}/commands", json={"action": "open_door"}).status_code == 400  # máy chủ không hỗ trợ
        bad = client.post(f"/api/devices/{device_id}/commands", json={"action": "buzzer", "payload": {"on": True, "duration_s": 9999}})
        assert bad.status_code == 400 and "duration_s" in bad.json()["detail"]
        extra = client.post(f"/api/devices/{device_id}/commands", json={"action": "buzzer", "payload": {"on": True, "pin": 13}})
        assert extra.status_code == 400


def test_offline_command_is_delivered_when_device_reconnects(client, public_client, device):
    device_id = device["device"]["id"]
    with connect(public_client, device["token"]) as ws:
        hello(ws)
        wait_for(lambda: client.get(f"/api/devices/{device_id}").json()["device"]["capabilities"])
    wait_for(lambda: client.get(f"/api/devices/{device_id}").json()["device"]["online"] is False)
    cmd = client.post(f"/api/devices/{device_id}/commands", json={"action": "set_alarm", "payload": {"enabled": False}}).json()
    assert cmd["delivered"] is False and cmd["status"] == "pending" and "ngoại tuyến" in cmd["note"]
    with connect(public_client, device["token"]) as ws:
        hello(ws)
        msg = ws.receive_json()  # máy chủ gửi lại lệnh còn hạn ngay sau khi thiết bị chào
        assert msg["type"] == "command" and msg["command_id"] == cmd["id"]
        wait_for(lambda: client.get(f"/api/commands/{cmd['id']}").json()["status"] == "sent")


def test_unconfirmed_command_times_out(client, public_client, ctx, device, move_clock):
    device_id = device["device"]["id"]
    with connect(public_client, device["token"]) as ws:
        hello(ws)
        wait_for(lambda: client.get(f"/api/devices/{device_id}").json()["device"]["capabilities"])
        cmd = client.post(f"/api/devices/{device_id}/commands", json={"action": "read_now", "ttl_seconds": 10}).json()
        ws.receive_json()
        move_clock(11)
        assert ctx.devices.expire_commands() == 1
        expired = client.get(f"/api/commands/{cmd['id']}").json()
        assert expired["status"] == "timed_out" and expired["final"] is True and "Hết thời gian" in expired["error"]
        # Phản hồi muộn vẫn được ghi nhận trung thực (đánh dấu là muộn).
        ws.send_json({"type": "ack", "command_id": cmd["id"], "status": "applied"})
        late = wait_for(lambda: (c := client.get(f"/api/commands/{cmd['id']}").json())["status"] == "applied" and c)
        assert late["result"] == {"late": True}


def test_cancel_pending_command(client, device, ctx):
    device_id = device["device"]["id"]
    with ctx.db.session() as s:
        from app.models import Device

        s.get(Device, __import__("uuid").UUID(device_id)).capabilities = CAPS
    cmd = client.post(f"/api/devices/{device_id}/commands", json={"action": "read_now"}).json()
    cancelled = client.post(f"/api/commands/{cmd['id']}/cancel").json()
    assert cancelled["status"] == "cancelled"
    assert client.post(f"/api/commands/{cmd['id']}/cancel").status_code == 400


def test_token_rotation_and_deactivation_lock_out_old_credentials(client, public_client, device):
    device_id = device["device"]["id"]
    rotated = client.post(f"/api/devices/{device_id}/token").json()
    assert rotated["token"] != device["token"]
    with pytest.raises(WebSocketDisconnect):
        with connect(public_client, device["token"]) as ws:
            ws.receive_json()
    with connect(public_client, rotated["token"]) as ws:
        hello(ws)
    client.patch(f"/api/devices/{device_id}", json={"is_active": False})
    with pytest.raises(WebSocketDisconnect):
        with connect(public_client, rotated["token"]) as ws:
            ws.receive_json()


def test_threshold_change_is_synced_to_device(client, public_client, device):
    device_id = device["device"]["id"]
    with connect(public_client, device["token"]) as ws:
        hello(ws)
        wait_for(lambda: client.get(f"/api/devices/{device_id}").json()["device"]["capabilities"])
        assert client.patch("/api/settings", json={"temp_max": 28}).status_code == 200
        msg = ws.receive_json()
    assert msg["type"] == "command" and msg["action"] == "set_thresholds" and msg["payload"]["temp_max"] == 28


def test_scanner_cannot_reach_device_management(client, public_client, scanner, device):
    headers, _ = scanner
    device_id = device["device"]["id"]
    # API công khai không có endpoint quản lý/lệnh thiết bị.
    for method, path in (("get", "/api/v1/devices"), ("post", f"/api/v1/devices/{device_id}/commands"),
                         ("post", f"/api/devices/{device_id}/commands"), ("get", "/api/device/status")):
        assert public_client.request(method.upper(), path, headers=headers, json={"action": "buzzer"}).status_code in (404, 405)
    # Token Scanner đem sang cổng Admin bị từ chối.
    assert client.post(f"/api/devices/{device_id}/commands", headers=headers, json={"action": "buzzer", "payload": {"on": True}}).status_code == 401
    with client.app.state.ctx.db.session() as s:
        assert s.scalar(select(func.count()).select_from(DeviceCommand)) == 0
