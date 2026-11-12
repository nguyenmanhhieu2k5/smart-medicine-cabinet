"""Chuẩn hóa văn bản thuốc: tên, hàm lượng, số đăng ký, dạng bào chế.

Mọi phép so khớp (tìm kiếm thủ công lẫn đối chiếu OCR) đều đi qua module này
để hai phía — dữ liệu Excel và văn bản người dùng/OCR — được đưa về cùng dạng.

Ví dụ:
    "PARACETAMOL 500 MG", "Paracetamol-500mg", "paracetamol 500mg"
    đều cho ``normalize_text`` == "paracetamol 500mg".
"""
from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass
from typing import Iterable

# Giá trị giữ chỗ trong Excel được xem là "không có dữ liệu".
PLACEHOLDERS = {"", "-", "--", "---", "n/a", "na", "null", "none", "nan", "không", "khong", "."}


def clean_cell(value: object) -> str | None:
    """Trả về chuỗi hiển thị gọn (gộp khoảng trắng) hoặc None nếu ô trống/giữ chỗ."""
    if value is None:
        return None
    text = " ".join(str(value).split())
    if text.lower() in PLACEHOLDERS:
        return None
    return text


# --------------------------------------------------------------------------- #
# Gấp Unicode
# --------------------------------------------------------------------------- #
_EXTRA_FOLD = str.maketrans({"đ": "d", "Đ": "d", "ð": "d", "ł": "l", "ø": "o", "ß": "ss", "æ": "ae", "œ": "oe"})


def fold(text: str | None) -> str:
    """Chữ thường, bỏ dấu tiếng Việt, gấp ký tự tương thích (NFKC)."""
    if not text:
        return ""
    t = unicodedata.normalize("NFKC", str(text)).lower()
    t = t.replace("µ", "μ")
    t = unicodedata.normalize("NFD", t)
    t = "".join(ch for ch in t if unicodedata.category(ch) != "Mn")
    return t.translate(_EXTRA_FOLD)


# --------------------------------------------------------------------------- #
# Số và đơn vị
# --------------------------------------------------------------------------- #
_THOUSANDS_DOT = re.compile(r"(?<![\d.,])\d{1,3}(?:\.\d{3}){2,}(?![\d.,])")
_THOUSANDS_COMMA = re.compile(r"(?<![\d.,])\d{1,3}(?:,\d{3}){2,}(?![\d.,])")
_THOUSANDS_IU = re.compile(r"(?<![\d.,])(\d{1,3})[.,](\d{3})(?=\s*(?:iu|ui|dvqt|cfu)\b)")
# Trong dữ liệu nguồn, "1.000mg", "1.680mg", "2.340mg" dùng dấu chấm ngăn cách hàng nghìn
# (số thập phân viết bằng dấu phẩy). Phần nguyên bằng 0 ("0.125 mg") vẫn là số thập phân.
_THOUSANDS_MASS = re.compile(r"(?<![\d.,])([1-9]\d{0,2})\.(\d{3})(?=\s*(?:mg|mcg|g|ml)\b)")
_DECIMAL_COMMA = re.compile(r"(?<=\d),(?=\d)")
_SPACED_UNITS = [
    (re.compile(r"\bi\s*\.\s*u\b\.?"), "iu"),
    (re.compile(r"\bu\s*\.\s*i\b\.?"), "iu"),
    (re.compile(r"\bm\s*\.\s*i\s*\.\s*u\b\.?"), "miu"),
    (re.compile(r"\bđvqt\b|\bdvqt\b|\bd\.v\.q\.t\b\.?"), "iu"),
    (re.compile(r"μg|\bug\b|\bmicrograms?\b|\bmicrogam\b"), "mcg"),
    (re.compile(r"\bmilligrams?\b|\bmiligam\b|\bmiligram\b"), "mg"),
    (re.compile(r"\bmililit\b|\bmilliliters?\b|\bmillilitres?\b"), "ml"),
]

