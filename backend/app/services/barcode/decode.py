"""Đọc mã vạch / mã QR có trong ẢNH quét (zxing-cpp) và đối chiếu với dữ liệu.

Ứng dụng Windows chụp bằng webcam hoặc chọn ảnh; điện thoại chọn ảnh có sẵn → máy chủ vừa OCR vừa tìm mã trên ảnh:
- GTIN (EAN-13/8, UPC, ITF-14, DataMatrix/QR chuẩn GS1) → bảng mã vạch `medicine_catalog_barcodes`;
- nội dung mã QR có số đăng ký → danh mục thuốc;
- DataMatrix GS1 có (17) hạn dùng, (10) số lô → gợi ý hạn dùng chính xác (không phải đoán từ chữ OCR).
Mã khớp dữ liệu được đưa lên đầu danh sách ứng viên; mã chưa có dữ liệu thì ứng dụng mời "Tìm mã này trên mạng".
"""
from __future__ import annotations

import logging
from typing import Any

import cv2
import numpy as np
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.catalog import CatalogReg
from app.services.barcode.gs1 import parse_code
from app.services.barcode.lookup import find_medicine
from app.services.barcode.web_lookup import reg_numbers
from app.services.medicine_matcher.catalog import CatalogRepository, medicine_summary

log = logging.getLogger("smc.barcode")

try:  # thư viện tùy chọn — thiếu thì vẫn OCR bình thường, chỉ không đọc mã
    import zxingcpp
except ImportError:  # pragma: no cover
    zxingcpp = None

# Loại mã in trên bao bì thuốc (tên theo zxing-cpp).
READABLE = {"EAN-13", "EAN-8", "UPC-A", "UPC-E", "ITF", "ITF-14", "Code 128", "QR Code", "Micro QR Code", "Data Matrix"}
MAX_CODES = 4
SCALES = (1.0, 0.5, 2.0)  # gốc → thu nhỏ → phóng to (gộp kết quả)
MAX_UPSCALED_SIDE = 4000  # không phóng to ảnh đã lớn (chậm, không thêm gì)
MIN_DOWNSCALED_SIDE = 200  # ảnh đã nhỏ thì không thu nhỏ nữa
CONFIDENT_MESSAGE = "Đã đọc mã vạch/QR trên hộp và khớp dữ liệu. Vui lòng kiểm tra trước khi lưu."


def available() -> bool:
    return zxingcpp is not None


def _gray(image: np.ndarray) -> np.ndarray:
    if image.ndim == 2:
        return image
    return cv2.cvtColor(image, cv2.COLOR_BGRA2GRAY if image.shape[2] == 4 else cv2.COLOR_BGR2GRAY)


def read_codes(image: np.ndarray | None) -> list[dict[str, str]]:
    """Các mã đọc được trên ảnh (BGR/xám): [{"format": "EAN-13", "text": "893…"}], tối đa MAX_CODES, không trùng.

    Quét ở nhiều tỉ lệ rồi gộp: ảnh webcam 1920×1080 thật có mã QR nhỏ cạnh mã vạch — ở kích thước gốc zxing chỉ thấy
    mã vạch, thu nhỏ ×0,5 hoặc phóng to ×2 thì thấy cả QR. Tổng thêm ~0,2 giây, rất nhỏ so với OCR.
    """
    if zxingcpp is None or image is None:
        return []
    try:
        gray = _gray(image)
    except Exception:  # noqa: BLE001
        return []
    h, w = gray.shape[:2]
    out: list[dict[str, str]] = []
    seen: set[str] = set()
    for scale in SCALES:
        if (scale > 1 and max(h, w) * scale > MAX_UPSCALED_SIDE) or (scale < 1 and min(h, w) * scale < MIN_DOWNSCALED_SIDE):
            continue
        view = gray if scale == 1 else cv2.resize(
            gray, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA if scale < 1 else cv2.INTER_CUBIC)
        try:
            results = zxingcpp.read_barcodes(view)
        except Exception as exc:  # noqa: BLE001 — ảnh lạ không được làm hỏng lượt OCR
            log.warning("Không đọc được mã trên ảnh (tỉ lệ %s): %s", scale, type(exc).__name__)
            continue
        for r in results:
            fmt = str(r.format)
            text = (r.text or "").strip()
            if not text or fmt not in READABLE or text in seen:
                continue
            seen.add(text)
            out.append({"format": fmt, "text": text[:1000]})
        if len(out) >= MAX_CODES:
            break
    return out[:MAX_CODES]


