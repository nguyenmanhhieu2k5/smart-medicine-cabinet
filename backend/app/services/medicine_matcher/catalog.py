"""Truy vấn danh mục thuốc: xem chi tiết, tìm kiếm thủ công, truy xuất ứng viên.

Không bao giờ tải toàn bộ ~55.000 bản ghi vào bộ nhớ: mọi truy vấn đi qua chỉ
mục SQLite (bảng số đăng ký, FTS5 từ, FTS5 trigram) rồi mới xếp hạng bằng
RapidFuzz trên tập ứng viên nhỏ.
"""
from __future__ import annotations

import re
from typing import Any, Iterable, Sequence

from rapidfuzz import fuzz
from sqlalchemy import func, select, text
from sqlalchemy.orm import Session

from app.models.catalog import CATALOG_COLUMNS, CatalogImport, CatalogMedicine
from app.services.medicine_matcher.normalize import (
    clean_cell,
    extract_reg_numbers,
    fts_safe,
    name_core,
    normalize_reg,
    normalize_text,
    parse_quantities,
    reg_ocr_variants,
    strength_tokens,
)

_QTY_RAW = re.compile(
    r"\d+(?:[.,]\d+)?\s*(?:mcg|µg|μg|mg|g|kg|ml|l|iu|ui|%|IU|UI|MG|G|ML|MCG)(?![A-Za-z0-9])"
)


# --------------------------------------------------------------------------- #
# Trình bày
# --------------------------------------------------------------------------- #
def strength_display(row: CatalogMedicine) -> tuple[str | None, str | None]:
    """(chuỗi hàm lượng để hiển thị, nguồn) — chỉ lấy từ dữ liệu Excel.

    Ưu tiên cột `hamLuong`; nếu trống thì trích các đại lượng được ghi trong
    cột hoạt chất hoặc tên thuốc (nguồn được ghi rõ để người dùng biết).
    """
    ham_luong = clean_cell(row.ham_luong)
    if ham_luong:
        return (ham_luong if len(ham_luong) <= 90 else ham_luong[:87] + "…"), "hamLuong"
    for source, value in (("hoatChatChinh", clean_cell(row.hoat_chat_chinh)), ("tenThuoc", clean_cell(row.ten_thuoc))):
        if not value:
            continue
        found = [" ".join(m.group(0).split()) for m in _QTY_RAW.finditer(value)]
        if found:
            unique = list(dict.fromkeys(found))[:4]
            return "; ".join(unique), source
    return None, None


def registration_status(row: CatalogMedicine) -> dict[str, Any]:
    """Trạng thái số đăng ký theo đúng các cờ có trong file nguồn."""
    if row.is_da_rut_so_dang_ky:
        return {"code": "withdrawn", "label": "Đã rút số đăng ký"}
    if row.is_het_han is True:
        return {"code": "expired", "label": "Số đăng ký đã hết hạn"}
    if row.is_het_han is False:
        return {"code": "valid", "label": "Số đăng ký còn hiệu lực"}
    return {"code": "unknown", "label": "Không có thông tin"}


def _date_part(value: str | None) -> str | None:
    v = clean_cell(value)
    if not v:
        return None
    m = re.match(r"(\d{4}-\d{2}-\d{2})", v)
    return m.group(1) if m else v


def medicine_summary(row: CatalogMedicine) -> dict[str, Any]:
    strength, strength_source = strength_display(row)
    return {
        "id": row.id,
        "ten_thuoc": clean_cell(row.ten_thuoc) or row.ten_thuoc,
        "hoat_chat_chinh": clean_cell(row.hoat_chat_chinh),
        "ham_luong": strength,
        "ham_luong_source": strength_source,
        "dang_bao_che": clean_cell(row.dang_bao_che),
        "so_dang_ky": clean_cell(row.so_dang_ky),
        "ten_cong_ty_san_xuat": clean_cell(row.ten_cong_ty_san_xuat),
        "nuoc_san_xuat": clean_cell(row.nuoc_san_xuat),
        "dong_goi": clean_cell(row.dong_goi),
        "registration_status": registration_status(row),
        "in_source": bool(row.in_source),
    }


