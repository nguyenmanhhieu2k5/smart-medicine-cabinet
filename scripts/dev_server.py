"""Máy chủ DÙNG MỘT LẦN để chạy thử ứng dụng Windows khi chưa cài dịch vụ thật trên Mini PC.

    backend\\.venv\\Scripts\\python scripts\\dev_server.py                     (danh mục mẫu, có ESP32 mô phỏng)
    backend\\.venv\\Scripts\\python scripts\\dev_server.py --catalog full      (nhập DAV_unique.xlsx thật)

Tạo cụm PostgreSQL tạm (initdb của PostgreSQL 17 đã cài) → chạy `python -m app.server` (cổng Public + Admin trên
127.0.0.1) → tạo tài khoản Admin với mật khẩu NGẪU NHIÊN → (tuỳ chọn) chạy trình mô phỏng ESP32.
In ra một dòng `SMC_READY {...json...}` gồm địa chỉ và thông tin đăng nhập, rồi chờ.

Dừng bằng Ctrl+C hoặc khi tiến trình cha đóng stdin → dừng máy chủ, XÓA cụm PostgreSQL tạm.
KHÔNG dùng cho dữ liệu thật: dữ liệu thật nằm trong PostgreSQL cài bằng deploy\\postgres\\setup-postgres.ps1.
"""
from __future__ import annotations

import argparse
import json
import os
import secrets
import signal
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parents[1]
BACKEND = ROOT / "backend"
sys.path.insert(0, str(BACKEND))

from app.database.cluster import LocalCluster, admin_execute, find_pg_bin, free_port  # noqa: E402

PY = sys.executable


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


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--catalog", choices=["sample", "full"], default="sample")
    ap.add_argument("--no-simulator", action="store_true", help="không chạy trình mô phỏng ESP32")
    ap.add_argument("--email", default="admin@example.com")
    ap.add_argument("--public-port", type=int, default=0, help="cổng API công khai (mặc định: cổng trống bất kỳ)")
    ap.add_argument("--admin-port", type=int, default=0, help="cổng API quản trị (mặc định: cổng trống bất kỳ)")
    ap.add_argument("--cors", default="", help="origin được gọi API công khai từ trình duyệt, ví dụ http://127.0.0.1:19006 (bản web của mobile)")
    args = ap.parse_args()
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")

    work = Path(tempfile.mkdtemp(prefix="smc-devserver-"))
    cluster = LocalCluster(work / "pg", free_port(), find_pg_bin())
    server = sim = None
    stop = threading.Event()
    try:
        cluster.start()
        admin_execute(cluster.url(), "CREATE DATABASE smart_medicine")
        public_port, admin_port = args.public_port or free_port(), args.admin_port or free_port()
        env = {**os.environ, "DATABASE_URL": cluster.url("smart_medicine"), "SMC_DATA_DIR": str(work / "data"),
               "SMC_ENV_FILE": str(work / "none.env"), "SMC_PUBLIC_PORT": str(public_port), "SMC_ADMIN_PORT": str(admin_port),
               "SMC_PUBLIC_BASE_URL": f"http://127.0.0.1:{public_port}", "PYTHONUTF8": "1", "PYTHONIOENCODING": "utf-8",
               "SMC_CORS_ORIGINS": args.cors}
        if args.catalog == "sample":
            env["SMC_CATALOG_XLSX"] = str(ROOT / "tests" / "fixtures" / "catalog_sample.xlsx")
        flags = subprocess.CREATE_NEW_PROCESS_GROUP if sys.platform == "win32" else 0
        log = open(work / "server.out", "w", encoding="utf-8")  # noqa: SIM115
        server = subprocess.Popen([PY, "-m", "app.server"], cwd=BACKEND, env=env, stdout=log, stderr=subprocess.STDOUT,
                                  stdin=subprocess.DEVNULL, creationflags=flags)
        pub, adm = f"http://127.0.0.1:{public_port}", f"http://127.0.0.1:{admin_port}"
        wait(lambda: httpx.get(adm + "/api/health", timeout=2).status_code == 200 and httpx.get(pub + "/api/v1/health", timeout=2).status_code == 200, 120)

        password = "Smc" + secrets.token_urlsafe(12) + "9"  # ngẫu nhiên mỗi lần, không ghi ra file
        created = subprocess.run([PY, "-m", "app.cli", "create-admin", "--email", args.email, "--name", "Quản trị thử nghiệm"],
                                 cwd=BACKEND, env={**env, "SMC_ADMIN_PASSWORD": password}, capture_output=True, text=True, encoding="utf-8")
        if created.returncode != 0:
            raise RuntimeError(f"Không tạo được Admin: {created.stderr.strip() or created.stdout.strip()}")

        device_id = None
        if not args.no_simulator:
            client = httpx.Client(base_url=adm, timeout=30)
            token = client.post("/api/auth/login", json={"email": args.email, "password": password}).json()["access_token"]
            client.headers["Authorization"] = f"Bearer {token}"
            dev = client.post("/api/devices", json={"name": "Tủ thuốc thử nghiệm"}).json()
            device_id = dev["device"]["id"]
            client.close()
            sim = subprocess.Popen([PY, str(ROOT / "scripts" / "esp32_simulator.py"), "--url", f"ws://127.0.0.1:{public_port}/api/v1/device/ws",
                                    "--token", dev["token"], "--interval", "3"], cwd=ROOT, env=env,
                                   stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

        info = {"admin_url": adm, "public_url": pub, "email": args.email, "password": password, "device_id": device_id,
                "server_pid": server.pid, "work_dir": str(work), "log": str(work / "server.out")}
        print("SMC_READY " + json.dumps(info, ensure_ascii=False), flush=True)
        print(f"Ứng dụng Windows: đặt địa chỉ máy chủ {adm}, đăng nhập {args.email} / {password}", flush=True)
        print("Nhấn Ctrl+C để dừng và xóa dữ liệu tạm.", flush=True)

        def watch_stdin() -> None:
            try:
                while sys.stdin.read(1024):
                    pass
            except Exception:  # noqa: BLE001
                pass
            stop.set()

        if not sys.stdin.isatty():
            threading.Thread(target=watch_stdin, daemon=True).start()
        while not stop.is_set() and server.poll() is None:
            stop.wait(0.5)
        if server.poll() is not None:
            print(f"Máy chủ đã dừng bất thường (mã {server.returncode}). Xem {work / 'server.out'}", flush=True)
            return 1
        return 0
    except KeyboardInterrupt:
        return 0
    finally:
        if sim is not None:
            sim.kill()
        if server is not None and server.poll() is None:
            try:
                server.send_signal(signal.CTRL_BREAK_EVENT if sys.platform == "win32" else signal.SIGINT)
                server.wait(timeout=30)
            except Exception:  # noqa: BLE001
                server.kill()
        cluster.destroy()
        print("Đã dừng máy chủ thử nghiệm và xóa cụm PostgreSQL tạm.", flush=True)


if __name__ == "__main__":
    sys.exit(main())