def resolve_codes(s: Session, codes: list[dict[str, str]]) -> list[dict[str, Any]]:
    """Đối chiếu từng mã. status: found | not_found (GTIN chưa có dữ liệu) | internal (mã nội bộ cửa hàng) | text (nội dung khác)."""
    out: list[dict[str, Any]] = []
    for code in codes:
        parsed = parse_code(code["text"])
        item: dict[str, Any] = {
            "format": code["format"], "text": code["text"], "kind": parsed.kind, "gtin": parsed.gtin, "display": parsed.display,
            "expiry": parsed.expiry.isoformat() if parsed.expiry else None, "lot": parsed.lot,
            "status": "text", "medicine_id": None, "match_by": None,
        }
        if parsed.kind == "gtin" and parsed.gtin:
            hit = find_medicine(s, parsed.gtin)
            item["status"] = "found" if hit else "not_found"
            if hit:
                item.update(medicine_id=int(hit[1].id), match_by="barcode")
        elif parsed.kind == "internal":
            item["status"] = "internal"
        else:
            regs = [norm[:40] for _, norm in reg_numbers(code["text"])]
            if regs:
                mid = s.scalars(select(CatalogReg.medicine_id).where(CatalogReg.reg_norm.in_(regs))).first()
                if mid is not None:
                    item.update(status="found", medicine_id=int(mid), match_by="registration")
        out.append(item)
    return out


def merge_into_match(match: dict[str, Any], barcodes: list[dict[str, Any]], repo: CatalogRepository) -> dict[str, Any]:
    """Thuốc khớp mã vạch/QR lên đầu danh sách ứng viên (điểm 100, mức Cao), giữ các ứng viên OCR còn lại (tối đa 3)."""
    hits = [b for b in barcodes if b.get("medicine_id")]
    if not hits:
        return match
    rows = {row.id: row for row in repo.get_many([b["medicine_id"] for b in hits])}
    first: list[dict[str, Any]] = []
    for b in hits:
        row = rows.get(b["medicine_id"])
        if row is None or any(c["medicine"]["id"] == row.id for c in first):
            continue
        detail = (f"Mã vạch {b['display']} ({b['format']}) đã gắn với thuốc này" if b["match_by"] == "barcode"
                  else f"Số đăng ký trong mã {b['format']} khớp danh mục")
        first.append({
            "medicine": medicine_summary(row), "score": 100.0, "level": "high", "level_label": "Cao",
            "components": [{"key": "barcode", "label": "Mã vạch/QR", "status": "match", "value": 1.0, "weight": 1.0,
                            "detail": detail}],
            "flags": [],
        })
    if not first:
        return match
    ids = {c["medicine"]["id"] for c in first}
    rest = [c for c in match.get("candidates") or [] if c["medicine"]["id"] not in ids]
    return {**match, "status": "confident", "message": CONFIDENT_MESSAGE, "reasons": [], "candidates": (first + rest)[:3]}


def expiry_from_codes(barcodes: list[dict[str, Any]]) -> dict[str, Any] | None:
    """Hạn dùng (17) trong DataMatrix/QR chuẩn GS1 — máy đọc chính xác, không cần đoán từ chữ."""
    for b in barcodes:
        if b.get("expiry"):
            y, m, d = b["expiry"].split("-")
            return {"date": b["expiry"], "precision": "day", "text": f"{d}/{m}/{y} (đọc từ mã {b['format']})",
                    "needs_confirmation": False}
    return None
