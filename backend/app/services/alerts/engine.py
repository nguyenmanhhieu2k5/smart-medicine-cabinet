"""Sinh, cập nhật và tự đóng cảnh báo.

Mỗi điều kiện đang diễn ra ứng với một `dedupe_key`; trong lúc điều kiện còn
tồn tại chỉ có một cảnh báo mở. Khi điều kiện hết, cảnh báo tự chuyển sang
"resolved". Người dùng có thể đánh dấu đã xem / xác nhận.
"""
from __future__ import annotations

from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core import clock
from app.models import Alert, CabinetItem
from app.schemas.settings import AppSettings
from app.services import history
from app.services.cabinet import expiry_status, format_quantity, is_low_stock

OPEN_STATUSES = ("active", "seen", "acknowledged")
UNHANDLED_STATUSES = ("active", "seen")
SEVERITY_ORDER = {"normal": 0, "info": 1, "warning": 2, "danger": 3}
SEVERITY_LABELS = {"normal": "Bình thường", "info": "Thông tin", "warning": "Cảnh báo", "danger": "Nguy hiểm"}
CATEGORY_LABELS = {"environment": "Môi trường", "medicine": "Thuốc", "system": "Hệ thống"}
STATUS_LABELS = {"active": "Mới", "seen": "Đã xem", "acknowledged": "Đã xác nhận", "resolved": "Đã kết thúc"}

ENVIRONMENT_TYPES = ("temp_high", "temp_low", "humidity_high", "humidity_low", "sensor_data_lost", "device_disconnected")


def raise_alert(
    session: Session,
    *,
    category: str,
    type_: str,
    severity: str,
    title: str,
    message: str,
    dedupe_key: str,
    data: dict[str, Any] | None = None,
) -> Alert:
    now = clock.now()
    alert = session.scalar(
        select(Alert).where(Alert.dedupe_key == dedupe_key, Alert.status.in_(OPEN_STATUSES)).limit(1)
    )
    if alert is None:
        alert = Alert(
            category=category, type=type_, severity=severity, title=title, message=message,
            dedupe_key=dedupe_key, status="active", data=data, created_at=now, updated_at=now,
        )
        session.add(alert)
        session.flush()
        history.record(session, "alert", type_, title, message, {"alert_id": alert.id, "severity": severity})
        return alert
    escalated = SEVERITY_ORDER.get(severity, 0) > SEVERITY_ORDER.get(alert.severity, 0)
    if alert.message != message or alert.severity != severity or alert.title != title:
        alert.title, alert.message, alert.severity, alert.data = title, message, severity, data
        alert.updated_at = now
        if escalated:  # nặng hơn → báo lại cho người dùng
            alert.status = "active"
            alert.notified_at = None
    return alert


def resolve_alert(session: Session, dedupe_key: str) -> int:
    now = clock.now()
    alerts = session.scalars(
        select(Alert).where(Alert.dedupe_key == dedupe_key, Alert.status.in_(OPEN_STATUSES))
    ).all()
    for alert in alerts:
        alert.status = "resolved"
        alert.resolved_at = now
        alert.updated_at = now
    return len(alerts)


def resolve_prefix(session: Session, prefix: str, keep: set[str] | None = None) -> None:
    keep = keep or set()
    alerts = session.scalars(
        select(Alert).where(Alert.dedupe_key.like(prefix + "%"), Alert.status.in_(OPEN_STATUSES))
    ).all()
    now = clock.now()
    for alert in alerts:
        if alert.dedupe_key not in keep:
            alert.status = "resolved"
            alert.resolved_at = now
            alert.updated_at = now


