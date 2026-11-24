"""API công khai /api/v1 (qua Tailscale Funnel hoặc Cloudflare Tunnel): ứng dụng di động SCANNER + kết nối ESP32.

KHÔNG có endpoint quản trị nào ở đây. Mọi endpoint (trừ đăng nhập/đăng ký, health, cấu hình)
yêu cầu access token aud=scanner; token của kênh Admin không dùng được ở đây và ngược lại.
"""
from __future__ import annotations

import uuid
from datetime import date, datetime
from typing import Any, Literal

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, Request, UploadFile, WebSocket
from fastapi.responses import FileResponse
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import func, select

from app import __version__
from app.api.cabinet import STATUS_FILTERS, _counts, _filtered, _serialize_all
from app.api.deps import bad_request, get_ctx, not_found
from app.api.ocr import parse_crop, read_image
from app.auth.deps import client_ip, get_principal, request_meta, require
from app.auth.ratelimit import RateLimitExceeded
from app.auth.service import Principal, audit, user_public
from app.core import clock
from app.core.context import AppContext
from app.database.session import APP_TIMEZONE, iso_local
from app.models import CabinetItem, OcrCandidateRecord, ScanHistory, User
from app.services import history, settings_store
from app.services.alerts import engine as alert_engine
from app.services.barcode.gs1 import parse_code
from app.services.cabinet import serialize_item
from app.services.barcode.lookup import find_medicine, gs1_extra
from app.services.medicine_matcher.catalog import CatalogRepository, medicine_detail, medicine_summary
from app.services.medicine_matcher.normalize import normalize_text
from app.services.ocr.preprocess import ImageError
from app.services.ocr.service import OcrBusy

router = APIRouter(prefix="/api/v1")
scanner_read = require("catalog:read")
scanner_scan = require("scan:create")
own_history = require("scan:read_own")
own_profile = require("profile:manage_own")
cabinet_read = require("cabinet:read")
cabinet_expiry = require("cabinet:update_expiry")


# --------------------------------------------------------------------------- #
# Hệ thống
# --------------------------------------------------------------------------- #
@router.get("/health", tags=["public"])
def health(ctx: AppContext = Depends(get_ctx)) -> dict:
    ok = ctx.db.check()
    return {"status": "ok" if ok else "degraded", "version": __version__, "time": iso_local(clock.now()),
            "ocr": ctx.ocr.status()["state"] if ok else None}


@router.get("/app/config", tags=["public"])
def app_config(ctx: AppContext = Depends(get_ctx)) -> dict:
    return {
        "registration_enabled": ctx.settings.allow_registration,
        "password_reset_enabled": ctx.auth.password_reset_available,
        "providers": {"password": True, "google": False, "apple": False, "phone": False},
        "max_upload_mb": 25,
        "ocr_timeout_seconds": 30,
        "max_candidates": 3,
        "server_version": __version__,
    }


# --------------------------------------------------------------------------- #
# Tài khoản
# --------------------------------------------------------------------------- #
class RegisterBody(BaseModel):
    full_name: str = Field(..., min_length=1, max_length=120)
    email: str = Field(..., min_length=3, max_length=254)
    password: str = Field(..., min_length=1, max_length=200)


class LoginBody(BaseModel):
    email: str = Field(..., min_length=3, max_length=254)
    password: str = Field(..., min_length=1, max_length=200)


class RefreshBody(BaseModel):
    refresh_token: str = Field(..., min_length=20, max_length=200)


class ForgotBody(BaseModel):
    email: str = Field(..., min_length=3, max_length=254)


class ResetBody(BaseModel):
    email: str = Field(..., min_length=3, max_length=254)
    code: str = Field(..., min_length=4, max_length=12)
    new_password: str = Field(..., min_length=1, max_length=200)


class ProfileBody(BaseModel):
    full_name: str | None = Field(None, min_length=1, max_length=120)
    phone: str | None = Field(None, max_length=32)
    preferences: dict[str, Any] | None = None


class PasswordBody(BaseModel):
    current_password: str = Field(..., min_length=1, max_length=200)
    new_password: str = Field(..., min_length=1, max_length=200)


ALLOWED_PREFERENCES = {"notifications", "vibrate_on_scan", "image_quality", "language", "theme"}


