"""Trang web quét thuốc — KHÁCH chưa đăng nhập: /api/v1/guest/... (chỉ chức năng quét).

Khách được quét thử ``SMC_GUEST_SCANS`` lần (mặc định 5); hết lượt → 401 ``code=guest_limit`` để trang web chuyển sang
đăng nhập/đăng ký. Đã đăng nhập thì trang web dùng các endpoint thường (giống hệt ứng dụng điện thoại).

Khách KHÔNG có: lịch sử quét, tủ thuốc, sửa hạn dùng, hồ sơ. Mỗi endpoint kiểm tra chủ sở hữu lượt quét bằng mã khách
(header ``X-Guest-Id``) — khách này không xem/hủy/tra tiếp được lượt quét của khách khác hay của tài khoản.
"""
from __future__ import annotations

import uuid
from typing import Any

from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse

from app.api.deps import bad_request, get_ctx, not_found
from app.api.ocr import parse_crop, read_image
from app.api.public import AiCodeBody, BarcodeBody, public_job
from app.auth.deps import client_ip
from app.auth.ratelimit import RateLimitExceeded
from app.core.context import AppContext
from app.services.barcode.gs1 import parse_code
from app.services.barcode.lookup import find_medicine, gs1_extra
from app.services.guest import GuestLimitReached
from app.services.medicine_matcher.catalog import CatalogRepository, medicine_detail, medicine_summary
from app.services.ocr.preprocess import ImageError
from app.services.ocr.service import OcrBusy

router = APIRouter(prefix="/api/v1/guest", tags=["guest"])


class GuestContext:
    def __init__(self, ctx: AppContext, key: str, ip: str | None):
        self.ctx, self.key, self.ip = ctx, key, ip

    def read_rate(self) -> None:
        _rate(self.ctx, "guest_read_ip", self.ip or "unknown")


def _rate(ctx: AppContext, bucket: str, key: str) -> None:
    try:
        ctx.limiter.hit(bucket, key)
    except RateLimitExceeded as exc:
        raise HTTPException(429, str(exc), headers={"Retry-After": str(exc.retry_after)}) from exc


def guest(request: Request, ctx: AppContext = Depends(get_ctx)) -> GuestContext:
    if not ctx.guests.enabled:
        raise HTTPException(404, "Trang web không cho quét khi chưa đăng nhập. Hãy đăng nhập để quét.")
    key = ctx.guests.key(request.headers.get("x-guest-id"))
    if key is None:
        raise bad_request("Thiếu hoặc sai mã khách (X-Guest-Id). Hãy tải lại trang.")
    return GuestContext(ctx, key, client_ip(request))


def _limit_response(exc: GuestLimitReached, quota: dict[str, Any] | None = None) -> JSONResponse:
    return JSONResponse({"detail": str(exc), "code": "guest_limit", "guest": quota or {"limit": exc.limit, "remaining": 0}}, status_code=401)


def _consume(g: GuestContext, codes: list[str] | None = None) -> dict[str, Any]:
    try:
        return g.ctx.guests.consume(g.key, g.ip, codes=codes)
    except RateLimitExceeded as exc:
        raise HTTPException(429, "Đã có quá nhiều lượt quét thử từ mạng này hôm nay. Hãy đăng nhập để quét tiếp.",
                            headers={"Retry-After": str(exc.retry_after)}) from exc


def _code_keys(code: str) -> list[str]:
    """Các khóa ghi nhận một mã đã quét: nội dung mã + GTIN chuẩn (nếu là mã sản phẩm)."""
    raw = code.strip()[:400]
    parsed = parse_code(raw)
    return list(dict.fromkeys([raw] + ([parsed.gtin] if parsed.gtin else [])))


# --------------------------------------------------------------------------- #
@router.get("/status")
def status(g: GuestContext = Depends(guest)) -> dict:
    """Số lượt quét thử còn lại của trình duyệt khách."""
    g.read_rate()
    return g.ctx.guests.status(g.key)


@router.post("/scans", status_code=202)
async def create_scan(
    file: UploadFile = File(..., description="Ảnh hộp/vỉ thuốc"),
    source: str = Form("camera", pattern="^(camera|upload)$"),
    crop: str | None = Form(None),
    g: GuestContext = Depends(guest),
) -> Any:
    ctx = g.ctx
    data = await read_image(file)
    if not ctx.ocr.enabled:
        raise HTTPException(503, "Máy chủ đang tắt chức năng nhận diện.")
    try:
        quota = _consume(g)
    except GuestLimitReached as exc:
        return _limit_response(exc, ctx.guests.status(g.key))
    try:
        job = ctx.ocr.submit(data, source=source, crop=parse_crop(crop), channel="public", guest_key=g.key)
    except (ImageError, OcrBusy, HTTPException) as exc:
        ctx.guests.refund(g.key)  # ảnh hỏng / máy chủ bận: không mất lượt
        if isinstance(exc, ImageError):
            raise bad_request(str(exc)) from exc
        if isinstance(exc, OcrBusy):
            raise HTTPException(exc.status_code, str(exc)) from exc
        raise
    return {**public_job(job.public()), "guest": quota}


