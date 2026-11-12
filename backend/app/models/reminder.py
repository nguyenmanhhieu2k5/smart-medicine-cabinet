"""Lời nhắc uống thuốc — lịch và liều do người dùng tự nhập."""
from __future__ import annotations

from datetime import date, datetime

from sqlalchemy import JSON, Boolean, Date, DateTime, Float, ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.database.session import Base


class Reminder(Base):
    __tablename__ = "reminders"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    cabinet_item_id: Mapped[int | None] = mapped_column(
        Integer, ForeignKey("cabinet_items.id", ondelete="SET NULL"), index=True
    )
    medicine_name: Mapped[str] = mapped_column(Text)
    dose_text: Mapped[str | None] = mapped_column(Text)  # do người dùng nhập theo chỉ định
    # Số lượng trừ khỏi tủ mỗi lần đánh dấu "đã uống" (tùy chọn, do người dùng nhập).
    dose_quantity: Mapped[float | None] = mapped_column(Float)
    times: Mapped[list[str]] = mapped_column(JSON, default=list)  # ["08:00", "20:00"]
    frequency: Mapped[str] = mapped_column(String(16), default="daily")  # daily | weekly | interval
    days_of_week: Mapped[list[int]] = mapped_column(JSON, default=list)  # 0=Thứ 2 … 6=Chủ nhật
    interval_days: Mapped[int] = mapped_column(Integer, default=1)
    start_date: Mapped[date] = mapped_column(Date)
    end_date: Mapped[date | None] = mapped_column(Date)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    note: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime)
    updated_at: Mapped[datetime] = mapped_column(DateTime)


class ReminderLog(Base):
    __tablename__ = "reminder_logs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    reminder_id: Mapped[int] = mapped_column(Integer, ForeignKey("reminders.id", ondelete="CASCADE"), index=True)
    scheduled_for: Mapped[datetime] = mapped_column(DateTime)
    status: Mapped[str] = mapped_column(String(12))  # notified | taken | skipped
    acted_at: Mapped[datetime] = mapped_column(DateTime)
    notified_at: Mapped[datetime | None] = mapped_column(DateTime)

    __table_args__ = (UniqueConstraint("reminder_id", "scheduled_for", name="uq_reminder_occurrence"),)
