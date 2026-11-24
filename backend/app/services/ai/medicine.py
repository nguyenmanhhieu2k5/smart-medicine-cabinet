"""Tra cứu thuốc trên mạng khi dữ liệu nội bộ không có câu trả lời.

Nguồn (SMC_LOOKUP_PROVIDER): "tavily" = CHỈ tìm kiếm web + quy tắc, không AI (mặc định); "auto" = Gemini trước rồi
Tavily; "gemini" = chỉ Gemini.

Ba tình huống:
- barcode: mã vạch không có trong bảng mã vạch → tìm trang ghi ĐÚNG mã đó (Tavily) hoặc Gemini + Google Search
  (bắt buộc tra mạng: không có mạng thì không thể "biết" mã vạch → báo không khả dụng, không đoán).
- qr: nội dung mã QR. Có số đăng ký → tra thẳng danh mục. Đường link → Tavily đọc trang đó. Chữ khác → tìm trên mạng.
- scan: người dùng xác nhận "không có thuốc đúng" trong kết quả OCR → tìm trên mạng theo tên in nổi bật trên hộp
  (Tavily), hoặc Gemini đọc ẢNH + chữ OCR.

Kết quả luôn: chỉ thông tin nhận dạng (không liều dùng/chỉ định), kèm nguồn, được đối chiếu lại với danh mục DAV
(số đăng ký trước, tên + hàm lượng sau) và lưu đệm (ai_lookups) để lần sau trả lời ngay.
"""
from __future__ import annotations

import base64
import hashlib
import logging
import re
import time
import uuid
from datetime import timedelta
from typing import Any

from sqlalchemy import select

from app.core import clock
from app.core.config import Settings
from app.database.session import Database
from app.models.ai import AiLookup
from app.models.catalog import CatalogReg
from app.services.ai.gemini import GeminiClient, GeminiError, parse_json_object
from app.services.barcode.gs1 import parse_code
from app.services.barcode.web_lookup import (
    TextQuery,
    Vocab,
    build_info,
    build_vocab,
    evidence_pages,
    match_pages,
    match_text_pages,
    reg_numbers,
    text_pages,
    text_query,
)
from app.services.medicine_matcher.catalog import CatalogRepository, medicine_summary
from app.services.medicine_matcher.matcher import OcrLine, lines_from_text
from app.services.medicine_matcher.normalize import split_reg_field
from app.services.ocr import preprocess
from app.services.websearch.tavily import SearchError, TavilyClient

log = logging.getLogger("smc.ai")
FIELDS = ("ten_thuoc", "hoat_chat", "ham_luong", "dang_bao_che", "quy_cach", "so_dang_ky", "nha_san_xuat", "nuoc_san_xuat", "ghi_chu")
TOTAL_BUDGET = 24.0  # giây tối đa cho một lượt tra (mọi mô hình, cả hai chế độ) — tránh bắt người dùng chờ lâu
CACHE_FOUND = timedelta(days=30)
CACHE_NOT_FOUND = timedelta(days=1)
NOTICE = ("Thông tin do AI tổng hợp từ Internet, có thể chưa chính xác. Hãy đối chiếu với vỏ hộp và hỏi dược sĩ "
          "trước khi dùng thuốc.")
NOTICES = {
    "web": NOTICE,
    "offline": NOTICE,
    "search": ("Kết quả tìm kiếm trên Internet (không dùng AI): thuốc được xác định qua số đăng ký ghi trên các trang nguồn "
               "và lấy thông tin từ danh mục Cục Quản lý Dược. Hãy đối chiếu với vỏ hộp và hỏi dược sĩ trước khi dùng."),
    "text": ("Đọc trực tiếp số đăng ký trong nội dung mã (không dùng AI, không tra mạng) rồi lấy thông tin từ danh mục Cục Quản "
             "lý Dược. Hãy đối chiếu với vỏ hộp."),
}
MESSAGES: dict[tuple[str, ...], str] = {
    ("web", True): "AI đã tìm thấy thông tin trên mạng.",
    ("offline", True): "AI đã đọc thông tin trên ảnh/mã (chưa kiểm chứng được trên mạng).",
    ("text", True): "Đã đọc được số đăng ký trong nội dung mã.",
    ("barcode", "search", True): "Đã tìm thấy mã vạch trên mạng (tra cứu không dùng AI).",
    ("barcode", "search", False): "Không tìm thấy trang nào trên mạng ghi đúng mã vạch này.",
    ("search", True): "Đã tìm thấy thông tin thuốc trên mạng (tra cứu không dùng AI).",
    ("qr", "search", False): "Không tìm được thuốc khớp danh mục từ nội dung mã QR trên mạng.",
    ("search", False): ("Không tìm được thuốc khớp danh mục từ kết quả tìm kiếm trên mạng. Hãy chụp rõ mặt hộp có tên "
                        "thuốc, hoặc tìm thủ công."),
}
NO_TEXT = ("Trên ảnh không thấy tên thuốc hay hoạt chất nào có trong danh mục Cục Quản lý Dược nên chưa tìm trên mạng. "
           "Hãy chụp mặt trước của hộp (có tên thuốc). Thực phẩm chức năng, mỹ phẩm không nằm trong danh mục thuốc.")
