from __future__ import annotations

from datetime import date, datetime
from typing import Literal

from pydantic import BaseModel, Field, field_validator, model_validator

from app.services.reminders.schedule import parse_time


class ReminderBase(BaseModel):
    cabinet_item_id: int | None = None
    medicine_name: str | None = Field(None, max_length=300)
    dose_text: str | None = Field(None, max_length=200, description="Liều do người dùng nhập theo chỉ định")
    dose_quantity: float | None = Field(None, ge=0, le=1000)
    times: list[str] | None = None
    frequency: Literal["daily", "weekly", "interval"] | None = None
    days_of_week: list[int] | None = None
    interval_days: int | None = Field(None, ge=1, le=365)
    start_date: date | None = None
    end_date: date | None = None
    enabled: bool | None = None
    note: str | None = Field(None, max_length=500)

    @field_validator("times")
    @classmethod
    def _times(cls, value: list[str] | None) -> list[str] | None:
        if value is None:
            return None
        cleaned = sorted({parse_time(v).strftime("%H:%M") for v in value})
        if not cleaned:
            raise ValueError("Cần ít nhất một giờ nhắc.")
        if len(cleaned) > 12:
            raise ValueError("Tối đa 12 giờ nhắc mỗi ngày.")
        return cleaned

    @field_validator("days_of_week")
    @classmethod
    def _days(cls, value: list[int] | None) -> list[int] | None:
        if value is None:
            return None
        if any(d < 0 or d > 6 for d in value):
            raise ValueError("Thứ trong tuần phải từ 0 (Thứ 2) đến 6 (Chủ nhật).")
        return sorted(set(value))


class ReminderCreate(ReminderBase):
    times: list[str]
    frequency: Literal["daily", "weekly", "interval"] = "daily"
    start_date: date

    @model_validator(mode="after")
    def _check(self) -> "ReminderCreate":
        if self.frequency == "weekly" and not self.days_of_week:
            raise ValueError("Hãy chọn ít nhất một thứ trong tuần.")
        if self.end_date and self.end_date < self.start_date:
            raise ValueError("Ngày kết thúc phải sau ngày bắt đầu.")
        if not self.cabinet_item_id and not (self.medicine_name or "").strip():
            raise ValueError("Hãy chọn thuốc trong tủ hoặc nhập tên thuốc.")
        return self


class ReminderUpdate(ReminderBase):
    model_config = {"extra": "forbid"}


class ReminderLogRequest(BaseModel):
    scheduled_for: datetime
    status: Literal["taken", "skipped", "pending"]
