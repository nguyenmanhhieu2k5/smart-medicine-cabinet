"""Gợi ý hạn sử dụng đọc từ bao bì (cần người dùng xác nhận).

Chỉ đề xuất khi ngày đi kèm từ khóa hạn dùng (HSD, EXP, Hạn dùng…) để không
nhầm với ngày sản xuất. Kết quả luôn chỉ là gợi ý.
"""
from __future__ import annotations

import calendar
import re
from datetime import date
from typing import Any, Sequence

from app.services.medicine_matcher.normalize import fold

_KEYWORD = re.compile(r"\b(hsd|h\.s\.d|han dung|han su dung|han sd|hd|exp(?:iry)?(?: date)?|use by|use before|best before)\b[\s.:/-]*")
_MFG = re.compile(r"\b(nsx|ngay sx|ngay san xuat|mfg|mfd|manufactured|sx)\b")
_MONTHS = {m: i for i, m in enumerate(("jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"), 1)}

_DMY = re.compile(r"(?<!\d)(\d{1,2})\s*[/.\-]\s*(\d{1,2})\s*[/.\-]\s*(\d{4}|\d{2})(?!\d)")
_MY = re.compile(r"(?<!\d)(\d{1,2})\s*[/.\-]\s*(\d{4}|\d{2})(?!\d)")
_YMD = re.compile(r"(?<!\d)(\d{4})\s*[/.\-]\s*(\d{1,2})\s*[/.\-]\s*(\d{1,2})(?!\d)")
_MON_Y = re.compile(r"\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s*[/.\-]?\s*(\d{4}|\d{2})\b")
_COMPACT = re.compile(r"(?<!\d)(\d{2})(\d{2})(\d{2}|\d{4})(?!\d)")


def _year(value: str) -> int:
    year = int(value)
    return year + 2000 if year < 100 else year


def _make(year: int, month: int, day: int | None) -> date | None:
    if not (2000 <= year <= 2100 and 1 <= month <= 12):
        return None
    last = calendar.monthrange(year, month)[1]
    if day is None:
        day = last  # chỉ ghi tháng/năm → hết hạn vào cuối tháng
    if not 1 <= day <= last:
        return None
    return date(year, month, day)


def _parse_date(fragment: str) -> tuple[date, str] | None:
    """Ngày đầu tiên hợp lệ trong đoạn văn bản (đã bỏ dấu, chữ thường)."""
    m = _YMD.search(fragment)
    if m:
        d = _make(int(m.group(1)), int(m.group(2)), int(m.group(3)))
        if d:
            return d, "day"
    m = _DMY.search(fragment)
    if m:
        d = _make(_year(m.group(3)), int(m.group(2)), int(m.group(1)))
        if d:
            return d, "day"
    m = _MON_Y.search(fragment)
    if m:
        d = _make(_year(m.group(2)), _MONTHS[m.group(1)], None)
        if d:
            return d, "month"
    m = _MY.search(fragment)
    if m:
        d = _make(_year(m.group(2)), int(m.group(1)), None)
        if d:
            return d, "month"
    m = _COMPACT.search(fragment)
    if m:
        d = _make(_year(m.group(3)), int(m.group(2)), int(m.group(1)))
        if d:
            return d, "day"
    return None


def extract_expiry(lines: Sequence[str]) -> dict[str, Any] | None:
    """Tìm hạn dùng dạng “HSD: 15/06/2027”, “EXP 06/2027”, “Hạn dùng: 06-2027”…"""
    folded = [fold(line) for line in lines]
    for index, line in enumerate(folded):
        for match in _KEYWORD.finditer(line):
            tail = line[match.end():]
            # Nếu sau từ khóa hạn dùng còn có mốc ngày sản xuất thì chỉ xét phần trước mốc đó.
            mfg = _MFG.search(tail)
            segment = tail[: mfg.start()] if mfg else tail
            found = _parse_date(segment[:40])
            if not found and index + 1 < len(folded) and not segment.strip():
                nxt = folded[index + 1]
                if not _MFG.search(nxt):
                    found = _parse_date(nxt[:40])  # ngày nằm ở dòng kế tiếp
            if found:
                value, precision = found
                return {
                    "date": value.isoformat(),
                    "precision": precision,  # "month": bao bì chỉ ghi tháng/năm
                    "text": lines[index].strip(),
                    "needs_confirmation": True,
                }
    return None
