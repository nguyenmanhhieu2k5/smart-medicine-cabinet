"""Trình mô phỏng ESP32 (KHÔNG phải dữ liệu thật) — kết nối WSS RA NGOÀI tới máy chủ như firmware thật.

    backend\\.venv\\Scripts\\python scripts\\esp32_simulator.py --url wss://api.<tên-miền>/api/v1/device/ws --token smcdev_...
    backend\\.venv\\Scripts\\python scripts\\esp32_simulator.py --url ws://127.0.0.1:8000/api/v1/device/ws --token smcdev_...

Giao thức giống firmware/esp32_cabinet (xem docs/ESP32_PROTOCOL.md). Mọi bản tin số đo có
``"simulated": true`` nên ứng dụng quản trị luôn gắn nhãn "Mô phỏng" — không thể nhầm với số đo thật.
Lệnh hỗ trợ: buzzer, read_now, set_thresholds, set_alarm, set_interval (trả ACK received → applied).
"""
from __future__ import annotations

import argparse
import asyncio
import json
import math
import random
import time

import websockets

CAPABILITIES = ["buzzer", "read_now", "set_thresholds", "set_alarm", "set_interval"]


class SimulatedCabinet:
    def __init__(self, temp: float, hum: float, interval: int, fail_actions: set[str]):
        self.center_temp, self.center_hum = temp, hum
        self.interval = interval
        self.fail_actions = fail_actions
        self.buzzer = False
        self.alarm_enabled = True
        self.thresholds = {"temp_min": 15.0, "temp_max": 30.0, "humidity_min": 30.0, "humidity_max": 75.0}
        self.started = time.monotonic()
        self.seen: list[str] = []

    def reading(self) -> dict:
        t = time.monotonic() - self.started
        temp = round(self.center_temp + 1.2 * math.sin(t / 60) + random.uniform(-0.2, 0.2), 1)
        hum = round(self.center_hum + 4 * math.sin(t / 90) + random.uniform(-0.5, 0.5), 1)
        out_of_range = not (self.thresholds["temp_min"] <= temp <= self.thresholds["temp_max"]) or \
            not (self.thresholds["humidity_min"] <= hum <= self.thresholds["humidity_max"])
        return {
            "type": "telemetry", "temperature": temp, "humidity": hum, "sensor_ok": True, "simulated": True,
            "buzzer_on": self.buzzer or (self.alarm_enabled and out_of_range), "alarm_enabled": self.alarm_enabled,
            "local_alarm": bool(self.alarm_enabled and out_of_range), "interval_s": self.interval,
            "uptime_ms": int(t * 1000),
        }

    def apply(self, action: str, payload: dict) -> tuple[bool, str | None, dict]:
        if action in self.fail_actions:
            return False, "Mô phỏng lỗi phần cứng", {}
        if action == "buzzer":
            self.buzzer = bool(payload.get("on"))
            return True, None, {"buzzer_on": self.buzzer}
        if action == "read_now":
            return True, None, {}
        if action == "set_thresholds":
            self.thresholds.update({k: float(v) for k, v in payload.items() if k in self.thresholds})
            return True, None, {"thresholds": self.thresholds}
        if action == "set_alarm":
            self.alarm_enabled = bool(payload.get("enabled"))
            return True, None, {"alarm_enabled": self.alarm_enabled}
        if action == "set_interval":
            self.interval = int(payload.get("seconds", self.interval))
            return True, None, {"interval_s": self.interval}
        return False, f"unsupported action {action}", {}


async def run(url: str, token: str, cabinet: SimulatedCabinet, once: bool) -> None:
    backoff = 1
    while True:
        try:
            async with websockets.connect(url, additional_headers={"Authorization": f"Bearer {token}"}, ping_interval=None,
                                          open_timeout=15) as ws:
                backoff = 1
                welcome = json.loads(await ws.recv())
                print("Đã kết nối:", welcome.get("name"), "· ngưỡng", welcome.get("thresholds"))
                if isinstance(welcome.get("thresholds"), dict):
                    cabinet.thresholds.update(welcome["thresholds"])
                await ws.send(json.dumps({"type": "hello", "firmware": "sim-2.0.0", "capabilities": CAPABILITIES,
                                          "state": {"simulated": True}}))
                await ws.send(json.dumps(cabinet.reading()))
                next_telemetry = time.monotonic() + cabinet.interval
                while True:
                    timeout = max(0.1, next_telemetry - time.monotonic())
                    try:
                        msg = json.loads(await asyncio.wait_for(ws.recv(), timeout=timeout))
                    except asyncio.TimeoutError:
                        await ws.send(json.dumps(cabinet.reading()))
                        next_telemetry = time.monotonic() + cabinet.interval
                        continue
                    if msg.get("type") == "ping":
                        await ws.send(json.dumps({"type": "pong"}))
                    elif msg.get("type") == "command":
                        cid, action = msg["command_id"], msg["action"]
                        await ws.send(json.dumps({"type": "ack", "command_id": cid, "status": "received"}))
                        if cid in cabinet.seen:  # lệnh gửi lại → không thực hiện hai lần
                            await ws.send(json.dumps({"type": "ack", "command_id": cid, "status": "applied", "result": {"duplicate": True}}))
                            continue
                        cabinet.seen = (cabinet.seen + [cid])[-32:]
                        ok, error, result = cabinet.apply(action, msg.get("payload") or {})
                        await ws.send(json.dumps({"type": "ack", "command_id": cid, "status": "applied" if ok else "failed",
                                                  "message": error, "result": result}))
                        print(f"Lệnh {action} {msg.get('payload')} → {'applied' if ok else 'failed'}")
                        if ok:
                            await ws.send(json.dumps(cabinet.reading()))
                        if once:
                            return
        except (OSError, websockets.WebSocketException) as exc:
            print(f"Mất kết nối ({exc.__class__.__name__}: {exc}); thử lại sau {backoff}s")
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, 60)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--url", required=True, help="wss://.../api/v1/device/ws hoặc ws://127.0.0.1:8000/api/v1/device/ws")
    ap.add_argument("--token", required=True, help="Token thiết bị (smcdev_...) tạo ở ứng dụng quản trị")
    ap.add_argument("--temp", type=float, default=26.5, help="Nhiệt độ trung tâm (°C)")
    ap.add_argument("--hum", type=float, default=58.0, help="Độ ẩm trung tâm (%%)")
    ap.add_argument("--interval", type=int, default=10, help="Chu kỳ gửi số đo (giây)")
    ap.add_argument("--fail", action="append", default=[], help="Mô phỏng lỗi khi nhận lệnh này (lặp lại được)")
    ap.add_argument("--once", action="store_true", help="Thoát sau khi xử lý một lệnh (dùng cho kiểm thử)")
    args = ap.parse_args()
    cabinet = SimulatedCabinet(args.temp, args.hum, args.interval, set(args.fail))
    try:
        asyncio.run(run(args.url, args.token, cabinet, args.once))
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
