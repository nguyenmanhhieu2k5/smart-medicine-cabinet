from __future__ import annotations

from fastapi import APIRouter, Depends

from app import __version__
from app.api.deps import get_ctx
from app.core import clock
from app.core.context import AppContext
from app.services.medicine_matcher.catalog import CatalogRepository

router = APIRouter(tags=["health"])


@router.get("/health")
def health(ctx: AppContext = Depends(get_ctx)) -> dict:
    db_ok, catalog_count = True, 0
    try:
        with ctx.db.session() as s:
            catalog_count = CatalogRepository(s).count()
    except Exception:
        db_ok = False
    return {
        "status": "ok" if db_ok else "degraded",
        "version": __version__,
        "time": clock.now().isoformat(),
        "database": "ok" if db_ok else "error",
        "catalog_count": catalog_count,
        "ocr": ctx.ocr.status()["state"],
        "import_running": ctx.imports.is_running(),
    }
