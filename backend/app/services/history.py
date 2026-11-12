"""Ghi lịch sử hoạt động vào SQLite."""
from __future__ import annotations

from typing import Any

from sqlalchemy.orm import Session

from app.core import clock
from app.models import HistoryEvent

GROUP_LABELS = {
    "scan": "Quét thuốc",
    "cabinet": "Quản lý thuốc",
    "reminder": "Nhắc uống",
    "alert": "Cảnh báo",
    "system": "Hệ thống",
}


def record(
    session: Session,
    group: str,
    type_: str,
    title: str,
    description: str | None = None,
    data: dict[str, Any] | None = None,
    image_path: str | None = None,
) -> HistoryEvent:
    event = HistoryEvent(
        group=group, type=type_, title=title, description=description,
        data=data, image_path=image_path, created_at=clock.now(),
    )
    session.add(event)
    session.flush()
    return event


def serialize(event: HistoryEvent) -> dict[str, Any]:
    return {
        "id": event.id,
        "group": event.group,
        "group_label": GROUP_LABELS.get(event.group, event.group),
        "type": event.type,
        "title": event.title,
        "description": event.description,
        "data": event.data,
        "has_image": bool(event.image_path),
        "created_at": event.created_at.isoformat(),
    }