# --------------------------------------------------------------------------- #
# Thuốc
# --------------------------------------------------------------------------- #
def evaluate_medicines(session: Session, settings: AppSettings) -> None:
    items = session.scalars(select(CabinetItem)).all()
    keep: set[str] = set()
    for item in items:
        status, days = expiry_status(item.expiry_date, settings.expiry_warning_days)
        if status == "expired":
            key = f"med:expired:{item.id}"
            keep.add(key)
            raise_alert(
                session, category="medicine", type_="expired", severity="danger",
                title=f"{item.name} đã hết hạn",
                message=f"Hạn dùng {item.expiry_date:%d/%m/%Y}. Không sử dụng thuốc quá hạn.",
                dedupe_key=key, data={"cabinet_item_id": item.id},
            )
        elif status == "expiring":
            key = f"med:expiring:{item.id}"
            keep.add(key)
            when = "hôm nay" if days == 0 else f"sau {days} ngày"
            raise_alert(
                session, category="medicine", type_="expiring_soon", severity="warning",
                title=f"{item.name} sắp hết hạn",
                message=f"Hết hạn {when} ({item.expiry_date:%d/%m/%Y}).",
                dedupe_key=key, data={"cabinet_item_id": item.id, "days_left": days},
            )
        if is_low_stock(item, settings.low_stock_threshold):
            key = f"med:low_stock:{item.id}"
            keep.add(key)
            raise_alert(
                session, category="medicine", type_="low_stock", severity="info" if item.quantity > 0 else "warning",
                title=f"{item.name} {'đã hết' if item.quantity <= 0 else 'sắp hết'}",
                message=f"Còn {format_quantity(item.quantity)} {item.unit}.",
                dedupe_key=key, data={"cabinet_item_id": item.id, "quantity": item.quantity},
            )
    resolve_prefix(session, "med:", keep)


# --------------------------------------------------------------------------- #
# Môi trường
# --------------------------------------------------------------------------- #
def environment_status(device: dict[str, Any], settings: AppSettings) -> dict[str, Any]:
    """Đánh giá số đo so với ngưỡng. `device` là ảnh chụp trạng thái từ DeviceMonitor."""
    result: dict[str, Any] = {"code": "not_configured", "label": "Chưa kết nối", "temperature": None, "humidity": None}
    if not device.get("enabled"):
        return result
    state = device.get("state")
    if state != "connected":
        result.update(code="disconnected", label="Mất kết nối" if device.get("ever_connected") else "Chưa kết nối")
        return result
    temp, hum = device.get("temperature"), device.get("humidity")

    def judge(value: float | None, low: float, high: float) -> str | None:
        if value is None:
            return None
        if value > high:
            return "high"
        if value < low:
            return "low"
        return "normal"

    result["temperature"] = judge(temp, settings.temp_min, settings.temp_max)
    result["humidity"] = judge(hum, settings.humidity_min, settings.humidity_max)
    if result["temperature"] is None and result["humidity"] is None:
        result.update(code="no_data", label="Mất dữ liệu cảm biến")
    elif "high" in (result["temperature"], result["humidity"]) or "low" in (result["temperature"], result["humidity"]):
        result.update(code="out_of_range", label="Vượt ngưỡng")
    else:
        result.update(code="normal", label="Bình thường")
    return result


def _range_alert(session: Session, *, kind: str, value: float, low: float, high: float, unit: str, name: str, soft: float) -> set[str]:
    keep: set[str] = set()
    if value > high:
        over = value - high
        key = f"env:{kind}_high"
        keep.add(key)
        raise_alert(
            session, category="environment", type_=f"{kind}_high", severity="danger" if over > soft else "warning",
            title=f"{name} vượt ngưỡng",
            message=f"{name} hiện tại {value:g}{unit}, cao hơn ngưỡng tối đa {high:g}{unit}.",
            dedupe_key=key, data={"value": value, "max": high},
        )
    elif value < low:
        under = low - value
        key = f"env:{kind}_low"
        keep.add(key)
        raise_alert(
            session, category="environment", type_=f"{kind}_low", severity="danger" if under > soft else "warning",
            title=f"{name} dưới ngưỡng",
            message=f"{name} hiện tại {value:g}{unit}, thấp hơn ngưỡng tối thiểu {low:g}{unit}.",
            dedupe_key=key, data={"value": value, "min": low},
        )
    return keep


