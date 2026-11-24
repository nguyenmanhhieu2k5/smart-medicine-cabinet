"""Kiểm thử đầu-cuối máy chủ Mini PC với tiến trình THẬT (không dùng TestClient).

    backend\\.venv\\Scripts\\python scripts\\e2e_server.py            (PostgreSQL tạm, tự dọn)
    backend\\.venv\\Scripts\\python scripts\\e2e_server.py --catalog sample

Các bước: PostgreSQL tạm → `python -m app.server` (2 cổng) → tạo Admin bằng CLI → đăng nhập 2 kênh →
kiểm tra tách kênh → tạo thiết bị → trình mô phỏng ESP32 kết nối WS → lệnh + ACK → Scanner quét ảnh thật
(PaddleOCR) → lịch sử → dừng máy chủ bằng tín hiệu như dịch vụ Windows.
"""
from __future__ import annotations

import argparse
import os
import signal
import socket
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parents[1]
BACKEND = ROOT / "backend"
sys.path.insert(0, str(BACKEND))

from app.database.cluster import LocalCluster, admin_execute, find_pg_bin, free_port  # noqa: E402

PY = sys.executable
RESULTS: list[tuple[str, bool, str]] = []


def step(name: str, ok: bool, detail: str = "") -> None:
    RESULTS.append((name, ok, detail))
    print(f"[{'PASS' if ok else 'FAIL'}] {name}{' — ' + detail if detail else ''}", flush=True)
    if not ok:
        raise SystemExit(1)


def wait(predicate, timeout: float, interval: float = 0.5):
    deadline = time.monotonic() + timeout
    last = None
    while time.monotonic() < deadline:
        try:
            last = predicate()
            if last:
                return last
        except Exception as exc:  # noqa: BLE001
            last = exc
        time.sleep(interval)
    raise TimeoutError(f"Hết thời gian chờ ({last})")


