"""Thông báo đang chờ hiển thị (lời nhắc đến giờ, cảnh báo mới).

Lớp desktop (Electron) hỏi endpoint này định kỳ rồi hiện thông báo Windows.
Mỗi mục chỉ được trả về một lần.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy import select

from app.api.deps import get_ctx
from app.core import clock
from app.core.context import AppContext
from app.models import Alert
from app.services import settings_store
from app.services.alerts import engine as alert_engine
from app.services.reminders.schedule import due_for_notification

router = APIRouter(prefix="/notifications", tags=["notifications"])


@router.post("/pending")
def pending(ctx: AppContext = Depends(get_ctx)) -> dict:
    items: list[dict] = []
    with ctx.db.session() as s:
        settings = settings_store.load_settings(s)
        alert_engine.evaluate_medicines(s, settings)
        if settings.notify_reminders:
            for due in due_for_notification(s):
                dose = f" — {due['dose_text']}" if due.get("dose_text") else ""
                items.append({
                    "kind": "reminder", "title": "Đến giờ uống thuốc",
                    "body": f"{due['time']} · {due['medicine_name']}{dose}", "route": "/reminders", **due,
                })
        alerts = s.scalars(
            select(Alert).where(Alert.notified_at.is_(None), Alert.status == "active", Alert.severity.in_(("warning", "danger")))
        ).all()
        now = clock.now()
        for alert in alerts:
            alert.notified_at = now
            if alert.category == "environment" and not settings.notify_environment:
                continue
            items.append({
                "kind": "alert", "title": alert.title, "body": alert.message,
                "severity": alert.severity, "alert_id": alert.id, "route": "/alerts",
            })
        return {
            "items": items,
            "windows_notifications": settings.notify_windows,
            "sound": settings.sound_enabled,
            "unhandled_alerts": alert_engine.unhandled_count(s),
        }
