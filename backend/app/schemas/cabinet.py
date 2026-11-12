from __future__ import annotations

from datetime import date
from typing import Literal

from pydantic import BaseModel, Field, field_validator


def _blank_to_none(value: object) -> object:
    if isinstance(value, str):
        value = value.strip()
        return value or None
    return value


class CabinetBase(BaseModel):
    name: str | None = Field(None, max_length=300)
    ingredient: str | None = Field(None, max_length=1000)
    strength: str | None = Field(None, max_length=300)
    dosage_form: str | None = Field(None, max_length=200)
    registration_no: str | None = Field(None, max_length=80)
    manufacturer: str | None = Field(None, max_length=300)
    unit: str | None = Field(None, max_length=24)
    expiry_date: date | None = None
    expiry_source: Literal["manual", "ocr_confirmed"] | None = None
    lot_number: str | None = Field(None, max_length=64)
    low_stock_threshold: float | None = Field(None, ge=0, le=1_000_000)
    location: str | None = Field(None, max_length=200)
    note: str | None = Field(None, max_length=1000)

    _strip = field_validator(
        "name", "ingredient", "strength", "dosage_form", "registration_no", "manufacturer",
        "unit", "lot_number", "location", "note", mode="before",
    )(_blank_to_none)

    @field_validator("expiry_date")
    @classmethod
    def _plausible(cls, value: date | None) -> date | None:
        if value is not None and not (2000 <= value.year <= 2100):
            raise ValueError("Hạn dùng phải nằm trong khoảng năm 2000–2100.")
        return value


class CabinetCreate(CabinetBase):
    catalog_id: int | None = Field(None, ge=0)
    quantity: float = Field(0, ge=0, le=1_000_000)
    scan_job_id: str | None = Field(None, max_length=32)


class CabinetUpdate(CabinetBase):
    model_config = {"extra": "forbid"}
    quantity: float | None = Field(None, ge=0, le=1_000_000)


class QuantityAdjust(BaseModel):
    delta: float = Field(..., ge=-1_000_000, le=1_000_000)
    reason: str | None = Field(None, max_length=200)
