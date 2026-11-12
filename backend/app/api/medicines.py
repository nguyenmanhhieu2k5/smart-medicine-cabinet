"""Danh mục thuốc (dữ liệu Excel) — chỉ đọc."""
from __future__ import annotations

from fastapi import APIRouter, Depends, Query

from app.api.deps import get_ctx, not_found
from app.core.context import AppContext
from app.models import CabinetItem
from app.services.medicine_matcher.catalog import CatalogRepository, medicine_detail
from sqlalchemy import func, select

router = APIRouter(prefix="/medicines", tags=["medicines"])


@router.get("/search")
def search(
    q: str = Query("", max_length=200, description="Tên thuốc, hoạt chất, hàm lượng hoặc số đăng ký"),
    limit: int = Query(20, ge=1, le=50),
    offset: int = Query(0, ge=0, le=5000),
    ctx: AppContext = Depends(get_ctx),
) -> dict:
    with ctx.db.session() as s:
        repo = CatalogRepository(s)
        result = repo.search(q, limit=limit, offset=offset)
        result["catalog_count"] = repo.count()
        return result


@router.get("/{medicine_id}")
def detail(medicine_id: int, ctx: AppContext = Depends(get_ctx)) -> dict:
    with ctx.db.session() as s:
        row = CatalogRepository(s).get(medicine_id)
        if row is None:
            raise not_found("Không tìm thấy thuốc trong danh mục.")
        data = medicine_detail(row)
        data["in_cabinet_count"] = s.scalar(
            select(func.count()).select_from(CabinetItem).where(CabinetItem.catalog_id == medicine_id)
        ) or 0
        return data
