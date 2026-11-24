"""Cụm PostgreSQL tạm thời cho phát triển và kiểm thử (KHÔNG dùng cho production).

Dùng chính bộ cài PostgreSQL trên máy (initdb/pg_ctl) để tạo một cụm riêng trong thư mục
của người dùng, chỉ nghe 127.0.0.1, xác thực `trust`. Nhờ vậy kiểm thử chạy trên PostgreSQL
thật mà không cần mật khẩu superuser của dịch vụ PostgreSQL chính và không đụng tới nó.
"""
from __future__ import annotations

import os
import shutil
import socket
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path

SUPERUSER = "smc_dev"


def find_pg_bin() -> Path:
    """Thư mục chứa initdb/pg_ctl: SMC_PG_BIN → PATH → vị trí cài mặc định trên Windows."""
    env = os.environ.get("SMC_PG_BIN")
    candidates: list[Path] = [Path(env)] if env else []
    found = shutil.which("pg_ctl")
    if found:
        candidates.append(Path(found).parent)
    if sys.platform == "win32":
        base = Path(os.environ.get("ProgramFiles", r"C:\Program Files")) / "PostgreSQL"
        if base.is_dir():
            candidates += sorted((p / "bin" for p in base.iterdir()), key=lambda p: p.parent.name, reverse=True)
    else:
        candidates += sorted(Path("/usr/lib/postgresql").glob("*/bin"), reverse=True)
    exe = ".exe" if sys.platform == "win32" else ""
    for c in candidates:
        if (c / f"initdb{exe}").is_file() and (c / f"pg_ctl{exe}").is_file():
            return c
    raise FileNotFoundError("Không tìm thấy initdb/pg_ctl. Cài PostgreSQL hoặc đặt biến SMC_PG_BIN.")


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@dataclass
class LocalCluster:
    data_dir: Path
    port: int
    bin_dir: Path

    @property
    def exe(self) -> str:
        return ".exe" if sys.platform == "win32" else ""

    def _tool(self, name: str) -> str:
        return str(self.bin_dir / f"{name}{self.exe}")

    def url(self, database: str = "postgres") -> str:
        return f"postgresql+psycopg://{SUPERUSER}@127.0.0.1:{self.port}/{database}"

    @property
    def log_file(self) -> Path:
        return self.data_dir.parent / f"{self.data_dir.name}.log"

    def initialized(self) -> bool:
        return (self.data_dir / "PG_VERSION").is_file()

    def init(self) -> None:
        if self.initialized():
            return
        self.data_dir.parent.mkdir(parents=True, exist_ok=True)
        subprocess.run(
            [self._tool("initdb"), "-D", str(self.data_dir), "-U", SUPERUSER, "--auth=trust", "-E", "UTF8", "--locale=C"],
            check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
        )

    def running(self) -> bool:
        result = subprocess.run([self._tool("pg_ctl"), "-D", str(self.data_dir), "status"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        return result.returncode == 0

    def start(self) -> None:
        self.init()
        if self.running():
            return
        options = f"-p {self.port} -c listen_addresses=127.0.0.1 -c fsync=off -c synchronous_commit=off -c full_page_writes=off"
        # stdout/stderr không được kế thừa ống dẫn của tiến trình cha (pg_ctl để postgres chạy nền).
        subprocess.run(
            [self._tool("pg_ctl"), "-D", str(self.data_dir), "-o", options, "-l", str(self.log_file), "-w", "-t", "60", "start"],
            check=True, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            close_fds=True,
        )
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            if subprocess.run([self._tool("pg_isready"), "-h", "127.0.0.1", "-p", str(self.port)], stdout=subprocess.DEVNULL).returncode == 0:
                return
            time.sleep(0.3)
        raise RuntimeError(f"PostgreSQL tạm không khởi động được (xem {self.log_file}).")

    def stop(self) -> None:
        if self.initialized() and self.running():
            subprocess.run(
                [self._tool("pg_ctl"), "-D", str(self.data_dir), "-m", "fast", "-w", "stop"],
                stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            )

    def destroy(self) -> None:
        self.stop()
        shutil.rmtree(self.data_dir, ignore_errors=True)
        self.log_file.unlink(missing_ok=True)


def admin_execute(url: str, *statements: str) -> None:
    """Chạy lệnh ngoài transaction (CREATE/DROP DATABASE) bằng psycopg."""
    import psycopg

    plain = url.replace("postgresql+psycopg://", "postgresql://")
    with psycopg.connect(plain, autocommit=True) as conn:
        for sql in statements:
            conn.execute(sql)
