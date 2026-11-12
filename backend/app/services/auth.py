"""Xác thực cloud tùy chọn qua Supabase Auth (GoTrue REST).

Chỉ hoạt động khi có biến môi trường SUPABASE_URL và SUPABASE_ANON_KEY. Khi
chưa cấu hình, ứng dụng dùng hồ sơ cục bộ và KHÔNG giả lập đăng nhập thành
công. Không có khóa hay mật khẩu nào được ghi trong mã nguồn.
"""
from __future__ import annotations

from typing import Any

import httpx


class AuthError(Exception):
    def __init__(self, message: str, status_code: int = 400):
        super().__init__(message)
        self.status_code = status_code


class SupabaseAuth:
    def __init__(self, url: str | None, anon_key: str | None, transport: httpx.BaseTransport | None = None):
        self.url = (url or "").rstrip("/")
        self.anon_key = anon_key or ""
        self._transport = transport
        self._session: dict[str, Any] | None = None  # chỉ giữ trong bộ nhớ, không ghi ra đĩa

    @property
    def configured(self) -> bool:
        return bool(self.url and self.anon_key)

    def _client(self) -> httpx.Client:
        return httpx.Client(timeout=10, transport=self._transport, headers={"apikey": self.anon_key})

    def status(self) -> dict[str, Any]:
        user = (self._session or {}).get("user") or {}
        return {
            "provider": "supabase" if self.configured else "local",
            "configured": self.configured,
            "signed_in": self._session is not None,
            "email": user.get("email"),
            "user_id": user.get("id"),
        }

    def sign_in(self, email: str, password: str) -> dict[str, Any]:
        if not self.configured:
            raise AuthError("Chưa cấu hình đăng nhập cloud (thiếu SUPABASE_URL / SUPABASE_ANON_KEY).", 503)
        try:
            with self._client() as client:
                response = client.post(
                    f"{self.url}/auth/v1/token", params={"grant_type": "password"},
                    json={"email": email, "password": password},
                )
        except httpx.HTTPError as exc:
            raise AuthError(f"Không kết nối được máy chủ xác thực: {exc.__class__.__name__}", 502) from exc
        if response.status_code != 200:
            try:
                body = response.json()
                detail = body.get("error_description") or body.get("msg") or body.get("message")
            except ValueError:
                detail = None
            raise AuthError(detail or "Email hoặc mật khẩu không đúng.", 401)
        data = response.json()
        if not data.get("access_token"):
            raise AuthError("Máy chủ xác thực trả về dữ liệu không hợp lệ.", 502)
        self._session = data
        return self.status()

    def sign_out(self) -> dict[str, Any]:
        if self._session and self.configured:
            try:
                with self._client() as client:
                    client.post(
                        f"{self.url}/auth/v1/logout",
                        headers={"Authorization": f"Bearer {self._session.get('access_token')}"},
                    )
            except httpx.HTTPError:
                pass  # vẫn xóa phiên cục bộ
        self._session = None
        return self.status()