@router.post("/auth/register", status_code=201, tags=["auth"])
def register(body: RegisterBody, request: Request, ctx: AppContext = Depends(get_ctx)) -> dict:
    return ctx.auth.register(email=body.email, password=body.password, full_name=body.full_name, meta=request_meta(request))


@router.post("/auth/login", tags=["auth"])
def login(body: LoginBody, request: Request, ctx: AppContext = Depends(get_ctx)) -> dict:
    return ctx.auth.login(email=body.email, password=body.password, channel="public", meta=request_meta(request))


@router.post("/auth/refresh", tags=["auth"])
def refresh(body: RefreshBody, request: Request, ctx: AppContext = Depends(get_ctx)) -> dict:
    return ctx.auth.refresh(refresh_token=body.refresh_token, channel="public", meta=request_meta(request))


@router.post("/auth/logout", tags=["auth"])
def logout(body: RefreshBody, ctx: AppContext = Depends(get_ctx)) -> dict:
    ctx.auth.logout(refresh_token=body.refresh_token)
    return {"ok": True}


@router.post("/auth/password/forgot", status_code=202, tags=["auth"])
def forgot_password(body: ForgotBody, request: Request, ctx: AppContext = Depends(get_ctx)) -> dict:
    ctx.auth.request_password_reset(body.email, request_meta(request))
    return {"ok": True, "message": "Nếu email đã đăng ký, chúng tôi đã gửi mã xác minh gồm 6 chữ số."}


@router.post("/auth/password/reset", tags=["auth"])
def reset_password(body: ResetBody, request: Request, ctx: AppContext = Depends(get_ctx)) -> dict:
    ctx.auth.confirm_password_reset(email=body.email, code=body.code, new_password=body.new_password, meta=request_meta(request))
    return {"ok": True, "message": "Đã đặt lại mật khẩu. Vui lòng đăng nhập bằng mật khẩu mới."}


@router.get("/me", tags=["me"])
def me(ctx: AppContext = Depends(get_ctx), principal: Principal = Depends(own_profile)) -> dict:
    with ctx.db.session() as s:
        user = s.get(User, principal.user_id)
        scans = s.scalar(select(func.count()).select_from(ScanHistory).where(ScanHistory.user_id == principal.user_id)) or 0
        data = user_public(user)
        # Trên ứng dụng di động mọi tài khoản chỉ có quyền Scanner.
        data |= {"role": "SCANNER", "role_name": "Người quét (chỉ đọc)", "permissions": sorted(principal.permissions),
                 "account_role": user.role_code, "preferences": user.preferences or {}, "scan_count": scans}
        return {"user": data}


@router.patch("/me", tags=["me"])
def update_me(body: ProfileBody, ctx: AppContext = Depends(get_ctx), principal: Principal = Depends(own_profile)) -> dict:
    changes = body.model_dump(exclude_unset=True)
    with ctx.db.session() as s:
        user = s.get(User, principal.user_id)
        if changes.get("full_name"):
            user.full_name = changes["full_name"].strip()
        if "phone" in changes:
            user.phone = (changes["phone"] or "").strip() or None
        if changes.get("preferences") is not None:
            prefs = {k: v for k, v in changes["preferences"].items() if k in ALLOWED_PREFERENCES and isinstance(v, (str, bool, int))}
            user.preferences = {**(user.preferences or {}), **prefs}
        user.updated_at = clock.now()
    return me(ctx, principal)


@router.post("/me/password", tags=["me"])
def change_password(body: PasswordBody, request: Request, ctx: AppContext = Depends(get_ctx),
                    principal: Principal = Depends(own_profile)) -> dict:
    ctx.auth.change_password(principal, body.current_password, body.new_password, request_meta(request))
    return {"ok": True}


# --------------------------------------------------------------------------- #
# Danh mục thuốc (chỉ đọc)
# --------------------------------------------------------------------------- #
@router.get("/catalog/search", tags=["catalog"])
def search(q: str = Query(..., min_length=1, max_length=120), limit: int = Query(20, ge=1, le=30),
           offset: int = Query(0, ge=0, le=300), ctx: AppContext = Depends(get_ctx), _: Principal = Depends(scanner_read)) -> dict:
    with ctx.db.session() as s:
        return CatalogRepository(s).search(q, limit=limit, offset=offset)


