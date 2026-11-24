"""Đăng nhập kênh Admin (chỉ tài khoản ADMIN; token aud=admin không dùng được ở kênh Public)."""
from __future__ import annotations

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel, Field

from app.api.deps import get_ctx
from app.auth.deps import get_principal, request_meta
from app.auth.service import Principal, user_public
from app.core.context import AppContext
from app.models import User

router = APIRouter(prefix="/auth", tags=["auth"])


class LoginBody(BaseModel):
    email: str = Field(..., min_length=3, max_length=254)
    password: str = Field(..., min_length=1, max_length=200)


class RefreshBody(BaseModel):
    refresh_token: str = Field(..., min_length=20, max_length=200)


class PasswordBody(BaseModel):
    current_password: str = Field(..., min_length=1, max_length=200)
    new_password: str = Field(..., min_length=1, max_length=200)


@router.post("/login")
def login(body: LoginBody, request: Request, ctx: AppContext = Depends(get_ctx)) -> dict:
    return ctx.auth.login(email=body.email, password=body.password, channel="admin", meta=request_meta(request))


@router.post("/refresh")
def refresh(body: RefreshBody, request: Request, ctx: AppContext = Depends(get_ctx)) -> dict:
    return ctx.auth.refresh(refresh_token=body.refresh_token, channel="admin", meta=request_meta(request))


@router.post("/logout")
def logout(body: RefreshBody, ctx: AppContext = Depends(get_ctx)) -> dict:
    """Thu hồi phiên theo refresh token (dùng được cả khi access token đã hết hạn)."""
    ctx.auth.logout(refresh_token=body.refresh_token)
    return {"ok": True}


@router.get("/me")
def me(ctx: AppContext = Depends(get_ctx), principal: Principal = Depends(get_principal)) -> dict:
    with ctx.db.session() as s:
        user = s.get(User, principal.user_id)
        return {"user": user_public(user), "channel": "admin"}


@router.post("/password")
def change_password(body: PasswordBody, request: Request, ctx: AppContext = Depends(get_ctx),
                    principal: Principal = Depends(get_principal)) -> dict:
    ctx.auth.change_password(principal, body.current_password, body.new_password, request_meta(request))
    return {"ok": True}
