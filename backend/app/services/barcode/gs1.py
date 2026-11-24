"""Đọc mã vạch theo chuẩn GS1 — không cần CSDL.

- Mã 1D trên vỏ hộp: EAN-13 (893… ở Việt Nam), EAN-8, UPC-A/UPC-E (12/8 số), ITF-14/GTIN-14.
- Mã 2D GS1 DataMatrix / GS1-128 (chuỗi AI): (01) GTIN, (17) hạn dùng YYMMDD, (10) số lô, (21) số sê-ri.
- GS1 Digital Link trong mã QR: https://…/01/<GTIN>/10/<lô>?17=<HSD>.

Mọi GTIN được chuẩn hóa về 14 chữ số (thêm 0 bên trái) để EAN-13 và GTIN-14 của cùng sản phẩm trùng nhau
— kể cả khi Excel đã làm mất số 0 đầu của mã (lưu mã vạch dạng số).
"""
from __future__ import annotations

import calendar
import re
from dataclasses import dataclass
from datetime import date
from urllib.parse import parse_qs, unquote, urlparse

GS = "\x1d"  # ký tự phân cách nhóm (FNC1) trong chuỗi GS1
# Mã nhận dạng ký hiệu mà một số đầu đọc gắn ở đầu chuỗi: ]d2 = GS1 DataMatrix, ]C1 = GS1-128, ]e0 = EAN, ]Q3 = GS1 QR.
_SYMBOLOGY_PREFIX = re.compile(r"^\][A-Za-z][0-9]")
# AI có độ dài cố định (số chữ số dữ liệu); các AI khác dài thay đổi, kết thúc bằng GS hoặc hết chuỗi.
_FIXED_AI = {"00": 18, "01": 14, "02": 14, "11": 6, "12": 6, "13": 6, "15": 6, "16": 6, "17": 6, "20": 2}
_VARIABLE_AI = {"10": 20, "21": 20, "22": 20, "240": 30, "241": 30, "30": 8, "37": 8, "90": 30, "91": 90, "92": 90,
                "93": 90, "94": 90, "95": 90, "96": 90, "97": 90, "98": 90, "99": 90}


@dataclass(frozen=True)
class ParsedCode:
    raw: str
    kind: str  # gtin | internal | invalid
    gtin: str | None = None  # 14 chữ số
    expiry: date | None = None  # AI (17)
    lot: str | None = None  # AI (10)
    serial: str | None = None  # AI (21)
    message: str = ""

    @property
    def display(self) -> str:
        """Dạng ngắn để hiển thị: bỏ các số 0 thêm vào đầu (EAN-13 hiện 13 số)."""
        if not self.gtin:
            return self.raw
        return self.gtin[1:] if self.gtin.startswith("0") else self.gtin


def check_digit(body: str) -> int:
    """Số kiểm tra GS1 (mod 10, trọng số 3-1 tính từ phải sang)."""
    total = sum(int(d) * (3 if i % 2 == 0 else 1) for i, d in enumerate(reversed(body)))
    return (10 - total % 10) % 10


def _expand_upce(code: str) -> str | None:
    """UPC-E (8 số) → UPC-A (12 số)."""
    if len(code) != 8 or code[0] not in "01":
        return None
    ns, d, check = code[0], code[1:7], code[7]
    last = d[5]
    if last in "012":
        body = d[0:2] + last + "0000" + d[2:5]
    elif last == "3":
        body = d[0:3] + "00000" + d[3:5]
    elif last == "4":
        body = d[0:4] + "00000" + d[4]
    else:
        body = d[0:5] + "0000" + last
    return ns + body + check


def is_valid_gtin(digits: str) -> bool:
    return digits.isdigit() and len(digits) in (8, 12, 13, 14) and check_digit(digits[:-1]) == int(digits[-1])


def is_restricted(gtin14: str) -> bool:
    """Mã nội bộ/lưu hành hạn chế (cửa hàng tự in, phiếu giảm giá) — không định danh sản phẩm toàn cầu.

    Tiền tố GS1 của GTIN-13: 02, 04, 20–29 (nội bộ, hàng cân), 05/98/99 (phiếu, coupon).
    """
    if gtin14.startswith("000000"):  # GTIN-8: tiền tố 0 hoặc 2 là mã nội bộ
        return gtin14[6] in "02"
    g13 = gtin14[1:]
    return g13.startswith(("02", "04", "05", "2", "98", "99"))


def to_gtin14(digits: str) -> str:
    return digits.zfill(14)


