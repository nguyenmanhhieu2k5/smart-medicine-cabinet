"""Lời nhắc uống thuốc — lịch và liều hoàn toàn do người dùng nhập."""
from __future__ import annotations

from datetime import date, timedelta

from fastapi import APIRouter, Depends, Query
from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from app.api.deps import bad_request, get_ctx, not_found
from app.core import clock
from app.core.context import AppContext
from app.models import CabinetItem, Reminder, ReminderLog
from app.schemas.reminder import ReminderCreate, ReminderLogRequest, ReminderUpdate
from app.services import history, settings_store
from app.services.alerts import engine as alert_engine
from app.services.cabinet import format_quantity
from app.services.reminders.schedule import build_schedule, occurrences, serialize_reminder

router = APIRouter(prefix="/reminders", tags=["reminders"])


def _get(s: Session, reminder_id: int) -> Reminder:
    reminder = s.get(Reminder, reminder_id)
    if reminder is None:
        raise not_found("Không tìm thấy lời nhắc.")
    return reminder


def _resolve_name(s: Session, cabinet_item_id: int | None, fallback: str | None) -> str:
    if cabinet_item_id is not None:
        item = s.get(CabinetItem, cabinet_item_id)
        if item is None:
            raise not_found("Thuốc được chọn không còn trong tủ.")
        return item.name
    name = (fallback or "").strip()
    if not name:
        raise bad_request("Hãy chọn thuốc trong tủ hoặc nhập tên thuốc.")
    return name


@router.get("")
def list_reminders(ctx: AppContext = Depends(get_ctx)) -> dict:
    with ctx.db.session() as s:
        reminders = s.scalars(select(Reminder).order_by(Reminder.created_at.desc())).all()
        return {"items": [serialize_reminder(r) for r in reminders]}


@router.get("/schedule")
def schedule(
    start: date | None = Query(None, alias="from"),
    end: date | None = Query(None, alias="to"),
    ctx: AppContext = Depends(get_ctx),
) -> dict:
    """Từng lần nhắc trong khoảng ngày (mặc định: tuần hiện tại, Thứ 2 → Chủ nhật)."""
    today = clock.today()
    if start is None:
        start = today - timedelta(days=today.weekday())
    if end is None:
        end = start + timedelta(days=6)
    if end < start:
        raise bad_request("Khoảng ngày không hợp lệ.")
    if (end - start).days > 62:
        raise bad_request("Chỉ xem được tối đa 62 ngày mỗi lần.")
    with ctx.db.session() as s:
        return {"from": start.isoformat(), "to": end.isoformat(), "today": today.isoformat(), "items": build_schedule(s, start, end)}


@router.post("", status_code=201)
def create_reminder(body: ReminderCreate, ctx: AppContext = Depends(get_ctx)) -> dict:
    now = clock.now()
    with ctx.db.session() as s:
        name = _resolve_name(s, body.cabinet_item_id, body.medicine_name)
        reminder = Reminder(
            cabinet_item_id=body.cabinet_item_id, medicine_name=name, dose_text=body.dose_text,
            dose_quantity=body.dose_quantity, times=body.times, frequency=body.frequency,
            days_of_week=body.days_of_week or [], interval_days=body.interval_days or 1,
            start_date=body.start_date, end_date=body.end_date,
            enabled=True if body.enabled is None else body.enabled, note=body.note,
            created_at=now, updated_at=now,
        )
        s.add(reminder)
        s.flush()
        history.record(
            s, "reminder", "reminder_created", "Tạo lời nhắc",
            f"{name} lúc {', '.join(reminder.times)}", {"reminder_id": reminder.id},
        )
        return serialize_reminder(reminder)


@router.get("/{reminder_id}")
def get_reminder(reminder_id: int, ctx: AppContext = Depends(get_ctx)) -> dict:
    with ctx.db.session() as s:
        return serialize_reminder(_get(s, reminder_id))


