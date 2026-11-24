"""Tavily Search API (https://docs.tavily.com) — tìm kiếm web, KHÔNG có AI ở phía máy chủ này.

- POST https://api.tavily.com/search, khóa trong header `Authorization: Bearer tvly-…` (không nằm trên URL/nhật ký).
- Gói miễn phí: 1.000 lượt/tháng; tìm "basic" = 1 lượt.
- Lỗi: 401 sai khóa; 432/433 hết hạn mức gói; 429/434 quá tải/quá nhanh; 5xx lỗi máy chủ Tavily.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any

import httpx

log = logging.getLogger("smc.websearch")
API_URL = "https://api.tavily.com/search"


class SearchError(Exception):
    """reason: not_configured | auth | quota | busy | error."""

    def __init__(self, reason: str, message: str):
        super().__init__(message)
        self.reason = reason


@dataclass
class SearchResult:
    title: str
    url: str
    content: str
    raw_content: str


class TavilyClient:
    def __init__(self, api_key: str | None, timeout: float = 15.0, transport: httpx.BaseTransport | None = None):
        self.api_key = api_key
        self._http = httpx.Client(timeout=httpx.Timeout(timeout, connect=8.0), transport=transport)
        self.last_error: str | None = None

    @property
    def configured(self) -> bool:
        return bool(self.api_key)

    def close(self) -> None:
        self._http.close()

    def search(self, query: str, *, max_results: int = 10, exact: bool = False) -> list[SearchResult]:
        if not self.configured:
            raise SearchError("not_configured", "Chưa cấu hình khóa Tavily trên máy chủ (SMC_TAVILY_API_KEY trong server.env).")
        body: dict[str, Any] = {
            "query": query[:400],
            "search_depth": "basic",  # 1 lượt/lần tìm
            "max_results": max(1, min(max_results, 20)),
            "include_raw_content": "text",  # nội dung trang → tìm số đăng ký quanh mã vạch
            "include_answer": False,  # không dùng câu trả lời do AI của Tavily tạo
            "exact_match": exact,
        }
        try:
            response = self._http.post(API_URL, headers={"Authorization": f"Bearer {self.api_key}"}, json=body)
        except httpx.TimeoutException as exc:
            self.last_error = "Tavily không phản hồi kịp."
            raise SearchError("busy", self.last_error) from exc
        except httpx.HTTPError as exc:
            self.last_error = "Không kết nối được Tavily."
            raise SearchError("error", self.last_error) from exc
        if response.status_code == 200:
            self.last_error = None
            data = response.json()
            return [
                SearchResult(title=str(r.get("title") or ""), url=str(r.get("url") or ""), content=str(r.get("content") or ""),
                             raw_content=str(r.get("raw_content") or "")[:60_000])
                for r in data.get("results") or [] if r.get("url")
            ]
        detail = ""
        try:
            detail = str(((response.json() or {}).get("detail") or {}).get("error") or "")[:160]
        except (ValueError, AttributeError):
            pass
        log.warning("Tavily trả %s: %s", response.status_code, detail)
        if response.status_code == 401:
            self.last_error = "Khóa Tavily không hợp lệ."
            raise SearchError("auth", self.last_error)
        if response.status_code in (432, 433):
            self.last_error = "Đã dùng hết lượt tìm kiếm Tavily của tháng này."
            raise SearchError("quota", self.last_error)
        if response.status_code in (429, 434) or response.status_code >= 500:
            self.last_error = "Dịch vụ tìm kiếm Tavily đang bận. Vui lòng thử lại sau."
            raise SearchError("busy", self.last_error)
        self.last_error = f"Tavily từ chối yêu cầu (mã {response.status_code})."
        raise SearchError("error", self.last_error)