def _gtin_result(raw: str, digits: str, **extra: object) -> ParsedCode:
    if len(digits) == 8 and digits[0] in "01" and not is_valid_gtin(digits):
        expanded = _expand_upce(digits)
        if expanded and is_valid_gtin(expanded):
            digits = expanded
    if not is_valid_gtin(digits):
        return ParsedCode(raw=raw, kind="invalid", message="Mã vạch không hợp lệ (sai số kiểm tra).")
    gtin = to_gtin14(digits)
    if gtin == "0" * 14:
        return ParsedCode(raw=raw, kind="invalid", message="Mã vạch không hợp lệ.")
    if is_restricted(gtin):
        return ParsedCode(raw=raw, kind="internal", gtin=gtin,
                          message="Đây là mã nội bộ (cửa hàng tự in), không phải mã vạch sản phẩm.")
    return ParsedCode(raw=raw, kind="gtin", gtin=gtin, **extra)  # type: ignore[arg-type]


def parse_gs1_date(value: str | None) -> date | None:
    """YYMMDD của GS1; DD = 00 nghĩa là ngày cuối tháng."""
    if not value or not re.fullmatch(r"\d{6}", value):
        return None
    yy, mm, dd = int(value[:2]), int(value[2:4]), int(value[4:])
    if not 1 <= mm <= 12:
        return None
    year = 2000 + yy  # thuốc đang lưu hành: hạn dùng luôn ở thế kỷ 21
    if dd == 0:
        dd = calendar.monthrange(year, mm)[1]
    try:
        return date(year, mm, dd)
    except ValueError:
        return None


def parse_element_string(text: str) -> dict[str, str] | None:
    """Chuỗi AI GS1: "(01)0893…(17)270131(10)AB12" hoặc dạng thô "010893…17270131 10AB12<GS>21…"."""
    s = text.strip()
    if "(" in s:
        pairs = re.findall(r"\((\d{2,4})\)([^(]*)", s)
        return {ai: value.strip() for ai, value in pairs} or None
    out: dict[str, str] = {}
    i = 0
    while i < len(s):
        if s[i] == GS:
            i += 1
            continue
        ai = next((k for k in (s[i:i + 3], s[i:i + 2]) if k in _FIXED_AI or k in _VARIABLE_AI), None)
        if ai is None:
            break
        i += len(ai)
        if ai in _FIXED_AI:
            value = s[i:i + _FIXED_AI[ai]]
            i += _FIXED_AI[ai]
        else:
            end = s.find(GS, i)
            end = len(s) if end < 0 else end
            value = s[i:min(end, i + _VARIABLE_AI[ai])]
            i = end
        out[ai] = value
    return out or None


def _digital_link(text: str) -> dict[str, str] | None:
    """GS1 Digital Link: https://id.gs1.org/01/08935206010120/10/AB12?17=270131."""
    try:
        url = urlparse(text.strip())
    except ValueError:
        return None
    if url.scheme not in ("http", "https"):
        return None
    parts = [unquote(p) for p in url.path.split("/") if p]
    out: dict[str, str] = {}
    for i in range(len(parts) - 1):
        if parts[i] in ("01", "10", "21", "17", "22") and parts[i] not in out:
            out[parts[i]] = parts[i + 1]
    for key, values in parse_qs(url.query).items():
        if key in ("17", "10", "21") and values:
            out.setdefault(key, values[0])
    return out if "01" in out else None


def parse_code(raw: str | None) -> ParsedCode:
    """Đọc nội dung một mã vạch (do camera/đầu đọc trả về hoặc ghi trong file)."""
    text = (raw or "").strip()
    text = _SYMBOLOGY_PREFIX.sub("", text)
    if not text:
        return ParsedCode(raw="", kind="invalid", message="Không đọc được mã.")
    compact = re.sub(r"[\s-]", "", text)
    if compact.isdigit() and len(compact) in (8, 12, 13, 14):
        return _gtin_result(text, compact)
    ais = _digital_link(text) if text.lower().startswith("http") else None
    if ais is None and (text.startswith("(") or text.startswith("01") or GS in text):
        ais = parse_element_string(text)
    if ais and re.fullmatch(r"\d{14}", ais.get("01", "")):
        return _gtin_result(
            text, ais["01"],
            expiry=parse_gs1_date(ais.get("17")),
            lot=(ais.get("10") or None),
            serial=(ais.get("21") or None),
        )
    return ParsedCode(raw=text, kind="invalid", message="Mã này không phải mã vạch sản phẩm (GTIN/EAN).")


def split_codes(value: object) -> list[str]:
    """Một ô Excel có thể chứa nhiều mã: "8935…; 8936…" — và mã có thể bị Excel lưu dạng số (mất số 0 đầu)."""
    if value is None:
        return []
    if isinstance(value, bool):
        return []
    if isinstance(value, int):
        return [str(value)]
    if isinstance(value, float):
        return [str(int(value))] if value.is_integer() and value > 0 else []
    text = str(value).strip()
    if not text:
        return []
    if re.fullmatch(r"\d+(?:\.0+)?", text):
        return [text.split(".")[0]]
    if re.fullmatch(r"\d(?:\.\d+)?[eE]\+\d+", text):  # 8.93521E+12 — Excel đã làm tròn, không khôi phục được
        return [text]
    return [p.strip() for p in re.split(r"[;,/|\n]+", text) if p.strip()]
