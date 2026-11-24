"""Gọi Google Gemini (REST generateContent) có Google Search — nhanh và chịu lỗi.

- Thử các mô hình theo thứ tự cấu hình (mới nhất trước); 503/500/hết giờ → chuyển ngay mô hình sau.
- Bộ ngắt mạch trong bộ nhớ: mô hình vừa quá tải bị bỏ qua 60 giây, "Google Search hết hạn mức" bị bỏ qua 10 phút
  → các lượt sau không mất thời gian chờ lỗi lặp lại.
- Khóa API gửi trong header `x-goog-api-key` (không nằm trên URL), không bao giờ ghi vào nhật ký.
"""
from __future__ import annotations

import json
import logging
import re
import threading
import time
from dataclasses import dataclass, field
from typing import Any

import httpx

log = logging.getLogger("smc.ai")
API_URL = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
OVERLOAD_COOLDOWN = 20.0  # 503 "high demand" của Google thường qua nhanh
SEARCH_QUOTA_COOLDOWN = 600.0
RETRYABLE = {500, 502, 503, 504}


class GeminiError(Exception):
    """reason: not_configured | search_quota | quota | overloaded | auth | error."""

    def __init__(self, reason: str, message: str):
        super().__init__(message)
        self.reason = reason


@dataclass
class GeminiAnswer:
    model: str
    text: str
    searched: bool
    sources: list[dict[str, str]] = field(default_factory=list)
    elapsed_ms: int = 0


def parse_json_object(text: str) -> dict[str, Any] | None:
    """Lấy đối tượng JSON đầu tiên trong câu trả lời (bỏ ```json … ``` nếu có)."""
    if not text:
        return None
    cleaned = re.sub(r"```(?:json)?", "", text).strip()
    start, end = cleaned.find("{"), cleaned.rfind("}")
    if start < 0 or end <= start:
        return None
    try:
        data = json.loads(cleaned[start:end + 1])
    except json.JSONDecodeError:
        return None
    return data if isinstance(data, dict) else None


def _sources(candidate: dict[str, Any]) -> list[dict[str, str]]:
    chunks = (candidate.get("groundingMetadata") or {}).get("groundingChunks") or []
    out: dict[str, dict[str, str]] = {}
    for chunk in chunks:
        web = chunk.get("web") or {}
        url, title = web.get("uri"), (web.get("title") or "").strip()
        if url and (title or url) not in out:
            out[title or url] = {"title": title or url, "url": url}
    return list(out.values())[:8]


