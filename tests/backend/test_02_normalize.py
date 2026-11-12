"""2. Chuẩn hóa tên thuốc · 7. Xử lý OCR thiếu/sai ký tự (mức văn bản)."""
from __future__ import annotations

import pytest

from app.services.medicine_matcher.normalize import (
    bare_numbers,
    clean_cell,
    find_reg_numbers,
    fix_ocr_text,
    form_tags,
    ingredient_names,
    name_core,
    normalize_reg,
    normalize_text,
    parse_shelf_life_months,
    split_reg_field,
    strength_tokens,
)


@pytest.mark.parametrize("raw", ["PARACETAMOL 500 MG", "Paracetamol-500mg", "paracetamol 500mg", "  Paracetamol   500 mg. ", "PARACETAMOL (500MG)"])
def test_spec_examples_normalize_to_the_same_text(raw):
    assert normalize_text(raw) == "paracetamol 500mg"


def test_vietnamese_unicode_is_folded():
    assert normalize_text("Viên nén bao phim") == "vien nen bao phim"
    assert normalize_text("ĐƯỜNG UỐNG") == "duong uong"
    # Dạng tổ hợp (NFD) và dựng sẵn (NFC) cho cùng kết quả.
    assert normalize_text("Thuốc") == normalize_text("Thuốc") == "thuoc"
    assert normalize_text("Ｐａｒａｃｅｔａｍｏｌ") == "paracetamol"  # ký tự toàn chiều rộng


@pytest.mark.parametrize(
    ("text", "tokens"),
    [
        ("Augmentin 250mg/31,25mg", ["250mg", "31.25mg"]),
        ("500 MG", ["500mg"]),
        ("0,5 g", ["500mg"]),
        ("1g", ["1000mg"]),
        ("100 µg", ["0.1mg"]),
        ("100 mcg", ["0.1mg"]),
        ("Vitamin A 5.000 IU", ["5000iu"]),
        ("Spiramycin 1.500.000 IU", ["1500000iu"]),
        ("Natri clorid 0,9% 500ml", ["0.9%", "500ml"]),
        ("Vitamin B12 và D3", []),
        ("Hộp 10 vỉ x 10 viên", []),
    ],
)
def test_strength_tokens_are_canonical(text, tokens):
    assert strength_tokens(text) == tokens


def test_same_strength_written_differently_is_equal():
    assert strength_tokens("1 g") == strength_tokens("1000mg") == strength_tokens("1.000 mg")
    assert strength_tokens("62,5 mg") == strength_tokens("62.5mg")
    assert strength_tokens("500mg") != strength_tokens("250mg")


def test_bare_numbers_only_reports_numbers_without_units():
    assert bare_numbers("Hapacol 250") == ["250"]
    assert bare_numbers("Paracetamol 500mg") == []
    assert bare_numbers("Vitamin B12") == []


def test_name_core_drops_strength_and_form_words():
    assert name_core("Augmentin 625mg tablets") == "augmentin"
    assert name_core("Paracetamol 500") == "paracetamol"
    assert name_core("Panadol Extra") == "panadol extra"
    assert name_core("500mg") == "500mg"  # không để tên rỗng


@pytest.mark.parametrize(
    ("ocr", "fixed"),
    [
        ("Paracetam0l", "Paracetamol"),
        ("5OOmg", "500mg"),
        ("l00 mg", "100 mg"),
        ("500rng", "500mg"),
        ("250mq", "250mg"),
        ("Hapacol250", "Hapacol 250"),
    ],
)
def test_common_ocr_errors_are_repaired(ocr, fixed):
    assert fix_ocr_text(ocr) == fixed


def test_ocr_repair_does_not_invent_numbers():
    assert fix_ocr_text("solo mg") == "solo mg"  # không có chữ số thật → giữ nguyên
    assert fix_ocr_text("Vitamin B1") == "Vitamin B1"


def test_registration_numbers():
    assert normalize_reg("VN-20169-16") == normalize_reg("vn 20169 16") == "VN2016916"
    found = dict((norm, shown) for shown, norm in find_reg_numbers("SĐK: VN - 20169 - 16; Reg: 8931 1020 5525; QLSP-H03-1172-19"))
    assert found["VN2016916"] == "VN-20169-16"
    assert "893110205525" in found and "QLSPH03117219" in found
    assert split_reg_field("893100254823 (VD-28817-18)") == ["893100254823", "VD2881718"]
    assert find_reg_numbers("Hộp 10 vỉ x 10 viên") == []


def test_dosage_form_tags_vi_and_en():
    assert form_tags("Viên nén bao phim") == form_tags("Film-coated tablets") == {"tablet", "film_coated"}
    assert form_tags("Viên nang cứng") == {"capsule", "hard"}
    assert "powder" in form_tags("Bột pha hỗn dịch uống") and "suspension" in form_tags("Bột pha hỗn dịch uống")
    assert form_tags("www.congty.com.vn") == frozenset()  # ".com" không phải "cốm"


def test_ingredient_names_strip_notes_and_amounts():
    text = "Amoxicillin (dưới dạng Amoxicillin trihydrate) 500mg; Acid clavulanic (dưới dạng Kali clavulanate) 125mg"
    assert ingredient_names(text) == ["amoxicillin", "acid clavulanic"]
    assert ingredient_names(None) == []


def test_placeholders_and_shelf_life():
    assert clean_cell("--") is None and clean_cell("  ") is None and clean_cell(" a  b ") == "a b"
    assert parse_shelf_life_months("36 tháng") == 36
    assert parse_shelf_life_months("36") == 36
    assert parse_shelf_life_months("2 năm") == 24
    assert parse_shelf_life_months("--") is None
