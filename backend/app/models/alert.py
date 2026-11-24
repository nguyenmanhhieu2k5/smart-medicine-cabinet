from __future__ import annotations

from datetime import datetime

from sqlalchemy import BigInteger, CheckConstraint, Identity, Index, String, Text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.database.session import Base, LocalDateTime


class Alert(Base):
    __tablename__ = "alerts"

    id: Mapped[int] = mapped_column(BigInteger, Identity(), primary_key=True)
    category: Mapped[str] = mapped_column(String(16))  # environment | medicine | system
    type: Mapped[str] = mapped_column(String(32))
    severity: Mapped[str] = mapped_column(String(12))  # normal | info | warning | danger
    title: Mapped[str] = mapped_column(Text)
    message: Mapped[str] = mapped_column(Text)
    # Khóa chống trùng: một điều kiện đang diễn ra chỉ có một cảnh báo mở.
    dedupe_key: Mapped[str] = mapped_column(String(96))
    status: Mapped[str] = mapped_column(String(16), default="active", server_default="active")
    data: Mapped[dict | None] = mapped_column(JSONB)
    created_at: Mapped[datetime] = mapped_column(LocalDateTime)
    updated_at: Mapped[datetime] = mapped_column(LocalDateTime)
    resolved_at: Mapped[datetime | None] = mapped_column(LocalDateTime)
    notified_at: Mapped[datetime | None] = mapped_column(LocalDateTime)

    __table_args__ = (
        CheckConstraint("category IN ('environment', 'medicine', 'system')", name="ck_alerts_category"),
        CheckConstraint("severity IN ('normal', 'info', 'warning', 'danger')", name="ck_alerts_severity"),
        CheckConstraint("status IN ('active', 'seen', 'acknowledged', 'resolved')", name="ck_alerts_status"),
        Index("ix_alerts_status_key", "status", "dedupe_key"),
        Index("ix_alerts_created", "created_at"),
    )
