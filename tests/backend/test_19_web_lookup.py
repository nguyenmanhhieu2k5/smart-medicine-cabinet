"""Tra mã vạch trên mạng KHÔNG dùng AI: Tavily (GIẢ LẬP bằng httpx.MockTransport) + quy tắc + danh mục DAV.

Không gọi Tavily thật trong kiểm thử (không tốn lượt tìm kiếm).
"""
from __future__ import annotations

import json

import httpx
import pytest

from app.services.ai.gemini import GeminiClient
from app.services.ai.medicine import AiMedicineService
from app.services.barcode.gs1 import check_digit
from app.services.barcode.web_lookup import evidence_pages, nearest_regs
from app.services.websearch.tavily import SearchResult, TavilyClient

from .conftest import AUGMENTIN_1G, AUGMENTIN_625
from .test_17_ai_lookup import QUOTA, FakeGemini

TAVILY_KEY = "tvly-test-SECRET-key"
CODE = "893520601012" + str(check_digit("893520601012"))
OTHER = "893520601013" + str(check_digit("893520601013"))


class FakeTavily:
    def __init__(self):
        self.calls: list[dict] = []
        self.replies: list[tuple[int, dict]] = []

    def reply(self, status: int, payload: dict):
        self.replies.append((status, payload))

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.calls.append({"body": json.loads(request.content), "auth": request.headers.get("authorization"), "url": str(request.url)})
        status, payload = self.replies.pop(0) if self.replies else (200, {"results": []})
        return httpx.Response(status, json=payload)


def page(title: str, content: str, raw: str = "", url: str = "https://nhathuoc.example/sp") -> dict:
    return {"title": title, "url": url, "content": content, "raw_content": raw, "score": 0.9}


@pytest.fixture
def tavily(ctx):
    fake = FakeTavily()
    ctx.ai = AiMedicineService(ctx.db, ctx.settings, client=GeminiClient(None, ["m"]),
                               search=TavilyClient(TAVILY_KEY, transport=httpx.MockTransport(fake.handler)))
    return fake


def test_evidence_requires_exact_code_and_takes_nearest_registration():
    filler = "x " * 1200
    listing = SearchResult(
        title="Thuốc kháng sinh | Nhà thuốc", url="https://a.example/list", content="",
        raw_content=f"Augmentin 625mg Mã vạch: {CODE[:3]} {CODE[3:7]} {CODE[7:]} SĐK: VN-20169-16 {filler} Thuốc khác SĐK: VD-99999-99",
    )
    unrelated = SearchResult(title="Trang khác", url="https://b.example", content=f"mã {OTHER} SĐK VN-11057-10", raw_content="")
    pages = evidence_pages([listing, unrelated], CODE)
    assert [p["url"] for p in pages] == ["https://a.example/list"]  # chỉ trang có ĐÚNG mã (kể cả viết cách quãng)
    assert [norm for _, norm in nearest_regs(pages[0])] == ["VN2016916"]  # số đăng ký gần mã, không lấy sản phẩm ở xa


def test_barcode_found_by_registration_without_ai(ctx, tavily):
    tavily.reply(200, {"results": [
        page("Augmentin 625mg - Nhà thuốc A", f"Mã vạch {CODE}. Số đăng ký: VN-20169-16. Hộp 2 vỉ x 7 viên."),
        page("Augmentin 625mg | Nhà thuốc B", f"Barcode: {CODE} – SĐK VN-20169-16", url="https://b.example/augmentin"),
        page("Không liên quan", "Paracetamol SĐK VD-24859-16", url="https://c.example"),
    ]})
    r = ctx.ai.lookup_code("barcode", CODE)
    assert r["status"] == "found" and r["mode"] == "search" and r["model"] == "tavily"
    assert r["result"]["ten_thuoc"] == "Augmentin 625mg tablets"  # lấy từ DANH MỤC, không lấy từ trang web
    assert r["result"]["so_dang_ky"] == "VN-20169-16" and r["result"]["do_tin_cay"] == "cao"
    assert r["catalog_matches"][0]["id"] == AUGMENTIN_625 and r["catalog_matches"][0]["match_by"] == "registration"
    assert len(r["sources"]) == 2 and "không dùng AI" in r["notice"]
    call = tavily.calls[0]
    assert call["auth"] == f"Bearer {TAVILY_KEY}" and TAVILY_KEY not in call["url"] and TAVILY_KEY not in json.dumps(call["body"])
    assert call["body"]["exact_match"] is True and CODE in call["body"]["query"] and call["body"]["include_answer"] is False
    assert ctx.ai.lookup_code("barcode", CODE)["cached"] and len(tavily.calls) == 1


def test_title_only_gives_low_confidence_suggestions(ctx, tavily):
    tavily.reply(200, {"results": [page("Augmentin 1g - Nhà thuốc A", f"Mã sản phẩm {CODE}")]})
    r = ctx.ai.lookup_code("barcode", CODE)
    assert r["status"] == "found" and r["result"]["do_tin_cay"] == "thap" and r["result"]["so_dang_ky"] is None
    assert AUGMENTIN_1G in [m["id"] for m in r["catalog_matches"]] and r["catalog_matches"][0]["match_by"] == "name"


def test_not_found_tries_relaxed_query_then_caches(ctx, tavily):
    tavily.reply(200, {"results": [page("Trang khác", f"mã {OTHER}")]})
    tavily.reply(200, {"results": []})
    r = ctx.ai.lookup_code("barcode", CODE)
    assert r["status"] == "not_found" and "Không tìm thấy trang nào" in r["message"]
    assert [c["body"]["exact_match"] for c in tavily.calls] == [True, False]
    assert ctx.ai.lookup_code("barcode", CODE)["cached"] and len(tavily.calls) == 2


@pytest.mark.parametrize("status,reason", [(432, "quota"), (401, "auth"), (429, "busy")])
def test_tavily_errors_are_explained(ctx, tavily, status, reason):
    tavily.reply(status, {"detail": {"error": "x"}})
    r = ctx.ai.lookup_code("barcode", CODE)
    assert r["status"] == "unavailable" and r["reason"] == reason and r["message"]


def test_gemini_without_search_quota_falls_back_to_tavily(ctx):
    gemini, tavily = FakeGemini(), FakeTavily()
    gemini.reply("m-fast", True, 429, QUOTA)
    tavily.reply(200, {"results": [page("Augmentin", f"{CODE} SĐK VN-20169-16")]})
    ctx.ai = AiMedicineService(ctx.db, ctx.settings, client=GeminiClient("g-key", ["m-fast"], transport=httpx.MockTransport(gemini.handler)),
                               search=TavilyClient(TAVILY_KEY, transport=httpx.MockTransport(tavily.handler)))
    r = ctx.ai.lookup_code("barcode", CODE)
    assert r["status"] == "found" and r["mode"] == "search" and len(gemini.calls) == 1 and len(tavily.calls) == 1


def test_qr_with_registration_number_needs_no_ai_or_internet(ctx, tavily):
    r = ctx.ai.lookup_code("qr", "AUGMENTIN 625MG - SDK VN-20169-16 - GSK")
    assert r["status"] == "found" and r["mode"] == "text" and r["catalog_matches"][0]["id"] == AUGMENTIN_625
    assert not tavily.calls


def test_status_and_secrets(ctx, tavily, client):
    status = client.get("/api/ai/status").json()
    assert status["web_search"] == {"provider": "tavily", "configured": True, "last_error": None}
    assert TAVILY_KEY not in json.dumps(status)
    ctx.settings.tavily_api_key = TAVILY_KEY
    assert TAVILY_KEY not in repr(ctx.settings)