@router.patch("/{reminder_id}")
def update_reminder(reminder_id: int, body: ReminderUpdate, ctx: AppContext = Depends(get_ctx)) -> dict:
    changes = body.model_dump(exclude_unset=True)
    with ctx.db.session() as s:
        reminder = _get(s, reminder_id)
        if "cabinet_item_id" in changes or "medicine_name" in changes:
            item_id = changes.get("cabinet_item_id", reminder.cabinet_item_id)
            changes["medicine_name"] = _resolve_name(s, item_id, changes.get("medicine_name") or reminder.medicine_name)
        for key in ("times", "frequency", "start_date"):
            if key in changes and changes[key] is None:
                raise bad_request("Giờ nhắc, tần suất và ngày bắt đầu không được để trống.")
        for key, value in changes.items():
            setattr(reminder, key, value)
        if reminder.frequency == "weekly" and not reminder.days_of_week:
            raise bad_request("Hãy chọn ít nhất một thứ trong tuần.")
        if reminder.end_date and reminder.end_date < reminder.start_date:
            raise bad_request("Ngày kết thúc phải sau ngày bắt đầu.")
        reminder.interval_days = reminder.interval_days or 1
        reminder.updated_at = clock.now()
        only_toggle = set(changes) == {"enabled"}
        history.record(
            s, "reminder", "reminder_toggled" if only_toggle else "reminder_updated",
            ("Bật lời nhắc" if reminder.enabled else "Tắt lời nhắc") if only_toggle else "Sửa lời nhắc",
            reminder.medicine_name, {"reminder_id": reminder.id},
        )
        return serialize_reminder(reminder)


@router.delete("/{reminder_id}")
def delete_reminder(reminder_id: int, ctx: AppContext = Depends(get_ctx)) -> dict:
    with ctx.db.session() as s:
        reminder = _get(s, reminder_id)
        name = reminder.medicine_name
        s.execute(delete(ReminderLog).where(ReminderLog.reminder_id == reminder_id))
        s.delete(reminder)
        history.record(s, "reminder", "reminder_deleted", "Xóa lời nhắc", name, {"reminder_id": reminder_id})
    return {"deleted": True, "id": reminder_id}


@router.post("/{reminder_id}/log")
def log_occurrence(reminder_id: int, body: ReminderLogRequest, ctx: AppContext = Depends(get_ctx)) -> dict:
    """Đánh dấu một lần nhắc là đã uống / bỏ qua (hoặc hoàn tác về chưa xử lý)."""
    when = body.scheduled_for.replace(tzinfo=None, second=0, microsecond=0)
    with ctx.db.session() as s:
        reminder = _get(s, reminder_id)
        if when not in occurrences(reminder, when.date(), when.date()):
            raise bad_request("Thời điểm này không thuộc lịch của lời nhắc.")
        now = clock.now()
        if body.status == "taken" and when > now + timedelta(hours=12):
            raise bad_request("Chưa đến giờ của lần nhắc này.")
        log = s.scalar(select(ReminderLog).where(ReminderLog.reminder_id == reminder_id, ReminderLog.scheduled_for == when))
        previous = log.status if log else None
        if log is None:
            log = ReminderLog(reminder_id=reminder_id, scheduled_for=when, status="notified", acted_at=now)
            s.add(log)
        log.status = "notified" if body.status == "pending" else body.status
        log.acted_at = now

        # Trừ / hoàn số lượng trong tủ theo "số lượng mỗi lần" do người dùng nhập (nếu có).
        stock_note = ""
        qty = reminder.dose_quantity or 0
        if qty > 0 and reminder.cabinet_item_id is not None and previous != body.status:
            item = s.get(CabinetItem, reminder.cabinet_item_id)
            delta = (-qty if body.status == "taken" else 0) + (qty if previous == "taken" else 0)
            if item is not None and delta != 0:
                old = item.quantity
                item.quantity = max(0.0, round(item.quantity + delta, 3))
                item.updated_at = now
                stock_note = f" · tồn {format_quantity(old)} → {format_quantity(item.quantity)} {item.unit}"
                history.record(
                    s, "cabinet", "quantity_change", "Thay đổi số lượng",
                    f"{item.name}: {format_quantity(old)} → {format_quantity(item.quantity)} {item.unit} (lời nhắc)",
                    {"cabinet_item_id": item.id, "from": old, "to": item.quantity, "reminder_id": reminder.id},
                )
                alert_engine.evaluate_medicines(s, settings_store.load_settings(s))
        if body.status in ("taken", "skipped") and previous != body.status:
            history.record(
                s, "reminder", "reminder_completed" if body.status == "taken" else "reminder_skipped",
                "Đã uống thuốc" if body.status == "taken" else "Bỏ qua lời nhắc",
                f"{reminder.medicine_name} · {when:%H:%M %d/%m/%Y}{stock_note}",
                {"reminder_id": reminder.id, "scheduled_for": when.isoformat()},
            )
        day = when.date()
        rows = [r for r in build_schedule(s, day, day, [reminder]) if r["scheduled_for"] == when.isoformat()]
        return rows[0] if rows else {"reminder_id": reminder_id, "scheduled_for": when.isoformat(), "status": body.status}
