"""Quản lý tài khoản và phân quyền (kênh Admin, quyền users:manage)."""
from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, Query, Request
from pydantic import BaseModel, Field
from sqlalchemy import func, or_, select

from app.api.deps import bad_request, get_ctx, not_found
from app.auth.deps import client_ip, require
from app.auth.service import AuthError, Principal, audit, user_public
from app.core import clock
from app.core.context import AppContext
from app.models import ROLE_ADMIN, ROLE_SCANNER, Role, User, UserSession

router = APIRouter(prefix="/admin/users", tags=["users"])
manage = require("users:manage")


class UserCreate(BaseModel):
    email: str = Field(..., min_length=3, max_length=254)
    password: str = Field(..., min_length=1, max_length=200)
    full_name: str = Field("", max_length=120)
    phone: str | None = Field(None, max_length=32)
    role: str = Field(ROLE_SCANNER, pattern=f"^({ROLE_ADMIN}|{ROLE_SCANNER})$")


class UserPatch(BaseModel):
    full_name: str | None = Field(None, max_length=120)
    phone: str | None = Field(None, max_length=32)
    role: str | None = Field(None, pattern=f"^({ROLE_ADMIN}|{ROLE_SCANNER})$")
    is_active: bool | None = None


class PasswordSet(BaseModel):
    new_password: str = Field(..., min_length=1, max_length=200)


def _get(s, user_id: uuid.UUID) -> User:
    user = s.get(User, user_id)
    if user is None:
        raise not_found("Không tìm thấy tài khoản.")
    return user


@router.get("")
def list_users(
    q: str = Query("", max_length=120), role: str | None = Query(None, pattern=f"^({ROLE_ADMIN}|{ROLE_SCANNER})$"),
    limit: int = Query(50, ge=1, le=200), offset: int = Query(0, ge=0),
    ctx: AppContext = Depends(get_ctx), _: Principal = Depends(manage),
) -> dict:
    with ctx.db.session() as s:
        stmt = select(User).join(Role)
        if q.strip():
            like = f"%{q.strip().lower()}%"
            stmt = stmt.where(or_(func.lower(User.email).like(like), func.lower(User.full_name).like(like)))
        if role:
            stmt = stmt.where(Role.code == role)
        total = s.scalar(select(func.count()).select_from(stmt.subquery())) or 0
        rows = s.scalars(stmt.order_by(User.created_at.desc()).limit(limit).offset(offset)).all()
        active_sessions = dict(s.execute(
            select(UserSession.user_id, func.count()).where(UserSession.revoked_at.is_(None), UserSession.expires_at > clock.now())
            .group_by(UserSession.user_id)
        ).all())
        items = [user_public(u) | {"active_sessions": int(active_sessions.get(u.id, 0))} for u in rows]
        return {"items": items, "total": total, "limit": limit, "offset": offset}


@router.post("", status_code=201)
def create_user(body: UserCreate, request: Request, ctx: AppContext = Depends(get_ctx), principal: Principal = Depends(manage)) -> dict:
    with ctx.db.session() as s:
        user = ctx.auth.create_user(s, email=body.email, password=body.password, full_name=body.full_name,
                                    role_code=body.role, phone=body.phone)
        audit(s, "user.create", channel="admin", user_id=principal.user_id, actor=principal.email, resource_type="user",
              resource_id=str(user.id), ip=client_ip(request), detail={"email": user.email, "role": body.role})
        return {"user": user_public(user)}


@router.get("/{user_id}")
def get_user(user_id: uuid.UUID, ctx: AppContext = Depends(get_ctx), _: Principal = Depends(manage)) -> dict:
    with ctx.db.session() as s:
        user = _get(s, user_id)
        sessions = s.scalars(
            select(UserSession).where(UserSession.user_id == user.id, UserSession.revoked_at.is_(None),
                                      UserSession.expires_at > clock.now()).order_by(UserSession.last_used_at.desc())
        ).all()
        return {
            "user": user_public(user),
            "sessions": [{"id": str(x.id), "audience": x.audience, "client": x.client, "ip": x.ip,
                          "user_agent": x.user_agent, "created_at": x.created_at.isoformat(),
                          "last_used_at": x.last_used_at.isoformat()} for x in sessions],
        }