@router.get("/catalog/{medicine_id}", tags=["catalog"])
def medicine(medicine_id: int, ctx: AppContext = Depends(get_ctx), _: Principal = Depends(scanner_read)) -> dict:
    with ctx.db.session() as s:
        row = CatalogRepository(s).get(medicine_id)
        if row is None:
            raise not_found("Không tìm thấy thuốc trong danh mục.")
        data = medicine_detail(row)
        data.pop("raw", None)
        data["source"] = "CSDL Dược (DAV_unique)"
        data["read_only"] = True
        return data


# --------------------------------------------------------------------------- #
# Mã vạch (chỉ tra cứu — không thêm/sửa dữ liệu mã vạch hay danh mục từ kênh công khai)
# --------------------------------------------------------------------------- #
class BarcodeBody(BaseModel):
    code: str = Field(..., min_length=1, max_length=400, description="Nội dung mã do camera đọc được (EAN-13, DataMatrix GS1…)")


@router.post("/barcodes/lookup", tags=["scan"])
def barcode_lookup(body: BarcodeBody, ctx: AppContext = Depends(get_ctx), principal: Principal = Depends(scanner_scan)) -> dict:
    """Mã vạch → thuốc trong danh mục. Tìm thấy thì ghi vào lịch sử quét của chính người dùng."""
    try:
        ctx.limiter.hit("barcode_user", str(principal.user_id))
    except RateLimitExceeded as exc:
        raise HTTPException(429, str(exc), headers={"Retry-After": str(exc.retry_after)}) from exc
    parsed = parse_code(body.code)
    out: dict[str, Any] = {"status": parsed.kind, "code": parsed.display, "gtin": parsed.gtin, "gs1": gs1_extra(parsed),
                           "medicine": None, "history_id": None, "message": parsed.message}
    if parsed.kind != "gtin" or parsed.gtin is None:
        return out
    with ctx.db.session() as s:
        found = find_medicine(s, parsed.gtin)
        if found is None:
            out.update(status="not_found", message=f"Mã vạch {parsed.display} chưa có trong dữ liệu. "
                                                   "Hãy chụp mặt hộp có tên thuốc để nhận diện.")
            return out
        _, row = found
        summary = medicine_summary(row)
        history = ScanHistory(
            user_id=principal.user_id, job_id=None, status="confident", title=row.ten_thuoc[:300],
            subtitle=f"Quét mã vạch {parsed.display}", candidate_count=1, top_medicine_id=row.id,
            selected_medicine_id=row.id, search_text=normalize_text(f"{row.ten_thuoc} {parsed.display}")[:1000],
            created_at=clock.now(),
        )
        s.add(history)
        s.flush()
        out.update(status="found", medicine=summary, history_id=str(history.id), message="")
    return out


# --------------------------------------------------------------------------- #
# Tủ thuốc: tài khoản đăng ký (SCANNER) chỉ XEM và SỬA NGÀY HẾT HẠN — không thêm/xóa/sửa gì khác
# --------------------------------------------------------------------------- #
PUBLIC_CABINET_FIELDS = (
    "id", "catalog_id", "name", "ingredient", "strength", "dosage_form", "registration_no", "manufacturer", "quantity_text",
    "expiry_date", "expiry_source", "expiry_status", "expiry_status_label", "days_left", "lot_number", "updated_at",
)
MIN_EXPIRY = date(2000, 1, 1)


def _public_cabinet_item(row: dict[str, Any]) -> dict[str, Any]:
    return {k: row.get(k) for k in PUBLIC_CABINET_FIELDS}


class ExpiryBody(BaseModel):
    # Chỉ nhận đúng một trường: gửi thêm tên/số lượng/… → 422 (không có cách nào sửa thông tin khác từ điện thoại).
    model_config = ConfigDict(extra="forbid")
    expiry_date: date | None = Field(..., description="Ngày hết hạn mới (YYYY-MM-DD); null = chưa rõ")


@router.get("/cabinet/medicines", tags=["cabinet"])
def cabinet_list(
    q: str = Query("", max_length=200),
    status: str = Query("all", pattern="^(" + "|".join(STATUS_FILTERS) + ")$"),
    ctx: AppContext = Depends(get_ctx),
    _: Principal = Depends(cabinet_read),
) -> dict:
    """Thuốc trong tủ, sắp theo hạn dùng gần nhất trước (để kiểm tra/sửa ngày hết hạn)."""
    with ctx.db.session() as s:
        rows = _serialize_all(s, list(s.scalars(select(CabinetItem)).all()))
        counts = _counts(rows)
        rows = _filtered(rows, q, status, "expiry")
        return {"items": [_public_cabinet_item(r) for r in rows[:500]], "total": len(rows), "counts": counts}


