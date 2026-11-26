"""Dựng ứng dụng FastAPI cho từng kênh của máy chủ Mini PC.

- ``channel="admin"``  → API quản trị (cổng 8001, ra ngoài qua Tailscale), đường dẫn ``/api/...``.
- ``channel="public"`` → API công khai (cổng 8000, ra ngoài qua Tailscale Funnel hoặc Cloudflare Tunnel), đường dẫn ``/api/v1/...``.

Hai ứng dụng dùng chung một :class:`AppContext` (CSDL, OCR, hub thiết bị) khi chạy bằng ``app.server``.
"""
from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from typing import Any, Callable

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from starlette.middleware.trustedhost import TrustedHostMiddleware
from starlette.types import ASGIApp, Receive, Scope, Send

from app import __version__
from app.api import (
    admin_auth, admin_misc, admin_users, ai, alerts, backup, cabinet, catalog, device, guest, health, history, medicines,
    notifications, ocr, profile, public, reminders, tts,
)
from app.api import settings as settings_api
from app.auth.deps import require, require_admin_channel, require_by_method
from app.auth.ratelimit import RateLimitExceeded
from app.auth.service import AuthError
from app.core.config import Settings, load_settings
from app.core.context import AppContext
from app.database.session import DatabaseError
from app.web import mount_web

log = logging.getLogger("smc")

CLOUDFLARE_HEADERS = (b"cf-ray", b"cf-connecting-ip", b"cf-ipcountry", b"cf-visitor")
# Tailscale Funnel (kênh công khai qua Internet) gắn header này vào mọi yêu cầu đi qua Funnel.
FUNNEL_HEADERS = (b"tailscale-funnel-request",)
PUBLIC_PROXY_HEADERS = CLOUDFLARE_HEADERS + FUNNEL_HEADERS


class RejectPublicProxyMiddleware:
    """Cổng Admin không bao giờ phục vụ yêu cầu đi qua kênh công khai (Cloudflare Tunnel hoặc Tailscale Funnel) —
    phòng trường hợp cấu hình nhầm cổng."""

    def __init__(self, app: ASGIApp):
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] in ("http", "websocket"):
            names = {k.lower() for k, _ in scope.get("headers", [])}
            if any(h in names for h in PUBLIC_PROXY_HEADERS):
                if scope["type"] == "websocket":
                    await send({"type": "websocket.close", "code": 1008})
                    return
                response = JSONResponse({"detail": "Kênh quản trị chỉ truy cập được qua mạng quản trị (Tailscale)."}, status_code=403)
                await response(scope, receive, send)
                return
        await self.app(scope, receive, send)


class SecurityHeadersMiddleware:
    def __init__(self, app: ASGIApp):
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        async def send_wrapper(message: dict[str, Any]) -> None:
            if message["type"] == "http.response.start":
                headers = list(message.get("headers", []))
                names = {k.lower() for k, _ in headers}
                for key, value in ((b"x-content-type-options", b"nosniff"), (b"referrer-policy", b"no-referrer"),
                                   (b"x-frame-options", b"DENY")):
                    if key not in names:
                        headers.append((key, value))
                if b"cache-control" not in names:
                    headers.append((b"cache-control", b"no-store"))
                message["headers"] = headers
            await send(message)

        await self.app(scope, receive, send_wrapper)


