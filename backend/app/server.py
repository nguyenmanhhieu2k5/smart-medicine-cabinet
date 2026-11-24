"""Chạy máy chủ trên Mini PC: ``python -m app.server`` (dịch vụ Windows gọi lệnh này).

Một tiến trình, hai cổng (đều chỉ nghe 127.0.0.1):
- Public  ``SMC_PUBLIC_PORT`` (mặc định 8000) ← Tailscale Funnel hoặc Cloudflare Tunnel (mobile + ESP32)
- Admin   ``SMC_ADMIN_PORT``  (mặc định 8001) ← tailscale serve (ứng dụng Windows)
"""
from __future__ import annotations

import asyncio
import contextlib
import logging
import logging.handlers
import signal
import sys

import uvicorn

from app.core.config import Settings, load_settings
from app.core.context import AppContext
from app.database import migrate
from app.database.session import redact_url
from app.main import create_app

log = logging.getLogger("smc")


class _Server(uvicorn.Server):
    """Không để từng server tự cài bộ bắt tín hiệu (hai server dùng chung một vòng lặp)."""

    @contextlib.contextmanager
    def capture_signals(self):  # noqa: ANN201
        yield

    def install_signal_handlers(self) -> None:  # uvicorn cũ
        return


def setup_logging(settings: Settings) -> None:
    settings.logs_dir.mkdir(parents=True, exist_ok=True)
    fmt = logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s")
    root = logging.getLogger()
    root.setLevel(logging.INFO)
    file_handler = logging.handlers.RotatingFileHandler(settings.logs_dir / "server.log", maxBytes=5_000_000, backupCount=5, encoding="utf-8")
    file_handler.setFormatter(fmt)
    console = logging.StreamHandler(sys.stderr)
    console.setFormatter(fmt)
    root.handlers = [file_handler, console]


async def serve(ctx: AppContext) -> None:
    settings = ctx.settings
    public_app = create_app(ctx=ctx, channel="public", manage_lifecycle=False)
    admin_app = create_app(ctx=ctx, channel="admin", manage_lifecycle=False)
    common = {"log_level": "warning", "access_log": False, "proxy_headers": False, "ws_max_size": 65536,
              "timeout_graceful_shutdown": 10}
    servers = [
        _Server(uvicorn.Config(public_app, host=settings.public_host, port=settings.public_port, **common)),
        _Server(uvicorn.Config(admin_app, host=settings.admin_host, port=settings.admin_port, **common)),
    ]

    def stop(*_: object) -> None:
        log.info("Đang dừng máy chủ…")
        for srv in servers:
            srv.should_exit = True

    for sig in (signal.SIGINT, signal.SIGTERM, getattr(signal, "SIGBREAK", None)):
        if sig is not None:
            try:
                signal.signal(sig, stop)
            except (ValueError, OSError):
                pass

    await ctx.startup()
    log.info("Public API: http://%s:%d/api/v1  |  Admin API: http://%s:%d/api",
             settings.public_host, settings.public_port, settings.admin_host, settings.admin_port)
    try:
        await asyncio.gather(*(srv.serve() for srv in servers))
    finally:
        await ctx.shutdown()


def main() -> None:
    settings = load_settings()
    setup_logging(settings)
    if not settings.database_url:
        log.error("Thiếu DATABASE_URL — chạy deploy\\postgres\\setup-postgres.ps1 trước.")
        raise SystemExit(2)
    log.info("CSDL: %s", redact_url(settings.database_url))
    if settings.auto_migrate:
        migrate.upgrade(settings.database_url)
    ctx = AppContext(settings)
    asyncio.run(serve(ctx))


if __name__ == "__main__":
    main()
