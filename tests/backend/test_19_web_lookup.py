"""Tra mã vạch trên mạng KHÔNG dùng AI: Tavily (GIẢ LẬP bằng httpx.MockTransport) + quy tắc + danh mục DAV.

Không gọi Tavily thật trong kiểm thử (không tốn lượt tìm kiếm).
"""
from __future__ import annotations

import json
import uuid

import httpx
import pytest
from sqlalchemy import select

from app.models.catalog import CatalogMedicine
from app.services.ai.gemini import GeminiClient
from app.services.ai.medicine import AiMedicineService
from app.services.barcode.gs1 import check_digit
from app.services.barcode.web_lookup import Vocab, _coverage, _name_ok, evidence_pages, nearest_regs, text_query
from app.services.medicine_matcher.matcher import lines_from_text
from app.services.websearch.tavily import SearchResult, TavilyClient

from .conftest import AUGMENTIN_1G, AUGMENTIN_625, FOGICAP_40
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
                               search=TavilyClient(TAVILY_KEY, transport=httpx.MockTransport(tavily.handler)), provider="auto")
    r = ctx.ai.lookup_code("barcode", CODE)
    assert r["status"] == "found" and r["mode"] == "search" and len(gemini.calls) == 1 and len(tavily.calls) == 1


# --------------------------------------------------------------------------- #
# Chỉ Tavily (mặc định SMC_LOOKUP_PROVIDER=tavily): không bao giờ gọi Gemini, kể cả khi có khóa
# --------------------------------------------------------------------------- #
def box_line(text: str, height: float, y: float) -> dict:
    return {"text": text, "score": 0.95, "box": [10.0, y, 400.0, y + height]}


SCAN_LINES = [  # chữ to nhất là tên thuốc; dòng thành phần/quy cách nhỏ hơn
    box_line("GSK", 20, 10),
    box_line("Augmentin", 70, 40),
    box_line("625 mg", 30, 120),
    box_line("Amoxicillin 500 mg / Acid clavulanic 125 mg", 18, 160),
    box_line("Hộp 2 vỉ x 7 viên nén bao phim", 16, 190),
]


@pytest.fixture
def tavily_only(ctx):
    gemini, tavily = FakeGemini(), FakeTavily()
    ctx.ai = AiMedicineService(ctx.db, ctx.settings, client=GeminiClient("g-key", ["m-fast"], transport=httpx.MockTransport(gemini.handler)),
                               search=TavilyClient(TAVILY_KEY, transport=httpx.MockTransport(tavily.handler)))
    assert ctx.ai.provider == "tavily" and ctx.ai.status()["provider"] == "tavily"
    return gemini, tavily


def test_tavily_mode_never_calls_gemini(ctx, tavily_only):
    gemini, tavily = tavily_only
    tavily.reply(200, {"results": [page("Augmentin", f"{CODE} SĐK VN-20169-16")]})
    assert ctx.ai.lookup_code("barcode", CODE)["mode"] == "search"
    ctx.ai.lookup_code("qr", "Thuốc kháng sinh Augmentin của GSK")
    ctx.ai.lookup_scan(str(uuid.uuid4()), image=b"png", ocr_text="", lines=SCAN_LINES)
    assert gemini.calls == [] and len(tavily.calls) == 3


def test_scan_searches_most_prominent_name_and_matches_registration(ctx, tavily_only):
    _, tavily = tavily_only
    tavily.reply(200, {"results": [
        page("Augmentin 625mg - Nhà thuốc A", "Thuốc Augmentin 625mg (amoxicillin, acid clavulanic). Số đăng ký: VN-20169-16."),
        page("Augmentin 625 | Nhà thuốc B", "AUGMENTIN 625mg viên nén – SĐK VN-20169-16 – GSK", url="https://b.example/aug"),
        page("Paracetamol 500mg", "Paracetamol SĐK VD-24859-16", url="https://c.example"),  # không nhắc tên → bỏ
    ]})
    r = ctx.ai.lookup_scan(str(uuid.uuid4()), image=None, ocr_text="", lines=SCAN_LINES)
    query = tavily.calls[0]["body"]["query"]
    assert query.startswith("Augmentin") and "625 mg" in query and "GSK" not in query
    assert tavily.calls[0]["body"]["exact_match"] is False
    assert r["status"] == "found" and r["kind"] == "scan" and r["mode"] == "search" and r["model"] == "tavily"
    assert r["catalog_matches"][0]["id"] == AUGMENTIN_625 and r["catalog_matches"][0]["match_by"] == "registration"
    assert r["result"]["so_dang_ky"] == "VN-20169-16" and r["result"]["do_tin_cay"] == "cao"
    assert "Augmentin" in r["result"]["ghi_chu"] and len(r["sources"]) == 2
    assert "thông tin thuốc trên mạng" in r["message"] and "không dùng AI" in r["notice"]