def medicine_detail(row: CatalogMedicine) -> dict[str, Any]:
    data = medicine_summary(row)
    data.update(
        so_dang_ky_cu=clean_cell(row.so_dang_ky_cu),
        ham_luong_goc=clean_cell(row.ham_luong),
        ten_duong_dung=clean_cell(row.ten_duong_dung),
        tieu_chuan=clean_cell(row.tieu_chuan),
        tuoi_tho=clean_cell(row.tuoi_tho),
        shelf_life_months=row.shelf_life_months,
        ngay_cap_so_dang_ky=_date_part(row.ngay_cap_so_dang_ky),
        ngay_gia_han_so_dang_ky=_date_part(row.ngay_gia_han_so_dang_ky),
        ngay_het_han_so_dang_ky=_date_part(row.ngay_het_han_so_dang_ky),
        so_quyet_dinh=clean_cell(row.so_quyet_dinh),
        dot_cap=clean_cell(row.dot_cap),
        ten_cong_ty_dang_ky=clean_cell(row.ten_cong_ty_dang_ky),
        dia_chi_dang_ky=clean_cell(row.dia_chi_dang_ky),
        nuoc_dang_ky=clean_cell(row.nuoc_dang_ky),
        dia_chi_san_xuat=clean_cell(row.dia_chi_san_xuat),
        phan_loai_thuoc_enum=clean_cell(row.phan_loai_thuoc_enum),
        # Toàn bộ giá trị gốc theo đúng tên cột của file Excel.
        raw={excel: getattr(row, col) for excel, col in CATALOG_COLUMNS.items()},
    )
    return data


# --------------------------------------------------------------------------- #
# Truy vấn
# --------------------------------------------------------------------------- #
_FTS_WEIGHTS = "10.0, 4.0, 3.0, 1.0, 8.0"  # name, ingredient, strength, form, reg
# Chuỗi (đã bỏ dấu cách/gạch) trông giống số đăng ký: "VN2016916", "893110205525".
_REG_QUERY = re.compile(r"^(?:[A-Z]{1,4}\d[A-Z0-9]{4,11}|\d{6,12})$")
RELAXED_MIN_SCORE = 60.0  # ở chế độ nới lỏng/gần đúng, bỏ các kết quả quá khác từ khóa


def _quote(token: str) -> str:
    return '"' + token.replace('"', "") + '"'