@router.patch("/cabinet/medicines/{item_id}/expiry", tags=["cabinet"])
def cabinet_update_expiry(item_id: int, body: ExpiryBody, request: Request, ctx: AppContext = Depends(get_ctx),
                          principal: Principal = Depends(cabinet_expiry)) -> dict:
    new = body.expiry_date
    today = clock.now().date()
    if new is not None and not (MIN_EXPIRY <= new <= today.replace(year=today.year + 30)):
        raise bad_request("Ngày hết hạn không hợp lệ.")
    with ctx.db.session() as s:
        item = s.get(CabinetItem, item_id)
        if item is None:
            raise not_found("Không tìm thấy thuốc này trong tủ.")
        settings = settings_store.load_settings(s)
        old = item.expiry_date
        if old != new:
            item.expiry_date = new
            item.expiry_source = "manual" if new else None
            item.updated_at = clock.now()
            item.updated_by = principal.user_id
            shown = lambda d: d.strftime("%d/%m/%Y") if d else "chưa rõ"  # noqa: E731
            history.record(
                s, "cabinet", "cabinet_update", "Sửa hạn dùng",
                f"{item.name}: {shown(old)} → {shown(new)} (ứng dụng điện thoại · {principal.email})",
                {"cabinet_item_id": item.id, "fields": ["expiry_date"], "by": principal.email},
            )
            audit(s, "cabinet.expiry_update", channel="public", user_id=principal.user_id, actor=principal.email,
                  resource_type="cabinet_item", resource_id=str(item.id), ip=client_ip(request),
                  detail={"from": old.isoformat() if old else None, "to": new.isoformat() if new else None})
            alert_engine.evaluate_medicines(s, settings)  # cảnh báo hết hạn tính lại ngay
        return _public_cabinet_item(serialize_item(item, settings.expiry_warning_days, settings.low_stock_threshold))


# --------------------------------------------------------------------------- #
# AI tra cứu trên mạng (Gemini + Google Search) — chỉ đọc, kết quả không tự vào tủ thuốc
# --------------------------------------------------------------------------- #
class AiCodeBody(BaseModel):
    kind: Literal["barcode", "qr"]
    code: str = Field(..., min_length=1, max_length=1000)


def _ai_rate(ctx: AppContext, principal: Principal) -> None:
    try:
        ctx.limiter.hit("ai_user", str(principal.user_id))
    except RateLimitExceeded as exc:
        raise HTTPException(429, str(exc), headers={"Retry-After": str(exc.retry_after)}) from exc


@router.post("/ai/lookup", tags=["scan"])
def ai_lookup(body: AiCodeBody, ctx: AppContext = Depends(get_ctx), principal: Principal = Depends(scanner_scan)) -> dict:
    """Mã vạch/QR chưa có trong dữ liệu → AI tìm thông tin thuốc trên mạng."""
    _ai_rate(ctx, principal)
    return ctx.ai.lookup_code(body.kind, body.code, user_id=principal.user_id)


@router.post("/ai/scans/{job_id}", tags=["scan"])
def ai_scan(job_id: uuid.UUID, ctx: AppContext = Depends(get_ctx), principal: Principal = Depends(scanner_scan)) -> dict:
    """Người dùng xác nhận "không có thuốc đúng" trong kết quả quét → AI đọc ảnh + tra mạng."""
    _ai_rate(ctx, principal)
    material = ctx.ocr.ai_material(str(job_id), user_id=principal.user_id)
    if material is None:
        raise not_found("Không tìm thấy lượt quét này.")
    image, text, lines = material
    return ctx.ai.lookup_scan(str(job_id), image=image, ocr_text=text, lines=lines, user_id=principal.user_id)