def evaluate_environment(session: Session, settings: AppSettings, device: dict[str, Any]) -> None:
    keep: set[str] = set()
    if not device.get("enabled"):
        resolve_prefix(session, "env:", keep)  # chưa cấu hình thiết bị → không có cảnh báo môi trường
        return
    state = device.get("state")
    if state in ("disconnected", "error"):
        key = "env:device_disconnected"
        keep.add(key)
        raise_alert(
            session, category="environment", type_="device_disconnected", severity="warning",
            title="Mất kết nối ESP32",
            message=device.get("last_error") or "Không nhận được phản hồi từ thiết bị tủ thuốc.",
            dedupe_key=key,
        )
    elif state == "stale":
        key = "env:sensor_data_lost"
        keep.add(key)
        raise_alert(
            session, category="environment", type_="sensor_data_lost", severity="warning",
            title="Mất dữ liệu cảm biến",
            message="Thiết bị vẫn kết nối nhưng đã lâu không có số đo mới.",
            dedupe_key=key,
        )
    elif state == "connected":
        temp, hum = device.get("temperature"), device.get("humidity")
        if temp is None and hum is None:
            key = "env:sensor_data_lost"
            keep.add(key)
            raise_alert(
                session, category="environment", type_="sensor_data_lost", severity="warning",
                title="Mất dữ liệu cảm biến",
                message="Thiết bị phản hồi nhưng không có giá trị nhiệt độ/độ ẩm (kiểm tra cảm biến).",
                dedupe_key=key,
            )
        if temp is not None:
            keep |= _range_alert(session, kind="temp", value=temp, low=settings.temp_min, high=settings.temp_max, unit="°C", name="Nhiệt độ", soft=2.0)
        if hum is not None:
            keep |= _range_alert(session, kind="humidity", value=hum, low=settings.humidity_min, high=settings.humidity_max, unit="%", name="Độ ẩm", soft=5.0)
    else:  # connecting: chưa kết luận, giữ nguyên các cảnh báo đang mở
        return
    resolve_prefix(session, "env:", keep)


# --------------------------------------------------------------------------- #
# Hệ thống
# --------------------------------------------------------------------------- #
SYSTEM_ALERTS = {
    "camera_error": ("warning", "Camera không hoạt động"),
    "ocr_error": ("warning", "OCR gặp lỗi"),
    "database_error": ("danger", "Không đọc được cơ sở dữ liệu"),
    "catalog_missing": ("info", "Chưa nhập danh mục thuốc"),
}


def raise_system(session: Session, type_: str, message: str) -> Alert:
    severity, title = SYSTEM_ALERTS[type_]
    return raise_alert(
        session, category="system", type_=type_, severity=severity, title=title,
        message=message, dedupe_key=f"sys:{type_}",
    )


def resolve_system(session: Session, type_: str) -> int:
    return resolve_alert(session, f"sys:{type_}")


# --------------------------------------------------------------------------- #
def unhandled_count(session: Session) -> int:
    return session.scalar(
        select(func.count()).select_from(Alert).where(Alert.status.in_(UNHANDLED_STATUSES))
    ) or 0


def serialize(alert: Alert) -> dict[str, Any]:
    return {
        "id": alert.id,
        "category": alert.category,
        "category_label": CATEGORY_LABELS.get(alert.category, alert.category),
        "type": alert.type,
        "severity": alert.severity,
        "severity_label": SEVERITY_LABELS.get(alert.severity, alert.severity),
        "title": alert.title,
        "message": alert.message,
        "status": alert.status,
        "status_label": STATUS_LABELS.get(alert.status, alert.status),
        "data": alert.data,
        "created_at": alert.created_at.isoformat(),
        "updated_at": alert.updated_at.isoformat(),
        "resolved_at": alert.resolved_at.isoformat() if alert.resolved_at else None,
    }
