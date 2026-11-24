"""Tra mã vạch trên mạng KHÔNG dùng AI: kết quả tìm kiếm (Tavily) + quy tắc + danh mục DAV.

1. Chỉ tin trang có ĐÚNG dãy số mã vạch (cho phép dấu cách/chấm/gạch giữa các chữ số).
2. Mỗi trang lấy số đăng ký GẦN chỗ ghi mã vạch nhất (±300 → ±800 → ±1500 ký tự) — tránh nhầm sang sản phẩm khác
   trên trang liệt kê nhiều thuốc. Mỗi trang một phiếu.
3. Số đăng ký → thuốc trong danh mục 55.005 thuốc (bảng medicine_catalog_regs). Không có số đăng ký → gợi ý theo tiêu đề
   trang (độ tin cậy thấp, người dùng tự chọn).
Thông tin hiển thị lấy từ DANH MỤC chính thức, không lấy từ trang web.
"""
from __future__ import annotations

import re
from collections import Counter
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.catalog import CatalogMedicine, CatalogReg
from app.services.medicine_matcher.catalog import CatalogRepository, strength_display
from app.services.medicine_matcher.normalize import clean_cell, find_reg_numbers
from app.services.websearch.tavily import SearchResult

WINDOWS = (300, 800, 1500)
_TITLE_SPLIT = re.compile(r"\s+[|–—-]\s+|\s*\|\s*")
_TITLE_NOISE = re.compile(r"\b(mua|giá|gia|rẻ|chính hãng|chinh hang|nhà thuốc|nha thuoc|online|tốt nhất|giao hàng)\b", re.IGNORECASE)


def _code_pattern(code: str) -> re.Pattern[str]:
    return re.compile(r"(?<!\d)" + r"[\s.\-]?".join(code) + r"(?!\d)")


def evidence_pages(results: list[SearchResult], code: str) -> list[dict[str, Any]]:
    """Các trang có đúng mã vạch, kèm vị trí mã trong văn bản."""
    pattern = _code_pattern(code)
    pages: list[dict[str, Any]] = []
    seen: set[str] = set()
    for r in results:
        if r.url in seen:
            continue
        text = "\n".join(filter(None, [r.title, r.content, r.raw_content]))
        m = pattern.search(text)
        if not m:
            continue
        seen.add(r.url)
        pages.append({"title": r.title.strip() or r.url, "url": r.url, "text": text, "pos": (m.start(), m.end())})
    return pages


_TRAILING_WORD = re.compile(r"[-–—.\s]+[^\W\d_]+$")


def reg_numbers(text: str) -> list[tuple[str, str]]:
    """Số đăng ký trong văn bản web/QR. Số đăng ký luôn kết thúc bằng nhóm chữ số (năm) → bỏ chữ dính sau dấu gạch/chấm:
    "VN-20169-16. Hộp 2 vỉ" hay "VN-20169-16 - GSK" vẫn là VN-20169-16."""
    out: dict[str, str] = {}
    for shown, norm in find_reg_numbers(text):
        trimmed = _TRAILING_WORD.sub("", shown)
        if trimmed != shown:
            shown, norm = trimmed, re.sub(r"[A-Z]+$", "", norm)
        if sum(ch.isdigit() for ch in norm) >= 4:
            out.setdefault(norm, shown)
    return [(shown, norm) for norm, shown in out.items()]


def nearest_regs(page: dict[str, Any]) -> list[tuple[str, str]]:
    """Số đăng ký gần mã vạch nhất trên một trang: [(dạng hiển thị, dạng chuẩn)]."""
    text, (start, end) = page["text"], page["pos"]
    for radius in WINDOWS:
        found = reg_numbers(text[max(0, start - radius): end + radius])
        if found:
            return found
    return []


def title_core(title: str) -> str:
    head = _TITLE_SPLIT.split(title.strip())[0]
    return " ".join(_TITLE_NOISE.sub(" ", head).split())


def match_pages(s: Session, pages: list[dict[str, Any]]) -> dict[str, Any]:
    """→ {ids, by: registration|name|None, reg, votes}."""
    reg_votes: Counter[str] = Counter()
    shown: dict[str, str] = {}
    for page in pages:
        for disp, norm in dict.fromkeys(nearest_regs(page)):
            reg_votes[norm[:40]] += 1
            shown.setdefault(norm[:40], disp)
    if reg_votes:
        rows = s.execute(select(CatalogReg.reg_norm, CatalogReg.medicine_id).where(CatalogReg.reg_norm.in_(list(reg_votes)))).all()
        id_votes: Counter[int] = Counter()
        reg_of: dict[int, str] = {}
        for reg, mid in rows:
            id_votes[mid] += reg_votes[reg]
            reg_of.setdefault(mid, reg)
        if id_votes:
            ids = [mid for mid, _ in id_votes.most_common(3)]
            return {"ids": ids, "by": "registration", "reg": shown[reg_of[ids[0]]], "votes": id_votes[ids[0]]}
    repo = CatalogRepository(s)
    name_votes: Counter[int] = Counter()
    for page in pages:
        query = title_core(page["title"])
        if len(query) < 3:
            continue
        for rank, item in enumerate(repo.search(query[:120], limit=3).get("items", [])):
            name_votes[int(item["id"])] += 3 - rank
    ids = [mid for mid, _ in name_votes.most_common(3)]
    return {"ids": ids, "by": "name" if ids else None, "reg": None, "votes": 0}


def build_info(s: Session, pages: list[dict[str, Any]], match: dict[str, Any]) -> dict[str, Any]:
    """Thông tin hiển thị — lấy từ danh mục khi khớp số đăng ký (nguồn chính thức), không lấy từ trang web."""
    n = len(pages)
    if match["by"] == "registration":
        row = s.get(CatalogMedicine, match["ids"][0])
        assert row is not None
        strength, _ = strength_display(row)
        return {
            "found": True, "ten_thuoc": clean_cell(row.ten_thuoc), "hoat_chat": clean_cell(row.hoat_chat_chinh), "ham_luong": strength,
            "dang_bao_che": clean_cell(row.dang_bao_che), "quy_cach": clean_cell(row.dong_goi), "so_dang_ky": clean_cell(row.so_dang_ky),
            "nha_san_xuat": clean_cell(row.ten_cong_ty_san_xuat), "nuoc_san_xuat": clean_cell(row.nuoc_san_xuat),
            "do_tin_cay": "cao" if match["votes"] >= 2 else "trung_binh",
            "ghi_chu": f"Mã vạch xuất hiện trên {n} trang; số đăng ký {match['reg']} ghi cạnh mã vạch khớp danh mục Cục Quản lý Dược.",
        }
    title = title_core(pages[0]["title"]) or pages[0]["title"]
    return {
        "found": True, "ten_thuoc": title[:300], "hoat_chat": None, "ham_luong": None, "dang_bao_che": None, "quy_cach": None,
        "so_dang_ky": None, "nha_san_xuat": None, "nuoc_san_xuat": None, "do_tin_cay": "thap",
        "ghi_chu": (f"Mã vạch xuất hiện trên {n} trang nhưng không ghi số đăng ký — "
                    + ("các thuốc trong danh mục bên dưới chỉ là gợi ý theo tên, hãy kiểm tra vỏ hộp." if match["ids"]
                       else "không khớp thuốc nào trong danh mục.")),
    }