# --------------------------------------------------------------------------- #
# Quét OCR
# --------------------------------------------------------------------------- #
def public_job(job: dict[str, Any]) -> dict[str, Any]:
    """Bỏ thông tin nội bộ (đường dẫn mô hình, nhật ký thử tiền xử lý) trước khi trả cho mobile."""
    result = job.get("result") or None
    view = None
    if result:
        match = result.get("match") or {}
        view = {
            "match": {
                "status": match.get("status"),
                "message": match.get("message"),
                "reasons": match.get("reasons") or [],
                "candidates": [
                    {"rank": i + 1, "medicine": c.get("medicine"), "score": c.get("score"), "level": c.get("level"),
                     "level_label": c.get("level_label")}
                    for i, c in enumerate((match.get("candidates") or [])[:3])
                ],
            },
            "ocr_text": [ln.get("text") for ln in (result.get("ocr") or {}).get("lines", [])],
            "expiry_suggestion": result.get("expiry_suggestion"),
            "elapsed_ms": result.get("elapsed_ms"),
        }
    return {
        "id": job["id"], "status": job["status"], "progress": job["progress"], "message": job["message"],
        "stages": job.get("stages"), "created_at": job["created_at"], "finished_at": job.get("finished_at"),
        "error": job.get("error"), "result": view,
    }


@router.post("/scans", status_code=202, tags=["scan"])
async def create_scan(
    file: UploadFile = File(..., description="Ảnh hộp/vỉ thuốc"),
    source: str = Form("camera", pattern="^(camera|upload)$"),
    crop: str | None = Form(None),
    ctx: AppContext = Depends(get_ctx),
    principal: Principal = Depends(scanner_scan),
) -> dict:
    try:
        ctx.limiter.hit("scan_user", str(principal.user_id))
    except RateLimitExceeded as exc:
        raise HTTPException(429, str(exc), headers={"Retry-After": str(exc.retry_after)}) from exc
    data = await read_image(file)
    if not ctx.ocr.enabled:
        raise HTTPException(503, "Máy chủ đang tắt chức năng nhận diện.")
    try:
        job = ctx.ocr.submit(data, source=source, crop=parse_crop(crop), user_id=principal.user_id,
                             channel="public", actor=principal.email)
    except ImageError as exc:
        raise bad_request(str(exc)) from exc
    except OcrBusy as exc:
        raise HTTPException(exc.status_code, str(exc)) from exc
    return public_job(job.public())


@router.get("/scans/{job_id}", tags=["scan"])
def get_scan(job_id: str, ctx: AppContext = Depends(get_ctx), principal: Principal = Depends(own_history)) -> dict:
    found = ctx.ocr.load(job_id, user_id=principal.user_id)
    if found is None:
        raise not_found("Không tìm thấy lượt quét này.")
    view = public_job(found)
    # Mục lịch sử tương ứng (có khi lượt quét đã kết thúc) — để ghi nhận ứng viên người dùng chọn xem.
    with ctx.db.session() as s:
        view["history_id"] = next((str(h) for h in s.scalars(
            select(ScanHistory.id).where(ScanHistory.job_id == uuid.UUID(found["id"]), ScanHistory.user_id == principal.user_id)
        ).all()), None)
    return view


@router.delete("/scans/{job_id}", tags=["scan"])
def cancel_scan(job_id: str, ctx: AppContext = Depends(get_ctx), principal: Principal = Depends(scanner_scan)) -> dict:
    if not ctx.ocr.cancel(job_id, user_id=principal.user_id):
        found = ctx.ocr.load(job_id, user_id=principal.user_id)
        if found is None:
            raise not_found("Không tìm thấy lượt quét này.")
        return {"cancelled": False, "status": found["status"]}
    return {"cancelled": True}


@router.get("/scans/{job_id}/thumbnail", tags=["scan"])
def scan_thumbnail(job_id: str, ctx: AppContext = Depends(get_ctx), principal: Principal = Depends(own_history)) -> FileResponse:
    path = ctx.ocr.thumbnail(job_id, user_id=principal.user_id)
    if path is None:
        raise not_found("Ảnh không còn (đã quá thời gian lưu giữ).")
    return FileResponse(path, media_type="image/jpeg", headers={"Cache-Control": "private, max-age=86400"})


