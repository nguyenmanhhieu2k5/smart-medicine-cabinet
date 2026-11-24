"""AI tra cứu thuốc trên mạng (Gemini + Google Search) — Gemini GIẢ LẬP bằng httpx.MockTransport (không gọi Google thật).

Kiểm tra: tự chuyển mô hình khi quá tải, mã vạch bắt buộc tra mạng (không đoán), ảnh/QR được đọc khi chưa tra mạng được,
đối chiếu với danh mục DAV, lưu đệm, khóa API không lộ (URL, API, nhật ký), phân quyền hai kênh.
"""
from __future__ import annotations

import json
import logging
import uuid

import httpx
import pytest
from sqlalchemy import func, select

from app.models import AiLookup
from app.services.ai.gemini import GeminiClient, parse_json_object
from app.services.ai.medicine import AiMedicineService
from app.services.barcode.gs1 import check_digit

from .conftest import AUGMENTIN_1G, AUGMENTIN_625, png_bytes
from .test_14_public_scan import submit, wait_done

KEY = "test-gemini-key-AQ.SECRET"


def ean(body12: str) -> str:
    return body12 + str(check_digit(body12))


C1, C2, C3, C4 = (ean(f"89352060101{i}") for i in (2, 3, 4, 5))
AUGMENTIN = {
    "found": True, "ten_thuoc": "Augmentin 625mg", "hoat_chat": "Amoxicillin; Acid clavulanic", "ham_luong": "500mg/125mg",
    "dang_bao_che": "Viên nén bao phim", "quy_cach": "Hộp 2 vỉ x 7 viên", "so_dang_ky": "VN-20169-16",
    "nha_san_xuat": "SmithKline Beecham", "nuoc_san_xuat": "Anh", "do_tin_cay": "cao", "ghi_chu": None,
}


