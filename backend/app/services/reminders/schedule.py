"""Tính các lần nhắc uống thuốc theo lịch người dùng đặt.

Module này không tự suy ra liều dùng: mọi mốc giờ, tần suất và liều đều do
người dùng nhập theo chỉ định của chuyên gia y tế.
"""
from __future__ import annotations

import re
from datetime import date, datetime, time, timedelta
from typing import Any, Iterable

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core import clock
from app.models import Reminder, ReminderLog

TIME_RE = re.compile(r"^([01]\d|2[0-3]):([0-5]\d)$")
MISSED_AFTER = timedelta(hours=2)  # quá 2 giờ chưa đánh dấu thì coi là "đã lỡ"
DUE_WINDOW = timedelta(minutes=60)  # nhắc trong vòng 60 phút kể từ giờ hẹn

FREQUENCY_LABELS = {"daily": "Hằng ngày", "weekly": "Theo thứ trong tuần", "interval": "Cách ngày"}
WEEKDAY_SHORT = ["T2", "T3", "T4", "T5", "T6", "T7", "CN"]


def parse_time(value: str) -> time:
    m = TIME_RE.match(value.strip())
    if not m:
        raise ValueError(f"Giờ không hợp lệ: {value!r} (định dạng HH:MM)")
    return time(int(m.group(1)), int(m.group(2)))


def occurs_on(reminder: Reminder, day: date) -> bool:
    if day < reminder.start_date:
        return False
    if reminder.end_date and day > reminder.end_date:
        return False
    if reminder.frequency == "weekly":
        return day.weekday() in (reminder.days_of_week or [])
    if reminder.frequency == "interval":
        step = max(1, reminder.interval_days or 1)
        return (day - reminder.start_date).days % step == 0
    return True  # daily


def occurrences(reminder: Reminder, start: date, end: date) -> list[datetime]:
    out: list[datetime] = []
    day = start
    while day <= end:
        if occurs_on(reminder, day):
            for t in sorted(reminder.times or []):
                out.append(datetime.combine(day, parse_time(t)))
        day += timedelta(days=1)
    return out


def describe_frequency(reminder: Reminder) -> str:
    if reminder.frequency == "weekly":
        days = ", ".join(WEEKDAY_SHORT[d] for d in sorted(reminder.days_of_week or []) if 0 <= d <= 6)
        return f"Hằng tuần: {days}" if days else "Hằng tuần"
    if reminder.frequency == "interval":
        return f"Mỗi {reminder.interval_days} ngày" if (reminder.interval_days or 1) > 1 else "Hằng ngày"
    return "Hằng ngày"


def serialize_reminder(reminder: Reminder) -> dict[str, Any]:
    return {
        "id": reminder.id,
        "cabinet_item_id": reminder.cabinet_item_id,
        "medicine_name": reminder.medicine_name,
        "dose_text": reminder.dose_text,
        "dose_quantity": reminder.dose_quantity,
        "times": sorted(reminder.times or []),
        "frequency": reminder.frequency,
        "frequency_label": describe_frequency(reminder),
        "days_of_week": sorted(reminder.days_of_week or []),
        "interval_days": reminder.interval_days,
        "start_date": reminder.start_date.isoformat(),
        "end_date": reminder.end_date.isoformat() if reminder.end_date else None,
        "enabled": reminder.enabled,
        "note": reminder.note,
        "created_at": reminder.created_at.isoformat(),
        "updated_at": reminder.updated_at.isoformat(),
    }


def build_schedule(session: Session, start: date, end: date, reminders: Iterable[Reminder] | None = None) -> list[dict[str, Any]]:
    """Danh sách từng lần nhắc trong khoảng ngày, kèm trạng thái."""
    if reminders is None:
        reminders = session.scalars(select(Reminder)).all()
    reminders = list(reminders)
    if not reminders:
        return []
    logs = session.scalars(
        select(ReminderLog).where(
            ReminderLog.scheduled_for >= datetime.combine(start, time.min),
            ReminderLog.scheduled_for <= datetime.combine(end, time.max),
        )
    ).all()
    log_map = {(log.reminder_id, log.scheduled_for): log for log in logs}
    now = clock.now()
    rows: list[dict[str, Any]] = []
    for reminder in reminders:
        for when in occurrences(reminder, start, end):
            log = log_map.get((reminder.id, when))
            if log is not None and log.status in ("taken", "skipped"):
                status = log.status
            elif not reminder.enabled:
                status = "disabled"
            elif when > now:
                status = "upcoming"
            elif now - when > MISSED_AFTER:
                status = "missed"
            else:
                status = "due"
            rows.append(
                {
                    "reminder_id": reminder.id,
                    "medicine_name": reminder.medicine_name,
                    "dose_text": reminder.dose_text,
                    "cabinet_item_id": reminder.cabinet_item_id,
                    "date": when.date().isoformat(),
                    "time": when.strftime("%H:%M"),
                    "scheduled_for": when.isoformat(),
                    "status": status,
                    "enabled": reminder.enabled,
                    "acted_at": log.acted_at.isoformat() if log and log.status in ("taken", "skipped") else None,
                }
            )
    rows.sort(key=lambda r: (r["scheduled_for"], r["medicine_name"]))
    return rows


def due_for_notification(session: Session) -> list[dict[str, Any]]:
    """Các lần nhắc đã đến giờ, chưa xử lý và chưa được thông báo. Đánh dấu đã thông báo."""
    now = clock.now()
    reminders = session.scalars(select(Reminder).where(Reminder.enabled.is_(True))).all()
    out: list[dict[str, Any]] = []
    for reminder in reminders:
        for when in occurrences(reminder, (now - DUE_WINDOW).date(), now.date()):
            if not (now - DUE_WINDOW <= when <= now):
                continue
            log = session.scalar(
                select(ReminderLog).where(ReminderLog.reminder_id == reminder.id, ReminderLog.scheduled_for == when)
            )
            if log is not None:
                continue  # đã thông báo hoặc đã xử lý
            session.add(
                ReminderLog(reminder_id=reminder.id, scheduled_for=when, status="notified", acted_at=now, notified_at=now)
            )
            out.append(
                {
                    "reminder_id": reminder.id,
                    "medicine_name": reminder.medicine_name,
                    "dose_text": reminder.dose_text,
                    "scheduled_for": when.isoformat(),
                    "time": when.strftime("%H:%M"),
                }
            )
    session.flush()
    return out
