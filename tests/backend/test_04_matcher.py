"""6. Phân biệt cùng tên khác hàm lượng · 7. OCR thiếu/sai ký tự ·
8. Xếp hạng 3 ứng viên · 9. Không tự động xác nhận thuốc sai."""
from __future__ import annotations

import pytest

from app.services.medicine_matcher.catalog import CatalogRepository
from app.services.medicine_matcher.matcher import (
    MAX_CANDIDATES,
    UNCERTAIN_MESSAGE,
    MedicineMatcher,
    OcrLine,
    lines_from_text,
    name_similarity,
)
from app.services.medicine_matcher.normalize import normalize_text

from .conftest import AUGMENTIN_1G, AUGMENTIN_250, AUGMENTIN_500_62, AUGMENTIN_625, AUGMENTIN_625_OLD, FOGICAP_40


def match(db, text: str | list[OcrLine]) -> dict:
    lines = lines_from_text(text) if isinstance(text, str) else text
    with db.session() as s:
        return MedicineMatcher(CatalogRepository(s)).match(lines)


def ids(result: dict) -> list[int]:
    return [c["medicine"]["id"] for c in result["candidates"]]


def component(candidate: dict, key: str) -> dict:
    return next(c for c in candidate["components"] if c["key"] == key)


# ---- 6. Cùng tên, khác hàm lượng ------------------------------------------- #
@pytest.mark.parametrize(
    ("text", "expected", "others"),
    [
        ("Augmentin\n250mg/31,25mg\nBột pha hỗn dịch uống", {AUGMENTIN_250}, {AUGMENTIN_500_62, AUGMENTIN_625, AUGMENTIN_1G}),
        ("Augmentin\n500mg/62,5mg\nBột pha hỗn dịch uống", {AUGMENTIN_500_62}, {AUGMENTIN_250, AUGMENTIN_625, AUGMENTIN_1G}),
        ("Augmentin 625mg\nAmoxicillin 500mg / Acid clavulanic 125mg", {AUGMENTIN_625, AUGMENTIN_625_OLD}, {AUGMENTIN_250, AUGMENTIN_500_62, AUGMENTIN_1G}),
        ("Augmentin 1g\nAmoxicillin 875mg + Acid clavulanic 125mg", {AUGMENTIN_1G, 23159}, {AUGMENTIN_250, AUGMENTIN_500_62, AUGMENTIN_625}),
    ],
)
def test_same_name_different_strength_are_not_the_same_medicine(db, text, expected, others):
    result = match(db, text)
    top = result["candidates"][0]
    assert top["medicine"]["id"] in expected
    assert component(top, "strength")["status"] == "match"
    # Các hàm lượng khác của cùng tên Augmentin không bao giờ đứng ngang hàng ứng viên đầu.
    for cand in result["candidates"][1:]:
        if cand["medicine"]["id"] in others:
            assert cand["score"] <= top["score"] - 20
            assert component(cand, "strength")["status"] in ("conflict", "partial")


def test_wrong_strength_is_flagged_as_conflict_and_capped(db):
    result = match(db, "Augmentin 625mg\nAmoxicillin 500mg / Acid clavulanic 125mg")
    with db.session() as s:
        scored = MedicineMatcher(CatalogRepository(s))
        full = scored.match(lines_from_text("Augmentin\n875mg 125mg"))
    wrong = [c for c in full["candidates"] if c["medicine"]["id"] in (AUGMENTIN_250, AUGMENTIN_500_62)]
    for cand in wrong:
        assert "strength_conflict" in cand["flags"] and cand["score"] <= 55
    assert result["candidates"][0]["score"] >= 80


def test_only_name_visible_never_picks_a_strength(db):
    result = match(db, "Augmentin")
    assert result["status"] == "uncertain"
    assert result["message"] == UNCERTAIN_MESSAGE == "Chưa thể xác định chắc chắn. Vui lòng chọn đúng thuốc."
    assert len(result["candidates"]) == MAX_CANDIDATES
    assert len({c["score"] for c in result["candidates"]}) == 1  # các hàm lượng đồng hạng
    assert all(c["level"] != "high" for c in result["candidates"])
    assert result["evidence"]["search_hint"] == "augmentin"


# ---- 7. OCR sai / thiếu ký tự ----------------------------------------------- #
@pytest.mark.parametrize(
    "text",
    [
        "Paracetam0l 5OOmg\nViên nén",
        "PARACETAMOL 500 MG",
        "Paracetarnol 500rng",
        "Paracetamol500mg",
        "Paracetamo 500mg",  # mất ký tự cuối
    ],
)
def test_ocr_noise_still_finds_the_medicine(db, text):
    result = match(db, text)
    top = result["candidates"][0]
    assert "paracetamol" in normalize_text(top["medicine"]["ten_thuoc"])
    assert component(top, "strength")["status"] == "match"
    assert "500" in (top["medicine"]["ham_luong"] or top["medicine"]["ten_thuoc"])


def test_misread_registration_number_is_matched_fuzzily(db):
    # O thay cho 0 trong phần số: VN-2O169-16
    result = match(db, "SĐK: VN-2O169-16")
    assert ids(result)[0] == AUGMENTIN_625
    assert component(result["candidates"][0], "registration")["status"] in ("match", "partial")