@router.get("/scans/{job_id}")
def get_scan(job_id: str, g: GuestContext = Depends(guest)) -> dict:
    g.read_rate()
    found = g.ctx.ocr.load(job_id, guest_key=g.key)
    if found is None:
        raise not_found("Không tìm thấy lượt quét này.")
    return {**public_job(found), "history_id": None}


@router.delete("/scans/{job_id}")
def cancel_scan(job_id: str, g: GuestContext = Depends(guest)) -> dict:
    if not g.ctx.ocr.cancel(job_id, guest_key=g.key):
        found = g.ctx.ocr.load(job_id, guest_key=g.key)
        if found is None:
            raise not_found("Không tìm thấy lượt quét này.")
        return {"cancelled": False, "status": found["status"]}
    return {"cancelled": True}


@router.get("/scans/{job_id}/thumbnail")
def scan_thumbnail(job_id: str, g: GuestContext = Depends(guest)) -> FileResponse:
    g.read_rate()
    path = g.ctx.ocr.thumbnail(job_id, guest_key=g.key)
    if path is None:
        raise not_found("Ảnh không còn (đã quá thời gian lưu giữ).")
    return FileResponse(path, media_type="image/jpeg", headers={"Cache-Control": "private, max-age=3600"})


@router.post("/barcodes/lookup")
def barcode_lookup(body: BarcodeBody, g: GuestContext = Depends(guest)) -> Any:
    """Mã vạch/QR camera vừa đọc → thuốc trong danh mục. Mã MỚI tính một lượt; quét lại cùng mã không tính."""
    try:
        quota = _consume(g, _code_keys(body.code))
    except GuestLimitReached as exc:
        return _limit_response(exc, g.ctx.guests.status(g.key))
    parsed = parse_code(body.code)
    out: dict[str, Any] = {"status": parsed.kind, "code": parsed.display, "gtin": parsed.gtin, "gs1": gs1_extra(parsed),
                           "medicine": None, "history_id": None, "message": parsed.message, "guest": quota}
    if parsed.kind != "gtin" or parsed.gtin is None:
        return out
    with g.ctx.db.session() as s:
        found = find_medicine(s, parsed.gtin)
        if found is None:
            out.update(status="not_found", message=f"Mã vạch {parsed.display} chưa có trong dữ liệu. "
                                                   "Hãy chụp mặt hộp có tên thuốc để nhận diện.")
            return out
        out.update(status="found", medicine=medicine_summary(found[1]), message="")
    return out


@router.get("/catalog/{medicine_id}")
def medicine(medicine_id: int, g: GuestContext = Depends(guest)) -> dict:
    """Chi tiết thuốc trong kết quả quét (danh mục công khai của Cục Quản lý Dược, chỉ đọc)."""
    g.read_rate()
    with g.ctx.db.session() as s:
        row = CatalogRepository(s).get(medicine_id)
        if row is None:
            raise not_found("Không tìm thấy thuốc trong danh mục.")
        data = medicine_detail(row)
        data.pop("raw", None)
        data["source"] = "CSDL Dược (DAV_unique)"
        data["read_only"] = True
        return data


@router.post("/ai/lookup")
def ai_lookup(body: AiCodeBody, g: GuestContext = Depends(guest)) -> Any:
    """Tìm trên mạng theo mã vạch/QR. Mã khách vừa quét: không tính thêm lượt; mã khác: tính một lượt."""
    _rate(g.ctx, "guest_web_ip", g.ip or "unknown")
    try:
        _consume(g, _code_keys(body.code))
    except GuestLimitReached as exc:
        return _limit_response(exc, g.ctx.guests.status(g.key))
    return g.ctx.ai.lookup_code(body.kind, body.code, user_id=None)


@router.post("/ai/scans/{job_id}")
def ai_scan(job_id: uuid.UUID, g: GuestContext = Depends(guest)) -> dict:
    """Không có thuốc đúng trong kết quả quét CỦA CHÍNH KHÁCH → tìm trên mạng (không tính thêm lượt)."""
    _rate(g.ctx, "guest_web_ip", g.ip or "unknown")
    material = g.ctx.ocr.ai_material(str(job_id), guest_key=g.key)
    if material is None:
        raise not_found("Không tìm thấy lượt quét này.")
    image, text, lines = material
    return g.ctx.ai.lookup_scan(str(job_id), image=image, ocr_text=text, lines=lines, user_id=None)