VOCAB_TTL = 6 * 3600.0  # bộ từ của danh mục (tên + hoạt chất) — danh mục hiếm khi đổi

SYSTEM = """Bạn là công cụ tra cứu THÔNG TIN NHẬN DẠNG thuốc lưu hành tại Việt Nam cho ứng dụng tủ thuốc gia đình.
Quy tắc bắt buộc:
- Chỉ trả về MỘT đối tượng JSON hợp lệ, không markdown, không lời dẫn.
- Khóa: found (true/false), ten_thuoc, hoat_chat, ham_luong, dang_bao_che, quy_cach, so_dang_ky, nha_san_xuat,
  nuoc_san_xuat, do_tin_cay ("cao" | "trung_binh" | "thap"), ghi_chu (tối đa 200 ký tự). Không có thông tin thì null.
- Chỉ nêu thông tin nhận dạng sản phẩm. TUYỆT ĐỐI KHÔNG đưa liều dùng, cách dùng, chỉ định, chống chỉ định,
  tác dụng phụ hay lời khuyên y khoa.
- Không bịa đặt. Không đủ bằng chứng thì found=false, hoặc do_tin_cay="thap" và giải thích ngắn trong ghi_chu.
- Viết tiếng Việt; giữ nguyên tên thương mại, số đăng ký như in trên bao bì (VD-…, VN-…, QLSP-…, hoặc 12 chữ số)."""

_STR = {"type": "STRING", "nullable": True}
JSON_SCHEMA: dict[str, Any] = {
    "type": "OBJECT",
    "properties": {"found": {"type": "BOOLEAN"}, **{k: _STR for k in FIELDS}, "do_tin_cay": {"type": "STRING", "enum": ["cao", "trung_binh", "thap"]}},
    "required": ["found"],
}


def _clean(info: dict[str, Any] | None) -> dict[str, Any] | None:
    if not info:
        return None
    out: dict[str, Any] = {"found": bool(info.get("found"))}
    for key in FIELDS:
        value = info.get(key)
        text = " ".join(str(value).split())[:300] if value not in (None, "", "null") else None
        out[key] = text or None
    level = str(info.get("do_tin_cay") or "").lower().replace(" ", "_")
    out["do_tin_cay"] = level if level in ("cao", "trung_binh", "thap") else "thap"
    if not out["ten_thuoc"]:
        out["found"] = False
    return out


def match_catalog(s, info: dict[str, Any]) -> list[dict[str, Any]]:  # noqa: ANN001
    """Đối chiếu kết quả AI với danh mục DAV: số đăng ký (chắc chắn) → tên + hàm lượng (gợi ý)."""
    repo = CatalogRepository(s)
    ids: list[int] = []
    by = "registration"
    regs = [r[:40] for r in split_reg_field(info.get("so_dang_ky"))]
    if regs:
        ids = list(dict.fromkeys(s.scalars(select(CatalogReg.medicine_id).where(CatalogReg.reg_norm.in_(regs))).all()))[:3]
    if not ids and info.get("ten_thuoc"):
        by = "name"
        for query in (" ".join(filter(None, [info["ten_thuoc"], info.get("ham_luong")])), info["ten_thuoc"]):
            ids = [int(item["id"]) for item in repo.search(query[:120], limit=3).get("items", [])][:3]
            if ids:
                break
    rows = {row.id: row for row in repo.get_many(ids)} if ids else {}
    return [{**medicine_summary(rows[i]), "match_by": by} for i in ids if i in rows]


