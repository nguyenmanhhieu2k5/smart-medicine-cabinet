"""Quét thuốc: gửi ảnh → nhận mã công việc → hỏi kết quả."""
from __future__ import annotations

import json

from fastapi import APIRouter, Depends, File, Form, UploadFile
from fastapi.responses import FileResponse

from app.api.deps import bad_request, get_ctx, not_found
from app.core.context import AppContext
from app.services.ocr.preprocess import ImageError

router = APIRouter(prefix="/ocr", tags=["ocr"])
MAX_IMAGE_BYTES = 25 * 1024 * 1024


@router.post("", status_code=202)
async def submit(
    file: UploadFile = File(..., description="Ảnh hộp/vỉ/nhãn thuốc"),
    source: str = Form("upload", pattern="^(camera|upload)$"),
    crop: str | None = Form(None, description="JSON [x, y, w, h] theo tỉ lệ 0–1 của khung quét"),
    ctx: AppContext = Depends(get_ctx),
) -> dict:
    data = await file.read(MAX_IMAGE_BYTES + 1)
    if len(data) > MAX_IMAGE_BYTES:
        raise bad_request("Ảnh quá lớn (tối đa 25 MB).")
    crop_rect = None
    if crop:
        try:
            parsed = json.loads(crop)
            if isinstance(parsed, list) and len(parsed) == 4:
                crop_rect = [float(v) for v in parsed]
        except (ValueError, TypeError):
            raise bad_request("Tham số crop không hợp lệ.") from None
    if not ctx.ocr.enabled:
        raise bad_request("OCR đang tắt trong cấu hình hiện tại.")
    try:
        job = ctx.ocr.submit(data, source=source, crop=crop_rect)
    except ImageError as exc:
        raise bad_request(str(exc)) from exc
    return job.public()


@router.get("/status")
def status(ctx: AppContext = Depends(get_ctx)) -> dict:
    return ctx.ocr.status()


@router.post("/warmup", status_code=202)
def warmup(ctx: AppContext = Depends(get_ctx)) -> dict:
    ctx.ocr.warmup()
    return ctx.ocr.status()


@router.get("/jobs/{job_id}")
def job(job_id: str, ctx: AppContext = Depends(get_ctx)) -> dict:
    found = ctx.ocr.get(job_id)
    if found is None:
        raise not_found("Không tìm thấy lần quét này (có thể đã hết hạn).")
    return found.public()


@router.get("/jobs/{job_id}/image")
def job_image(job_id: str, ctx: AppContext = Depends(get_ctx)) -> FileResponse:
    found = ctx.ocr.get(job_id)
    if found is None or not found.image_path or not found.image_path.exists():
        raise not_found("Ảnh quét không còn.")
    return FileResponse(found.image_path, media_type="image/jpeg", headers={"Cache-Control": "no-store"})
