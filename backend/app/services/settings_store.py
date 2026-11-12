"""Đọc/ghi cấu hình trong SQLite, có kiểm tra hợp lệ."""
from __future__ import annotations

from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core import clock
from app.models import Setting
from app.schemas.settings import AppSettings

# Các khóa cho phép đặt lại về None bằng cách gửi null.
NULLABLE_KEYS = {"camera_device_id", "esp32_token", "tts_voice", "catalog_source_path", "profile_avatar"}


def load_settings(session: Session) -> AppSettings:
    stored = {row.key: row.value for row in session.scalars(select(Setting)).all()}
    known = {k: v for k, v in stored.items() if k in AppSettings.model_fields}
    try:
        return AppSettings(**known)
    except Exception:
        # Giá trị cũ không còn hợp lệ → bỏ qua từng khóa lỗi thay vì làm hỏng ứng dụng.
        clean: dict[str, Any] = {}
        for key, value in known.items():
            try:
                AppSettings(**{**clean, key: value})
                clean[key] = value
            except Exception:
                continue
        return AppSettings(**clean)


def save_settings(session: Session, changes: dict[str, Any]) -> AppSettings:
    """Ghi các thay đổi; ném ValueError nếu kết quả không hợp lệ."""
    current = load_settings(session).model_dump()
    merged = {**current, **changes}
    validated = AppSettings(**merged)  # ném ValidationError (là ValueError) nếu sai
    now = clock.now()
    data = validated.model_dump()
    for key in changes:
        if key not in data:
            continue
        row = session.get(Setting, key)
        if row is None:
            session.add(Setting(key=key, value=data[key], updated_at=now))
        else:
            row.value = data[key]
            row.updated_at = now
    session.flush()
    return validated
