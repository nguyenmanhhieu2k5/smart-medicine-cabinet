from __future__ import annotations

from fastapi import APIRouter, Depends
from pydantic import ValidationError

from app.api.deps import bad_request, get_ctx
from app.core.context import AppContext
from app.schemas.settings import SettingsPatch
from app.services import settings_store
from app.services.alerts import engine as alert_engine
from app.services.ocr.engine import PROFILES, PaddleOcrEngine

router = APIRouter(prefix="/settings", tags=["settings"])


def _public(settings) -> dict:  # noqa: ANN001
    data = settings.model_dump()
    data["esp32_token_set"] = bool(data.pop("esp32_token"))
    return data


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
            "database": str(ctx.settings.db_path),
            "backups": str(ctx.settings.backups_dir),
        },
    }


@router.patch("")
async def update_settings(body: SettingsPatch, ctx: AppContext = Depends(get_ctx)) -> dict:
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
    if any(key.startswith("esp32_") for key in changes):
        await ctx.device.configure(settings)
    if any(key.startswith(("temp_", "humidity_")) for key in changes):
        await ctx.device.poll_once()  # đánh giá lại cảnh báo môi trường theo ngưỡng mới
    return {"settings": _public(settings)}
