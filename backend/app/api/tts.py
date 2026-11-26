"""Giọng đọc tiếng Việt tự nhiên cho ứng dụng Windows (kênh quản trị) — xem app/services/tts.py."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel, ConfigDict, Field

from app.api.deps import get_ctx
from app.auth.deps import get_principal
from app.auth.service import Principal
from app.core.context import AppContext
from app.services.tts import MAX_CHARS, TtsError

router = APIRouter(prefix="/tts", tags=["tts"])


class SpeakBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    text: str = Field(..., min_length=1, max_length=MAX_CHARS * 2)
    speed: float = Field(1.0, ge=0.5, le=2.0)


@router.get("/status")
def status(ctx: AppContext = Depends(get_ctx), _: Principal = Depends(get_principal)) -> dict:
    return ctx.tts.status()


@router.post("", response_class=Response)
def speak(body: SpeakBody, ctx: AppContext = Depends(get_ctx), _: Principal = Depends(get_principal)) -> Response:
    try:
        audio = ctx.tts.synthesize(body.text, body.speed)
    except TtsError as exc:
        raise HTTPException(503, str(exc)) from exc
    return Response(content=audio, media_type="audio/wav", headers={"Cache-Control": "private, max-age=3600"})