@router.patch("/{user_id}")
def update_user(user_id: uuid.UUID, body: UserPatch, request: Request, ctx: AppContext = Depends(get_ctx),
                principal: Principal = Depends(manage)) -> dict:
    changes = body.model_dump(exclude_unset=True)
    with ctx.db.session() as s:
        user = _get(s, user_id)
        demote = changes.get("role") == ROLE_SCANNER and user.role_code == ROLE_ADMIN
        deactivate = changes.get("is_active") is False and user.is_active
        if user.id == principal.user_id and (demote or deactivate):
            raise bad_request("Không thể tự hạ quyền hoặc vô hiệu hóa chính tài khoản đang đăng nhập.")
        if (demote or deactivate) and user.role_code == ROLE_ADMIN and ctx.auth.count_admins(s) <= 1:
            raise bad_request("Phải còn ít nhất một quản trị viên đang hoạt động.")
        if "full_name" in changes and changes["full_name"] is not None:
            user.full_name = changes["full_name"].strip()
        if "phone" in changes:
            user.phone = (changes["phone"] or "").strip() or None
        if changes.get("role"):
            user.role = ctx.auth.role(s, changes["role"])
        if changes.get("is_active") is not None:
            user.is_active = bool(changes["is_active"])
        user.updated_at = clock.now()
        if demote or deactivate:
            ctx.auth._revoke_all(s, user.id, "role_changed" if demote else "deactivated")  # noqa: SLF001
        audit(s, "user.update", channel="admin", user_id=principal.user_id, actor=principal.email, resource_type="user",
              resource_id=str(user.id), ip=client_ip(request), detail=changes)
        s.flush()
        s.refresh(user)
        return {"user": user_public(user)}


@router.post("/{user_id}/password")
def set_password(user_id: uuid.UUID, body: PasswordSet, request: Request, ctx: AppContext = Depends(get_ctx),
                 principal: Principal = Depends(manage)) -> dict:
    with ctx.db.session() as s:
        user = _get(s, user_id)
        try:
            ctx.auth.admin_set_password(s, user, body.new_password)
        except AuthError:
            raise
        audit(s, "user.password_reset", channel="admin", user_id=principal.user_id, actor=principal.email,
              resource_type="user", resource_id=str(user.id), ip=client_ip(request))
        return {"ok": True}


@router.post("/{user_id}/sessions/revoke")
def revoke_sessions(user_id: uuid.UUID, request: Request, ctx: AppContext = Depends(get_ctx),
                    principal: Principal = Depends(manage)) -> dict:
    with ctx.db.session() as s:
        user = _get(s, user_id)
        ctx.auth._revoke_all(s, user.id, "revoked_by_admin", keep=principal.session_id if user.id == principal.user_id else None)  # noqa: SLF001
        audit(s, "user.sessions_revoke", channel="admin", user_id=principal.user_id, actor=principal.email,
              resource_type="user", resource_id=str(user.id), ip=client_ip(request))
        return {"ok": True}


@router.delete("/{user_id}")
def delete_user(user_id: uuid.UUID, request: Request, ctx: AppContext = Depends(get_ctx), principal: Principal = Depends(manage)) -> dict:
    with ctx.db.session() as s:
        user = _get(s, user_id)
        if user.id == principal.user_id:
            raise bad_request("Không thể xóa chính tài khoản đang đăng nhập.")
        if user.role_code == ROLE_ADMIN and user.is_active and ctx.auth.count_admins(s) <= 1:
            raise bad_request("Phải còn ít nhất một quản trị viên đang hoạt động.")
        email = user.email
        audit(s, "user.delete", channel="admin", user_id=principal.user_id, actor=principal.email, resource_type="user",
              resource_id=str(user_id), ip=client_ip(request), detail={"email": email})
        s.delete(user)
        return {"deleted": True}
