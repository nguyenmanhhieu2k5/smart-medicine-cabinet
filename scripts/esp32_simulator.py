"""Trình mô phỏng ESP32 cho phát triển và kiểm thử (KHÔNG phải dữ liệu thật).

    python scripts/esp32_simulator.py --port 8080 [--temp 26.5 --hum 58] [--fail-after 10]

Trả về JSON theo docs/ESP32_PROTOCOL.md kèm `"simulated": true` để giao diện
luôn gắn nhãn "Mô phỏng". Chỉ dùng thư viện chuẩn của Python.
"""
from __future__ import annotations

import argparse
import json
import math
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8080)
    ap.add_argument("--temp", type=float, default=26.5, help="Nhiệt độ trung tâm (°C)")
    ap.add_argument("--hum", type=float, default=58.0, help="Độ ẩm trung tâm (%%)")
    ap.add_argument("--fail-after", type=int, default=0, help="Sau N lần đọc thì trả lỗi 500 (thử mất kết nối)")
    args = ap.parse_args()
    started = time.time()
    state = {"reads": 0, "buzzer": False}

    class Handler(BaseHTTPRequestHandler):
        def _json(self, code: int, payload: dict) -> None:
            body = json.dumps(payload).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self) -> None:  # noqa: N802
            if self.path.split("?")[0] != "/api/status":
                self._json(404, {"error": "not found"})
                return
            state["reads"] += 1
            if args.fail_after and state["reads"] > args.fail_after:
                self._json(500, {"error": "simulated failure"})
                return
            t = time.time() - started
            self._json(200, {
                "temperature": round(args.temp + 0.6 * math.sin(t / 30), 1),
                "humidity": round(args.hum + 2.0 * math.sin(t / 45 + 1), 1),
                "sensor_ok": True,
                "uptime_ms": int(t * 1000),
                "firmware": "simulator-1.0",
                "capabilities": ["buzzer"],
                "buzzer_on": state["buzzer"],
                "simulated": True,
            })

        def do_POST(self) -> None:  # noqa: N802
            if self.path != "/api/command":
                self._json(404, {"error": "not found"})
                return
            length = int(self.headers.get("Content-Length") or 0)
            try:
                body = json.loads(self.rfile.read(length) or b"{}")
            except ValueError:
                self._json(400, {"error": "bad json"})
                return
            if body.get("command") == "buzzer":
                state["buzzer"] = bool(body.get("value"))
                self._json(200, {"ok": True, "buzzer_on": state["buzzer"]})
            else:
                self._json(400, {"error": "unsupported command"})

        def log_message(self, fmt: str, *values) -> None:  # noqa: ANN002
            print(f"[sim] {self.address_string()} {fmt % values}")

    print(f"ESP32 MÔ PHỎNG tại http://{args.host}:{args.port}/api/status (Ctrl+C để dừng)")
    ThreadingHTTPServer((args.host, args.port), Handler).serve_forever()


if __name__ == "__main__":
    main()
