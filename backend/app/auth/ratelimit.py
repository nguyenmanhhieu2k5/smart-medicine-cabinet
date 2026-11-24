"""Giới hạn tần suất trong bộ nhớ (cửa sổ trượt) cho đăng nhập, đăng ký, quét OCR…

Máy chủ chạy một tiến trình duy nhất trên Mini PC nên bộ đếm trong bộ nhớ là đủ.
"""
from __future__ import annotations

import threading
import time
from collections import deque


class RateLimitExceeded(Exception):
    def __init__(self, retry_after: int):
        super().__init__(f"Quá nhiều yêu cầu, thử lại sau {retry_after} giây.")
        self.retry_after = retry_after


class RateLimiter:
    # tên bucket → (số lần tối đa, cửa sổ giây)
    DEFAULT_RULES: dict[str, tuple[int, int]] = {
        "login_ip": (20, 60),
        "login_email": (8, 300),
        "register_ip": (10, 3600),
        "forgot_email": (3, 3600),
        "forgot_ip": (10, 3600),
        "reset_ip": (20, 3600),
        "refresh_ip": (120, 60),
        "scan_user": (40, 3600),
        "barcode_user": (300, 3600),  # tra mã vạch rất nhẹ (một truy vấn) nhưng vẫn chặn dò quét hàng loạt
        "ai_user": (60, 3600),  # mỗi lượt AI tốn hạn mức Gemini của chủ máy
        "device_command_user": (60, 60),
    }

    def __init__(self, rules: dict[str, tuple[int, int]] | None = None):
        self.rules = dict(self.DEFAULT_RULES)
        if rules:
            self.rules.update(rules)
        self._hits: dict[tuple[str, str], deque[float]] = {}
        self._lock = threading.Lock()

    def hit(self, bucket: str, key: str | None) -> None:
        """Ghi nhận một lần; ném RateLimitExceeded nếu vượt ngưỡng."""
        if not key or bucket not in self.rules:
            return
        limit, window = self.rules[bucket]
        now = time.monotonic()
        with self._lock:
            q = self._hits.setdefault((bucket, key.lower()), deque())
            while q and now - q[0] > window:
                q.popleft()
            if len(q) >= limit:
                raise RateLimitExceeded(max(1, int(window - (now - q[0])) + 1))
            q.append(now)
            if len(self._hits) > 50_000:  # chặn rò rỉ bộ nhớ khi bị dò quét
                self._prune(now)

    def reset(self, bucket: str, key: str | None) -> None:
        if key:
            with self._lock:
                self._hits.pop((bucket, key.lower()), None)

    def _prune(self, now: float) -> None:
        longest = max(w for _, w in self.rules.values())
        for k in [k for k, q in self._hits.items() if not q or now - q[-1] > longest]:
            del self._hits[k]
