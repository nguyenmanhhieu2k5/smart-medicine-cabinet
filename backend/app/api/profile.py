"""Hồ sơ của tài khoản quản trị đang đăng nhập (kênh Admin)."""
from __future__ import annotations

from fastapi import APIRouter, Depends, File, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from app.api.deps import bad_request, get_ctx, not_found
from app.auth.deps import get_principal
from app.auth.service import Principal, user_public
from app.core import clock
from app.core.context import AppContext
from app.models import User
from app.services.ocr import preprocess

router = APIRouter(tags=["profile"])


class ProfilePatch(BaseModel):
    name: str | None = Field(None, max_length=120)
    phone: str | None = Field(None, max_length=32)


def _avatar_path(ctx: AppContext, principal: Principal):  # noqa: ANN202
    return ctx.settings.images_dir / f"avatar_{principal.user_id}.jpg"


def _profile(ctx: AppContext, principal: Principal) -> dict:
    with ctx.db.session() as s:
        user = s.get(User, principal.user_id)
        if user is None:
            raise not_found("Không tìm thấy tài khoản.")
        account = user_public(user)
    return {
        "name": account["full_name"],
        "email": account["email"],
        "role": account["role_name"] or account["role"],
        "phone": account["phone"],
        "has_avatar": _avatar_path(ctx, principal).is_file(),
        "account": account,
        "auth": {"provider": "server", "configured": True, "signed_in": True, "email": account["email"], "user_id": account["id"]},
    }


@router.get("/profile")
def get_profile(ctx: AppContext = Depends(get_ctx), principal: Principal = Depends(get_principal)) -> dict:
    return _profile(ctx, principal)


@router.patch("/profile")
def update_profile(body: ProfilePatch, ctx: AppContext = Depends(get_ctx), principal: Principal = Depends(get_principal)) -> dict:
    changes = body.model_dump(exclude_unset=True)
    with ctx.db.session() as s:
        user = s.get(User, principal.user_id)
        if user is None:
            raise not_found("Không tìm thấy tài khoản.")
        if "name" in changes and changes["name"] is not None:
            user.full_name = changes["name"].strip()
        if "phone" in changes:
            user.phone = (changes["phone"] or "").strip() or None
        user.updated_at = clock.now()
    return _profile(ctx, principal)


@router.post("/profile/avatar")
async def upload_avatar(file: UploadFile = File(...), ctx: AppContext = Depends(get_ctx), principal: Principal = Depends(get_principal)) -> dict:
    data = await file.read(8 * 1024 * 1024 + 1)
    if len(data) > 8 * 1024 * 1024:
        raise bad_request("Ảnh đại diện tối đa 8 MB.")
    try:
        image = preprocess.limit_size(preprocess.decode_image(data), 512)
    except preprocess.ImageError as exc:
        raise bad_request(str(exc)) from exc
    _avatar_path(ctx, principal).write_bytes(preprocess.encode_jpeg(image, 90))
    return _profile(ctx, principal)


@router.get("/profile/avatar")
def get_avatar(ctx: AppContext = Depends(get_ctx), principal: Principal = Depends(get_principal)) -> FileResponse:
    target = _avatar_path(ctx, principal)
    if not target.is_file():
        raise not_found("Chưa có ảnh đại diện.")
    return FileResponse(target, media_type="image/jpeg", headers={"Cache-Control": "no-store"})


@router.delete("/profile/avatar")
def delete_avatar(ctx: AppContext = Depends(get_ctx), principal: Principal = Depends(get_principal)) -> dict:
    _avatar_path(ctx, principal).unlink(missing_ok=True)
    return _profile(ctx, principal)
