"""Cảnh báo môi trường, thuốc và hệ thống."""
from __future__ import annotations

from typing import Literal

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, Field
from sqlalchemy import select

from app.api.deps import get_ctx, not_found
from app.core import clock
from app.core.context import AppContext
from app.models import Alert
from app.services import settings_store
from app.services.alerts import engine as alert_engine

router = APIRouter(prefix="/alerts", tags=["alerts"])


class AlertAction(BaseModel):
    status: Literal["seen", "acknowledged"]


class SystemReport(BaseModel):
    type: Literal["camera_error"]
    message: str = Field("", max_length=300)
    resolved: bool = False


@router.get("")
def list_alerts(
    scope: str = Query("open", pattern="^(open|unhandled|all|resolved)$"),
    category: str = Query("all", pattern="^(all|environment|medicine|system)$"),
    severity: str = Query("all", pattern="^(all|normal|info|warning|danger)$"),
    limit: int = Query(100, ge=1, le=500),
    ctx: AppContext = Depends(get_ctx),
) -> dict:
    with ctx.db.session() as s:
        settings = settings_store.load_settings(s)
        alert_engine.evaluate_medicines(s, settings)  # hạn dùng đổi theo ngày → tính lại khi xem
        query = select(Alert)
        if scope == "open":
            query = query.where(Alert.status.in_(alert_engine.OPEN_STATUSES))
        elif scope == "unhandled":
            query = query.where(Alert.status.in_(alert_engine.UNHANDLED_STATUSES))
        elif scope == "resolved":
            query = query.where(Alert.status == "resolved")
        if category != "all":
            query = query.where(Alert.category == category)
        if severity != "all":
            query = query.where(Alert.severity == severity)
        alerts = list(s.scalars(query.order_by(Alert.updated_at.desc()).limit(limit)).all())
        alerts.sort(key=lambda a: (-alert_engine.SEVERITY_ORDER.get(a.severity, 0), a.status != "active", -a.id))
        open_alerts = s.scalars(select(Alert).where(Alert.status.in_(alert_engine.OPEN_STATUSES))).all()
        by_category = {"environment": 0, "medicine": 0, "system": 0}
        for alert in open_alerts:
            by_category[alert.category] = by_category.get(alert.category, 0) + 1
        return {
            "items": [alert_engine.serialize(a) for a in alerts],
            "unhandled": alert_engine.unhandled_count(s),
            "open": len(open_alerts),
            "by_category": by_category,
        }


@router.get("/count")
def count(ctx: AppContext = Depends(get_ctx)) -> dict:
    with ctx.db.session() as s:
        return {"unhandled": alert_engine.unhandled_count(s)}


@router.patch("/{alert_id}")
def update_alert(alert_id: int, body: AlertAction, ctx: AppContext = Depends(get_ctx)) -> dict:
    with ctx.db.session() as s:
        alert = s.get(Alert, alert_id)
        if alert is None:
            raise not_found("Không tìm thấy cảnh báo.")
        if alert.status != "resolved":
            order = {"active": 0, "seen": 1, "acknowledged": 2}
            if order[body.status] > order.get(alert.status, 0):
                alert.status = body.status
                alert.updated_at = clock.now()
        return alert_engine.serialize(alert)


@router.post("/mark-all")
def mark_all(body: AlertAction, ctx: AppContext = Depends(get_ctx)) -> dict:
    with ctx.db.session() as s:
        targets = ("active",) if body.status == "seen" else ("active", "seen")
        alerts = s.scalars(select(Alert).where(Alert.status.in_(targets))).all()
        for alert in alerts:
            alert.status = body.status
            alert.updated_at = clock.now()
        s.flush()
        return {"updated": len(alerts), "unhandled": alert_engine.unhandled_count(s)}


@router.post("/report")
def report(body: SystemReport, ctx: AppContext = Depends(get_ctx)) -> dict:
    """Giao diện báo lỗi phía người dùng (vd camera không mở được) hoặc báo đã hết lỗi."""
    with ctx.db.session() as s:
        if body.resolved:
            alert_engine.resolve_system(s, body.type)
        else:
            alert_engine.raise_system(s, body.type, body.message or "Không truy cập được camera.")
        s.flush()
        return {"unhandled": alert_engine.unhandled_count(s)}
