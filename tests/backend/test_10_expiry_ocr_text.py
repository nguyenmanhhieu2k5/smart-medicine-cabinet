"""Gợi ý hạn dùng từ văn bản OCR (luôn cần người dùng xác nhận)."""
from __future__ import annotations

import pytest

from app.services.ocr.expiry import extract_expiry


@pytest.mark.parametrize(
    ("lines", "expected", "precision"),
    [
        (["HSD: 15/06/2027"], "2027-06-15", "day"),
        (["Hạn dùng: 06/2027"], "2027-06-30", "month"),  # chỉ ghi tháng → cuối tháng
        (["EXP 02-2028"], "2028-02-29", "month"),  # năm nhuận
        (["EXP: JUN 2027"], "2027-06-30", "month"),
        (["NSX: 12/02/2025  HSD: 12/02/2028"], "2028-02-12", "day"),
        (["HSD: 12/02/2028 NSX: 12/02/2025"], "2028-02-12", "day"),
        (["Số lô: 010225", "HSD:", "20.11.26"], "2026-11-20", "day"),
        (["Exp. date 2027-03-01"], "2027-03-01", "day"),
    ],
)
def test_expiry_is_read_only_next_to_an_expiry_keyword(lines, expected, precision):
    found = extract_expiry(lines)
    assert found is not None and found["date"] == expected and found["precision"] == precision
    assert found["needs_confirmation"] is True


@pytest.mark.parametrize(
    "lines",
    [
        ["NSX: 12/02/2025"],  # chỉ có ngày sản xuất
        ["12/02/2028"],  # ngày không kèm từ khóa → không đoán
        ["HSD: xem trên bao bì"],
        ["HSD: 45/13/2027"],  # ngày không hợp lệ
        ["Hộp 10 vỉ x 10 viên"],
        [],
    ],
)
def test_no_guess_without_clear_expiry(lines):
    assert extract_expiry(lines) is None