# (mẫu đơn vị, tên chuẩn, đại lượng, hệ số về đơn vị gốc)
_UNITS: dict[str, tuple[str, str, float]] = {
    "ng": ("mg", "mass", 1e-6),
    "mcg": ("mg", "mass", 1e-3),
    "mg": ("mg", "mass", 1.0),
    "g": ("mg", "mass", 1e3),
    "gam": ("mg", "mass", 1e3),
    "gram": ("mg", "mass", 1e3),
    "gr": ("mg", "mass", 1e3),
    "kg": ("mg", "mass", 1e6),
    "mcl": ("ml", "volume", 1e-3),
    "ml": ("ml", "volume", 1.0),
    "l": ("ml", "volume", 1e3),
    "lit": ("ml", "volume", 1e3),
    "iu": ("iu", "iu", 1.0),
    "ui": ("iu", "iu", 1.0),
    "miu": ("iu", "iu", 1e6),
    "mui": ("iu", "iu", 1e6),
    "%": ("%", "percent", 1.0),
}
_UNIT_ALT = "|".join(sorted((re.escape(u) for u in _UNITS), key=len, reverse=True))
_QTY_RE = re.compile(rf"(?<![a-z0-9.,])(\d+(?:\.\d+)?)\s*({_UNIT_ALT})(?![a-z0-9])")
_GLUE_RE = re.compile(rf"(\d)\s+({_UNIT_ALT})(?![a-z0-9])")
_BARE_NUM_RE = re.compile(r"(?<![a-z0-9.])(\d+(?:\.\d+)?)(?![a-z0-9.%])")


def _normalize_numbers(t: str) -> str:
    t = _THOUSANDS_DOT.sub(lambda m: m.group(0).replace(".", ""), t)
    t = _THOUSANDS_COMMA.sub(lambda m: m.group(0).replace(",", ""), t)
    t = _THOUSANDS_IU.sub(r"\1\2", t)
    t = _THOUSANDS_MASS.sub(r"\1\2", t)
    return _DECIMAL_COMMA.sub(".", t)


def _prepare(text: str | None) -> str:
    """Gấp Unicode + chuẩn hóa số + bí danh đơn vị (chưa bỏ dấu câu)."""
    t = fold(text)
    if not t:
        return ""
    for pattern, repl in _SPACED_UNITS:
        t = pattern.sub(repl, t)
    return _normalize_numbers(t)


def normalize_text(text: str | None) -> str:
    """Dạng chuẩn dùng để so khớp/tìm kiếm.

    - bỏ dấu, chữ thường, gộp khoảng trắng, bỏ dấu câu;
    - số thập phân dùng dấu chấm (31,25 → 31.25);
    - số dính liền đơn vị ("500 MG" → "500mg").
    """
    t = _prepare(text)
    if not t:
        return ""
    t = _GLUE_RE.sub(r"\1\2", t)
    t = re.sub(r"[^a-z0-9.%]+", " ", t)
    t = re.sub(r"(?<!\d)\.|\.(?!\d)", " ", t)
    return " ".join(t.split())


def _fmt_number(value: float) -> str:
    if abs(value - round(value)) < 1e-9:
        return str(int(round(value)))
    return f"{value:.6g}"


@dataclass(frozen=True)
class Quantity:
    """Một đại lượng đã quy đổi: 0,5 g → value=500, unit='mg', dim='mass'."""

    value: float
    unit: str
    dim: str
    written: str  # số như được viết (trước quy đổi), ví dụ "0.5"

    @property
    def token(self) -> str:
        return f"{_fmt_number(self.value)}{self.unit}"


def parse_quantities(text: str | None) -> list[Quantity]:
    """Trích mọi đại lượng có đơn vị (mg, g, mcg, ml, IU, %) trong văn bản."""
    t = _prepare(text)
    out: list[Quantity] = []
    for m in _QTY_RE.finditer(t):
        unit, dim, factor = _UNITS[m.group(2)]
        try:
            raw = float(m.group(1))
        except ValueError:  # pragma: no cover - regex đã bảo đảm
            continue
        out.append(Quantity(value=round(raw * factor, 9), unit=unit, dim=dim, written=_fmt_number(raw)))
    return out


