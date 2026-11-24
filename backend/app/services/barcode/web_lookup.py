"""Tra thuốc trên mạng KHÔNG dùng AI: kết quả tìm kiếm (Tavily) + quy tắc + danh mục DAV.

Mã vạch:
1. Chỉ tin trang có ĐÚNG dãy số mã vạch (cho phép dấu cách/chấm/gạch giữa các chữ số).
2. Mỗi trang lấy số đăng ký GẦN chỗ ghi mã vạch nhất (±300 → ±800 → ±1500 ký tự) — tránh nhầm sang sản phẩm khác
   trên trang liệt kê nhiều thuốc. Mỗi trang một phiếu.
3. Số đăng ký → thuốc trong danh mục 55.005 thuốc (bảng medicine_catalog_regs). Không có số đăng ký → gợi ý theo tiêu đề
   trang (độ tin cậy thấp, người dùng tự chọn).
Chữ trên hộp (ảnh quét OCR) / nội dung mã QR: như trên nhưng "mỏ neo" là TÊN thuốc in nổi bật nhất thay cho mã vạch;
thuốc khớp số đăng ký còn phải có tên trùng chữ trên hộp thì mới nhận.
Thông tin hiển thị lấy từ DANH MỤC chính thức, không lấy từ trang web.
"""
from __future__ import annotations

import re
import unicodedata
from collections import Counter
from collections.abc import Sequence
from dataclasses import dataclass, field
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.catalog import CatalogMedicine, CatalogReg
from app.services.medicine_matcher.catalog import CatalogRepository, strength_display
from app.services.medicine_matcher.matcher import _STOPWORDS, OcrLine, build_evidence
from app.services.medicine_matcher.normalize import clean_cell, find_reg_numbers, fold
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
    """Số đăng ký gần "mỏ neo" (mã vạch/tên thuốc) nhất trên một trang: [(dạng hiển thị, dạng chuẩn)].
    Trang không có mỏ neo (pos=None, ví dụ trang mà mã QR trỏ tới): lấy vài số đầu trang."""
    text = page["text"]
    if page.get("pos") is None:
        return reg_numbers(text)[:3]
    start, end = page["pos"]
    for radius in WINDOWS:
        found = reg_numbers(text[max(0, start - radius): end + radius])
        if found:
            return found
    return []


def title_core(title: str) -> str:
    head = _TITLE_SPLIT.split(title.strip())[0]
    return " ".join(_TITLE_NOISE.sub(" ", head).split())


def match_pages(s: Session, pages: list[dict[str, Any]]) -> dict[str, Any]:
    """→ {ids, by: registration|name|None, reg, votes}: số đăng ký trên trang trước, không có thì theo tiêu đề trang."""
    return match_regs(s, pages) or match_titles(s, pages)


def match_regs(s: Session, pages: list[dict[str, Any]]) -> dict[str, Any] | None:
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
            return {"ids": ids, "by": "registration", "reg": shown[reg_of[ids[0]]], "votes": id_votes[ids[0]],
                    "reg_of": {mid: shown[reg_of[mid]] for mid in ids}, "votes_of": {mid: id_votes[mid] for mid in ids}}
    return None


def match_titles(s: Session, pages: list[dict[str, Any]]) -> dict[str, Any]:
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


