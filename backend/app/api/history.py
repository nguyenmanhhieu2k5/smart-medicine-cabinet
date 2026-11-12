"""Lịch sử hoạt động."""
from __future__ import annotations

from datetime import date, datetime, time
from pathlib import Path

from fastapi import APIRouter, Depends, Query
from fastapi.responses import FileResponse
from sqlalchemy import delete, func, or_, select

from app.api.deps import get_ctx, not_found
from app.core.context import AppContext
from app.models import HistoryEvent
from app.services import history

router = APIRouter(prefix="/history", tags=["history"])


@router.get("")
def list_history(
    q: str = Query("", max_length=200),
    group: str = Query("all", pattern="^(all|scan|cabinet|reminder|alert|system)$"),
    start: date | None = Query(None, alias="from"),
    end: date | None = Query(None, alias="to"),
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    ctx: AppContext = Depends(get_ctx),
) -> dict:
    with ctx.db.session() as s:
        query = select(HistoryEvent)
        if group != "all":
            query = query.where(HistoryEvent.group == group)
        if start:
            query = query.where(HistoryEvent.created_at >= datetime.combine(start, time.min))
        if end:
            query = query.where(HistoryEvent.created_at <= datetime.combine(end, time.max))
        if q.strip():
            like = f"%{q.strip()}%"
            query = query.where(or_(HistoryEvent.title.like(like), HistoryEvent.description.like(like)))
        total = s.scalar(select(func.count()).select_from(query.subquery())) or 0
        events = s.scalars(
            query.order_by(HistoryEvent.created_at.desc(), HistoryEvent.id.desc()).offset((page - 1) * page_size).limit(page_size)
        ).all()
        return {
            "items": [history.serialize(e) for e in events],
            "total": total, "page": page, "page_size": page_size, "pages": max(1, -(-total // page_size)),
        }


@router.get("/{event_id}")
def get_event(event_id: int, ctx: AppContext = Depends(get_ctx)) -> dict:
    with ctx.db.session() as s:
        event = s.get(HistoryEvent, event_id)
        if event is None:
            raise not_found("Không tìm thấy hoạt động.")
        return history.serialize(event)


@router.get("/{event_id}/image")
def get_event_image(event_id: int, ctx: AppContext = Depends(get_ctx)) -> FileResponse:
    with ctx.db.session() as s:
        event = s.get(HistoryEvent, event_id)
        path = event.image_path if event else None
    if not path or not Path(path).is_file() or Path(path).resolve().parent != ctx.settings.images_dir.resolve():
        raise not_found("Không có ảnh cho hoạt động này.")
    return FileResponse(path, media_type="image/jpeg", headers={"Cache-Control": "no-store"})


@router.delete("/{event_id}")
def delete_event(event_id: int, ctx: AppContext = Depends(get_ctx)) -> dict:
    with ctx.db.session() as s:
        event = s.get(HistoryEvent, event_id)
        if event is None:
            raise not_found("Không tìm thấy hoạt động.")
        s.delete(event)
    return {"deleted": 1}


@router.delete("")
def clear_history(
    before: date | None = Query(None, description="Chỉ xóa các hoạt động trước ngày này"),
    ctx: AppContext = Depends(get_ctx),
) -> dict:
    with ctx.db.session() as s:
        statement = delete(HistoryEvent)
        if before:
            statement = statement.where(HistoryEvent.created_at < datetime.combine(before, time.min))
        deleted = s.execute(statement).rowcount or 0
    removed_images = ctx.ocr.purge_orphan_uploads()
    return {"deleted": deleted, "removed_images": removed_images}
