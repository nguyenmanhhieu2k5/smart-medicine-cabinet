"""Lượt quét OCR: công việc, kết quả, ứng viên và lịch sử quét theo tài khoản."""
from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import BigInteger, CheckConstraint, Float, ForeignKey, Identity, Index, Integer, SmallInteger, String, Text, UniqueConstraint, Uuid
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.database.session import Base, LocalDateTime

JOB_STATUSES = ("queued", "preprocessing", "recognizing", "matching", "done", "error", "cancelled")
SCAN_STATUSES = ("confident", "uncertain", "no_text", "no_match", "no_catalog", "failed", "cancelled")


class OcrJobRecord(Base):
    __tablename__ = "ocr_jobs"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, ForeignKey("users.id", ondelete="SET NULL"))
    channel: Mapped[str] = mapped_column(String(8))  # admin | public
    source: Mapped[str] = mapped_column(String(16))  # camera | upload
    status: Mapped[str] = mapped_column(String(16), default="queued", server_default="queued")
    progress: Mapped[int] = mapped_column(SmallInteger, default=0, server_default="0")
    message: Mapped[str | None] = mapped_column(Text)
    image_path: Mapped[str | None] = mapped_column(Text)
    thumb_path: Mapped[str | None] = mapped_column(Text)
    image_width: Mapped[int | None] = mapped_column(Integer)
    image_height: Mapped[int | None] = mapped_column(Integer)
    error: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(LocalDateTime)
    started_at: Mapped[datetime | None] = mapped_column(LocalDateTime)
    finished_at: Mapped[datetime | None] = mapped_column(LocalDateTime)

    __table_args__ = (
        CheckConstraint("channel IN ('admin', 'public')", name="ck_ocr_jobs_channel"),
        CheckConstraint("source IN ('camera', 'upload')", name="ck_ocr_jobs_source"),
        CheckConstraint(f"status IN {JOB_STATUSES!r}", name="ck_ocr_jobs_status"),
        CheckConstraint("progress BETWEEN 0 AND 100", name="ck_ocr_jobs_progress"),
        Index("ix_ocr_jobs_user_created", "user_id", "created_at"),
        Index("ix_ocr_jobs_status", "status"),
    )


class OcrResultRecord(Base):
    __tablename__ = "ocr_results"

    job_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("ocr_jobs.id", ondelete="CASCADE"), primary_key=True)
    raw_text: Mapped[str] = mapped_column(Text, default="", server_default="")
    lines: Mapped[list] = mapped_column(JSONB, default=list)
    line_count: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    mean_score: Mapped[float | None] = mapped_column(Float)
    preprocess: Mapped[str | None] = mapped_column(String(64))
    engine: Mapped[dict | None] = mapped_column(JSONB)
    image_info: Mapped[dict | None] = mapped_column(JSONB)
    expiry_suggestion: Mapped[dict | None] = mapped_column(JSONB)
    match_status: Mapped[str] = mapped_column(String(16))
    match_message: Mapped[str | None] = mapped_column(Text)
    extracted: Mapped[dict | None] = mapped_column(JSONB)  # số đăng ký, hàm lượng… trích từ văn bản
    elapsed_ms: Mapped[int | None] = mapped_column(Integer)
    payload: Mapped[dict] = mapped_column(JSONB, default=dict)  # toàn bộ kết quả trả về cho ứng dụng
    created_at: Mapped[datetime] = mapped_column(LocalDateTime)


class OcrCandidateRecord(Base):
    __tablename__ = "ocr_candidates"

    id: Mapped[int] = mapped_column(BigInteger, Identity(), primary_key=True)
    job_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("ocr_jobs.id", ondelete="CASCADE"))
    rank: Mapped[int] = mapped_column(SmallInteger)
    medicine_id: Mapped[int | None] = mapped_column(Integer, ForeignKey("medicine_catalog.id", ondelete="SET NULL"))
    medicine_name: Mapped[str] = mapped_column(Text)
    score: Mapped[float] = mapped_column(Float)
    level: Mapped[str] = mapped_column(String(8))  # high | medium | low
    details: Mapped[dict | None] = mapped_column(JSONB)

    __table_args__ = (
        UniqueConstraint("job_id", "rank", name="uq_ocr_candidates_job_rank"),
        CheckConstraint("rank BETWEEN 1 AND 3", name="ck_ocr_candidates_rank"),
        CheckConstraint("level IN ('high', 'medium', 'low')", name="ck_ocr_candidates_level"),
        CheckConstraint("score >= 0", name="ck_ocr_candidates_score"),
    )


class ScanHistory(Base):
    """Lịch sử quét — mỗi tài khoản chỉ xem được lịch sử của chính mình."""

    __tablename__ = "scan_history"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("users.id", ondelete="CASCADE"))
    job_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, ForeignKey("ocr_jobs.id", ondelete="SET NULL"), unique=True)
    status: Mapped[str] = mapped_column(String(16))
    title: Mapped[str] = mapped_column(Text)
    subtitle: Mapped[str | None] = mapped_column(Text)
    candidate_count: Mapped[int] = mapped_column(SmallInteger, default=0, server_default="0")
    top_medicine_id: Mapped[int | None] = mapped_column(Integer, ForeignKey("medicine_catalog.id", ondelete="SET NULL"))
    selected_medicine_id: Mapped[int | None] = mapped_column(Integer, ForeignKey("medicine_catalog.id", ondelete="SET NULL"))
    search_text: Mapped[str] = mapped_column(Text, default="", server_default="")  # chuẩn hóa, không dấu
    created_at: Mapped[datetime] = mapped_column(LocalDateTime)

    __table_args__ = (
        CheckConstraint(f"status IN {SCAN_STATUSES!r}", name="ck_scan_history_status"),
        Index("ix_scan_history_user_created", "user_id", "created_at"),
    )
