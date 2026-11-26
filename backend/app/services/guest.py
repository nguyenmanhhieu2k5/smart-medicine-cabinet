"""Khách trên trang web quét thuốc: quét thử miễn phí vài lần, sau đó phải đăng nhập.

Trình duyệt tự tạo một mã khách ngẫu nhiên (UUID, lưu ở trình duyệt) và gửi kèm header ``X-Guest-Id``. Máy chủ chỉ lưu
HMAC của mã đó (không lưu IP, không lưu mã gốc) cùng số lượt đã dùng — bền qua khởi động lại máy chủ.

Một "lượt" = một ảnh gửi đi nhận diện, hoặc một mã vạch/QR MỚI được quét (quét lại cùng mã không tính thêm).
Xem chi tiết thuốc trong kết quả và "Tìm trên mạng" cho đúng lượt quét/mã của mình không tính thêm lượt.

Chặn lạm dụng (xóa dữ liệu trình duyệt để lấy mã khách mới): mỗi IP tối đa ``guest_scans_per_ip_day`` lượt khách/ngày
và toàn bộ khách tối đa ``guest_scans_total_day`` lượt/ngày (bảo vệ GPU và hạn mức tra cứu trên mạng).
"""
from __future__ import annotations

import hashlib
import hmac
import uuid
from typing import Any

from sqlalchemy.dialects.postgresql import insert

from app.auth.ratelimit import RateLimiter
from app.core import clock
from app.core.config import Settings
from app.database.session import Database
from app.models import GuestUsage

DAY = 24 * 3600
MAX_CODES = 20


class GuestLimitReached(Exception):
    """Khách đã dùng hết lượt quét miễn phí → phải đăng nhập."""

    def __init__(self, limit: int):
        super().__init__(f"Bạn đã dùng hết {limit} lượt quét miễn phí. Hãy đăng nhập hoặc tạo tài khoản để quét tiếp.")
        self.limit = limit


class GuestQuota:
    def __init__(self, db: Database, settings: Settings, limiter: RateLimiter):
        self.db = db
        self.settings = settings
        self.limiter = limiter
        limiter.rules.update({
            "guest_scan_ip": (settings.guest_scans_per_ip_day, DAY),
            "guest_scan_all": (settings.guest_scans_total_day, DAY),
            "guest_read_ip": (1200, 3600),  # theo dõi tiến độ, xem chi tiết thuốc, ảnh thu nhỏ
            "guest_web_ip": (30, DAY),  # "Tìm trên mạng" của khách (tốn hạn mức Tavily của chủ máy)
        })
        secret = (settings.jwt_secret or "smc-guest").encode()
        self._secret = hashlib.sha256(b"smc-guest-v1:" + secret).digest()

    @property
    def enabled(self) -> bool:
        return self.settings.guest_scans > 0

    @property
    def limit(self) -> int:
        return self.settings.guest_scans

    def key(self, raw: str | None) -> str | None:
        """Mã khách hợp lệ (UUID) → khóa lưu trữ (HMAC, 64 ký tự hex). Không hợp lệ → None."""
        try:
            value = uuid.UUID(str(raw or "").strip())
        except ValueError:
            return None
        return hmac.new(self._secret, value.hex.encode(), hashlib.sha256).hexdigest()

    def _view(self, used: int) -> dict[str, Any]:
        used = min(used, self.limit)
        return {"enabled": self.enabled, "limit": self.limit, "used": used, "remaining": max(0, self.limit - used)}

    def status(self, key: str) -> dict[str, Any]:
        with self.db.session() as s:
            row = s.get(GuestUsage, key)
            return self._view(row.scans_used if row else 0)

    def consume(self, key: str, ip: str | None, *, codes: list[str] | None = None) -> dict[str, Any]:
        """Tính một lượt quét. ``codes``: các khóa của mã vạch/QR vừa quét — mã đã quét rồi thì không tính lại.

        Hết lượt → GuestLimitReached; vượt trần theo IP/toàn hệ thống → RateLimitExceeded (429).
        """
        now = clock.now()
        wanted = [c for c in (codes or []) if c]
        with self.db.session() as s:
            s.execute(insert(GuestUsage).values(guest_key=key, scans_used=0, codes=[], created_at=now, last_used_at=now)
                      .on_conflict_do_nothing(index_elements=["guest_key"]))
            row = s.get(GuestUsage, key, with_for_update=True)  # khóa hàng: hai yêu cầu cùng lúc không vượt hạn mức
            seen = list(row.codes or [])
            if wanted and any(c in seen for c in wanted):
                return self._view(row.scans_used)
            if row.scans_used >= self.limit:
                raise GuestLimitReached(self.limit)
            self.limiter.hit("guest_scan_ip", ip or "unknown")
            self.limiter.hit("guest_scan_all", "all")
            row.scans_used += 1
            if wanted:
                row.codes = (seen + wanted)[-MAX_CODES:]
            row.last_used_at = now
            return self._view(row.scans_used)

    def refund(self, key: str) -> None:
        """Hoàn lượt khi ảnh không gửi được vào hàng đợi (ảnh hỏng, máy chủ bận)."""
        with self.db.session() as s:
            row = s.get(GuestUsage, key, with_for_update=True)
            if row is not None and row.scans_used > 0:
                row.scans_used -= 1

