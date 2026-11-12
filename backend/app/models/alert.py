from __future__ import annotations

from datetime import datetime

from sqlalchemy import JSON, DateTime, Index, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.database.session import Base


class Alert(Base):
    __tablename__ = "alerts"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    category: Mapped[str] = mapped_column(String(16))  # environment | medicine | system
    type: Mapped[str] = mapped_column(String(32))
    severity: Mapped[str] = mapped_column(String(12))  # normal | info | warning | danger
    title: Mapped[str] = mapped_column(Text)
    message: Mapped[str] = mapped_column(Text)
    # Khóa chống trùng: một điều kiện đang diễn ra chỉ có một cảnh báo mở.
    dedupe_key: Mapped[str] = mapped_column(String(96))
    status: Mapped[str] = mapped_column(String(16), default="active")  # active | seen | acknowledged | resolved
    data: Mapped[dict | None] = mapped_column(JSON)
    created_at: Mapped[datetime] = mapped_column(DateTime)
    updated_at: Mapped[datetime] = mapped_column(DateTime)
    resolved_at: Mapped[datetime | None] = mapped_column(DateTime)
    notified_at: Mapped[datetime | None] = mapped_column(DateTime)

    __table_args__ = (Index("ix_alerts_status_key", "status", "dedupe_key"),)
