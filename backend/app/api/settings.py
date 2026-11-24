from __future__ import annotations

from fastapi import APIRouter, Depends
from pydantic import ValidationError
from sqlalchemy import select

from app.api.deps import bad_request, get_ctx
from app.auth.deps import get_principal
from app.auth.service import Principal, audit
from app.iot.actions import CommandRejected
from app.models import Device
from app.core.context import AppContext
from app.schemas.settings import SettingsPatch
from app.services import settings_store
from app.services.alerts import engine as alert_engine
from app.services.ocr.engine import PROFILES, PaddleOcrEngine

router = APIRouter(prefix="/settings", tags=["settings"])


def _public(settings) -> dict:  # noqa: ANN001
    return settings.model_dump()


@router.get("")
def get_settings(ctx: AppContext = Depends(get_ctx)) -> dict:
    with ctx.db.session() as s:
        settings = settings_store.load_settings(s)
    return {
        "settings": _public(settings),
        "options": {
            "ocr_profiles": [{"value": key, "label": label, "detection": det, "recognition": rec} for key, (det, rec, label) in PROFILES.items()],
            "ocr_dependencies": PaddleOcrEngine.dependency_status(),
        },
        "paths": {
            "data_dir": str(ctx.settings.data_dir),
            "database": ctx.db.display_url,
            "backups": str(ctx.settings.backups_dir),
        },
    }


@router.patch("")
async def update_settings(body: SettingsPatch, ctx: AppContext = Depends(get_ctx), principal: Principal = Depends(get_principal)) -> dict:
    changes = body.model_dump(exclude_unset=True)
    for key in list(changes):
        if changes[key] is None and key not in settings_store.NULLABLE_KEYS:
            changes.pop(key)
    try:
        with ctx.db.session() as s:
            settings = settings_store.save_settings(s, changes)
            alert_engine.evaluate_medicines(s, settings)  # ngưỡng hạn dùng/số lượng có thể đã đổi
    except ValidationError as exc:
        first = exc.errors()[0]
        raise bad_request(str(first.get("msg", "Giá trị không hợp lệ")).replace("Value error, ", "")) from exc
    if any(key.startswith(("temp_", "humidity_")) for key in changes):
        ctx.devices.evaluate_alerts()  # đánh giá lại cảnh báo môi trường theo ngưỡng mới
        await _sync_thresholds(ctx, settings, principal)
    with ctx.db.session() as s:
        audit(s, "settings.update", channel="admin", user_id=principal.user_id, actor=principal.email,
              resource_type="settings", detail={"keys": sorted(changes)})
    return {"settings": _public(settings)}


async def _sync_thresholds(ctx: AppContext, settings, principal: Principal) -> None:  # noqa: ANN001
    """Gửi ngưỡng mới xuống mọi ESP32 hỗ trợ set_thresholds (cảnh báo cục bộ khi mất Internet)."""
    payload = {"temp_min": settings.temp_min, "temp_max": settings.temp_max,
               "humidity_min": settings.humidity_min, "humidity_max": settings.humidity_max}
    command_ids = []
    with ctx.db.session() as s:
        for device in s.scalars(select(Device).where(Device.is_active.is_(True))).all():
            if "set_thresholds" in (device.capabilities or []):
                try:
                    cmd = ctx.devices.create_command(s, device=device, action="set_thresholds", payload=payload,
                                                     user_id=principal.user_id, ttl_seconds=3600)
                    command_ids.append(cmd.id)
                except CommandRejected:
                    continue
    for command_id in command_ids:
        await ctx.devices.dispatch(command_id)