def strength_tokens(*texts: str | None) -> list[str]:
    """Danh sách token hàm lượng chuẩn, duy nhất, giữ thứ tự xuất hiện."""
    seen: dict[str, None] = {}
    for text in texts:
        for q in parse_quantities(text):
            seen.setdefault(q.token, None)
    return list(seen)


def bare_numbers(text: str | None) -> list[str]:
    """Các số đứng riêng, không kèm đơn vị (vd "Paracetamol 500", "Hezepril 10")."""
    t = _prepare(text)
    t = _QTY_RE.sub(" ", t)
    out: dict[str, None] = {}
    for m in _BARE_NUM_RE.finditer(t):
        try:
            out.setdefault(_fmt_number(float(m.group(1))), None)
        except ValueError:  # pragma: no cover
            continue
    return list(out)


# --------------------------------------------------------------------------- #
# Lỗi OCR thường gặp
# --------------------------------------------------------------------------- #
_OCR_DIGIT_MAP = str.maketrans({"o": "0", "O": "0", "l": "1", "I": "1", "i": "1", "s": "5", "S": "5", "b": "8", "B": "8", "z": "2", "Z": "2"})
_OCR_NUM_UNIT = re.compile(
    r"(?<![A-Za-z0-9])([0-9oOlIiSsBbZz][0-9oOlIiSsBbZz.,]*)(\s*)(mg|mcg|ml|g|iu|ui|kg|%)(?![A-Za-z0-9])",
    re.IGNORECASE,
)
_OCR_UNIT_TYPOS = [
    (re.compile(r"(?<=\d)\s*rng\b", re.IGNORECASE), "mg"),
    (re.compile(r"(?<=\d)\s*m[q9]\b", re.IGNORECASE), "mg"),
    (re.compile(r"(?<=\d)\s*n[ig]g\b", re.IGNORECASE), "mg"),
    (re.compile(r"(?<=\d)\s*m[1I]\b"), "ml"),
]
_OCR_LETTER_MAP = {"0": "o", "1": "l", "5": "s", "8": "b"}
_OCR_DIGIT_IN_WORD = re.compile(r"(?<=[A-Za-zÀ-ỹ]{2})([0158])(?=[A-Za-zÀ-ỹ])")
_LETTERS_THEN_DIGITS = re.compile(r"([A-Za-zÀ-ỹ]{3,})(\d{2,})")


def fix_ocr_text(text: str | None) -> str:
    """Sửa các lỗi OCR phổ biến *chỉ* trong ngữ cảnh an toàn.

    - "5OOmg", "l00 mg", "S00mg" → "500mg", "100 mg", "500mg";
    - "500rng", "500mq" → "500mg";
    - "Paracetam0l" → "Paracetamol";
    - "Paracetamol500" → "Paracetamol 500".
    Chỉ áp dụng cho văn bản OCR, không áp dụng cho dữ liệu Excel.
    """
    if not text:
        return ""
    t = str(text)
    for pattern, repl in _OCR_UNIT_TYPOS:
        t = pattern.sub(repl, t)

    def _num(m: re.Match[str]) -> str:
        number, space, unit = m.group(1), m.group(2), m.group(3)
        if not any(ch.isdigit() for ch in number):
            return m.group(0)  # không có chữ số thật → không đoán
        return number.translate(_OCR_DIGIT_MAP) + space + unit

    t = _OCR_NUM_UNIT.sub(_num, t)
    t = _OCR_DIGIT_IN_WORD.sub(lambda m: _OCR_LETTER_MAP[m.group(1)], t)
    t = _LETTERS_THEN_DIGITS.sub(r"\1 \2", t)
    return t


# --------------------------------------------------------------------------- #
# Số đăng ký
# --------------------------------------------------------------------------- #
def normalize_reg(text: str | None) -> str:
    """Số đăng ký về dạng chỉ gồm chữ hoa và số: "VN-20169-16" → "VN2016916"."""
    t = fold(text).upper()
    return re.sub(r"[^A-Z0-9]", "", t)


