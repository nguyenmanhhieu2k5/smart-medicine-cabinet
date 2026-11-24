"""Lời nhắc uống thuốc — lịch và liều do người dùng tự nhập."""
from __future__ import annotations

from datetime import date, datetime

from sqlalchemy import BigInteger, Boolean, CheckConstraint, Date, Float, ForeignKey, Identity, Integer, String, Text, UniqueConstraint
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.database.session import Base, LocalDateTime


class Reminder(Base):
    __tablename__ = "reminders"

    id: Mapped[int] = mapped_column(BigInteger, Identity(), primary_key=True)
    cabinet_item_id: Mapped[int | None] = mapped_column(
        BigInteger, ForeignKey("cabinet_medicines.id", ondelete="SET NULL"), index=True
    )
    medicine_name: Mapped[str] = mapped_column(Text)
    dose_text: Mapped[str | None] = mapped_column(Text)  # do người dùng nhập theo chỉ định
    # Số lượng trừ khỏi tủ mỗi lần đánh dấu "đã uống" (tùy chọn, do người dùng nhập).
    dose_quantity: Mapped[float | None] = mapped_column(Float)
    times: Mapped[list[str]] = mapped_column(JSONB, default=list)  # ["08:00", "20:00"]
    frequency: Mapped[str] = mapped_column(String(16), default="daily", server_default="daily")  # daily | weekly | interval
    days_of_week: Mapped[list[int]] = mapped_column(JSONB, default=list)  # 0=Thứ 2 … 6=Chủ nhật
    interval_days: Mapped[int] = mapped_column(Integer, default=1, server_default="1")
    start_date: Mapped[date] = mapped_column(Date)
    end_date: Mapped[date | None] = mapped_column(Date)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True, server_default="true")
    note: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(LocalDateTime)
    updated_at: Mapped[datetime] = mapped_column(LocalDateTime)

    __table_args__ = (
        CheckConstraint("frequency IN ('daily', 'weekly', 'interval')", name="ck_reminders_frequency"),
        CheckConstraint("interval_days >= 1", name="ck_reminders_interval"),
        CheckConstraint("dose_quantity IS NULL OR dose_quantity > 0", name="ck_reminders_dose_quantity"),
        CheckConstraint("end_date IS NULL OR end_date >= start_date", name="ck_reminders_dates"),
    )


class ReminderLog(Base):
    __tablename__ = "reminder_logs"

    id: Mapped[int] = mapped_column(BigInteger, Identity(), primary_key=True)
    reminder_id: Mapped[int] = mapped_column(BigInteger, ForeignKey("reminders.id", ondelete="CASCADE"), index=True)
    scheduled_for: Mapped[datetime] = mapped_column(LocalDateTime)
    status: Mapped[str] = mapped_column(String(12))  # notified | taken | skipped
    acted_at: Mapped[datetime] = mapped_column(LocalDateTime)
    notified_at: Mapped[datetime | None] = mapped_column(LocalDateTime)

    __table_args__ = (
        UniqueConstraint("reminder_id", "scheduled_for", name="uq_reminder_occurrence"),
        CheckConstraint("status IN ('notified', 'taken', 'skipped')", name="ck_reminder_logs_status"),
    )
