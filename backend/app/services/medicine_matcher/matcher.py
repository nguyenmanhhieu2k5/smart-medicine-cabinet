"""Đối chiếu văn bản OCR với danh mục thuốc và xếp hạng ứng viên.

Thiết kế:
    1. Trích bằng chứng từ các dòng OCR: số đăng ký, hàm lượng, dạng bào chế,
       các dòng "giống tên thuốc".
    2. Truy xuất ứng viên qua chỉ mục (số đăng ký → FTS từ → FTS trigram).
    3. Chấm điểm từng ứng viên theo các thành phần độc lập, có giải thích:
       số đăng ký, tên, hàm lượng, hoạt chất, dạng bào chế, nhà sản xuất.
    4. Quyết định mức chắc chắn. Kết quả KHÔNG BAO GIỜ được tự động lưu —
       người dùng luôn phải xác nhận.

Điểm trả về là "mức độ phù hợp" (0–100) tính từ quy tắc bên dưới, không phải
xác suất đã hiệu chuẩn.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any, Sequence

from rapidfuzz import fuzz

from app.models.catalog import CatalogMedicine
from app.services.medicine_matcher.catalog import CatalogRepository, medicine_summary
from app.services.medicine_matcher.normalize import (
    bare_numbers,
    clean_cell,
    find_reg_numbers,
    fix_ocr_text,
    form_classes,
    form_tags,
    ingredient_names,
    name_core,
    normalize_reg,
    normalize_text,
    parse_quantities,
    split_reg_field,
    strength_tokens,
)

# Trọng số các thành phần (tổng = 1). Chỉ thành phần *quan sát được* mới tham gia.
WEIGHTS: dict[str, float] = {
    "registration": 0.35,
    "name": 0.30,
    "strength": 0.20,
    "ingredient": 0.10,
    "form": 0.05,
}
MANUFACTURER_BONUS = 3.0  # điểm cộng nhỏ để tách các bản ghi trùng tên/hàm lượng
LABELS = {
    "registration": "Số đăng ký",
    "name": "Tên thuốc",
    "strength": "Hàm lượng",
    "ingredient": "Hoạt chất",
    "form": "Dạng bào chế",
    "manufacturer": "Nhà sản xuất",
}

NAME_SIM_FLOOR = 60.0  # độ giống tên dưới mức này được tính là 0
NAME_SIM_MIN = 75.0  # dưới mức này (và không trùng số đăng ký) thì không coi là ứng viên
COVERAGE_BASE = 0.55
COVERAGE_FULL = 0.60  # tổng trọng số bằng chứng để đạt điểm tối đa
CONFIDENT_MIN_SCORE = 80.0
CONFIDENT_MIN_MARGIN = 5.0
SAME_PRODUCT_MARGIN = 15.0  # hai bản ghi cùng sản phẩm cách nhau dưới mức này thì coi là "trùng"
NO_MATCH_BELOW = 45.0
MAX_CANDIDATES = 3

UNCERTAIN_MESSAGE = "Chưa thể xác định chắc chắn. Vui lòng chọn đúng thuốc."
CONFIDENT_MESSAGE = "Tìm thấy ứng viên phù hợp. Vui lòng kiểm tra và xác nhận trước khi lưu."
NO_MATCH_MESSAGE = "Không tìm thấy thuốc phù hợp trong danh mục. Bạn có thể tìm thủ công."

# Dòng chữ trên bao bì thường KHÔNG phải tên thuốc.
_BOILERPLATE = re.compile(
    r"\b(hop \d|\d+ vi\b|vi x|x \d+ vien|\d+ vien|\d+ goi|\d+ ong|chai \d|lo \d|tuyp \d|"
    r"sdk|so dk|so dang ky|reg no|visa|so lo|lot|batch|nsx|hsd|exp|mfg|mfd|han dung|han su dung|ngay san xuat|"
    r"bao quan|nhiet do|de xa tam tay|tam tay tre em|doc ky|huong dan su dung|thanh phan|cong thuc|chi dinh|"
    r"chong chi dinh|lieu dung|lieu luong|cach dung|tac dung phu|than trong|san xuat tai|san xuat boi|nha san xuat|"
    r"manufactured|manufacturer|distributed|cong ty|company|co ltd|ltd|jsc|dia chi|address|thuoc ban theo don|"
    r"thuoc ke don|thuoc khong ke don|prescription|gmp|who|tieu chuan|tccs|www|http|tel|fax|dien thoai|hotline|"
    r"composition|indications|dosage|storage|store|keep out|read the|each|contains|moi vien|ta duoc|excipients|"
    r"made in|xuat xu|ma vach|barcode)\b"
)
_STOPWORDS = {
    "hop", "vien", "nen", "nang", "bao", "phim", "thuoc", "moi", "chua", "cung", "mem", "dung", "dich", "uong",
    "tiem", "truyen", "tablets", "tablet", "capsules", "capsule", "film", "coated", "the", "and", "for", "with",
    "duoc", "pham", "cong", "ty", "san", "xuat", "viet", "nam", "ltd", "pharma", "pharmaceutical",
    "pharmaceuticals", "company", "limited", "co", "tnhh", "phan", "each", "contains", "oral", "use", "only",
    "bot", "pha", "hon", "siro", "kem", "gel", "acid", "sodium", "natri", "kali", "hydroclorid", "hydrochloride",
}
_COMPANY_NOISE = re.compile(
    r"\b(cong ty|co phan|tnhh|trach nhiem huu han|duoc pham|duoc|pharmaceuticals?|pharma|laboratories|laboratory|"
    r"labs?|ltd|limited|inc|corp|corporation|co|gmbh|ag|sa|s\.?a\.?s?|pvt|private|plc|jsc|company|industries|"
    r"chi nhanh|nha may|san xuat|xuat nhap khau|thuong mai|mot thanh vien|mtv|va|and|the|of|co so)\b"
)


@dataclass
class OcrLine:
    """Một dòng chữ OCR kèm độ tin cậy và khung bao (nếu thư viện cung cấp)."""

    text: str
    score: float | None = None
    box: tuple[float, float, float, float] | None = None  # x1, y1, x2, y2


@dataclass
class _Line:
    raw: str
    norm: str
    core: str
    prominence: float
    name_like: bool
    numbers: list[str]


@dataclass
class Evidence:
    lines: list[_Line]
    full_norm: str
    reg_found: list[tuple[str, str]]  # (dạng đọc được, dạng chuẩn)
    quantities: list[str]  # token chuẩn: "500mg"
    quantity_texts: list[str]  # như đọc được: "500 mg"
    form: frozenset[str]
    form_text: str | None
    phrases: list[tuple[str, float, list[str]]] = field(default_factory=list)  # (core, prominence, numbers)


_QTY_SHOW = re.compile(r"\d+(?:[.,]\d+)?\s*(?:mcg|µg|μg|mg|g|kg|ml|iu|ui|%)(?![A-Za-z0-9])", re.IGNORECASE)
_FORM_SHOW = re.compile(
    r"(viên nén bao phim|viên nén sủi(?: bọt)?|viên nén|viên nang cứng|viên nang mềm|viên nang|viên sủi|"
    r"siro|si rô|hỗn dịch uống|hỗn dịch|dung dịch tiêm|dung dịch uống|dung dịch|thuốc bột|bột pha [^\n,.;]{0,30}|"
    r"thuốc cốm|cốm pha [^\n,.;]{0,30}|kem bôi da|thuốc mỡ|gel|thuốc nhỏ mắt|"
    r"film[- ]?coated tablets?|tablets?|hard capsules?|soft capsules?|capsules?|syrup|suspension|injection|cream|ointment|eye drops)",
    re.IGNORECASE,
)


def build_evidence(lines: Sequence[OcrLine]) -> Evidence:
    cleaned = [ln for ln in lines if ln.text and ln.text.strip()]
    heights = [(ln.box[3] - ln.box[1]) for ln in cleaned if ln.box]
    max_h = max(heights) if heights else 0.0

    infos: list[_Line] = []
    for ln in cleaned:
        fixed = fix_ocr_text(ln.text)
        norm = normalize_text(fixed)
        if not norm:
            continue
        core = name_core(fixed)
        letters = sum(ch.isalpha() for ch in core)
        height = (ln.box[3] - ln.box[1]) if ln.box else 0.0
        prominence = (height / max_h) if (max_h > 0 and height > 0) else 1.0
        name_like = (
            letters >= 3
            and letters >= 0.5 * max(1, len(core.replace(" ", "")))
            and len(core) <= 60
            and not _BOILERPLATE.search(norm)
            and (ln.score is None or ln.score >= 0.5)
        )
        infos.append(_Line(raw=ln.text.strip(), norm=norm, core=core, prominence=round(prominence, 3), name_like=name_like, numbers=bare_numbers(fixed)))

    if max_h <= 0:
        # Không có khung bao (văn bản thuần): dòng giống-tên đứng trước được coi là nổi bật hơn.
        rank = 0
        for info in infos:
            if info.name_like:
                info.prominence = max(0.6, 1.0 - 0.1 * rank)
                rank += 1

    full_text = "\n".join(fix_ocr_text(ln.text) for ln in cleaned)
    full_norm = " ".join(i.norm for i in infos)
    quantities = strength_tokens(*[fix_ocr_text(ln.text) for ln in cleaned])
    quantity_texts = list(dict.fromkeys(" ".join(m.group(0).split()) for m in _QTY_SHOW.finditer(full_text)))
    form_match = _FORM_SHOW.search(full_text)

    ev = Evidence(
        lines=infos,
        full_norm=full_norm,
        reg_found=find_reg_numbers(full_text),
        quantities=quantities,
        quantity_texts=quantity_texts,
        form=form_tags(full_text),
        form_text=form_match.group(0) if form_match else None,
    )
    # Cụm ứng viên tên: từng dòng giống-tên và ghép hai dòng liền kề (tên in hai dòng).
    name_lines = [i for i in infos if i.name_like]
    for idx, info in enumerate(name_lines):
        ev.phrases.append((info.core, info.prominence, info.numbers))
        if idx + 1 < len(name_lines):
            nxt = name_lines[idx + 1]
            joined = f"{info.core} {nxt.core}".strip()
            if len(joined) <= 60:
                ev.phrases.append((joined, max(info.prominence, nxt.prominence), info.numbers + nxt.numbers))
    return ev


# --------------------------------------------------------------------------- #
# Chấm điểm
# --------------------------------------------------------------------------- #
def name_similarity(candidate_core: str, phrase: str) -> float:
    """Độ giống tên (0–100) giữa tên trong danh mục và một cụm chữ OCR."""
    if not candidate_core or not phrase:
        return 0.0
    ratio = fuzz.ratio(candidate_core, phrase)
    token_set = fuzz.token_set_ratio(candidate_core, phrase)
    score = 0.55 * token_set + 0.45 * ratio
    if len(candidate_core) >= 5:
        partial = fuzz.partial_ratio(candidate_core, phrase)
        shorter, longer = sorted((len(candidate_core), len(phrase)))
        cover = shorter / max(1, longer)
        score = max(score, partial * (0.75 + 0.25 * cover))
    return float(min(100.0, score))


def _manufacturer_core(name: str | None) -> str:
    norm = normalize_text(name)
    if not norm:
        return ""
    norm = re.sub(r"\(.*", " ", norm)
    norm = _COMPANY_NOISE.sub(" ", norm)
    return " ".join(norm.split())


@dataclass
class _Scored:
    row: CatalogMedicine
    name_sim: float = 0.0
    best_phrase: str = ""
    best_numbers: list[str] = field(default_factory=list)
    prominence: float = 1.0
    cat_strength: set[str] = field(default_factory=set)
    components: dict[str, dict[str, Any]] = field(default_factory=dict)
    score: float = 0.0
    flags: list[str] = field(default_factory=list)
    reg_exact: bool = False
    independent: int = 0


def _component(key: str, status: str, value: float | None, detail: str) -> dict[str, Any]:
    return {
        "key": key,
        "label": LABELS[key],
        "status": status,  # match | partial | conflict | not_observed | no_data
        "value": None if value is None else round(float(value), 3),
        "weight": WEIGHTS.get(key, 0.0),
        "detail": detail,
    }


class MedicineMatcher:
    def __init__(self, repo: CatalogRepository):
        self.repo = repo

    # ---- truy xuất ứng viên ---------------------------------------------- #
    def _retrieve(self, ev: Evidence) -> tuple[list[int], dict[int, tuple[str, float]], list[str]]:
        ids: dict[int, None] = {}
        reg_hits: dict[int, tuple[str, float]] = {}
        known_regs: list[str] = []
        for shown, reg in ev.reg_found:
            for mid, reg_norm, score in self.repo.ids_by_reg_fuzzy(reg):
                if score > reg_hits.get(mid, ("", 0.0))[1]:
                    reg_hits[mid] = (reg_norm, score)
                ids.setdefault(mid, None)
                if shown not in known_regs:
                    known_regs.append(shown)

        phrases = sorted(ev.phrases, key=lambda p: -p[1])[:8]
        for core, _prom, _nums in phrases:
            tokens = [t for t in core.split() if len(t) >= 3 and not t.isdigit() and t not in _STOPWORDS]
            for mid in self.repo.fts_any(tokens, column="name", limit=40):
                ids.setdefault(mid, None)
            for mid in self.repo.fts_any(tokens, column="name", limit=25, prefix=True):
                ids.setdefault(mid, None)
            if len(core) >= 5:
                for mid in self.repo.trigram(core, "name", 40):
                    ids.setdefault(mid, None)

        all_tokens: dict[str, None] = {}
        for info in ev.lines:
            for tok in info.core.split():
                if len(tok) >= 5 and tok.isalpha() and tok not in _STOPWORDS:
                    all_tokens.setdefault(tok, None)
        token_list = list(all_tokens)[:24]
        for mid in self.repo.fts_any(token_list, column="ingredient", limit=60):
            ids.setdefault(mid, None)
        for mid in self.repo.fts_any(token_list, column="name", limit=60):
            ids.setdefault(mid, None)
        return list(ids)[:500], reg_hits, known_regs

    # ---- chấm điểm ------------------------------------------------------- #
    def _score_all(self, ev: Evidence, rows: Sequence[CatalogMedicine], reg_hits: dict[int, tuple[str, float]]) -> list[_Scored]:
        scored: list[_Scored] = []
        for row in rows:
            sc = _Scored(row=row)
            core = row.name_core or row.name_norm
            for phrase, prominence, numbers in ev.phrases:
                sim = name_similarity(core, phrase) * (0.75 + 0.25 * prominence)
                if sim > sc.name_sim:
                    sc.name_sim, sc.best_phrase, sc.best_numbers, sc.prominence = sim, phrase, numbers, prominence
            sc.cat_strength = set(row.strength_norm.split())
            scored.append(sc)

        # "Họ" sản phẩm: các ứng viên có tên gần giống nhau. Hàm lượng đọc được mà
        # thuộc về một thành viên trong họ là hàm lượng có tính phân biệt.
        family_strength: set[str] = set()
        for sc in scored:
            if sc.name_sim >= 80 or sc.row.id in reg_hits:
                family_strength |= sc.cat_strength
        main_dims = {"mg", "iu", "%"}

        def is_main(token: str) -> bool:
            return token.endswith(("mg", "iu", "%"))

        ocr_main = [q for q in ev.quantities if is_main(q)]
        discriminative = [q for q in ev.quantities if q in family_strength]
        unexplained = [q for q in ocr_main if q not in family_strength]

        for sc in scored:
            row = sc.row
            comps = sc.components

            # -- Số đăng ký --
            if row.id in reg_hits:
                reg_norm, reg_score = reg_hits[row.id]
                exact = reg_score >= 100
                sc.reg_exact = exact
                comps["registration"] = _component(
                    "registration", "match" if exact else "partial", 1.0 if exact else 0.85,
                    f"Trùng số đăng ký {clean_cell(row.so_dang_ky) or reg_norm}" if exact
                    else f"Gần giống số đăng ký {clean_cell(row.so_dang_ky) or reg_norm} (có thể OCR sai ký tự)",
                )
            elif reg_hits:
                comps["registration"] = _component(
                    "registration", "conflict", 0.0, "Số đăng ký đọc được thuộc về bản ghi khác"
                )
            else:
                detail = "Không đọc được số đăng ký trên ảnh" if not ev.reg_found else "Số đọc được không có trong danh mục"
                comps["registration"] = _component("registration", "not_observed", None, detail)

            # -- Tên --
            # Độ giống < 60 coi như khác tên; 60–100 quy tuyến tính về 0–1.
            name_value = max(0.0, (sc.name_sim - NAME_SIM_FLOOR) / (100.0 - NAME_SIM_FLOOR))
            if not ev.phrases:
                comps["name"] = _component("name", "not_observed", None, "Không có dòng chữ giống tên thuốc trên ảnh")
            else:
                name_status = "match" if sc.name_sim >= 90 else "partial" if sc.name_sim >= NAME_SIM_MIN else "conflict"
                comps["name"] = _component(
                    "name", name_status, name_value,
                    f"Giống {sc.name_sim:.0f}/100 so với dòng “{sc.best_phrase}”" if sc.best_phrase else "Không có dòng nào giống tên này",
                )

            # -- Hàm lượng --
            cat_main = {q for q in sc.cat_strength if is_main(q)}
            cat_numbers = set(bare_numbers(row.ten_thuoc)) | {
                q.written for q in parse_quantities(" ".join(filter(None, [row.ham_luong, row.hoat_chat_chinh, row.ten_thuoc])))
            }
            # Đại lượng trùng với quy cách đóng gói của chính bản ghi (vd "gói 1,5g", "chai 60ml")
            # là thông tin bao bì, không phải bằng chứng trái hàm lượng.
            pack_tokens = set(strength_tokens(row.dong_goi))
            relevant = [q for q in discriminative if q in sc.cat_strength or q not in pack_tokens]
            if relevant:
                hit = [q for q in relevant if q in sc.cat_strength]
                miss = [q for q in relevant if q not in sc.cat_strength]
                if hit and not miss:
                    unseen = cat_main - set(ev.quantities)
                    value = 0.9 if unseen else 1.0
                    detail = "Khớp " + ", ".join(hit)
                    if unseen:
                        detail += f" (chưa thấy {', '.join(sorted(unseen))} trên ảnh)"
                    comps["strength"] = _component("strength", "match", value, detail)
                elif hit:
                    value = 0.5 * len(hit) / len(relevant)
                    comps["strength"] = _component(
                        "strength", "partial", value, f"Khớp {', '.join(hit)}; không khớp {', '.join(miss)}"
                    )
                    sc.flags.append("strength_partial")
                else:
                    comps["strength"] = _component(
                        "strength", "conflict", 0.0,
                        f"Ảnh ghi {', '.join(miss)}; bản ghi này là {', '.join(sorted(cat_main)) or 'hàm lượng khác'}",
                    )
                    sc.flags.append("strength_conflict")
            elif unexplained and cat_main:
                comps["strength"] = _component(
                    "strength", "conflict", 0.15,
                    f"Ảnh ghi {', '.join(unexplained)}, không khớp {', '.join(sorted(cat_main))}",
                )
                sc.flags.append("strength_unmatched")
            elif sc.best_numbers and cat_numbers and sc.name_sim >= 70:
                hit_n = [n for n in sc.best_numbers if n in cat_numbers]
                if hit_n and len(hit_n) == len(sc.best_numbers):
                    comps["strength"] = _component("strength", "match", 0.9, f"Số trên dòng tên khớp: {', '.join(hit_n)}")
                elif hit_n:
                    comps["strength"] = _component("strength", "partial", 0.5, f"Chỉ khớp một phần số trên dòng tên: {', '.join(hit_n)}")
                    sc.flags.append("strength_partial")
                else:
                    comps["strength"] = _component(
                        "strength", "conflict", 0.0,
                        f"Dòng tên ghi {', '.join(sc.best_numbers)}, bản ghi này ghi {', '.join(sorted(cat_numbers))}",
                    )
                    sc.flags.append("strength_conflict")
            elif not ev.quantities and not sc.best_numbers:
                comps["strength"] = _component("strength", "not_observed", None, "Không đọc được hàm lượng trên ảnh")
            elif not sc.cat_strength:
                comps["strength"] = _component("strength", "no_data", None, "Danh mục không ghi hàm lượng cho bản ghi này")
            else:
                comps["strength"] = _component("strength", "not_observed", None, "Không có hàm lượng đủ rõ để so sánh")

            # -- Hoạt chất --
            ingredients = ingredient_names(row.hoat_chat_chinh)[:4]
            if not ingredients:
                comps["ingredient"] = _component("ingredient", "no_data", None, "Danh mục không ghi hoạt chất")
            else:
                found = [ing for ing in ingredients if len(ing) >= 5 and fuzz.partial_ratio(ing, ev.full_norm) >= 88]
                if found:
                    value = len(found) / len(ingredients)
                    comps["ingredient"] = _component(
                        "ingredient", "match" if value >= 0.99 else "partial", value,
                        f"Thấy trên ảnh: {', '.join(found)}",
                    )
                else:
                    comps["ingredient"] = _component("ingredient", "not_observed", None, "Không đọc được tên hoạt chất trên ảnh")

            # -- Dạng bào chế --
            cat_form = form_tags(row.dang_bao_che)
            if ev.form and cat_form:
                inter, union = ev.form & cat_form, ev.form | cat_form
                if inter:
                    value = len(inter) / len(union)
                    comps["form"] = _component("form", "match" if value >= 0.99 else "partial", max(0.6, value), "Dạng bào chế tương ứng")
                elif form_classes(ev.form) & form_classes(cat_form):
                    comps["form"] = _component("form", "partial", 0.5, "Cùng nhóm dạng bào chế")
                else:
                    comps["form"] = _component("form", "conflict", 0.0, f"Ảnh ghi dạng khác với “{clean_cell(row.dang_bao_che)}”")
                    sc.flags.append("form_conflict")
            elif not ev.form:
                comps["form"] = _component("form", "not_observed", None, "Không đọc được dạng bào chế trên ảnh")
            else:
                comps["form"] = _component("form", "no_data", None, "Danh mục không ghi dạng bào chế")

            # -- Tổng hợp --
            total_w = sum(WEIGHTS[k] for k, c in comps.items() if c["value"] is not None and k in WEIGHTS)
            total = sum(WEIGHTS[k] * c["value"] for k, c in comps.items() if c["value"] is not None and k in WEIGHTS)
            score = 100.0 * total / total_w if total_w else 0.0
            # Ít loại bằng chứng thì điểm tối đa thấp hơn (chỉ đọc được tên → không thể "Cao").
            coverage = min(1.0, total_w / COVERAGE_FULL)
            score *= COVERAGE_BASE + (1.0 - COVERAGE_BASE) * coverage

            maker = _manufacturer_core(row.ten_cong_ty_san_xuat)
            if len(maker) >= 5 and fuzz.partial_ratio(maker, ev.full_norm) >= 90:
                comps["manufacturer"] = _component("manufacturer", "match", 1.0, "Thấy tên nhà sản xuất trên ảnh")
                score = min(100.0, score + MANUFACTURER_BONUS)

            if "strength_conflict" in sc.flags:
                score = min(score, 55.0)
            elif "strength_unmatched" in sc.flags:
                score = min(score, 70.0)
            if ev.phrases and sc.name_sim < NAME_SIM_MIN and not sc.reg_exact:
                score = min(score, 40.0)
            sc.score = round(score, 1)

            sc.independent = (
                (2 if sc.reg_exact else 0)
                + (1 if (ev.phrases and sc.name_sim >= 90) else 0)
                + (1 if (comps["strength"]["value"] or 0) >= 0.9 else 0)
                + (1 if (comps["ingredient"]["value"] or 0) >= 0.5 else 0)
            )
        return scored

    # ---- API chính -------------------------------------------------------- #
    def match(self, lines: Sequence[OcrLine]) -> dict[str, Any]:
        ev = build_evidence(lines)
        evidence_out: dict[str, Any] = {
            "lines": [ln.raw for ln in ev.lines],
            "registration_numbers": [],
            "strengths": ev.quantity_texts,
            "dosage_form": ev.form_text,
            "name_guess": None,
            "ingredients": [],
            "search_hint": None,  # gợi ý từ khóa để người dùng tìm thủ công
        }
        if not ev.lines:
            return {
                "status": "no_text",
                "message": "Không đọc được chữ trên ảnh. Hãy chụp lại rõ hơn hoặc nhập thủ công.",
                "reasons": [],
                "evidence": evidence_out,
                "candidates": [],
            }

        ids, reg_hits, known_regs = self._retrieve(ev)
        evidence_out["registration_numbers"] = [
            {"text": shown, "in_catalog": shown in known_regs} for shown, _ in ev.reg_found
        ]
        prominent = sorted((p for p in ev.phrases), key=lambda p: -p[1])
        if prominent:
            core = prominent[0][0]
            raw = next((ln.raw for ln in ev.lines if ln.core == core), None)
            evidence_out["name_guess"] = raw or core
            evidence_out["search_hint"] = core

        rows = self.repo.get_many(ids)
        scored = self._score_all(ev, rows, reg_hits)
        scored.sort(
            key=lambda s: (
                -s.score,
                -s.name_sim,
                0 if s.row.in_source else 1,
                1 if s.row.is_het_han else 0,
                -s.row.id,
            )
        )
        viable = [s for s in scored if s.score >= NO_MATCH_BELOW]
        if not viable:
            return {
                "status": "no_match",
                "message": NO_MATCH_MESSAGE,
                "reasons": ["Không có bản ghi nào đủ giống với chữ đọc được."],
                "evidence": evidence_out,
                "candidates": [],
            }

        top = viable[0]
        second = viable[1] if len(viable) > 1 else None
        reasons: list[str] = []
        if top.score < CONFIDENT_MIN_SCORE:
            reasons.append("Mức độ phù hợp của ứng viên tốt nhất chưa cao.")
        if any(f in top.flags for f in ("strength_conflict", "strength_unmatched", "strength_partial")):
            reasons.append("Hàm lượng đọc được không khớp hoàn toàn với bản ghi.")
        if top.independent < 2:
            reasons.append("Chỉ có một loại bằng chứng (ví dụ chỉ đọc được tên).")
        # Cùng sản phẩm (trùng tên + hàm lượng) nhưng khác số đăng ký/nhà sản xuất: nếu không có
        # bằng chứng về số đăng ký hay nhà sản xuất thì không được tự tin chọn một bản ghi.
        def product_key(sc: _Scored) -> tuple[str, frozenset[str]]:
            return (sc.row.name_core or sc.row.name_norm, frozenset(q for q in sc.cat_strength if q.endswith(("mg", "iu", "%"))))

        twins = [
            sc for sc in viable[1:]
            if top.score - sc.score < SAME_PRODUCT_MARGIN and product_key(sc) == product_key(top)
        ]
        if twins and not top.reg_exact and "manufacturer" not in top.components:
            reasons.append(
                "Có nhiều bản ghi trùng tên và hàm lượng (khác số đăng ký hoặc nhà sản xuất). "
                "Hãy đối chiếu số đăng ký trên bao bì."
            )
        elif second is not None and (top.score - second.score) < CONFIDENT_MIN_MARGIN:
            reasons.append("Có nhiều ứng viên với mức độ phù hợp gần nhau.")
        confident = not reasons
        status = "confident" if confident else "uncertain"

        ingredients_seen: list[str] = []
        detail = top.components.get("ingredient", {}).get("detail", "")
        if top.components.get("ingredient", {}).get("value"):
            ingredients_seen = [x.strip() for x in detail.replace("Thấy trên ảnh:", "").split(",") if x.strip()]
        evidence_out["ingredients"] = ingredients_seen

        candidates = [self._serialize(s) for s in viable[:MAX_CANDIDATES]]
        return {
            "status": status,
            "message": CONFIDENT_MESSAGE if confident else UNCERTAIN_MESSAGE,
            "reasons": reasons,
            "evidence": evidence_out,
            "candidates": candidates,
        }

    @staticmethod
    def _serialize(sc: _Scored) -> dict[str, Any]:
        level = "high" if sc.score >= CONFIDENT_MIN_SCORE else "medium" if sc.score >= 60 else "low"
        order = ["registration", "name", "strength", "ingredient", "form", "manufacturer"]
        return {
            "medicine": medicine_summary(sc.row),
            "score": sc.score,
            "level": level,
            "level_label": {"high": "Cao", "medium": "Trung bình", "low": "Thấp"}[level],
            "components": [sc.components[k] for k in order if k in sc.components],
            "flags": sc.flags,
        }


def lines_from_text(text: str) -> list[OcrLine]:
    """Tách văn bản nhiều dòng thành các OcrLine (dùng cho kiểm thử và nhập tay)."""
    return [OcrLine(text=part.strip()) for part in re.split(r"[\r\n]+", text or "") if part.strip()]


__all__ = [
    "MedicineMatcher",
    "OcrLine",
    "build_evidence",
    "lines_from_text",
    "name_similarity",
    "normalize_reg",
    "split_reg_field",
]