_REG_SPLIT = re.compile(r"[()\[\];,/]|\s{2,}")
_REG_DIGITS12 = re.compile(r"(?<!\d)(\d{11,12})(?!\d)")
# Nhóm sau dấu gạch cho phép lẫn chữ vì OCR hay đọc 0→O, 1→I/L, 5→S ("VN-2O169-16").
_REG_DASHED = re.compile(
    r"(?<![A-Z0-9])([A-Z]{1,4}\d{0,4}(?:\s*[-–—.]\s*[A-Z0-9]{1,6}){1,4})(?![A-Z0-9])"
)


def split_reg_field(value: str | None) -> list[str]:
    """Tách ô số đăng ký có thể chứa nhiều số: "8931… (VD-28817-18)" → 2 số."""
    if not value:
        return []
    out: dict[str, None] = {}
    for part in _REG_SPLIT.split(str(value)):
        norm = normalize_reg(part)
        if len(norm) >= 5 and any(ch.isdigit() for ch in norm):
            out.setdefault(norm, None)
    return list(out)


def find_reg_numbers(text: str | None) -> list[tuple[str, str]]:
    """Tìm các chuỗi có dạng số đăng ký lưu hành trong văn bản OCR.

    Trả về [(dạng đọc được, dạng chuẩn)]. Hỗ trợ dạng 12 chữ số
    (893110205525) và dạng có gạch (VN-20169-16, VD-34703-20,
    QLSP-H03-1172-19, V1523-H12-10, GC-123-45…).
    """
    if not text:
        return []
    t = fold(text).upper()
    # Bỏ khoảng trắng chèn giữa các nhóm chữ số ("8931 1020 5525").
    t = re.sub(r"(?<=\d) (?=\d{3,})", "", t)
    out: dict[str, str] = {}
    for m in _REG_DIGITS12.finditer(t):
        out.setdefault(m.group(1), m.group(1))
    for m in _REG_DASHED.finditer(t):
        norm = normalize_reg(m.group(1))
        digits = sum(ch.isdigit() for ch in norm)
        letters = sum(ch.isalpha() for ch in norm)
        if 6 <= len(norm) <= 18 and digits >= 4 and letters >= 1:
            shown = re.sub(r"\s*[-–—.]\s*", "-", m.group(1)).replace(" ", "")
            out.setdefault(norm, shown)
    return [(shown, norm) for norm, shown in out.items()]


def extract_reg_numbers(text: str | None) -> list[str]:
    """Dạng chuẩn của các số đăng ký tìm thấy trong văn bản."""
    return [norm for _, norm in find_reg_numbers(text)]


def reg_ocr_variants(reg_norm: str) -> list[str]:
    """Biến thể sửa lỗi OCR cho số đăng ký (O↔0, I/L↔1, S↔5, B↔8) ở phần số."""
    variants: dict[str, None] = {reg_norm: None}
    m = re.match(r"^([A-Z]{1,4})(.*)$", reg_norm)
    if m:
        head, tail = m.group(1), m.group(2)
        fixed_tail = tail.translate(str.maketrans({"O": "0", "I": "1", "L": "1", "S": "5", "B": "8", "Z": "2"}))
        variants.setdefault(head + fixed_tail, None)
        fixed_head = head.translate(str.maketrans({"0": "O", "1": "I", "5": "S", "8": "B"}))
        variants.setdefault(fixed_head + fixed_tail, None)
    else:
        variants.setdefault(reg_norm.translate(str.maketrans({"O": "0", "I": "1", "L": "1", "S": "5", "B": "8"})), None)
    return list(variants)