class FakeGemini:
    """Máy chủ Gemini giả: mỗi (mô hình, có tìm kiếm) → danh sách phản hồi lần lượt."""

    def __init__(self):
        self.calls: list[dict] = []
        self.plan: dict[tuple[str, bool], list[tuple[int, dict]]] = {}

    def reply(self, model: str, search: bool, status: int, payload: dict | None = None):
        self.plan.setdefault((model, search), []).append((status, payload or {}))

    def handler(self, request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        model = request.url.path.split("/models/")[1].split(":")[0]
        search = "tools" in body
        self.calls.append({"model": model, "search": search, "body": body, "url": str(request.url), "key": request.headers.get("x-goog-api-key")})
        queue = self.plan.get((model, search)) or [(503, {"error": {"message": "high demand", "status": "UNAVAILABLE"}})]
        status, payload = queue.pop(0) if len(queue) > 1 else queue[0]
        return httpx.Response(status, json=payload)


def answer(info: dict, sources: list[tuple[str, str]] = ()) -> dict:
    cand = {"content": {"parts": [{"text": "```json\n" + json.dumps(info, ensure_ascii=False) + "\n```"}]}}
    if sources:
        cand["groundingMetadata"] = {"groundingChunks": [{"web": {"uri": u, "title": t}} for t, u in sources]}
    return {"candidates": [cand]}


QUOTA = {"error": {"code": 429, "message": "You exceeded your current quota", "status": "RESOURCE_EXHAUSTED"}}
BUSY = {"error": {"code": 503, "message": "high demand", "status": "UNAVAILABLE"}}


@pytest.fixture
def gemini(ctx):
    fake = FakeGemini()
    client = GeminiClient(KEY, ["m-fast", "m-lite"], timeout=5, transport=httpx.MockTransport(fake.handler))
    ctx.ai = AiMedicineService(ctx.db, ctx.settings, client=client, provider="auto")
    return fake


def test_parse_json_object_tolerates_fences_and_text():
    assert parse_json_object('Kết quả:\n```json\n{"found": true}\n```') == {"found": True}
    assert parse_json_object("không có json") is None


def test_barcode_found_on_web_matches_catalog_and_is_cached(ctx, gemini):
    gemini.reply("m-fast", True, 200, answer(AUGMENTIN, [("nhathuoc.example", "https://vertex/redirect/1")]))
    first = ctx.ai.lookup_code("barcode", C1)
    assert first["status"] == "found" and first["mode"] == "web" and first["model"] == "m-fast" and not first["cached"]
    assert first["result"]["ten_thuoc"] == "Augmentin 625mg" and first["sources"] == [{"title": "nhathuoc.example", "url": "https://vertex/redirect/1"}]
    assert first["catalog_matches"][0]["id"] == AUGMENTIN_625 and first["catalog_matches"][0]["match_by"] == "registration"
    assert "dược sĩ" in first["notice"]
    call = gemini.calls[0]
    assert call["search"] and call["body"]["tools"] == [{"google_search": {}}] and C1 in json.dumps(call["body"], ensure_ascii=False)
    assert call["key"] == KEY and KEY not in call["url"]  # khóa đi trong header, không nằm trên URL
    again = ctx.ai.lookup_code("barcode", C1)
    assert again["cached"] and again["catalog_matches"][0]["id"] == AUGMENTIN_625 and len(gemini.calls) == 1


def test_overloaded_model_falls_back_then_is_skipped(ctx, gemini):
    gemini.reply("m-fast", True, 503, BUSY)
    gemini.reply("m-lite", True, 200, answer({**AUGMENTIN, "so_dang_ky": None, "ten_thuoc": "Augmentin 1g", "ham_luong": "875mg/125mg"}))
    r = ctx.ai.lookup_code("barcode", C2)
    assert r["status"] == "found" and r["model"] == "m-lite"
    assert r["catalog_matches"] and r["catalog_matches"][0]["match_by"] == "name"
    assert AUGMENTIN_1G in [m["id"] for m in r["catalog_matches"]]
    ctx.ai.lookup_code("barcode", C3)
    assert [c["model"] for c in gemini.calls] == ["m-fast", "m-lite", "m-lite"]  # m-fast đang quá tải → bỏ qua, không chờ


def test_barcode_never_guesses_without_web_search(ctx, gemini):
    gemini.reply("m-fast", True, 429, QUOTA)
    gemini.reply("m-lite", True, 429, QUOTA)
    r = ctx.ai.lookup_code("barcode", C1)
    assert r["status"] == "unavailable" and r["reason"] == "search_quota" and "thanh toán" in r["message"]
    assert all(c["search"] for c in gemini.calls)  # không hỏi AI khi không tra được mạng
    assert ctx.ai.status()["search_available"] is False
    n = len(gemini.calls)
    assert ctx.ai.lookup_code("barcode", C4)["reason"] == "search_quota" and len(gemini.calls) == n  # ngắt mạch: trả lời ngay
    with ctx.db.session() as s:
        assert s.scalar(select(func.count()).select_from(AiLookup)) == 0


def test_qr_falls_back_to_reading_content_offline(ctx, gemini):
    gemini.reply("m-fast", True, 429, QUOTA)
    gemini.reply("m-lite", True, 429, QUOTA)
    gemini.reply("m-fast", False, 200, answer(AUGMENTIN))
    r = ctx.ai.lookup_code("qr", "AUGMENTIN 625MG - amoxicillin 500mg + clavulanic acid 125mg - GSK")  # không có số đăng ký → cần AI
    assert r["status"] == "found" and r["mode"] == "offline" and "chưa kiểm chứng" in r["message"]
    offline = gemini.calls[-1]
    assert not offline["search"] and offline["body"]["generationConfig"]["responseMimeType"] == "application/json"


def test_invalid_barcode_and_not_configured(ctx, gemini):
    assert ctx.ai.lookup_code("barcode", "123")["reason"] == "invalid"
    ctx.ai = AiMedicineService(ctx.db, ctx.settings, client=GeminiClient(None, ["m-fast"]), provider="auto")
    r = ctx.ai.lookup_code("barcode", C1)
    assert r["status"] == "not_configured" and not gemini.calls


def test_scan_sends_photo_and_ocr_text(ctx, gemini):
    gemini.reply("m-fast", True, 200, answer(AUGMENTIN, [("dav.gov.vn", "https://vertex/redirect/2")]))
    r = ctx.ai.lookup_scan(str(uuid.uuid4()), image=png_bytes(640, 400), ocr_text="Augmentin 625mg\nSĐK VN-20169-16")
    assert r["status"] == "found" and r["catalog_matches"][0]["id"] == AUGMENTIN_625
    parts = gemini.calls[0]["body"]["contents"][0]["parts"]
    assert parts[0]["inline_data"]["mime_type"] == "image/jpeg" and "SĐK VN-20169-16" in parts[1]["text"]


def test_api_key_never_logged_or_returned(ctx, gemini, caplog, client):
    caplog.set_level(logging.DEBUG)
    gemini.reply("m-fast", True, 503, BUSY)
    gemini.reply("m-lite", True, 429, QUOTA)
    ctx.ai.lookup_code("barcode", C1)
    assert KEY not in caplog.text
    status = client.get("/api/ai/status").json()
    assert status["configured"] is True and KEY not in json.dumps(status)
    assert KEY not in repr(ctx.settings) and "gemini_api_key" not in client.get("/api/health").text


def test_public_endpoints(public_client, scanner, ctx, gemini):
    headers, _ = scanner
    assert public_client.post("/api/v1/ai/lookup", json={"kind": "barcode", "code": C1}).status_code == 401
    gemini.reply("m-fast", True, 200, answer(AUGMENTIN, [("x", "https://vertex/redirect/3")]))
    r = public_client.post("/api/v1/ai/lookup", json={"kind": "barcode", "code": C1}, headers=headers)
    assert r.status_code == 200 and r.json()["catalog_matches"][0]["id"] == AUGMENTIN_625
    assert public_client.post("/api/v1/ai/lookup", json={"kind": "sql", "code": "x"}, headers=headers).status_code == 422
    assert public_client.post(f"/api/v1/ai/scans/{uuid.uuid4()}", headers=headers).status_code == 404
    assert public_client.get("/api/v1/ai/status", headers=headers).status_code in (404, 405)  # trạng thái chỉ ở kênh quản trị
    ctx.limiter.rules["ai_user"] = (0, 3600)
    assert public_client.post("/api/v1/ai/lookup", json={"kind": "qr", "code": "abc"}, headers=headers).status_code == 429


def test_public_scan_fallback_uses_own_job_only(public_client, scanner, ctx, gemini):
    headers, _ = scanner
    job = submit(public_client, headers).json()
    wait_done(public_client, job["id"], headers)
    gemini.reply("m-fast", True, 200, answer(AUGMENTIN))
    r = public_client.post(f"/api/v1/ai/scans/{job['id']}", headers=headers)
    assert r.status_code == 200 and r.json()["status"] == "found"
    body = gemini.calls[0]["body"]["contents"][0]["parts"]
    assert body[0]["inline_data"]["data"] and "Augmentin 625mg" in body[-1]["text"]  # ảnh + chữ OCR của chính lượt quét
    other = public_client.post("/api/v1/auth/register", json={"full_name": "Người khác", "email": "khac@example.com", "password": "Khac2026xx"}).json()
    assert public_client.post(f"/api/v1/ai/scans/{job['id']}", headers={"Authorization": f"Bearer {other['access_token']}"}).status_code == 404


def test_time_budget_stops_trying_more_models():
    """Google quá tải: không bắt người dùng chờ hết mọi mô hình — dừng khi hết ngân sách thời gian."""
    import time

    from app.services.ai.gemini import GeminiError

    calls: list[str] = []

    def slow(request: httpx.Request) -> httpx.Response:
        calls.append(request.url.path)
        time.sleep(1.2)
        return httpx.Response(503, json=BUSY)

    client = GeminiClient(KEY, ["a", "b", "c", "d"], timeout=5, transport=httpx.MockTransport(slow))
    started = time.perf_counter()
    with pytest.raises(GeminiError) as err:
        client.generate([{"text": "x"}], system="s", search=False, budget=2.0)
    assert err.value.reason == "overloaded" and len(calls) == 1 and time.perf_counter() - started < 2.5
