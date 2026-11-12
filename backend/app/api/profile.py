"""Hồ sơ người dùng cục bộ + đăng nhập cloud tùy chọn (Supabase)."""
from __future__ import annotations

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from app.api.deps import bad_request, get_ctx, not_found
from app.core.context import AppContext
from app.services import settings_store
from app.services.auth import AuthError
from app.services.ocr import preprocess

router = APIRouter(tags=["profile"])


class ProfilePatch(BaseModel):
    name: str | None = Field(None, max_length=80)
    email: str | None = Field(None, max_length=120, pattern=r"^$|^[^@\s]+@[^@\s]+\.[^@\s]+$")
    role: str | None = Field(None, max_length=60)


class LoginRequest(BaseModel):
    email: str = Field(..., max_length=120)
    password: str = Field(..., min_length=1, max_length=200)


def _profile(ctx: AppContext) -> dict:
    with ctx.db.session() as s:
        settings = settings_store.load_settings(s)
    return {
        "name": settings.profile_name,
        "email": settings.profile_email,
        "role": settings.profile_role,
        "has_avatar": bool(settings.profile_avatar),
        "auth": ctx.auth.status(),
    }


@router.get("/profile")
def get_profile(ctx: AppContext = Depends(get_ctx)) -> dict:
    return _profile(ctx)


@router.patch("/profile")
def update_profile(body: ProfilePatch, ctx: AppContext = Depends(get_ctx)) -> dict:
    changes = {f"profile_{k}": (v or "").strip() for k, v in body.model_dump(exclude_unset=True).items() if v is not None}
    with ctx.db.session() as s:
        settings_store.save_settings(s, changes)
    return _profile(ctx)


@router.post("/profile/avatar")
async def upload_avatar(file: UploadFile = File(...), ctx: AppContext = Depends(get_ctx)) -> dict:
    data = await file.read(8 * 1024 * 1024 + 1)
    if len(data) > 8 * 1024 * 1024:
        raise bad_request("Ảnh đại diện tối đa 8 MB.")
    try:
        image = preprocess.limit_size(preprocess.decode_image(data), 512)
    except preprocess.ImageError as exc:
        raise bad_request(str(exc)) from exc
    target = ctx.settings.images_dir / "avatar.jpg"
    target.write_bytes(preprocess.encode_jpeg(image, 90))
    with ctx.db.session() as s:
        settings_store.save_settings(s, {"profile_avatar": str(target)})
    return _profile(ctx)


@router.get("/profile/avatar")
def get_avatar(ctx: AppContext = Depends(get_ctx)) -> FileResponse:
    target = ctx.settings.images_dir / "avatar.jpg"
    if not target.is_file():
        raise not_found("Chưa có ảnh đại diện.")
    return FileResponse(target, media_type="image/jpeg", headers={"Cache-Control": "no-store"})


@router.delete("/profile/avatar")
def delete_avatar(ctx: AppContext = Depends(get_ctx)) -> dict:
    (ctx.settings.images_dir / "avatar.jpg").unlink(missing_ok=True)
    with ctx.db.session() as s:
        settings_store.save_settings(s, {"profile_avatar": None})
    return _profile(ctx)


@router.post("/auth/login")
def login(body: LoginRequest, ctx: AppContext = Depends(get_ctx)) -> dict:
    try:
        ctx.auth.sign_in(body.email, body.password)
    except AuthError as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc
    return _profile(ctx)


@router.post("/auth/logout")
def logout(ctx: AppContext = Depends(get_ctx)) -> dict:
    ctx.auth.sign_out()
    return _profile(ctx)