def create_app(
    settings: Settings | None = None,
    *,
    channel: str = "admin",
    ctx: AppContext | None = None,
    ocr_engine_factory: Callable[..., Any] | None = None,
    mailer: Any = None,
    manage_lifecycle: bool | None = None,
) -> FastAPI:
    if channel not in ("admin", "public"):
        raise ValueError("channel phải là 'admin' hoặc 'public'")
    owned = ctx is None
    if ctx is None:
        ctx = AppContext(settings or load_settings(), ocr_engine_factory=ocr_engine_factory, mailer=mailer)
    manage = owned if manage_lifecycle is None else manage_lifecycle
    settings = ctx.settings

    @asynccontextmanager
    async def lifespan(app: FastAPI):  # noqa: ANN202
        if manage:
            await ctx.startup()
        yield
        if manage:
            await ctx.shutdown()

    is_admin = channel == "admin"
    app = FastAPI(
        title="Tủ thuốc thông minh — " + ("API quản trị" if is_admin else "API công khai"),
        version=__version__,
        lifespan=lifespan,
        docs_url="/api/docs" if is_admin else None,
        openapi_url="/api/openapi.json" if is_admin else None,
        redoc_url=None,
    )
    app.state.ctx = ctx
    app.state.channel = channel

    # Thứ tự: middleware thêm sau sẽ chạy trước.
    app.add_middleware(SecurityHeadersMiddleware)
    if is_admin:
        app.add_middleware(
            CORSMiddleware,
            allow_origins=["http://localhost:5173", "http://127.0.0.1:5173", "null", "file://"],
            allow_origin_regex=r"^(app|file)://.*$",
            allow_methods=["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
            allow_headers=["Authorization", "Content-Type", "X-SMC-Client"],
            expose_headers=["Content-Disposition"],
            max_age=600,
        )
        app.add_middleware(TrustedHostMiddleware, allowed_hosts=settings.admin_allowed_hosts)
        app.add_middleware(RejectPublicProxyMiddleware)
    elif settings.cors_origins:
        app.add_middleware(
            CORSMiddleware, allow_origins=settings.cors_origins, allow_methods=["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
            allow_headers=["Authorization", "Content-Type", "X-SMC-Client"], max_age=600,
        )

    @app.exception_handler(RequestValidationError)
    async def _validation(_: Request, exc: RequestValidationError) -> JSONResponse:
        errors = exc.errors()
        first = errors[0] if errors else {}
        field = ".".join(str(p) for p in first.get("loc", ())[1:])
        message = str(first.get("msg", "Dữ liệu không hợp lệ")).replace("Value error, ", "")
        detail = f"{field}: {message}" if field and not message[:1].isupper() else message
        return JSONResponse({"detail": detail, "errors": [{"loc": list(e.get("loc", ())), "msg": e.get("msg")} for e in errors]}, status_code=422)

    @app.exception_handler(AuthError)
    async def _auth(_: Request, exc: AuthError) -> JSONResponse:
        return JSONResponse({"detail": exc.message, "code": exc.code}, status_code=exc.status_code)

    @app.exception_handler(RateLimitExceeded)
    async def _rate(_: Request, exc: RateLimitExceeded) -> JSONResponse:
        return JSONResponse({"detail": str(exc), "code": "rate_limited"}, status_code=429, headers={"Retry-After": str(exc.retry_after)})

    @app.exception_handler(DatabaseError)
    async def _db(_: Request, exc: DatabaseError) -> JSONResponse:
        log.error("Lỗi CSDL: %s", exc)
        return JSONResponse({"detail": "Máy chủ tạm thời không truy cập được cơ sở dữ liệu.", "code": "database"}, status_code=503)

    @app.exception_handler(Exception)
    async def _unhandled(_: Request, exc: Exception) -> JSONResponse:
        if isinstance(exc, HTTPException):  # pragma: no cover — FastAPI tự xử lý
            raise exc
        log.exception("Lỗi không mong muốn: %s", exc)
        return JSONResponse({"detail": "Lỗi máy chủ. Quản trị viên xem nhật ký để biết chi tiết."}, status_code=500)

    if is_admin:
        admin_only = [Depends(require_admin_channel)]
        app.include_router(health.router, prefix="/api")
        app.include_router(admin_auth.router, prefix="/api")
        guarded = [
            (medicines.router, [Depends(require("catalog:read"))]),
            (catalog.router, [Depends(require("catalog:manage"))]),
            (ocr.router, [Depends(require("scan:create"))]),
            (ai.router, [Depends(require("scan:create"))]),
            (cabinet.router, [Depends(require_by_method("cabinet:read", "cabinet:write"))]),
            (reminders.router, [Depends(require("reminders:manage"))]),
            (alerts.router, [Depends(require("alerts:manage"))]),
            (history.router, [Depends(require("history:read"))]),
            (notifications.router, [Depends(require("alerts:manage"))]),
            (settings_api.router, [Depends(require("settings:manage"))]),
            (device.router, []),
            (profile.router, []),
            (tts.router, []),
            (backup.router, []),
            (admin_users.router, []),
            (admin_misc.router, []),
        ]
        for router, deps in guarded:
            app.include_router(router, prefix="/api", dependencies=admin_only + deps)
    else:
        app.include_router(public.router)
        app.include_router(guest.router)
        if settings.web_dir:
            mount_web(app, settings.web_dir)  # đăng ký SAU CÙNG: không che route API nào
    return app