def test_scan_ignores_registration_of_another_drug_near_the_name(ctx, tavily_only):
    _, tavily = tavily_only
    tavily.reply(200, {"results": [  # trang liệt kê: số đăng ký gần chữ "Augmentin" là của Fogicap
        page("Augmentin 625mg - Nhà thuốc A", "Augmentin 625mg giá tốt. Sản phẩm khác: Fogicap 40 SĐK 893110205525"),
    ]})
    r = ctx.ai.lookup_scan(str(uuid.uuid4()), image=None, ocr_text="", lines=SCAN_LINES)
    ids = [m["id"] for m in r["catalog_matches"]]
    assert r["status"] == "found" and FOGICAP_40 not in ids and AUGMENTIN_625 in ids
    assert r["catalog_matches"][0]["match_by"] == "name" and r["result"]["do_tin_cay"] == "thap"


def test_scan_without_readable_name_does_not_spend_a_search(ctx, tavily_only):
    _, tavily = tavily_only
    r = ctx.ai.lookup_scan(str(uuid.uuid4()), image=None, ocr_text="Hộp 10 vỉ x 10 viên\nHSD 12/2027\nSố lô 123")
    assert r["status"] == "unavailable" and r["reason"] == "no_text" and not tavily.calls


def test_scan_with_nothing_relevant_is_not_found_and_cached(ctx, tavily_only):
    _, tavily = tavily_only
    tavily.reply(200, {"results": [page("Tin tức sức khỏe", "Bài viết không nói về thuốc nào")]})
    job = str(uuid.uuid4())
    r = ctx.ai.lookup_scan(job, image=None, ocr_text="", lines=SCAN_LINES)
    assert r["status"] == "not_found" and "chụp rõ" in r["message"] and r["catalog_matches"] == []
    assert ctx.ai.lookup_scan(job, image=None, ocr_text="", lines=SCAN_LINES)["cached"] and len(tavily.calls) == 1


def test_qr_link_is_read_with_tavily_extract(ctx, tavily_only):
    _, tavily = tavily_only
    tavily.reply(200, {"results": [{"url": "https://hang.example/sp/123",
                                    "raw_content": "Augmentin 625mg\nNhà sản xuất: GSK\nSố đăng ký: VN-20169-16"}], "failed_results": []})
    r = ctx.ai.lookup_code("qr", "https://hang.example/sp/123")
    call = tavily.calls[0]
    assert call["url"].endswith("/extract") and call["body"]["urls"] == ["https://hang.example/sp/123"]
    assert call["auth"] == f"Bearer {TAVILY_KEY}"
    assert r["status"] == "found" and r["mode"] == "search" and r["catalog_matches"][0]["id"] == AUGMENTIN_625
    assert r["sources"] == [{"title": "Augmentin 625mg", "url": "https://hang.example/sp/123"}]


def test_qr_link_that_cannot_be_read_is_not_found(ctx, tavily_only):
    _, tavily = tavily_only
    tavily.reply(200, {"results": [], "failed_results": [{"url": "https://hang.example/x", "error": "blocked"}]})
    r = ctx.ai.lookup_code("qr", "https://hang.example/x")
    assert r["status"] == "not_found" and "mã QR" in r["message"]


# Bộ từ của danh mục (rút gọn) — trong máy chủ lấy từ 55.005 thuốc. "pain", "gold" cũng là từ đầu tên của vài thuốc thật.
VOCAB = Vocab(
    heads={"augmentin": 9, "panadol": 15, "hapacol": 62, "imefed": 2, "extra": 2, "fogicap": 3, "pain": 2, "paracetamol": 305},
    ingredients={"amoxicillin": 558, "amoxicilin": 925, "clavulanic": 413, "paracetamol": 2231, "caffeine": 60, "truong": 12,
                 "trihydrate": 430, "potassium": 352},
)