class CatalogRepository:
    def __init__(self, session: Session):
        self.s = session

    # ---- cơ bản ---------------------------------------------------------- #
    def count(self) -> int:
        return self.s.scalar(select(func.count()).select_from(CatalogMedicine)) or 0

    def get(self, medicine_id: int) -> CatalogMedicine | None:
        return self.s.get(CatalogMedicine, medicine_id)

    def get_many(self, ids: Sequence[int]) -> list[CatalogMedicine]:
        if not ids:
            return []
        rows: list[CatalogMedicine] = []
        id_list = list(dict.fromkeys(ids))
        for i in range(0, len(id_list), 500):
            part = id_list[i : i + 500]
            rows.extend(self.s.scalars(select(CatalogMedicine).where(CatalogMedicine.id.in_(part))).all())
        order = {mid: n for n, mid in enumerate(id_list)}
        rows.sort(key=lambda r: order.get(r.id, 0))
        return rows

    def last_import(self) -> CatalogImport | None:
        return self.s.scalar(select(CatalogImport).order_by(CatalogImport.id.desc()).limit(1))

    # ---- số đăng ký ------------------------------------------------------ #
    def ids_by_reg(self, reg_norms: Iterable[str]) -> dict[str, list[int]]:
        """reg_norm → danh sách id (một số đăng ký có thể thuộc nhiều bản ghi)."""
        out: dict[str, list[int]] = {}
        for reg in reg_norms:
            rows = self.s.execute(
                text("SELECT medicine_id FROM catalog_regs WHERE reg_norm = :r"), {"r": reg}
            ).all()
            if rows:
                out[reg] = [r[0] for r in rows]
        return out

    def ids_by_reg_fuzzy(self, reg_norm: str) -> list[tuple[int, str, float]]:
        """Tìm số đăng ký gần giống (OCR sai 1–2 ký tự). Trả về (id, reg, độ giống)."""
        hits: dict[tuple[int, str], float] = {}
        for variant in reg_ocr_variants(reg_norm):
            exact = self.ids_by_reg([variant])
            for reg, ids in exact.items():
                for mid in ids:
                    hits[(mid, reg)] = max(hits.get((mid, reg), 0), 97.0 if variant != reg_norm else 100.0)
        if hits or len(reg_norm) < 7:
            return [(mid, reg, score) for (mid, reg), score in hits.items()]
        # Cùng tiền tố 4 ký tự và độ dài gần bằng, rồi so bằng RapidFuzz.
        prefix = reg_norm[:4]
        rows = self.s.execute(
            text(
                "SELECT medicine_id, reg_norm FROM catalog_regs "
                "WHERE reg_norm LIKE :p AND length(reg_norm) BETWEEN :lo AND :hi LIMIT 4000"
            ),
            {"p": prefix + "%", "lo": len(reg_norm) - 1, "hi": len(reg_norm) + 1},
        ).all()
        for mid, reg in rows:
            score = fuzz.ratio(reg_norm, reg)
            if score >= 90:
                hits[(mid, reg)] = score
        return [(mid, reg, score) for (mid, reg), score in hits.items()]

    # ---- FTS ------------------------------------------------------------- #
    def _fts(self, match: str, limit: int) -> list[int]:
        try:
            rows = self.s.execute(
                text(
                    f"SELECT rowid FROM catalog_fts WHERE catalog_fts MATCH :q "
                    f"ORDER BY bm25(catalog_fts, {_FTS_WEIGHTS}) LIMIT :n"
                ),
                {"q": match, "n": limit},
            ).all()
        except Exception:  # cú pháp MATCH không hợp lệ → coi như không có kết quả
            return []
        return [r[0] for r in rows]

    def fts_any(self, tokens: Iterable[str], column: str | None = None, limit: int = 60, prefix: bool = False) -> list[int]:
        toks = [fts_safe(t) for t in dict.fromkeys(tokens) if t]
        if not toks:
            return []
        body = " OR ".join(_quote(t) + ("*" if prefix else "") for t in toks[:24])
        match = f"{column} : ({body})" if column else body
        return self._fts(match, limit)

    def trigram(self, phrase: str, column: str = "name", limit: int = 40) -> list[int]:
        """Ứng viên có nhiều bộ ba ký tự chung với `phrase` (chịu được lỗi OCR)."""
        grams: dict[str, None] = {}
        for word in phrase.split():
            if len(word) < 3:
                continue
            for i in range(len(word) - 2):
                grams.setdefault(word[i : i + 3], None)
        if not grams:
            return []
        body = " OR ".join(_quote(g) for g in list(grams)[:28])
        try:
            rows = self.s.execute(
                text(
                    f"SELECT rowid FROM catalog_trgm WHERE catalog_trgm MATCH :q "
                    f"ORDER BY bm25(catalog_trgm, 10.0, 3.0) LIMIT :n"
                ),
                {"q": f"{column} : ({body})", "n": limit},
            ).all()
        except Exception:
            return []
        return [r[0] for r in rows]

    # ---- tìm kiếm thủ công ----------------------------------------------- #
    def search(self, query: str, limit: int = 20, offset: int = 0) -> dict[str, Any]:
        """Tìm theo tên, hoạt chất, hàm lượng hoặc số đăng ký."""
        q_norm = normalize_text(query)
        if not q_norm:
            return {"items": [], "total": 0, "query": query, "mode": "empty"}

        ordered: dict[int, float] = {}
        mode = "text"

        # 1) Số đăng ký (khớp chính xác hoặc theo tiền tố).
        reg_query = normalize_reg(query)
        looks_like_reg = bool(extract_reg_numbers(query)) or bool(_REG_QUERY.match(reg_query))
        if looks_like_reg:
            regs = extract_reg_numbers(query) or [reg_query]
            for reg in regs:
                for mid, _reg, score in self.ids_by_reg_fuzzy(reg):
                    ordered[mid] = max(ordered.get(mid, 0), 1000 + score)
            if len(reg_query) >= 5:
                rows = self.s.execute(
                    text("SELECT medicine_id FROM catalog_regs WHERE reg_norm LIKE :p LIMIT 50"),
                    {"p": reg_query + "%"},
                ).all()
                for (mid,) in rows:
                    ordered.setdefault(mid, 900.0)
            if ordered:
                mode = "registration"

        # 2) FTS: mọi từ đều phải có (từ cuối cùng khớp theo tiền tố).
        tokens = q_norm.split()
        clauses: list[str] = []
        for i, tok in enumerate(tokens):
            safe = fts_safe(tok)
            is_last = i == len(tokens) - 1
            canon = [q.token for q in parse_quantities(tok)]
            if canon:
                alts = [f"strength : {_quote(fts_safe(canon[0]))}", _quote(safe) + "*"]
                clauses.append("(" + " OR ".join(alts) + ")")
            else:
                clauses.append(_quote(safe) + ("*" if is_last or len(safe) >= 3 else ""))
        candidates = self._fts(" AND ".join(clauses), 400)
        if mode == "registration":
            candidates = candidates[:50]
        elif not candidates and len(tokens) > 1:
            # Không có bản ghi chứa đủ mọi từ → nới lỏng: chỉ cần chứa một trong các từ.
            mode = "relaxed"
            candidates += self.fts_any([t for t in tokens if len(t) >= 3], limit=200, prefix=True)
        if mode != "registration" and not candidates:
            core = name_core(query)
            if len(core) >= 4 and any(ch.isalpha() for ch in core):
                mode = "fuzzy" if not candidates else mode
                candidates += self.trigram(core, "name", 80) + self.trigram(core, "ingredient", 40)

        # 3) Xếp hạng lại bằng RapidFuzz trên tập ứng viên.
        q_core = name_core(query) or q_norm
        q_strength = set(strength_tokens(query))
        rows = self.get_many(list(dict.fromkeys(candidates))[:600])
        for row in rows:
            if row.id in ordered:
                continue
            name_score = max(
                fuzz.WRatio(q_core, row.name_core or row.name_norm),
                fuzz.token_set_ratio(q_norm, row.name_norm),
            )
            ing_score = fuzz.partial_ratio(q_core, row.ingredient_norm[:200]) if row.ingredient_norm else 0
            score = max(name_score, 0.92 * ing_score)
            if row.name_norm == q_norm:
                score += 30
            elif row.name_norm.startswith(q_norm) or (row.name_core and row.name_core == q_core):
                score += 15
            if q_strength:
                have = set(row.strength_norm.split())
                score += 12 * len(q_strength & have) - (8 if have and not (q_strength & have) else 0)
            if not row.in_source:
                score -= 5
            if mode in ("relaxed", "fuzzy") and score < RELAXED_MIN_SCORE:
                continue
            ordered[row.id] = score

        ranked = sorted(ordered.items(), key=lambda kv: (-kv[1], kv[0]))
        page_ids = [mid for mid, _ in ranked[offset : offset + limit]]
        items = [medicine_summary(r) for r in self.get_many(page_ids)]
        return {"items": items, "total": len(ranked), "query": query, "mode": mode}