# --------------------------------------------------------------------------- #
# Lịch sử quét của chính tài khoản
# --------------------------------------------------------------------------- #
def _history_item(h: ScanHistory) -> dict[str, Any]:
    return {
        "id": str(h.id), "job_id": str(h.job_id) if h.job_id else None, "status": h.status, "title": h.title,
        "subtitle": h.subtitle, "candidate_count": h.candidate_count, "top_medicine_id": h.top_medicine_id,
        "selected_medicine_id": h.selected_medicine_id, "created_at": iso_local(h.created_at),
        "has_thumbnail": h.job_id is not None,
    }


# Nhóm trạng thái cho bộ lọc của màn hình Lịch sử quét (ứng dụng di động).
HISTORY_STATUS_GROUPS = {
    "found": ("confident",),
    "multiple": ("uncertain",),
    "unrecognized": ("no_text", "no_match", "no_catalog"),
    "failed": ("failed", "cancelled"),
}


@router.get("/history", tags=["history"])
def history_list(
    q: str = Query("", max_length=120), limit: int = Query(30, ge=1, le=100),
    before: datetime | None = Query(None, description="Phân trang: lấy các mục trước thời điểm này"),
    status: str | None = Query(None, pattern="^(found|multiple|unrecognized|failed)$"),
    ctx: AppContext = Depends(get_ctx), principal: Principal = Depends(own_history),
) -> dict:
    with ctx.db.session() as s:
        stmt = select(ScanHistory).where(ScanHistory.user_id == principal.user_id)
        if status:
            stmt = stmt.where(ScanHistory.status.in_(HISTORY_STATUS_GROUPS[status]))
        needle = normalize_text(q)
        if needle:
            stmt = stmt.where(ScanHistory.search_text.contains(needle))
        if before is not None:
            stmt = stmt.where(ScanHistory.created_at < (before.astimezone(APP_TIMEZONE).replace(tzinfo=None) if before.tzinfo else before))
        rows = s.scalars(stmt.order_by(ScanHistory.created_at.desc()).limit(limit + 1)).all()
        items = [_history_item(h) for h in rows[:limit]]
        return {"items": items, "has_more": len(rows) > limit, "next_before": items[-1]["created_at"] if len(rows) > limit else None}


@router.get("/history/{history_id}", tags=["history"])
def history_detail(history_id: uuid.UUID, ctx: AppContext = Depends(get_ctx), principal: Principal = Depends(own_history)) -> dict:
    with ctx.db.session() as s:
        h = s.get(ScanHistory, history_id)
        if h is None or h.user_id != principal.user_id:
            raise not_found("Không tìm thấy mục lịch sử.")
        item = _history_item(h)
        job_id = str(h.job_id) if h.job_id else None
    job = ctx.ocr.load(job_id, user_id=principal.user_id) if job_id else None
    return {"item": item, "scan": public_job(job) if job else None}


class SelectBody(BaseModel):
    medicine_id: int = Field(..., gt=0)


@router.post("/history/{history_id}/select", tags=["history"])
def history_select(history_id: uuid.UUID, body: SelectBody, ctx: AppContext = Depends(get_ctx),
                   principal: Principal = Depends(own_history)) -> dict:
    """Ghi nhận ứng viên người dùng chọn xem chi tiết (chỉ trong lịch sử, không thêm thuốc vào tủ)."""
    with ctx.db.session() as s:
        h = s.get(ScanHistory, history_id)
        if h is None or h.user_id != principal.user_id:
            raise not_found("Không tìm thấy mục lịch sử.")
        allowed = set(s.scalars(select(OcrCandidateRecord.medicine_id).where(OcrCandidateRecord.job_id == h.job_id)).all())
        if body.medicine_id not in allowed:
            raise bad_request("Thuốc này không nằm trong kết quả của lượt quét.")
        h.selected_medicine_id = body.medicine_id
        return {"item": _history_item(h)}


# --------------------------------------------------------------------------- #
# ESP32 — kết nối WSS ra ngoài (token thiết bị, không phải token người dùng)
# --------------------------------------------------------------------------- #
@router.websocket("/device/ws")
async def device_socket(websocket: WebSocket) -> None:
    ctx: AppContext = websocket.app.state.ctx
    # Cùng quy tắc với HTTP: IP thật qua CF-Connecting-IP (Cloudflare) hoặc X-Forwarded-For (Tailscale Funnel).
    await ctx.devices.serve(websocket, client_ip(websocket))


__all__ = ["router", "public_job", "medicine_summary", "client_ip"]
