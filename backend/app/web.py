"""Phục vụ TRANG WEB quét thuốc (bản web của ứng dụng điện thoại, ``mobile/dist-web``) ở cổng Public.

Cùng địa chỉ với API (/api/v1) nên trình duyệt không cần CORS và cookie phiên đăng nhập là cookie cùng trang.
Ra Internet qua Cloudflare Tunnel với tên miền riêng (ví dụ tuthuoc.id.vn) — xem deploy/cloudflare/setup-cloudflared.ps1.

* File có thật trong thư mục → trả file (chống đi ngược thư mục bằng ``..``).
* Đường dẫn trang (không có phần mở rộng, ví dụ /scan, /login) → index.html (ứng dụng một trang — Expo Router).
* /api/... không bao giờ bị trang web che: không có route API → 404 JSON như cũ.
"""
from __future__ import annotations

from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, Response

MIME = {
    ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8", ".json": "application/json", ".map": "application/json", ".wasm": "application/wasm",
    ".ico": "image/x-icon", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
    ".webp": "image/webp", ".svg": "image/svg+xml", ".ttf": "font/ttf", ".otf": "font/otf", ".woff": "font/woff",
    ".woff2": "font/woff2", ".txt": "text/plain; charset=utf-8", ".webmanifest": "application/manifest+json",
}
# Chỉ chạy mã của chính trang (không CDN); 'wasm-unsafe-eval' cho bộ đọc mã vạch zxing (WebAssembly); style nội tuyến
# do react-native-web sinh ra; ảnh chụp camera là blob:/data:; camera chỉ cho chính trang này.
CSP = (
    "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; "
    "img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' data: blob:; media-src 'self' blob: mediastream: data:; "
    "worker-src 'self' blob:; manifest-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'"
)
PERMISSIONS = "camera=(self), microphone=(), geolocation=(), payment=(), usb=()"


def mount_web(app: FastAPI, web_dir: Path) -> None:
    root = web_dir.resolve()
    index = root / "index.html"

    def page_headers() -> dict[str, str]:
        return {"Cache-Control": "no-cache", "Content-Security-Policy": CSP, "Permissions-Policy": PERMISSIONS}

    @app.api_route("/{path:path}", methods=["GET", "HEAD"], include_in_schema=False)
    def web(path: str, request: Request) -> Response:
        if path == "api" or path.startswith("api/"):
            raise HTTPException(404, "Không có đường dẫn API này.")
        if not index.is_file():
            raise HTTPException(503, "Chưa có bản build trang web (chạy: npm --prefix mobile run export:web).")
        target = (root / path).resolve() if path else index
        if not target.is_relative_to(root):
            raise HTTPException(404, "Không tìm thấy.")
        if target.is_file():
            if target == index:
                return FileResponse(index, media_type=MIME[".html"], headers=page_headers())
            # Tên file có mã băm (/_expo/static/...) không bao giờ đổi nội dung → cho trình duyệt giữ lâu.
            immutable = path.startswith("_expo/static/") or path.startswith("assets/")
            headers = {"Cache-Control": "public, max-age=31536000, immutable" if immutable else "public, max-age=3600"}
            return FileResponse(target, media_type=MIME.get(target.suffix.lower(), "application/octet-stream"), headers=headers)
        if "." in path.rsplit("/", 1)[-1]:
            raise HTTPException(404, "Không tìm thấy.")  # thiếu file tĩnh: không trả trang HTML thay thế
        return FileResponse(index, media_type=MIME[".html"], headers=page_headers())
