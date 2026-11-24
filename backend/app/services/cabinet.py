"""Nghiệp vụ tủ thuốc: tình trạng hạn dùng, tồn kho, tuần tự hóa."""
from __future__ import annotations

from datetime import date
from typing import Any

from app.core import clock
from app.models import CabinetItem

EXPIRY_LABELS = {
    "ok": "Còn hạn",
    "expiring": "Sắp hết hạn",
    "expired": "Đã hết hạn",
    "unknown": "Chưa có hạn dùng",
}


def expiry_status(expiry: date | None, warning_days: int, today: date | None = None) -> tuple[str, int | None]:
    """(trạng thái, số ngày còn lại) theo hạn sử dụng THỰC TẾ trên bao bì.

    - unknown : chưa nhập hạn dùng
    - expired : hạn dùng trước hôm nay (ngày còn lại < 0)
    - expiring: còn từ 0 đến `warning_days` ngày
    - ok      : còn nhiều hơn `warning_days` ngày
    Thuốc vẫn dùng được trong chính ngày ghi trên bao bì nên ngày còn lại = 0
    được xếp vào "sắp hết hạn", không phải "đã hết hạn".
    """
    if expiry is None:
        return "unknown", None
    today = today or clock.today()
    days = (expiry - today).days
    if days < 0:
        return "expired", days
    if days <= warning_days:
        return "expiring", days
    return "ok", days


def is_low_stock(item: CabinetItem, default_threshold: float) -> bool:
    threshold = item.low_stock_threshold if item.low_stock_threshold is not None else default_threshold
    return item.quantity <= threshold


def format_quantity(value: float) -> str:
    return str(int(value)) if float(value).is_integer() else f"{value:g}"


def serialize_item(item: CabinetItem, warning_days: int, low_stock_default: float) -> dict[str, Any]:
    status, days = expiry_status(item.expiry_date, warning_days)
    if status == "expired":
        status_label = "Đã hết hạn"
    elif status == "expiring":
        status_label = "Hết hạn hôm nay" if days == 0 else f"Còn {days} ngày"
    else:
        status_label = EXPIRY_LABELS[status]
    return {
        "id": item.id,
        "catalog_id": item.catalog_id,
        "name": item.name,
        "ingredient": item.ingredient,
        "strength": item.strength,
        "dosage_form": item.dosage_form,
        "registration_no": item.registration_no,
        "manufacturer": item.manufacturer,
        "quantity": item.quantity,
        "quantity_text": f"{format_quantity(item.quantity)} {item.unit}".strip(),
        "unit": item.unit,
        "expiry_date": item.expiry_date.isoformat() if item.expiry_date else None,
        "expiry_source": item.expiry_source,
        "expiry_status": status,
        "expiry_status_label": status_label,
        "days_left": days,
        "lot_number": item.lot_number,
        "low_stock_threshold": item.low_stock_threshold,
        "low_stock": is_low_stock(item, low_stock_default),
        "location": item.location,
        "note": item.note,
        "has_image": bool(item.image_path),
        "source": item.source,
        "created_at": item.created_at.isoformat(),
        "updated_at": item.updated_at.isoformat(),
    }


def log_inventory(
    session, item: CabinetItem, action: str, before: float | None, after: float | None, *,
    user_id=None, note: str | None = None,
) -> None:
    """Ghi một dòng vào medicine_inventory_logs (gọi TRƯỚC khi xóa thuốc để còn id)."""
    from app.core import clock
    from app.models import InventoryLog

    delta = None if before is None or after is None else round(after - before, 3)
    session.add(InventoryLog(
        cabinet_medicine_id=item.id, medicine_name=item.name, action=action, quantity_before=before,
        quantity_after=after, delta=delta, unit=item.unit, note=(note or None) and note[:500], user_id=user_id,
        created_at=clock.now(),
    ))
