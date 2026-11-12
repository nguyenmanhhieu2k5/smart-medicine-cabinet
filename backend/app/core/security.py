"""Bảo vệ API cục bộ: token dùng chung giữa Electron và backend."""
from __future__ import annotations

import hmac

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse

PUBLIC_PATHS = ("/api/health",)


class TokenMiddleware(BaseHTTPMiddleware):
    """Yêu cầu header ``X-SMC-Token`` (hoặc tham số ``token`` cho thẻ <img>).

    Khi không cấu hình token (chế độ phát triển) middleware không chặn gì.
    """

    def __init__(self, app, token: str | None):  # noqa: ANN001
        super().__init__(app)
        self.token = token

    async def dispatch(self, request: Request, call_next):  # noqa: ANN001
        if self.token and request.method != "OPTIONS" and request.url.path.startswith("/api") and request.url.path not in PUBLIC_PATHS:
            supplied = request.headers.get("x-smc-token") or request.query_params.get("token") or ""
            if not hmac.compare_digest(supplied, self.token):
                return JSONResponse({"detail": "Thiếu hoặc sai mã truy cập API cục bộ."}, status_code=401)
        return await call_next(request)
