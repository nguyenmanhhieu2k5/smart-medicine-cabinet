"""AI tra cứu thuốc trên mạng (Gemini + Google Search) — kênh quản trị (ứng dụng Windows)."""
from __future__ import annotations

import uuid
from typing import Literal

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field

from app.api.deps import get_ctx, not_found
from app.auth.deps import require
from app.auth.service import Principal
from app.core.context import AppContext

router = APIRouter(prefix="/ai", tags=["ai"])
scan_create = require("scan:create")


class AiCodeBody(BaseModel):
    kind: Literal["barcode", "qr"]
    code: str = Field(..., min_length=1, max_length=1000)


@router.get("/status")
def ai_status(ctx: AppContext = Depends(get_ctx)) -> dict:
    """Đã cấu hình khóa chưa, mô hình nào, tìm kiếm trên mạng có dùng được không (KHÔNG trả khóa)."""
    return ctx.ai.status()


@router.post("/lookup")
def ai_lookup(body: AiCodeBody, ctx: AppContext = Depends(get_ctx), principal: Principal = Depends(scan_create)) -> dict:
    return ctx.ai.lookup_code(body.kind, body.code, user_id=principal.user_id)


@router.post("/scans/{job_id}")
def ai_scan(job_id: uuid.UUID, ctx: AppContext = Depends(get_ctx), principal: Principal = Depends(scan_create)) -> dict:
    material = ctx.ocr.ai_material(str(job_id))
    if material is None:
        raise not_found("Không tìm thấy lượt quét này.")
    image, text = material
    return ctx.ai.lookup_scan(str(job_id), image=image, ocr_text=text, user_id=principal.user_id)