def q_of(text: str):
    return text_query(lines_from_text(text), VOCAB)


def test_text_query_joins_two_line_brand_but_not_ingredient_line():
    q = q_of("Augmentin 1g\nAmoxicillin 875 mg / Acid clavulanic 125 mg")
    assert q is not None and q.name == "Augmentin 1g" and q.terms[0] == "augmentin" and not q.generic
    q2 = q_of("PANADOL\nEXTRA\nParacetamol 500 mg, Caffeine 65 mg")
    assert q2 is not None and q2.name == "PANADOL EXTRA" and q2.query == "PANADOL EXTRA 500 mg số đăng ký"
    assert q_of("Augmentin 625mg\nGSK").query == "Augmentin 625mg số đăng ký"  # hàm lượng đã có trong tên → không lặp


def test_back_of_box_uses_catalog_words_not_the_biggest_junk_text():
    """Ảnh thật (25/11/2026): chụp mặt sau hộp → từng tìm “CARTON RECYCLE 500 mg”, “DRP-8405 875 mg”, “sLsX: PRACTICE”."""
    back = ("ACTIVE INGREDIENTS\nEach caplet CONTAINS PARACETAMOL 500 mg\n• Muscular aches • Period pain · Toothache\n"
            "Fast effective temporary relief of pain and discomfort associated with:\nCARTON\nRECYCLE")
    q = q_of(back)
    assert q is not None and q.generic and q.query == "PARACETAMOL 500 mg số đăng ký"  # “Period pain” ≠ thuốc “Pain…”
    q = q_of(back + "\nDo not use with other paracetamol products while\ntaking Panadol.")
    assert q is not None and not q.generic and q.query == "Panadol 500 mg số đăng ký"
    q = q_of("Formulation\nEach tablet contains 875 mg amoxicilin as amoxicillin trihydrate\n"
             "and 125 mg clavulanic acid as clavulanate potassium.\nReg. No. DRP-8405")
    assert q is not None and q.generic and q.name == "amoxicilin clavulanic" and "875 mg" in q.query
    assert q_of("Lachong\nTiêu chuẩn: TCCS\nSĐKSP: 5052/2020/ĐKSP\nGMP\nCERTIFIED PRACTICE") is None  # thực phẩm chức năng
    assert q_of("Sổ tay ghi chép\nTrường THPT\nLớp 12A1") is None  # “Trường” có dấu → không phải hoạt chất


def test_same_active_ingredient_is_not_the_same_medicine():
    """Lỗi thật (25/11/2026): hộp “Augmentin 1g” từng khớp nhầm “Imefed DT 875 mg/125 mg” vì cùng hoạt chất."""
    q = q_of("Augmentin 1g\nAmoxicillin 875 mg / Acid clavulanic 125 mg")
    imefed = CatalogMedicine(ten_thuoc="Imefed DT 875 mg/ 125 mg", hoat_chat_chinh="Amoxicillin; Acid clavulanic")
    augmentin = CatalogMedicine(ten_thuoc="Augmentin 1g", hoat_chat_chinh="Amoxicillin; Acid clavulanic")
    assert not _name_ok(imefed, q) and _name_ok(augmentin, q)
    generic = q_of("Each tablet contains 875 mg amoxicilin\nand 125 mg clavulanic acid")
    assert _name_ok(imefed, generic) and _name_ok(augmentin, generic)  # tìm theo hoạt chất: thuốc cùng hoạt chất là hợp lệ
    assert not _name_ok(CatalogMedicine(ten_thuoc="Amoxicillin 500mg", hoat_chat_chinh="Amoxicillin"), generic)


def test_variant_with_words_not_on_the_box_ranks_lower():
    q = q_of("Hapacol 250\nParacetamol 250mg\nThuốc bột sủi bọt")
    assert _coverage(CatalogMedicine(ten_thuoc="Hapacol 250"), q) == 1.0
    assert _coverage(CatalogMedicine(ten_thuoc="Hapacol 250 flu"), q) < 1.0
    assert _coverage(CatalogMedicine(ten_thuoc="Augmentin 625mg tablets"), q_of("Augmentin\n625 mg")) == 1.0