def test_partial_text_without_strength_stays_uncertain(db):
    result = match(db, "Hapacol")
    assert result["status"] == "uncertain"
    assert all("hapacol" in normalize_text(c["medicine"]["ten_thuoc"]) for c in result["candidates"])


def test_no_text_and_unrelated_text(db):
    assert match(db, "")["status"] == "no_text"
    unrelated = match(db, "Sổ tay ghi chép\nLớp 12A1 - Năm học 2026\nTrường THPT")
    assert unrelated["status"] == "no_match" and unrelated["candidates"] == []


# ---- 8. Xếp hạng và giải thích ---------------------------------------------- #
def test_returns_at_most_three_ranked_candidates_with_explanations(db):
    result = match(db, "Augmentin 625mg\nAmoxicillin 500mg / Acid clavulanic 125mg\nViên nén bao phim\nSĐK: VN-20169-16")
    candidates = result["candidates"]
    assert 1 <= len(candidates) <= 3
    assert [c["score"] for c in candidates] == sorted((c["score"] for c in candidates), reverse=True)
    top = candidates[0]
    assert top["medicine"]["id"] == AUGMENTIN_625 and top["level"] == "high" and top["level_label"] == "Cao"
    for key in ("ten_thuoc", "hoat_chat_chinh", "ham_luong", "dang_bao_che", "so_dang_ky"):
        assert key in top["medicine"]
    keys = [c["key"] for c in top["components"]]
    assert keys[:5] == ["registration", "name", "strength", "ingredient", "form"]
    assert all(c["detail"] and c["label"] for c in top["components"])
    assert all(c["status"] == "match" for c in top["components"][:5])


def test_score_is_a_weighted_and_reproducible_match_level(db):
    text = "Augmentin 625mg\nAmoxicillin 500mg / Acid clavulanic 125mg"
    first, second = match(db, text), match(db, text)
    assert first == second  # xác định, không ngẫu nhiên
    for cand in first["candidates"]:
        assert 0 <= cand["score"] <= 100
        for comp in cand["components"]:
            assert comp["value"] is None or 0 <= comp["value"] <= 1


def test_registration_number_breaks_ties_between_identical_names(db):
    without = match(db, "Augmentin 625mg\nAmoxicillin 500mg / Acid clavulanic 125mg")
    assert without["status"] == "uncertain"
    assert any("trùng tên và hàm lượng" in r for r in without["reasons"])
    assert {AUGMENTIN_625, AUGMENTIN_625_OLD} <= set(ids(without))

    with_reg = match(db, "Augmentin 625mg\nAmoxicillin 500mg / Acid clavulanic 125mg\nSĐK: VN-20169-16")
    assert with_reg["status"] == "confident" and ids(with_reg)[0] == AUGMENTIN_625
    other = next(c for c in with_reg["candidates"] if c["medicine"]["id"] == AUGMENTIN_625_OLD)
    assert component(other, "registration")["status"] == "conflict"


def test_registration_alone_identifies_the_record(db):
    result = match(db, "SĐK: VD-34703-20")
    assert ids(result) == [FOGICAP_40]
    assert component(result["candidates"][0], "name")["status"] == "not_observed"


def test_prominent_brand_line_beats_generic_ingredient_line(db):
    lines = [
        OcrLine("Efferalgan", 0.99, (40, 40, 600, 150)),  # chữ to
        OcrLine("Paracetamol 500mg", 0.99, (40, 170, 420, 210)),  # chữ nhỏ
        OcrLine("Viên nén sủi bọt", 0.98, (40, 220, 380, 258)),
    ]
    result = match(db, lines)
    assert normalize_text(result["candidates"][0]["medicine"]["ten_thuoc"]).startswith("efferalgan")
    generic = [c for c in result["candidates"] if normalize_text(c["medicine"]["ten_thuoc"]).startswith("paracetamol")]
    assert all(c["score"] < result["candidates"][0]["score"] for c in generic)


def test_packaging_amount_is_not_treated_as_a_strength_conflict(db):
    result = match(db, "Hapacol 250\nParacetamol 250mg\nThuốc bột sủi bọt\nHộp 24 gói x 1,5g")
    top = result["candidates"][0]
    assert normalize_text(top["medicine"]["ten_thuoc"]) == "hapacol 250"
    assert component(top, "strength")["status"] == "match"


def test_name_similarity_is_length_aware():
    assert name_similarity("paracetamol", "paracetamol") == 100
    assert name_similarity("bi", "bidiclor") < 60  # tên rất ngắn không được khớp tràn lan
    assert name_similarity("augmentin", "augmentin") > name_similarity("euvi mentin", "augmentin")
    assert name_similarity("", "abc") == 0


# ---- 9. Không tự xác nhận ---------------------------------------------------- #
def test_matcher_never_marks_anything_as_saved_or_confirmed(db):
    for text in ("Augmentin 625mg\nSĐK: VN-20169-16", "Augmentin", "abc xyz"):
        result = match(db, text)
        assert result["status"] in ("confident", "uncertain", "no_match")
        assert "confirmed" not in result and "saved" not in result
        if result["status"] == "confident":
            assert "xác nhận" in result["message"]


def test_conflicting_name_and_registration_is_not_confident(db):
    # Tên trên ảnh là Paracetamol nhưng số đăng ký thuộc về Augmentin.
    result = match(db, "Paracetamol 500mg\nSĐK: VN-20169-16")
    assert result["status"] == "uncertain"