class AiMedicineService:
    def __init__(self, db: Database, settings: Settings, client: GeminiClient | None = None, search: TavilyClient | None = None,
                 provider: str | None = None):
        self.db = db
        self.client = client or GeminiClient(settings.gemini_api_key, settings.gemini_models, settings.gemini_timeout)
        self.search = search or TavilyClient(settings.tavily_api_key)
        self.provider = provider or settings.lookup_provider
        self._vocab: tuple[float, Vocab] | None = None

    def _catalog_vocab(self) -> Vocab:
        now = time.monotonic()
        if self._vocab is None or now - self._vocab[0] > VOCAB_TTL:
            with self.db.session() as s:
                vocab = build_vocab(s)
            if not vocab.heads:  # danh mục đang trống/đang nhập → không lưu đệm
                return vocab
            self._vocab = (now, vocab)
        return self._vocab[1]

    @property
    def gemini_on(self) -> bool:
        return self.provider in ("auto", "gemini") and self.client.configured

    @property
    def search_on(self) -> bool:
        return self.provider in ("auto", "tavily") and self.search.configured

    @property
    def configured(self) -> bool:
        return self.gemini_on or self.search_on

    def close(self) -> None:
        self.client.close()
        self.search.close()

    def status(self) -> dict[str, Any]:
        return {"provider": self.provider, "configured": self.client.configured, "models": self.client.models,
                "search_available": self.client.search_available(), "last_error": self.client.last_error,
                "web_search": {"provider": "tavily", "configured": self.search.configured, "last_error": self.search.last_error}}

    def _no_source(self, kind: str) -> dict[str, Any]:
        need = {"tavily": "khóa Tavily (SMC_TAVILY_API_KEY)", "gemini": "khóa Gemini (SMC_GEMINI_API_KEY)"}.get(
            self.provider, "khóa Tavily hoặc Gemini")
        return self._unavailable(kind, "not_configured", f"Chưa cấu hình tra cứu trên mạng: thiếu {need} trong server.env trên máy chủ.")

    # ------------------------------------------------------------------ #
    def _cached(self, key: str) -> AiLookup | None:
        now = clock.now()
        with self.db.session() as s:
            row = s.scalars(select(AiLookup).where(AiLookup.query_key == key).order_by(AiLookup.created_at.desc()).limit(1)).first()
            if row is None:
                return None
            ttl = CACHE_FOUND if row.status == "found" else CACHE_NOT_FOUND
            if row.created_at.replace(tzinfo=None) < now.replace(tzinfo=None) - ttl:
                return None
            s.expunge(row)
            return row

    def _response(self, kind: str, row: AiLookup, *, cached: bool) -> dict[str, Any]:
        with self.db.session() as s:
            repo = CatalogRepository(s)
            rows = {r.id: r for r in repo.get_many(list(row.catalog_ids or []))}
            matches = [{**medicine_summary(rows[i]), "match_by": (row.result or {}).get("_match_by", "name")}
                       for i in row.catalog_ids or [] if i in rows]
        result = {k: v for k, v in (row.result or {}).items() if not k.startswith("_")} or None
        found = row.status == "found"
        message = (MESSAGES.get((kind, row.mode, found)) or MESSAGES.get((row.mode, found))
                   or "AI không tìm thấy thông tin đáng tin cậy về thuốc này.")
        return {
            "status": row.status, "kind": kind, "mode": row.mode, "model": row.model, "cached": cached, "elapsed_ms": row.elapsed_ms,
            "result": result, "sources": row.sources or [], "catalog_matches": matches, "message": message, "reason": None,
            "notice": NOTICES.get(row.mode, NOTICE),
        }

    def _save(self, *, kind: str, key: str, found: bool, mode: str, model: str, info: dict[str, Any] | None, by: str | None,
              sources: list[dict[str, str]], ids: list[int], user_id: uuid.UUID | None, started: float) -> AiLookup:
        with self.db.session() as s:
            row = AiLookup(
                kind=kind, query_key=key[:160], status="found" if found else "not_found", mode=mode, model=model[:64],
                result={**info, "_match_by": by} if info else None, sources=sources, catalog_ids=ids, user_id=user_id,
                elapsed_ms=int((time.perf_counter() - started) * 1000), created_at=clock.now(),
            )
            s.add(row)
            s.flush()
            s.expunge(row)
        return row

    def _search_barcode(self, key: str, code: str, user_id: uuid.UUID | None) -> dict[str, Any]:
        """Tavily + quy tắc (không AI): trang có đúng mã vạch → số đăng ký cạnh mã → danh mục DAV."""
        started = time.perf_counter()
        try:
            pages = evidence_pages(self.search.search(f'"{code}"', max_results=10, exact=True), code)
            if not pages:  # thử thêm một lượt không ép khớp chính xác
                pages = evidence_pages(self.search.search(f"{code} thuốc", max_results=10), code)
        except SearchError as exc:
            return self._unavailable("barcode", exc.reason, str(exc))
        with self.db.session() as s:
            match = match_pages(s, pages) if pages else {"ids": [], "by": None}
            info = build_info(s, pages, match) if pages else None
        row = self._save(kind="barcode", key=key, found=bool(info), mode="search", model="tavily", info=info, by=match["by"],
                         sources=[{"title": p["title"][:200], "url": p["url"]} for p in pages[:6]], ids=match["ids"],
                         user_id=user_id, started=started)
        log.info("Tra mã vạch trên mạng (Tavily) → %s, %d trang, %s", row.status, len(pages), match["by"])
        return self._response("barcode", row, cached=False)

    def _qr_text(self, key: str, content: str, user_id: uuid.UUID | None) -> dict[str, Any] | None:
        """Mã QR có ghi số đăng ký (VD-…, VN-…, 12 chữ số) → tra thẳng danh mục, không cần AI hay mạng."""
        regs = [norm[:40] for _, norm in reg_numbers(content)]
        if not regs:
            return None
        started = time.perf_counter()
        with self.db.session() as s:
            ids = list(dict.fromkeys(s.scalars(select(CatalogReg.medicine_id).where(CatalogReg.reg_norm.in_(regs))).all()))[:3]
            if not ids:
                return None
            info = {**build_info(s, [{"title": content[:200], "url": ""}], {"ids": ids, "by": "registration", "reg": regs[0], "votes": 2}),
                    "ghi_chu": "Số đăng ký đọc từ nội dung mã QR khớp danh mục Cục Quản lý Dược."}
        row = self._save(kind="qr", key=key, found=True, mode="text", model="rules", info=info, by="registration", sources=[],
                         ids=ids, user_id=user_id, started=started)
        return self._response("qr", row, cached=False)

    def _search_text(self, kind: str, key: str, *, lines: list[OcrLine] | None = None, url: str | None = None,
                     user_id: uuid.UUID | None = None) -> dict[str, Any]:
        """Tavily + quy tắc (không AI) theo CHỮ trên hộp/trong mã QR, hoặc đọc trang mà mã QR trỏ tới."""
        started = time.perf_counter()
        q = text_query(lines, self._catalog_vocab()) if lines and url is None else None
        if url is None and q is None:
            return self._unavailable(kind, "no_text", NO_TEXT)
        try:
            if url is not None:
                page = self.search.extract(url)
                pages = [{"title": page.title or url, "url": page.url, "text": page.raw_content, "pos": None}] if page else []
                q = TextQuery(name=pages[0]["title"] if pages else url, strength=None, terms=[])
                lead, near = "Đã đọc trang web trong mã QR", "ghi trên trang"
                caveat = name_hint = None
            else:
                assert q is not None
                pages = text_pages(self.search.search(q.query, max_results=8), q)
                near = "ghi gần tên thuốc"
                lead = (f"Không đọc được tên thương mại trên hộp nên tìm theo hoạt chất “{q.name}”, {len(pages)} trang nhắc tới"
                        if q.generic else f"Tên “{q.name}” xuất hiện trên {len(pages)} trang")
                caveat = ("Có thể là thuốc khác cùng hoạt chất — hãy đối chiếu tên và nhà sản xuất trên vỏ hộp."
                          if q.generic else None)
                name_hint = " ".join(filter(None, [q.name, q.strength]))
        except SearchError as exc:
            return self._unavailable(kind, exc.reason, str(exc))
        with self.db.session() as s:
            match = match_text_pages(s, pages, q) if pages else {"ids": [], "by": None, "reg": None, "votes": 0}
            info = (build_info(s, pages, match, lead=lead, near=near, name_hint=name_hint, caveat=caveat)
                    if match["ids"] else None)
        row = self._save(kind=kind, key=key, found=bool(info), mode="search", model="tavily", info=info, by=match["by"],
                         sources=[{"title": p["title"][:200], "url": p["url"]} for p in pages[:6]], ids=match["ids"],
                         user_id=user_id, started=started)
        log.info("Tra %s trên mạng (Tavily) → %s, %d trang, %s", kind, row.status, len(pages), match["by"])
        return self._response(kind, row, cached=False)

    @staticmethod
    def _unavailable(kind: str, reason: str, message: str) -> dict[str, Any]:
        return {"status": "not_configured" if reason == "not_configured" else "unavailable", "kind": kind, "mode": None,
                "model": None, "cached": False, "elapsed_ms": 0, "result": None, "sources": [], "catalog_matches": [],
                "message": message, "reason": reason, "notice": NOTICE}

    def _ask(self, kind: str, key: str, parts_web: list[dict[str, Any]], parts_offline: list[dict[str, Any]] | None,
             user_id: uuid.UUID | None) -> dict[str, Any]:
        cached = self._cached(key)
        if cached is not None:
            return self._response(kind, cached, cached=True)
        started = time.perf_counter()
        try:
            # Nhanh: tra mạng tối đa ~TOTAL_BUDGET giây cho mọi mô hình; phần còn lại dành cho chế độ chỉ đọc ảnh/mã.
            answer = self.client.generate(parts_web, system=SYSTEM, search=True, budget=TOTAL_BUDGET * 0.6)
            mode = "web"
        except GeminiError as exc:
            if parts_offline is None or exc.reason in ("not_configured", "auth"):
                return self._unavailable(kind, exc.reason, str(exc))
            try:  # chưa tra mạng được → AI chỉ đọc ảnh/nội dung mã (ghi rõ chế độ cho người dùng)
                left = max(6.0, TOTAL_BUDGET - (time.perf_counter() - started))
                answer = self.client.generate(parts_offline, system=SYSTEM, search=False, json_schema=JSON_SCHEMA, budget=left)
                mode = "offline"
            except GeminiError as exc2:
                return self._unavailable(kind, exc2.reason, str(exc2))
        info = _clean(parse_json_object(answer.text))
        found = bool(info and info["found"])
        with self.db.session() as s:
            matches = match_catalog(s, info) if found and info else []
            row = AiLookup(
                kind=kind, query_key=key[:160], status="found" if found else "not_found", mode=mode, model=answer.model[:64],
                result={**info, "_match_by": matches[0]["match_by"] if matches else None} if info else None,
                sources=answer.sources, catalog_ids=[m["id"] for m in matches], user_id=user_id,
                elapsed_ms=int((time.perf_counter() - started) * 1000), created_at=clock.now(),
            )
            s.add(row)
            s.flush()
            s.expunge(row)
        log.info("AI %s → %s (%s, %s, %d ms)", kind, row.status, mode, answer.model, row.elapsed_ms)
        return self._response(kind, row, cached=False)

    # ------------------------------------------------------------------ #
    def lookup_code(self, kind: str, code: str, *, user_id: uuid.UUID | None = None) -> dict[str, Any]:
        code = (code or "").strip()
        if kind == "barcode":
            parsed = parse_code(code)
            if parsed.kind != "gtin" or not parsed.gtin:
                return self._unavailable(kind, "invalid", parsed.message or "Mã vạch không hợp lệ.")
            shown = parsed.display
            key = f"barcode:{parsed.gtin}"
            cached = self._cached(key)
            if cached is not None:
                return self._response(kind, cached, cached=True)
            ai: dict[str, Any] | None = None
            # 1) AI + Google Search (khi bật Gemini và khóa còn hạn mức tìm kiếm). Mã vạch bắt buộc tra mạng → không đoán.
            if self.gemini_on and self.client.search_available():
                prompt = (f"Mã vạch (GTIN/EAN) in trên hộp thuốc: {shown}. Dùng Google Search tìm sản phẩm thuốc mang ĐÚNG mã vạch "
                          f"này (tìm cả chuỗi \"{shown}\"; ưu tiên trang nhà thuốc, nhà sản xuất, cơ sở dữ liệu thuốc Việt Nam). "
                          "Chỉ trả found=true khi nguồn ghi đúng mã vạch này cho sản phẩm đó.")
                ai = self._ask(kind, key, [{"text": prompt}], None, user_id)
                if ai["status"] == "found":
                    return ai
            # 2) Tìm kiếm web (Tavily) + quy tắc, không dùng AI.
            if self.search_on:
                return self._search_barcode(key, shown, user_id)
            if ai is not None:
                return ai
            if self.gemini_on:  # chỉ dùng Gemini nhưng khóa đang hết hạn mức tìm kiếm
                return self._unavailable(kind, "search_quota", self.client.last_error or
                                         "Gemini chưa cho phép tìm kiếm trên mạng (hết hạn mức Google Search của khóa API).")
            return self._no_source(kind)
        content = code[:1000]
        key = f"qr:{hashlib.sha256(content.encode('utf-8')).hexdigest()[:48]}"
        cached = self._cached(key)
        if cached is not None:
            return self._response("qr", cached, cached=True)
        local = self._qr_text(key, content, user_id)  # có số đăng ký trong mã → không cần AI hay mạng
        if local is not None:
            return local
        if self.gemini_on:
            web = (f"Nội dung mã QR in trên hộp/vỉ thuốc: \"{content}\". Xác định thuốc liên quan; nếu là đường link hoặc mã "
                   "của hãng, dùng Google Search để tìm thông tin sản phẩm.")
            offline = (f"Nội dung mã QR in trên hộp/vỉ thuốc: \"{content}\". Chỉ dựa vào nội dung này (không tra mạng) để "
                       "nhận ra thuốc; không đủ thông tin thì found=false.")
            ai = self._ask("qr", key, [{"text": web}], [{"text": offline}], user_id)
            if ai["status"] == "found" or not self.search_on:
                return ai
        if self.search_on:
            if re.match(r"https?://\S+$", content.strip(), re.IGNORECASE):
                return self._search_text("qr", key, url=content.strip(), user_id=user_id)
            return self._search_text("qr", key, lines=lines_from_text(content), user_id=user_id)
        return self._no_source("qr")

    def lookup_scan(self, job_id: str, *, image: bytes | None, ocr_text: str, lines: list[dict[str, Any]] | None = None,
                    user_id: uuid.UUID | None = None) -> dict[str, Any]:
        key = f"scan:{job_id}"
        cached = self._cached(key)
        if cached is not None:
            return self._response("scan", cached, cached=True)
        if self.gemini_on:
            ai = self._ask_scan(key, image, ocr_text, user_id)
            if ai["status"] == "found" or not self.search_on:
                return ai
        if self.search_on:
            ocr_lines = [OcrLine(text=str(ln.get("text") or ""), score=ln.get("score"),
                                 box=tuple(ln["box"]) if isinstance(ln.get("box"), list | tuple) and len(ln["box"]) == 4 else None)
                         for ln in lines or [] if isinstance(ln, dict)] or lines_from_text(ocr_text)
            return self._search_text("scan", key, lines=ocr_lines, user_id=user_id)
        return self._no_source("scan")

    def _ask_scan(self, key: str, image: bytes | None, ocr_text: str, user_id: uuid.UUID | None) -> dict[str, Any]:
        text = (ocr_text or "").strip()[:1500] or "(không đọc được chữ)"
        parts_image: list[dict[str, Any]] = []
        if image:
            try:  # thu nhỏ để gửi nhanh (≤ 1280 px)
                small = preprocess.encode_jpeg(preprocess.limit_size(preprocess.decode_image(image), 1280), quality=85)
                parts_image = [{"inline_data": {"mime_type": "image/jpeg", "data": base64.b64encode(small).decode("ascii")}}]
            except Exception:  # noqa: BLE001 — vẫn hỏi bằng chữ OCR
                parts_image = []
        web = (f"Ảnh chụp hộp/vỉ thuốc kèm chữ đọc được bằng OCR:\n{text}\n\nHệ thống KHÔNG tìm thấy thuốc phù hợp trong danh "
               "mục của Cục Quản lý Dược. Hãy đọc kỹ chữ trên ảnh, xác định thuốc và dùng Google Search để kiểm chứng "
               "(ưu tiên số đăng ký và nhà sản xuất in trên bao bì).")
        offline = (f"Ảnh chụp hộp/vỉ thuốc kèm chữ đọc được bằng OCR:\n{text}\n\nChỉ dựa vào chữ và hình trên ảnh (không tra "
                   "mạng) để xác định thuốc; chữ không rõ thì found=false.")
        return self._ask("scan", key, [*parts_image, {"text": web}], [*parts_image, {"text": offline}], user_id)