def test_scan_of_back_label_searches_by_ingredient_with_medium_confidence(ctx, tavily_only):
    _, tavily = tavily_only
    with ctx.db.session() as s:
        para = s.scalars(select(CatalogMedicine).where(CatalogMedicine.ten_thuoc.ilike("paracetamol%500%"),
                                                       CatalogMedicine.so_dang_ky.is_not(None))).first()
        reg = para.so_dang_ky
    tavily.reply(200, {"results": [
        page("Paracetamol 500mg - Nhà thuốc A", f"Thuốc Paracetamol 500mg. Số đăng ký: {reg}."),
        page("Paracetamol 500 | Nhà thuốc B", f"PARACETAMOL 500 mg viên nén – SĐK {reg}", url="https://b.example/para"),
    ]})
    r = ctx.ai.lookup_scan(str(uuid.uuid4()), image=None, ocr_text="ACTIVE INGREDIENTS\nEach caplet CONTAINS PARACETAMOL 500 mg\nCARTON RECYCLE")
    assert tavily.calls[0]["body"]["query"] == "PARACETAMOL 500 mg số đăng ký"
    assert r["status"] == "found" and r["catalog_matches"][0]["id"] == para.id
    assert r["result"]["do_tin_cay"] == "trung_binh"  # 2 trang cùng số đăng ký nhưng chỉ biết hoạt chất → không “cao”
    assert "hoạt chất" in r["result"]["ghi_chu"] and "nhà sản xuất" in r["result"]["ghi_chu"]


def test_name_only_suggestion_shows_the_box_text_not_a_web_page_title(ctx, tavily_only):
    """Ảnh thật (25/11/2026): ô tên thuốc từng hiện “EVS Explore” (tiêu đề một trang web nước ngoài)."""
    _, tavily = tavily_only
    tavily.reply(200, {"results": [page("Paracetamol 500mg – EVS Explore", "paracetamol 500 mg tablet, no registration here")]})
    r = ctx.ai.lookup_scan(str(uuid.uuid4()), image=None, ocr_text="Each caplet CONTAINS PARACETAMOL 500 mg")
    assert r["status"] == "found" and r["result"]["ten_thuoc"] == "PARACETAMOL 500 mg" and r["result"]["do_tin_cay"] == "thap"
    assert r["catalog_matches"] and all(m["match_by"] == "name" for m in r["catalog_matches"])
    assert r["result"]["ghi_chu"].endswith("đối chiếu tên và nhà sản xuất trên vỏ hộp.")


def test_supplement_without_catalog_words_does_not_spend_a_search(ctx, tavily_only):
    _, tavily = tavily_only
    r = ctx.ai.lookup_scan(str(uuid.uuid4()), image=None, ocr_text="Lachong\nTiêu chuẩn: TCCS\nSĐKSP: 5052/2020/ĐKSP")
    assert r["status"] == "unavailable" and r["reason"] == "no_text" and "mặt trước" in r["message"] and not tavily.calls


def test_qr_plain_text_is_searched(ctx, tavily_only):
    _, tavily = tavily_only
    tavily.reply(200, {"results": [page("Augmentin 625mg", "Augmentin 625mg – Số đăng ký VN-20169-16")]})
    r = ctx.ai.lookup_code("qr", "AUGMENTIN 625MG\nGSK")
    assert "AUGMENTIN" in tavily.calls[0]["body"]["query"] and r["status"] == "found"
    assert r["catalog_matches"][0]["id"] == AUGMENTIN_625


def test_qr_with_registration_number_needs_no_ai_or_internet(ctx, tavily):
    r = ctx.ai.lookup_code("qr", "AUGMENTIN 625MG - SDK VN-20169-16 - GSK")
    assert r["status"] == "found" and r["mode"] == "text" and r["catalog_matches"][0]["id"] == AUGMENTIN_625
    assert not tavily.calls


def test_status_and_secrets(ctx, tavily, client):
    status = client.get("/api/ai/status").json()
    assert status["provider"] == "tavily"
    assert status["web_search"] == {"provider": "tavily", "configured": True, "last_error": None}
    assert TAVILY_KEY not in json.dumps(status)
    ctx.settings.tavily_api_key = TAVILY_KEY
    assert TAVILY_KEY not in repr(ctx.settings)