def build_info(s: Session, pages: list[dict[str, Any]], match: dict[str, Any], *, lead: str | None = None,
               near: str = "ghi cạnh mã vạch", name_hint: str | None = None, caveat: str | None = None) -> dict[str, Any]:
    """Thông tin hiển thị — lấy từ danh mục khi khớp số đăng ký (nguồn chính thức), không lấy từ trang web.
    lead/near: câu giải thích bằng chứng trong ghi_chu (mặc định cho mã vạch); caveat: câu lưu ý thêm ở cuối.
    name_hint: tên hiển thị khi chỉ có gợi ý theo tên (chữ trên hộp) — mặc định là tiêu đề trang (mã vạch)."""
    n = len(pages)
    lead = lead or f"Mã vạch xuất hiện trên {n} trang"
    tail = f" {caveat}" if caveat else ""
    if match["by"] == "registration":
        row = s.get(CatalogMedicine, match["ids"][0])
        assert row is not None
        strength, _ = strength_display(row)
        return {
            "found": True, "ten_thuoc": clean_cell(row.ten_thuoc), "hoat_chat": clean_cell(row.hoat_chat_chinh), "ham_luong": strength,
            "dang_bao_che": clean_cell(row.dang_bao_che), "quy_cach": clean_cell(row.dong_goi), "so_dang_ky": clean_cell(row.so_dang_ky),
            "nha_san_xuat": clean_cell(row.ten_cong_ty_san_xuat), "nuoc_san_xuat": clean_cell(row.nuoc_san_xuat),
            "do_tin_cay": "cao" if match["votes"] >= 2 else "trung_binh",
            "ghi_chu": f"{lead}; số đăng ký {match['reg']} {near} khớp danh mục Cục Quản lý Dược.{tail}",
        }
    title = name_hint or title_core(pages[0]["title"]) or pages[0]["title"]
    return {
        "found": True, "ten_thuoc": title[:300], "hoat_chat": None, "ham_luong": None, "dang_bao_che": None, "quy_cach": None,
        "so_dang_ky": None, "nha_san_xuat": None, "nuoc_san_xuat": None, "do_tin_cay": "thap",
        "ghi_chu": (f"{lead} nhưng không có số đăng ký khớp danh mục — "
                    + ("các thuốc trong danh mục bên dưới chỉ là gợi ý theo tên, hãy kiểm tra vỏ hộp." if match["ids"]
                       else "không khớp thuốc nào trong danh mục.") + tail),
    }


# --------------------------------------------------------------------------- #
# Tra theo CHỮ: ảnh quét (chữ OCR) hoặc nội dung mã QR không có số đăng ký
# --------------------------------------------------------------------------- #
# Muối/dạng hóa học đi kèm hoạt chất ("amoxicillin trihydrate", "clavulanate potassium") — không dùng làm tên để tìm.
_SALTS = {
    "potassium", "kali", "sodium", "natri", "trihydrate", "trihydrat", "monohydrate", "monohydrat", "dihydrate", "dihydrat",
    "anhydrous", "khan", "hydrochloride", "hydroclorid", "hydrobromide", "hydrobromid", "sulfate", "sulfat", "maleate", "maleat",
    "acetate", "acetat", "phosphate", "phosphat", "succinate", "succinat", "tartrate", "tartrat", "mesylate", "mesilat",
    "besylate", "besilat", "fumarate", "fumarat", "base",
}
_WORD = re.compile(r"[^\W_]+(?:[-'][^\W_]+)*")
_QTY_SHOW = re.compile(r"\d+(?:[.,]\d+)?\s*(?:mcg|µg|μg|mg|g|kg|ml|iu|ui|%)(?![A-Za-z0-9])", re.IGNORECASE)
_BRAND_LINE_MAX_WORDS = 6  # tên thuốc in thành dòng ngắn; câu dài (công dụng, hướng dẫn) không phải tên


@dataclass
class Vocab:
    """Từ có nghĩa lấy từ DANH MỤC: từ đầu tên thương mại (panadol, hapacol…) và từ trong hoạt chất (paracetamol…).
    Chữ OCR không có trong đây ("carton", "recycle", "practice"…) không bao giờ được dùng để tìm."""

    heads: dict[str, int]  # từ đầu tên thuốc → số thuốc
    ingredients: dict[str, int]  # từ trong cột hoạt chất → số thuốc

    def kind(self, token: str) -> str | None:
        """"ingredient" | "brand" | None."""
        if len(token) < 4 or not token.isalpha() or token in _STOPWORDS or token in _SALTS:
            return None
        if self.ingredients.get(token, 0) >= 3:
            return "ingredient"
        if 1 <= self.heads.get(token, 0) <= 150:  # từ đầu của quá nhiều thuốc là từ chung ("nước", "dung dịch"…)
            return "brand"
        return None