def port_open(port: int) -> bool:
    with socket.socket() as s:
        s.settimeout(0.5)
        return s.connect_ex(("127.0.0.1", port)) == 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--catalog", choices=["full", "sample"], default="full")
    args = ap.parse_args()
    work = Path(tempfile.mkdtemp(prefix="smc-e2e-"))
    cluster = LocalCluster(work / "pg", free_port(), find_pg_bin())
    cluster.start()
    admin_execute(cluster.url(), "CREATE DATABASE smart_medicine")
    db_url = cluster.url("smart_medicine")
    public_port, admin_port = free_port(), free_port()
    env = {**os.environ, "DATABASE_URL": db_url, "SMC_DATA_DIR": str(work / "data"), "SMC_ENV_FILE": str(work / "none.env"),
           "SMC_PUBLIC_PORT": str(public_port), "SMC_ADMIN_PORT": str(admin_port), "PYTHONUTF8": "1", "PYTHONIOENCODING": "utf-8",
           "SMC_PUBLIC_BASE_URL": f"http://127.0.0.1:{public_port}"}
    env.pop("SMC_OCR_DEFAULT_ENGINE", None)
    if args.catalog == "sample":
        env["SMC_CATALOG_XLSX"] = str(ROOT / "tests" / "fixtures" / "catalog_sample.xlsx")
    flags = subprocess.CREATE_NEW_PROCESS_GROUP if sys.platform == "win32" else 0
    log = open(work / "server.out", "w", encoding="utf-8")
    server = subprocess.Popen([PY, "-m", "app.server"], cwd=BACKEND, env=env, stdout=log, stderr=subprocess.STDOUT, creationflags=flags)
    sim = None
    try:
        pub = f"http://127.0.0.1:{public_port}"
        adm = f"http://127.0.0.1:{admin_port}"
        wait(lambda: httpx.get(pub + "/api/v1/health", timeout=2).status_code == 200 and httpx.get(adm + "/api/health", timeout=2).status_code == 200, 90)
        step("1. Máy chủ chạy 2 cổng (Public + Admin), migration tự chạy", True, f"public :{public_port}, admin :{admin_port}")
        step("1b. Cả hai cổng chỉ nghe 127.0.0.1", all(
            c.laddr.ip in ("127.0.0.1", "::1") for c in __import__("psutil").Process(server.pid).net_connections() if c.status == "LISTEN"))

        r = subprocess.run([PY, "-m", "app.cli", "create-admin", "--email", "admin@example.com", "--name", "Quản trị E2E"], cwd=BACKEND,
                           env={**env, "SMC_ADMIN_PASSWORD": "QuanTri2026"}, capture_output=True, text=True, encoding="utf-8")
        step("2. Tạo tài khoản Admin bằng CLI", r.returncode == 0, r.stdout.strip() or r.stderr.strip()[-200:])

        admin = httpx.Client(base_url=adm, timeout=30)
        tok = admin.post("/api/auth/login", json={"email": "admin@example.com", "password": "QuanTri2026"}).json()
        admin.headers["Authorization"] = "Bearer " + tok["access_token"]
        step("3. Admin đăng nhập kênh Admin", admin.get("/api/auth/me").json()["user"]["role"] == "ADMIN")

        public = httpx.Client(base_url=pub, timeout=30)
        reg = public.post("/api/v1/auth/register", json={"full_name": "Người quét", "email": "scanner@example.com", "password": "Scanner2026"})
        scanner_h = {"Authorization": "Bearer " + reg.json()["access_token"]}
        step("4. Scanner đăng ký qua kênh Public", reg.status_code == 201 and reg.json()["user"]["role"] == "SCANNER")
        cross = [
            httpx.get(adm + "/api/settings", headers=scanner_h).status_code,
            httpx.post(adm + "/api/auth/login", json={"email": "scanner@example.com", "password": "Scanner2026"}).status_code,
            httpx.get(pub + "/api/v1/me", headers={"Authorization": admin.headers["Authorization"]}).status_code,
            httpx.post(pub + "/api/cabinet/medicines", headers=scanner_h, json={"name": "x"}).status_code,
            httpx.get(adm + "/api/settings", headers={**admin.headers, "CF-Connecting-IP": "1.2.3.4"}).status_code,
        ]
        step("5. Tách kênh: token Scanner/Admin không dùng chéo, Public không có API quản trị, Admin chặn Cloudflare",
             cross == [401, 403, 401, 404, 403], str(cross))

        count = wait(lambda: (n := admin.get("/api/catalog/status").json()["count"]) and not admin.get("/api/catalog/status").json()["progress"]["running"] and n, 240, 2)
        step("6. Danh mục tự nhập vào PostgreSQL khi khởi động lần đầu", count >= 799, f"{count:,} thuốc".replace(",", "."))

        dev = admin.post("/api/devices", json={"name": "Tủ thuốc E2E"}).json()
        sim = subprocess.Popen([PY, str(ROOT / "scripts" / "esp32_simulator.py"), "--url", f"ws://127.0.0.1:{public_port}/api/v1/device/ws",
                                "--token", dev["token"], "--interval", "2"], cwd=ROOT, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        status = wait(lambda: (s := admin.get("/api/device/status").json())["state"] == "connected" and s, 30)
        step("7. ESP32 (mô phỏng) kết nối WS ra ngoài, số đo hiển thị kèm nhãn mô phỏng",
             status["temperature"] is not None and status["simulated"] is True, f"{status['temperature']}°C / {status['humidity']}%")
        cmd = admin.post(f"/api/devices/{dev['device']['id']}/commands", json={"action": "buzzer", "payload": {"on": True}}).json()
        done = wait(lambda: (c := admin.get(f"/api/commands/{cmd['id']}").json())["final"] and c, 20)
        step("8. Lệnh còi qua Internet: sent → acknowledged → applied (ACK từ thiết bị)",
             done["status"] == "applied" and [a["status"] for a in done["acks"]] == ["received", "applied"], done["status"])

        image = ROOT / "tests" / "fixtures" / "ocr" / "01_ro_net_augmentin_625.jpg"
        job = public.post("/api/v1/scans", headers=scanner_h, data={"source": "camera"}, files={"file": (image.name, image.read_bytes(), "image/jpeg")}).json()
        t0 = time.monotonic()
        result = wait(lambda: (j := public.get(f"/api/v1/scans/{job['id']}", headers=scanner_h).json())["status"] in ("done", "error") and j, 180, 0.3)
        top = (result["result"] or {}).get("match", {}).get("candidates", [{}])[0].get("medicine", {})
        engine = admin.get("/api/ocr/status").json()["engine"]
        step("9. Scanner quét ảnh thật → PaddleOCR trên máy chủ → PostgreSQL → ≤3 ứng viên",
             result["status"] == "done" and "Augmentin" in (top.get("ten_thuoc") or "") and len(result["result"]["match"]["candidates"]) <= 3,
             f"{top.get('ten_thuoc')} · {time.monotonic() - t0:.1f}s · engine={engine.get('engine')} device={engine.get('device')} gpu={engine.get('gpu_name')}")
        hist = public.get("/api/v1/history", headers=scanner_h).json()["items"]
        step("10. Lịch sử quét của chính Scanner lưu trong PostgreSQL", len(hist) == 1 and "Augmentin" in hist[0]["title"])
        backup = admin.post("/api/backup").json()
        step("11. Sao lưu pg_dump qua API Admin", backup.get("name", "").endswith(".dump"), f"{backup.get('size', 0) / 1e6:.1f} MB")

        if sys.platform == "win32":
            server.send_signal(signal.CTRL_BREAK_EVENT)
        else:
            server.send_signal(signal.SIGINT)
        server.wait(timeout=60)
        step("12. Dừng máy chủ bằng tín hiệu → đóng cả hai cổng", not port_open(public_port) and not port_open(admin_port), f"mã thoát {server.returncode}")
    finally:
        if sim is not None:
            sim.kill()
        if server.poll() is None:
            server.kill()
        log.close()
        cluster.destroy()
    print(f"\nKết quả: {sum(ok for _, ok, _ in RESULTS)}/{len(RESULTS)} đạt. Nhật ký máy chủ: {work / 'server.out'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
