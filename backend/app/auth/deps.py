"""Dependency FastAPI: xác thực Bearer token theo kênh, kiểm tra quyền, thông tin yêu cầu.

Phân quyền luôn kiểm tra ở máy chủ — giao diện chỉ ẩn nút cho dễ dùng, không phải cơ chế bảo vệ.
"""
from __future__ import annotations

from typing import Callable

from fastapi import Depends, HTTPException, Request
from starlette.requests import HTTPConnection

from app.auth.service import Principal, RequestMeta
from app.auth.tokens import TokenError

LOOPBACK = {"127.0.0.1", "::1", "localhost", "testclient"}
FORBIDDEN = "Bạn không có quyền thực hiện chức năng này."


def client_ip(request: HTTPConnection) -> str | None:
    """IP thật của người gọi (HTTP hoặc WebSocket). Chỉ tin header proxy khi kết nối tới từ chính Mini PC:
    cloudflared gửi ``CF-Connecting-IP``, Tailscale Funnel/serve gửi ``X-Forwarded-For``."""
    host = request.client.host if request.client else None
    if host in LOOPBACK:
        forwarded = request.headers.get("cf-connecting-ip") or request.headers.get("x-forwarded-for")
        if forwarded:
            return forwarded.split(",")[0].strip()[:64]
    return host


def request_meta(request: Request) -> RequestMeta:
    return RequestMeta(
        ip=client_ip(request),
        user_agent=request.headers.get("user-agent"),
        client=request.headers.get("x-smc-client"),
    )


def _bearer(request: Request) -> str | None:
    header = request.headers.get("authorization", "")
    if header[:7].lower() == "bearer ":
        return header[7:].strip() or None
    # Thẻ <img> không gửi được header: cho phép token trên URL, chỉ với GET.
    if request.method == "GET":
        return request.query_params.get("access_token") or None
    return None


def get_principal(request: Request) -> Principal:
    cached = getattr(request.state, "principal", None)
    if cached is not None:
        return cached
    token = _bearer(request)
    if not token:
        raise HTTPException(401, "Chưa đăng nhập hoặc phiên đã hết hạn.", headers={"WWW-Authenticate": "Bearer"})
    ctx = request.app.state.ctx
    try:
        principal = ctx.auth.authenticate(token, request.app.state.channel)
    except TokenError as exc:
        raise HTTPException(401, str(exc), headers={"WWW-Authenticate": "Bearer"}) from exc
    request.state.principal = principal
    return principal


def require(*permissions: str) -> Callable[..., Principal]:
    """Yêu cầu đủ mọi quyền được liệt kê."""

    def dependency(principal: Principal = Depends(get_principal)) -> Principal:
        if not all(principal.has(p) for p in permissions):
            raise HTTPException(403, FORBIDDEN)
        return principal

    return dependency


def require_by_method(read: str, write: str) -> Callable[..., Principal]:
    """GET/HEAD cần quyền đọc; các phương thức khác cần quyền ghi."""

    def dependency(request: Request, principal: Principal = Depends(get_principal)) -> Principal:
        needed = read if request.method in ("GET", "HEAD") else write
        if not principal.has(needed):
            raise HTTPException(403, FORBIDDEN)
        return principal

    return dependency


def require_admin_channel(request: Request, principal: Principal = Depends(get_principal)) -> Principal:
    if request.app.state.channel != "admin" or not principal.is_admin:
        raise HTTPException(403, FORBIDDEN)
    return principal
