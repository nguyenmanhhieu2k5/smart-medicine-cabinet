"""Kết quả tra cứu thuốc bằng AI (Gemini + Google Search) — lưu đệm để lần quét sau trả lời ngay, và để đối soát."""
from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import BigInteger, CheckConstraint, ForeignKey, Identity, Index, Integer, String, Uuid
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.database.session import Base, LocalDateTime


class AiLookup(Base):
    __tablename__ = "ai_lookups"

    id: Mapped[int] = mapped_column(BigInteger, Identity(), primary_key=True)
    kind: Mapped[str] = mapped_column(String(16))  # barcode | qr | scan
    query_key: Mapped[str] = mapped_column(String(160))  # "barcode:<GTIN-14>", "qr:<sha256>", "scan:<job id>"
    status: Mapped[str] = mapped_column(String(16))  # found | not_found
    mode: Mapped[str] = mapped_column(String(16))  # web (AI + Google Search) | offline (AI chỉ đọc ảnh/mã) | search (Tavily, không AI) | text (đọc số đăng ký trong mã)
    model: Mapped[str] = mapped_column(String(64))
    result: Mapped[dict | None] = mapped_column(JSONB)
    sources: Mapped[list] = mapped_column(JSONB, default=list)
    catalog_ids: Mapped[list] = mapped_column(JSONB, default=list)
    user_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, ForeignKey("users.id", ondelete="SET NULL"))
    elapsed_ms: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    created_at: Mapped[datetime] = mapped_column(LocalDateTime)

    __table_args__ = (
        CheckConstraint("kind IN ('barcode', 'qr', 'scan')", name="ck_ai_lookups_kind"),
        CheckConstraint("status IN ('found', 'not_found')", name="ck_ai_lookups_status"),
        CheckConstraint("mode IN ('web', 'offline', 'search', 'text')", name="ck_ai_lookups_mode"),
        Index("ix_ai_lookups_key_created", "query_key", "created_at"),
    )