def build_vocab(s: Session) -> Vocab:
    heads: Counter[str] = Counter()
    ingredients: Counter[str] = Counter()
    for name, active in s.execute(select(CatalogMedicine.ten_thuoc, CatalogMedicine.hoat_chat_chinh)):
        words = _tokens(name)
        if words:
            heads[words[0]] += 1
        ingredients.update(set(_tokens(active)))
    return Vocab(heads=dict(heads), ingredients=dict(ingredients))


@dataclass
class TextQuery:
    name: str  # tên thương mại như in trên hộp, hoặc hoạt chất khi hộp không có tên thương mại đọc được
    strength: str | None  # "625 mg"
    terms: list[str]  # token đã bỏ dấu; terms[0] = tên thương mại (hoặc hoạt chất chính khi generic)
    regs: list[tuple[str, str]] = field(default_factory=list)  # số đăng ký đọc được trên hộp
    context: set[str] = field(default_factory=set)  # mọi từ của toàn bộ chữ trên hộp — để ưu tiên tên khớp đủ
    generic: bool = False  # True: tìm theo hoạt chất (không đọc được tên thương mại) → chỉ là thuốc CÙNG HOẠT CHẤT

    @property
    def query(self) -> str:
        strength = self.strength
        number = re.match(r"\d+(?:[.,]\d+)?", strength or "")
        if number and re.search(rf"(?<![\d.,]){re.escape(number.group(0))}(?![\d.,])", self.name):
            strength = None  # hàm lượng đã nằm trong tên ("Augmentin 625mg")
        return " ".join(filter(None, [self.name, strength, "số đăng ký"]))

    @property
    def required(self) -> list[str]:
        """Từ trang web PHẢI nhắc tới: tên thương mại; hoặc mọi hoạt chất khi tìm theo hoạt chất."""
        return self.terms[:2] if self.generic else self.terms[:1]


def _terms(text: str) -> list[str]:
    return list(dict.fromkeys(t for t in re.split(r"[^0-9a-z]+", fold(text))
                              if len(t) >= 3 and not t.isdigit() and t not in _STOPWORDS))


def _tokens(text: str | None) -> list[str]:
    return [t for t in re.split(r"[^0-9a-z]+", fold(text)) if t]


_UNITS = {"mg", "g", "mcg", "ug", "ml", "l", "iu", "ui", "kg"}


def _words(text: str | None) -> list[str]:
    """Từ có nghĩa để so tên: tách số khỏi đơn vị ("625mg" → "625"), bỏ đơn vị và từ chỉ dạng bào chế ("tablets", "viên")."""
    split = re.sub(r"(?<=\d)(?=[a-z])|(?<=[a-z])(?=\d)", " ", fold(text))
    return [t for t in re.split(r"[^0-9a-z]+", split) if t and t not in _UNITS and t not in _STOPWORDS and (len(t) >= 2 or t.isdigit())]


def _stem(token: str) -> str:
    """Gốc từ cho hoạt chất viết nhiều kiểu: amoxicilin/amoxicillin → "amoxici", clavulanic/clavulanate → "clavula"."""
    return token[:7] if len(token) >= 8 else token


def _term_regex(token: str) -> str:
    tail = "[a-z]*" if len(token) >= 8 else ""
    return rf"(?<![0-9a-z]){re.escape(_stem(token))}{tail}(?![0-9a-z])"


def _all_known(text: str, vocab: Vocab) -> bool:
    """Mọi chữ có nghĩa (≥ 3 chữ cái) trong dòng đều là tên thuốc/hoạt chất trong danh mục."""
    words = [t for t in (re.sub(r"[^0-9a-z]", "", fold(w)) for w in _WORD.findall(text))
             if t.isalpha() and len(t) >= 3 and t not in _STOPWORDS]
    return bool(words) and all(vocab.kind(t) for t in words)


