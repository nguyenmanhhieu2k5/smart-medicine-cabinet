"""Ảnh quét có mã vạch / mã QR: máy chủ đọc mã (zxing-cpp) cùng lúc với OCR và đối chiếu dữ liệu.

Ảnh mã được tạo ngay trong kiểm thử bằng zxing-cpp (không cần file ảnh mẫu).
"""
from __future__ import annotations

import cv2
import numpy as np
import pytest
import zxingcpp

from app.core import clock
from app.models.catalog import CatalogBarcode
from app.services.barcode import decode
from app.services.barcode.gs1 import check_digit

from .conftest import AUGMENTIN_1G, AUGMENTIN_625
from .test_14_public_scan import wait_done

LINKED = "893520601012" + str(check_digit("893520601012"))  # gắn với Augmentin 1g trong kiểm thử
UNKNOWN = "893520609999"[:12] + str(check_digit("893520609999"[:12]))


def code_png(text: str, fmt=zxingcpp.BarcodeFormat.EAN13, scale: int = 4) -> bytes:
    """Ảnh hộp thuốc giả: nền trắng, mã ở góc — như ảnh chụp mặt có mã vạch."""
    img = np.array(zxingcpp.create_barcode(text, fmt).to_image(scale=scale))
    canvas = np.full((max(480, img.shape[0] + 80), max(640, img.shape[1] + 80)), 255, np.uint8)
    canvas[40:40 + img.shape[0], 40:40 + img.shape[1]] = img
    ok, buf = cv2.imencode(".png", canvas)
    assert ok
    return buf.tobytes()


@pytest.fixture
def linked_barcode(ctx):
    with ctx.db.session() as s:
        s.add(CatalogBarcode(gtin="0" + LINKED, medicine_id=AUGMENTIN_1G, source="excel", match_method="registration",
                             created_at=clock.now()))
    return LINKED


def scan(public_client, headers, image: bytes) -> dict:
    r = public_client.post("/api/v1/scans", headers=headers, data={"source": "upload"},
                           files={"file": ("ma-vach.png", image, "image/png")})
    assert r.status_code == 202, r.text
    return wait_done(public_client, r.json()["id"], headers)


def test_read_codes_finds_retail_barcodes_and_qr_codes():
    ean = cv2.imdecode(np.frombuffer(code_png(LINKED), np.uint8), cv2.IMREAD_GRAYSCALE)
    qr = cv2.imdecode(np.frombuffer(code_png("SDK VN-20169-16", zxingcpp.BarcodeFormat.QRCode), np.uint8), cv2.IMREAD_GRAYSCALE)
    assert decode.read_codes(ean) == [{"format": "EAN-13", "text": LINKED}]
    assert decode.read_codes(qr) == [{"format": "QR Code", "text": "SDK VN-20169-16"}]
    assert decode.read_codes(np.full((200, 300), 255, np.uint8)) == []
    assert decode.read_codes(None) == []


class _Hit:
    def __init__(self, fmt: str, text: str):
        self.format, self.text = fmt, text


def test_read_codes_tries_several_scales_and_merges(monkeypatch):
    """Lỗi thật (25/11/2026): ảnh webcam 1920×1080 có mã vạch + mã QR nhỏ — ở kích thước gốc chỉ đọc được mã vạch,
    thu nhỏ ×0,5 / phóng to ×2 thì đọc được cả QR."""
    seen_widths: list[int] = []

    class FakeZxing:
        @staticmethod
        def read_barcodes(view):
            seen_widths.append(view.shape[1])
            hits = [_Hit("EAN-13", LINKED)]
            if view.shape[1] != 1920:  # mã QR nhỏ chỉ thấy khi đổi tỉ lệ
                hits.append(_Hit("QR Code", "http://vacopharm.com"))
            return hits

    monkeypatch.setattr(decode, "zxingcpp", FakeZxing)
    codes = decode.read_codes(np.zeros((1080, 1920, 3), np.uint8))
    assert codes == [{"format": "EAN-13", "text": LINKED}, {"format": "QR Code", "text": "http://vacopharm.com"}]
    assert seen_widths == [1920, 960, 3840]  # gốc → ×0,5 → ×2
    seen_widths.clear()
    decode.read_codes(np.zeros((3000, 4000), np.uint8))  # ảnh lớn: không phóng to
    assert seen_widths == [4000, 2000]


def test_barcode_in_photo_puts_linked_medicine_first(public_client, scanner, linked_barcode, fake_engine):
    headers, _ = scanner
    done = scan(public_client, headers, code_png(LINKED))  # OCR giả vẫn đọc ra chữ của Augmentin 625mg
    codes = done["result"]["barcodes"]
    assert codes == [{"format": "EAN-13", "text": LINKED, "kind": "gtin", "display": LINKED, "status": "found",
                      "medicine_id": AUGMENTIN_1G, "match_by": "barcode", "expiry": None, "lot": None}]
    match = done["result"]["match"]
    ids = [c["medicine"]["id"] for c in match["candidates"]]
    assert match["status"] == "confident" and ids[0] == AUGMENTIN_1G and AUGMENTIN_625 in ids and len(ids) <= 3
    assert match["candidates"][0]["level"] == "high"


def test_unknown_barcode_is_reported_without_changing_ocr_candidates(public_client, scanner, fake_engine):
    headers, _ = scanner
    done = scan(public_client, headers, code_png(UNKNOWN))
    assert done["result"]["barcodes"][0]["status"] == "not_found" and done["result"]["barcodes"][0]["display"] == UNKNOWN
    assert done["result"]["match"]["candidates"][0]["medicine"]["id"] == AUGMENTIN_625  # ứng viên OCR giữ nguyên


def test_qr_with_registration_number_works_even_without_readable_text(public_client, scanner, fake_engine):
    headers, _ = scanner
    fake_engine.lines = []  # mặt hộp chỉ có mã QR
    done = scan(public_client, headers, code_png("AUGMENTIN 625MG - SDK VN-20169-16", zxingcpp.BarcodeFormat.QRCode))
    code = done["result"]["barcodes"][0]
    assert code["format"] == "QR Code" and code["status"] == "found" and code["match_by"] == "registration"
    assert done["result"]["match"]["status"] == "confident"
    assert done["result"]["match"]["candidates"][0]["medicine"]["id"] == AUGMENTIN_625


def test_gs1_qr_gives_exact_expiry_and_lot(public_client, scanner, linked_barcode, fake_engine):
    headers, _ = scanner
    fake_engine.lines = []
    link = f"https://id.gs1.org/01/0{LINKED}/10/LOT2026A?17=270630"
    done = scan(public_client, headers, code_png(link, zxingcpp.BarcodeFormat.QRCode))
    code = done["result"]["barcodes"][0]
    assert code["status"] == "found" and code["expiry"] == "2027-06-30" and code["lot"] == "LOT2026A"
    assert done["result"]["expiry_suggestion"] == {"date": "2027-06-30", "precision": "day",
                                                   "text": "30/06/2027 (đọc từ mã QR Code)", "needs_confirmation": False}
    assert done["result"]["match"]["candidates"][0]["medicine"]["id"] == AUGMENTIN_1G


def test_scan_still_works_when_barcode_library_is_missing(public_client, scanner, fake_engine, monkeypatch):
    headers, _ = scanner
    monkeypatch.setattr(decode, "zxingcpp", None)
    done = scan(public_client, headers, code_png(LINKED))
    assert done["status"] == "done" and done["result"]["barcodes"] == []
    assert done["result"]["match"]["candidates"][0]["medicine"]["id"] == AUGMENTIN_625
