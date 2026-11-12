"""Điểm vào FastAPI của Tủ thuốc thông minh."""
from __future__ import annotations

import asyncio
import logging
from contextlib import asynccontextmanager
from typing import Any, Callable

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from starlette.middleware.trustedhost import TrustedHostMiddleware

from app import __version__
from app.api import alerts, backup, cabinet, catalog, device, health, history, medicines, notifications, ocr, profile, reminders
from app.api import settings as settings_api
from app.core.config import Settings, load_settings
from app.core.context import AppContext
from app.core.security import TokenMiddleware
from app.services import settings_store
from app.services.alerts import engine as alert_engine
from app.services.medicine_matcher.catalog import CatalogRepository

log = logging.getLogger("smc")
MEDICINE_ALERT_INTERVAL = 15 * 60  # giây


def _startup_checks(ctx: AppContext) -> None:
    """Kiểm tra CSDL, danh mục; tự nhập file Excel đi kèm ở lần chạy đầu."""
    try:
        healthy = ctx.db.check()
    except Exception:
        healthy = False
    with ctx.db.session() as s:
        if healthy:
            alert_engine.resolve_system(s, "database_error")
        else:
            alert_engine.raise_system(s, "database_error", "Kiểm tra toàn vẹn cơ sở dữ liệu thất bại. Hãy khôi phục từ bản sao lưu.")
        settings = settings_store.load_settings(s)
        count = CatalogRepository(s).count()
        alert_engine.evaluate_medicines(s, settings)
        default = ctx.settings.find_default_catalog()
        if count == 0 and default is None:
            alert_engine.raise_system(s, "catalog_missing", "Hãy chọn file DAV_unique.xlsx trong Cài đặt → Dữ liệu thuốc.")
    if count == 0 and default is not None and ctx.settings.start_background_tasks:
        log.info("Danh mục trống — tự nhập %s", default)
        ctx.imports.start(default)
    ctx.ocr.purge_orphan_uploads()


async def _medicine_alert_loop(ctx: AppContext) -> None:
    while True:
        await asyncio.sleep(MEDICINE_ALERT_INTERVAL)
        try:
            def _evaluate() -> None:
                with ctx.db.session() as s:
                    alert_engine.evaluate_medicines(s, settings_store.load_settings(s))

            await asyncio.to_thread(_evaluate)
        except Exception:
            log.exception("Không đánh giá được cảnh báo thuốc")


def create_app(
    settings: Settings | None = None,
    *,
    ocr_engine_factory: Callable[..., Any] | None = None,
    device_adapter_factory: Callable[..., Any] | None = None,
) -> FastAPI:
    settings = settings or load_settings()
    ctx = AppContext(settings, ocr_engine_factory=ocr_engine_factory, device_adapter_factory=device_adapter_factory)

    @asynccontextmanager
    async def lifespan(app: FastAPI):  # noqa: ANN202
        await asyncio.to_thread(_startup_checks, ctx)
        with ctx.db.session() as s:
            user_settings = settings_store.load_settings(s)
        await ctx.device.configure(user_settings)
        tasks: list[asyncio.Task] = []
        if settings.start_background_tasks:
            ctx.device.start()
            tasks.append(asyncio.create_task(_medicine_alert_loop(ctx), name="medicine-alerts"))
        yield
        for task in tasks:
            task.cancel()
        await ctx.device.stop()
        ctx.close()

    app = FastAPI(
        title="Tủ thuốc thông minh — API cục bộ",
        version=__version__,
        lifespan=lifespan,
        docs_url="/api/docs",
        openapi_url="/api/openapi.json",
        redoc_url=None,
    )
    app.state.ctx = ctx

    # Thứ tự: middleware thêm sau sẽ chạy trước.
    app.add_middleware(TokenMiddleware, token=settings.api_token)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["http://localhost:5173", "http://127.0.0.1:5173", "null", "file://"],
        allow_origin_regex=r"^(app|file)://.*$",
        allow_methods=["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
        allow_headers=["Content-Type", "X-SMC-Token"],
        expose_headers=["Content-Disposition"],
        max_age=600,
    )
    # Chống DNS rebinding: chỉ chấp nhận Host cục bộ.
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=["127.0.0.1", "localhost", "testserver"])

    @app.exception_handler(RequestValidationError)
    async def _validation(_: Request, exc: RequestValidationError) -> JSONResponse:
        errors = exc.errors()
        first = errors[0] if errors else {}
        field = ".".join(str(p) for p in first.get("loc", ())[1:])
        message = str(first.get("msg", "Dữ liệu không hợp lệ")).replace("Value error, ", "")
        detail = f"{field}: {message}" if field and not message[:1].isupper() else message
        return JSONResponse({"detail": detail, "errors": [{"loc": list(e.get("loc", ())), "msg": e.get("msg")} for e in errors]}, status_code=422)

    @app.exception_handler(Exception)
    async def _unhandled(_: Request, exc: Exception) -> JSONResponse:
        log.exception("Lỗi không mong muốn: %s", exc)
        return JSONResponse({"detail": "Lỗi máy chủ cục bộ. Xem nhật ký để biết chi tiết."}, status_code=500)

    for module in (health, medicines, catalog, ocr, cabinet, reminders, alerts, history, device, settings_api, profile, backup, notifications):
        app.include_router(module.router, prefix="/api")
    return app