def text_query(lines: Sequence[OcrLine], vocab: Vocab) -> TextQuery | None:
    """Câu tìm kiếm từ chữ trên hộp, chỉ dùng chữ có trong danh mục:
    1. Tên thương mại (từ đầu tên thuốc trong danh mục) trên một dòng ngắn — ưu tiên dòng giống-tên, chữ to.
    2. Không có → hoạt chất (tối đa 2) + hàm lượng: ảnh chụp mặt sau/mặt bên ("Each caplet contains PARACETAMOL 500 mg").
    3. Không có gì → None (không tốn lượt tìm kiếm cho chữ vô nghĩa)."""
    ev = build_evidence(lines)
    all_text = "\n".join(ln.raw for ln in ev.lines)
    regs = reg_numbers(all_text)
    context = set(_words(all_text))
    first_qty = ev.quantity_texts[0] if ev.quantity_texts else None
    candidates: list[tuple[tuple[bool, float, int], int, int, list[tuple[str, str]]]] = []  # (ưu tiên, dòng, số chữ, tên)
    ingredients: list[tuple[str, str]] = []  # (token, chữ như in)
    for idx, ln in enumerate(ev.lines):
        words = [(w, re.sub(r"[^0-9a-z]", "", fold(w))) for w in _WORD.findall(ln.raw)]
        for w, t in words:
            # Hoạt chất: tên quốc tế viết chữ Latin không dấu (paracetamol, amoxicillin). Chữ tiếng Việt có dấu trùng tên
            # dược liệu ("Trường", "Hoàng"…) là chữ thường gặp → không coi là hoạt chất.
            if (vocab.kind(t) == "ingredient" and len(t) >= 5 and w.isascii()
                    and not any(_stem(t) == _stem(x) for x, _ in ingredients)):
                ingredients.append((t, w))
        if len(words) <= _BRAND_LINE_MAX_WORDS:
            brands = [(w, t) for w, t in words if vocab.kind(t) == "brand"]
            if brands:
                candidates.append(((ln.name_like, ln.prominence, -idx), idx, len(words), brands))
    if ingredients:  # có hoạt chất → tên thương mại phải in thành nhãn ngắn ("Panadol Extra"), không lấy chữ trong câu
        candidates = [c for c in candidates if c[2] <= 3]  # ("• Muscular aches • Period pain" ≠ thuốc "Pain…")
    if candidates:
        _, idx, _, brands = max(candidates, key=lambda c: c[0])
        ln = ev.lines[idx]
        raw = " ".join(ln.raw.split())
        # Giữ nguyên cả dòng ("Panadol Extra", "Hapacol 250") khi mọi chữ đều có trong danh mục; dòng lẫn chữ khác
        # ("taking Panadol.", "Thuốc kháng sinh Augmentin của GSK") thì chỉ lấy tên thuốc.
        name = raw if len(raw) <= 30 and _all_known(raw, vocab) else " ".join(dict.fromkeys(w for w, _ in brands))
        # Tên in thành hai dòng ("PANADOL" / "EXTRA"): ghép dòng kế tiếp khi nó cũng in to, ngắn, không có số và có trong danh mục.
        if len(name.split()) == 1 and idx + 1 < len(ev.lines):
            nxt_ln = ev.lines[idx + 1]
            nxt = " ".join(nxt_ln.raw.split())
            if (nxt_ln.name_like and len(nxt) <= 20 and len(nxt.split()) <= 2 and not any(ch.isdigit() for ch in nxt)
                    and nxt_ln.prominence >= 0.6 * ln.prominence and _all_known(nxt, vocab)):
                name = f"{name} {nxt}"
        line_qty = _QTY_SHOW.search(ln.raw)
        terms = list(dict.fromkeys([t for _, t in brands] + [t for t, _ in ingredients]))
        return TextQuery(name=name[:80], strength=line_qty.group(0) if line_qty else first_qty, terms=terms[:4], regs=regs,
                         context=context)
    if ingredients:
        top = ingredients[:2]
        return TextQuery(name=" ".join(w for _, w in top), strength=first_qty, terms=[t for t, _ in top], regs=regs,
                         context=context, generic=True)
    if regs:
        return TextQuery(name=regs[0][0], strength=None, terms=[], regs=regs, context=context)
    return None


def _fold_same_length(text: str) -> str:
    """Bỏ dấu + chữ thường nhưng GIỮ NGUYÊN độ dài (mỗi ký tự → một ký tự) để vị trí khớp dùng lại trên văn bản gốc."""
    out = []
    for ch in text:
        base = "d" if ch in "đĐ" else unicodedata.normalize("NFD", ch)[:1]
        out.append(base.lower()[:1] or " ")
    return "".join(out)


