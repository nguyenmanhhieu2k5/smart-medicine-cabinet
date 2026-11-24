from __future__ import annotations

from datetime import datetime

from sqlalchemy import BigInteger, Identity, Index, String, Text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.database.session import Base, LocalDateTime


class HistoryEvent(Base):
    """Dòng thời gian hoạt động hiển thị ở ứng dụng quản trị (quét, tủ thuốc, nhắc, cảnh báo, hệ thống)."""

    __tablename__ = "history_events"

    id: Mapped[int] = mapped_column(BigInteger, Identity(), primary_key=True)
    group: Mapped[str] = mapped_column("grp", String(16))  # scan | cabinet | reminder | alert | system | device
    type: Mapped[str] = mapped_column(String(32))
    title: Mapped[str] = mapped_column(Text)
    description: Mapped[str | None] = mapped_column(Text)
    data: Mapped[dict | None] = mapped_column(JSONB)
    image_path: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(LocalDateTime)

    __table_args__ = (Index("ix_history_created", "created_at"), Index("ix_history_group", "grp"))