class GeminiClient:
    def __init__(self, api_key: str | None, models: list[str], timeout: float = 25.0, transport: httpx.BaseTransport | None = None):
        self.api_key = api_key
        self.models = [m for m in models if m]
        self.timeout = timeout
        self._http = httpx.Client(timeout=httpx.Timeout(timeout, connect=8.0), transport=transport)
        self._skip: dict[tuple[str, bool], float] = {}
        self._lock = threading.Lock()
        self.last_error: str | None = None

    @property
    def configured(self) -> bool:
        return bool(self.api_key and self.models)

    def close(self) -> None:
        self._http.close()

    def _skipped(self, key: tuple[str, bool]) -> bool:
        with self._lock:
            until = self._skip.get(key)
            return until is not None and until > time.monotonic()

    def _cooldown(self, key: tuple[str, bool], seconds: float) -> None:
        with self._lock:
            self._skip[key] = time.monotonic() + seconds

    def search_available(self) -> bool:
        return any(not self._skipped((m, True)) for m in self.models)

    def generate(self, parts: list[dict[str, Any]], *, system: str, search: bool, json_schema: dict[str, Any] | None = None,
                 budget: float | None = None) -> GeminiAnswer:
        """Một lượt hỏi. search=True: bắt buộc Google Search (không được trả lời từ trí nhớ).

        budget: tổng số giây được dùng cho mọi mô hình — hết thì dừng, không bắt người dùng chờ lâu.
        """
        if not self.configured:
            raise GeminiError("not_configured", "Chưa cấu hình khóa Gemini trên máy chủ (SMC_GEMINI_API_KEY trong server.env).")
        deadline = time.monotonic() + (budget if budget is not None else self.timeout * len(self.models))
        reasons: list[str] = []
        for model in self.models:
            remaining = deadline - time.monotonic()
            if remaining < 1.5:
                reasons.append("overloaded")
                break
            key = (model, search)
            if self._skipped(key) or (search and self._skipped(("*", True))):
                reasons.append("skipped")
                continue
            body: dict[str, Any] = {
                "systemInstruction": {"parts": [{"text": system}]},
                "contents": [{"role": "user", "parts": parts}],
                # Nhanh: suy luận mức thấp — đủ cho tra cứu/trích thông tin.
                "generationConfig": {"temperature": 0.1, "thinkingConfig": {"thinkingLevel": "low"}},
            }
            if search:
                body["tools"] = [{"google_search": {}}]
            elif json_schema:
                body["generationConfig"].update(responseMimeType="application/json", responseSchema=json_schema)
            started = time.perf_counter()
            try:
                response = self._http.post(API_URL.format(model=model), headers={"x-goog-api-key": str(self.api_key)}, json=body,
                                           timeout=httpx.Timeout(min(self.timeout, remaining), connect=min(8.0, remaining)))
            except httpx.TimeoutException:
                log.warning("Gemini %s hết giờ (search=%s)", model, search)
                self._cooldown(key, OVERLOAD_COOLDOWN)
                reasons.append("overloaded")
                continue
            except httpx.HTTPError as exc:
                log.warning("Gemini %s lỗi mạng: %s", model, type(exc).__name__)
                reasons.append("network")
                continue
            elapsed = int((time.perf_counter() - started) * 1000)
            if response.status_code == 200:
                data = response.json()
                cands = data.get("candidates") or []
                if not cands:
                    reasons.append("empty")
                    continue
                cand = cands[0]
                text = "".join(p.get("text", "") for p in (cand.get("content") or {}).get("parts", []) if not p.get("thought"))
                self.last_error = None
                return GeminiAnswer(model=model, text=text, searched=search, sources=_sources(cand) if search else [], elapsed_ms=elapsed)
            message = ""
            try:
                message = str((response.json().get("error") or {}).get("message", ""))[:200]
            except ValueError:
                pass
            log.warning("Gemini %s trả %s (search=%s): %s", model, response.status_code, search, message)
            if response.status_code == 429:
                if search:
                    reasons.append("search_quota")
                    self._cooldown(key, SEARCH_QUOTA_COOLDOWN)
                else:
                    reasons.append("quota")
                    self._cooldown(key, OVERLOAD_COOLDOWN)
            elif response.status_code in RETRYABLE:
                reasons.append("overloaded")
                self._cooldown(key, OVERLOAD_COOLDOWN)
            elif response.status_code in (401, 403) or "API key" in message:
                self.last_error = "Khóa Gemini không hợp lệ hoặc không có quyền."
                raise GeminiError("auth", self.last_error)
            else:  # 400/404: mô hình không dùng được với khóa này — bỏ qua lâu hơn
                reasons.append("error")
                self._cooldown(key, SEARCH_QUOTA_COOLDOWN)
        search_blocked = self._skipped(("*", True)) and all(r == "skipped" for r in reasons)
        if search and ("search_quota" in reasons or search_blocked):
            if set(reasons) <= {"search_quota", "skipped"}:  # mọi mô hình đều báo hết hạn mức tìm kiếm
                self._cooldown(("*", True), SEARCH_QUOTA_COOLDOWN)
            self.last_error = ("Gemini chưa cho phép tìm kiếm trên mạng: hết hạn mức Google Search của khóa API "
                               "(bật thanh toán cho khóa trong Google AI Studio để dùng).")
            raise GeminiError("search_quota", self.last_error)
        if "quota" in reasons:
            self.last_error = "Khóa Gemini đã hết hạn mức sử dụng. Vui lòng thử lại sau."
            raise GeminiError("quota", self.last_error)
        self.last_error = "Máy chủ Gemini đang quá tải hoặc không phản hồi. Vui lòng thử lại sau ít phút."
        raise GeminiError("overloaded", self.last_error)