# --------------------------------------------------------------------------- #
# Dạng bào chế
# --------------------------------------------------------------------------- #
_FORM_PATTERNS: list[tuple[re.Pattern[str], frozenset[str]]] = [
    (re.compile(r"\bvien nen (dai )?bao phim\b|\bvien bao phim\b|\bfilm ?coated\b|\bf c tablets?\b"), frozenset({"tablet", "film_coated"})),
    (re.compile(r"\bbao duong\b|\bsugar ?coated\b"), frozenset({"tablet", "sugar_coated"})),
    (re.compile(r"\bbao tan trong ruot\b|\benteric\b|\bgastro ?resistant\b"), frozenset({"enteric"})),
    (re.compile(r"\bvien (nen )?sui\b|\bsui bot\b|\beffervescent\b"), frozenset({"effervescent"})),
    (re.compile(r"\bphan tan\b|\bdispersible\b|\borodispersible\b"), frozenset({"dispersible"})),
    (re.compile(r"\bvien nen\b|\bvien nhai\b|\btablets?\b|\bcaplets?\b|\btabs?\b"), frozenset({"tablet"})),
    (re.compile(r"\bvien nang cung\b|\bhard capsules?\b"), frozenset({"capsule", "hard"})),
    (re.compile(r"\bvien nang mem\b|\bsoft ?gels?\b|\bsoft capsules?\b"), frozenset({"capsule", "soft"})),
    (re.compile(r"\bvien nang\b|\bcapsules?\b|\bcaps\b"), frozenset({"capsule"})),
    (re.compile(r"\bsi ?ro\b|\bsyrup\b|\bsirop\b"), frozenset({"syrup"})),
    (re.compile(r"\bhon dich\b|\bsuspension\b"), frozenset({"suspension"})),
    (re.compile(r"\bdung dich\b|\bsolution\b"), frozenset({"solution"})),
    (re.compile(r"\bnhu tuong\b|\bemulsion\b"), frozenset({"emulsion"})),
    (re.compile(r"\btiem\b|\binjection\b|\binjectable\b|\binfusion\b|\btruyen\b"), frozenset({"injection"})),
    (re.compile(r"\bnho mat\b|\beye drops?\b|\bophthalmic\b"), frozenset({"eye"})),
    (re.compile(r"\bnho mui\b|\bxit mui\b|\bnasal\b"), frozenset({"nasal"})),
    (re.compile(r"\bnho tai\b|\bear drops?\b"), frozenset({"ear"})),
    (re.compile(r"\bkem\b|\bcream\b"), frozenset({"cream"})),
    (re.compile(r"\bgel\b"), frozenset({"gel"})),
    (re.compile(r"\bthuoc mo\b|\bmo boi\b|\bointment\b"), frozenset({"ointment"})),
    (re.compile(r"\bthuoc bot\b|\bbot pha\b|\bbot dong kho\b|\bpowder\b|^bot\b"), frozenset({"powder"})),
    (re.compile(r"\bthuoc com\b|\bcom pha\b|\bcom sui\b|\bcom tan\b|\bgranules?\b|^com\b"), frozenset({"granule"})),
    (re.compile(r"\bvien dat\b|\bthuoc dan\b|\bsuppositor"), frozenset({"suppository"})),
    (re.compile(r"\bxit\b|\bspray\b|\bkhi dung\b|\binhal"), frozenset({"spray"})),
    (re.compile(r"\bmieng dan\b|\bpatch\b"), frozenset({"patch"})),
    (re.compile(r"\bcao long\b|\bcao kho\b|\bcao dac\b"), frozenset({"extract"})),
    (re.compile(r"\bnguyen lieu\b"), frozenset({"raw_material"})),
]

_FORM_CLASS = {
    "tablet": "solid_oral", "capsule": "solid_oral", "effervescent": "solid_oral", "dispersible": "solid_oral",
    "syrup": "liquid_oral", "suspension": "liquid", "solution": "liquid", "emulsion": "liquid",
    "injection": "injection", "eye": "eye", "nasal": "nasal", "ear": "ear",
    "cream": "topical", "gel": "topical", "ointment": "topical", "patch": "topical",
    "powder": "powder", "granule": "powder", "suppository": "suppository", "spray": "spray",
    "extract": "extract", "raw_material": "raw_material",
}


def form_tags(text: str | None) -> frozenset[str]:
    """Nhãn dạng bào chế nhận ra từ văn bản (tiếng Việt hoặc tiếng Anh)."""
    t = normalize_text(text)
    if not t:
        return frozenset()
    tags: set[str] = set()
    for pattern, found in _FORM_PATTERNS:
        if pattern.search(t):
            tags |= found
    return frozenset(tags)