def text_pages(results: list[SearchResult], q: TextQuery) -> list[dict[str, Any]]:
    """Các trang có nhắc tới thuốc này (tên thương mại, hoặc đủ hoạt chất, hoặc đúng số đăng ký trên hộp),
    kèm vị trí tên trên trang làm "mỏ neo" để lấy số đăng ký gần nhất."""
    pages: list[dict[str, Any]] = []
    seen: set[str] = set()
    for r in results:
        if r.url in seen:
            continue
        text = "\n".join(filter(None, [r.title, r.content, r.raw_content]))
        folded = _fold_same_length(text)
        hits = [re.search(_term_regex(t), folded) for t in q.required]
        pos: tuple[int, int] | None = None
        if q.required and all(hits):
            first = hits[0]
            assert first is not None
            pos = (first.start(), first.end())
        elif q.regs:
            m = re.search(r"[\s.\-]?".join(re.escape(ch) for ch in q.regs[0][0] if ch.isalnum()), text, re.IGNORECASE)
            pos = (m.start(), m.end()) if m else None
        if pos is None:
            continue
        seen.add(r.url)
        pages.append({"title": r.title.strip() or r.url, "url": r.url, "text": text, "pos": pos})
    return pages


def _name_ok(row: CatalogMedicine, q: TextQuery) -> bool:
    """Thuốc tìm được phải đúng là thuốc trên hộp:
    - có tên thương mại → tên trong danh mục phải chứa đúng tên đó; trùng hoạt chất thôi là chưa đủ (Augmentin và Imefed
      cùng amoxicillin + acid clavulanic nhưng là hai thuốc khác nhau);
    - tìm theo hoạt chất → thuốc phải có đủ các hoạt chất đó."""
    if not q.terms:
        return True
    if q.generic:
        have = {_stem(t) for t in _tokens(" ".join(filter(None, [row.hoat_chat_chinh, row.ten_thuoc])))}
        return all(_stem(t) in have for t in q.required)
    return q.terms[0] in _tokens(row.ten_thuoc)


def _coverage(row: CatalogMedicine, q: TextQuery) -> float:
    """Tỉ lệ chữ trong tên danh mục có in trên hộp: "Hapacol 250" = 1.0, "Hapacol 250 flu" = 0.67 với hộp "Hapacol 250"."""
    words = _words(row.ten_thuoc)
    return sum(w in q.context for w in words) / len(words) if words and q.context else 0.0


def match_text_pages(s: Session, pages: list[dict[str, Any]], q: TextQuery) -> dict[str, Any]:
    """Như match_pages nhưng thuốc (theo số đăng ký hoặc theo tiêu đề trang) phải đúng thuốc trên hộp (_name_ok) —
    số đăng ký gần tên trên trang có thể là của thuốc khác (trang liệt kê nhiều sản phẩm). Ưu tiên tên khớp đủ chữ trên hộp.
    Độ tin cậy "cao" chỉ khi: có tên thương mại, tên danh mục khớp đủ chữ trên hộp và ≥ 2 trang cùng chỉ một số đăng ký."""
    repo = CatalogRepository(s)
    for match in (match_regs(s, pages), match_titles(s, pages)):
        if not match or not match["ids"]:
            continue
        rows = {row.id: row for row in repo.get_many(match["ids"])}
        ids = [mid for mid in match["ids"] if mid in rows and _name_ok(rows[mid], q)]
        if not ids:
            continue
        cover = {mid: _coverage(rows[mid], q) for mid in ids}
        ids.sort(key=lambda mid: -cover[mid])  # sort ổn định: cùng độ phủ thì giữ thứ tự theo số phiếu
        if match["by"] == "registration":
            votes = match["votes_of"][ids[0]]
            if q.generic or cover[ids[0]] < 1.0:
                votes = min(1, votes)
            return {**match, "ids": ids, "reg": match["reg_of"][ids[0]], "votes": votes}
        return {**match, "ids": ids}
    return {"ids": [], "by": None, "reg": None, "votes": 0}