def form_classes(tags: Iterable[str]) -> frozenset[str]:
    return frozenset(_FORM_CLASS[t] for t in tags if t in _FORM_CLASS)


# --------------------------------------------------------------------------- #
# Tên thuốc và hoạt chất
# --------------------------------------------------------------------------- #
_NAME_NOISE = {
    "tablets", "tablet", "tabs", "tab", "capsules", "capsule", "caps", "injection", "syrup", "cream",
    "vien", "nen", "nang", "bao", "phim", "sui", "thuoc", "forte", "new", "plus",
}
_NAME_KEEP = {"forte", "new", "plus"}  # là một phần phân biệt của tên thương mại


def name_core(text: str | None) -> str:
    """Phần chữ của tên thuốc: bỏ hàm lượng, số rời và từ chỉ dạng bào chế.

    "Augmentin 625mg tablets" → "augmentin"; "Paracetamol 500" → "paracetamol".
    Nếu bỏ hết thì giữ nguyên dạng chuẩn để không mất tên.
    """
    norm = normalize_text(text)
    if not norm:
        return ""
    kept: list[str] = []
    for tok in norm.split():
        if _QTY_RE.fullmatch(tok) or re.fullmatch(r"[\d.]+%?", tok):
            continue
        if tok in _NAME_NOISE and tok not in _NAME_KEEP:
            continue
        kept.append(tok)
    return " ".join(kept) if kept else norm


_PAREN = re.compile(r"\([^()]*\)")
_ING_SPLIT = re.compile(r"[;,+/]|\bva\b|\band\b|\s-\s")
_ING_STOP = re.compile(
    r"\b(moi|mot|vien|goi|lo|ong|tuyp|chai|chua|hoat chat|thanh phan|tuong duong|tuong ung|duoi dang|"
    r"voi|cho|sau khi|hoan nguyen|hon dich|dung dich|thuoc|duoc lieu|cao|kho|long|chiet xuat tu|ty le|"
    r"nen|nang|cung|mem|bao phim|tablet|capsule|each|contains|as|equivalent to|eq to)\b"
)


def ingredient_names(text: str | None, limit: int = 6) -> list[str]:
    """Tách tên hoạt chất từ ô `hoatChatChinh` (bỏ hàm lượng và phần chú thích)."""
    if not text:
        return []
    t = _prepare(text)
    for _ in range(3):  # ngoặc lồng nhau
        t = _PAREN.sub(" ", t)
    t = t.replace("(", " ").replace(")", " ")
    if ":" in t:
        head, _, tail = t.partition(":")
        if len(tail.strip()) >= 3:
            t = tail
    out: dict[str, None] = {}
    for part in _ING_SPLIT.split(t):
        part = _QTY_RE.sub(" ", part)
        part = re.sub(r"[^a-z\s-]+", " ", part)
        part = _ING_STOP.sub(" ", part)
        part = " ".join(part.replace("-", " ").split())
        if len(part.replace(" ", "")) >= 4:
            out.setdefault(part, None)
        if len(out) >= limit:
            break
    return list(out)


# --------------------------------------------------------------------------- #
# FTS
# --------------------------------------------------------------------------- #
def fts_safe(text: str) -> str:
    """Biến token chứa '.' hoặc '%' thành dạng FTS5 lập chỉ mục nguyên vẹn."""
    return text.replace(".", "p").replace("%", "pct")


def parse_shelf_life_months(text: str | None) -> int | None:
    """"36 tháng" hoặc "36" → 36; "2 năm" → 24. Không đoán khi không rõ."""
    t = fold(text)
    if not t:
        return None
    m = re.search(r"(\d{1,3})\s*(thang|nam|months?|years?)?", t)
    if not m:
        return None
    value = int(m.group(1))
    unit = m.group(2) or "thang"
    if unit.startswith(("nam", "year")):
        value *= 12
    return value if 0 < value <= 240 else None
