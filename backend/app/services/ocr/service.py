"""Dịch vụ quét thuốc: hàng đợi nền → tiền xử lý → OCR → đối chiếu danh mục.

API chỉ nhận ảnh và trả về mã công việc ngay lập tức; mọi xử lý nặng chạy trên
một luồng nền duy nhất nên giao diện không bị đứng và CPU không bị dùng song
song quá mức. Kết quả không bao giờ được tự động lưu vào tủ thuốc.
"""
from __future__ import annotations

import logging
import queue
import threading
import time
import uuid
from dataclasses import dataclass, field
from datetime import timedelta
from pathlib import Path
from typing import Any, Callable, Sequence

import numpy as np

from app.core import clock
from app.database.session import Database
from app.schemas.settings import AppSettings
from app.services import history, settings_store
from app.services.alerts import engine as alert_engine
from app.services.medicine_matcher.catalog import CatalogRepository
from app.services.medicine_matcher.matcher import MedicineMatcher, OcrLine
from app.services.ocr import preprocess
from app.services.ocr.engine import OcrConfig, OcrEngine, OcrEngineError, OcrOutput, PaddleOcrEngine
from app.services.ocr.expiry import extract_expiry

log = logging.getLogger("smc.ocr")

MAX_JOBS_KEPT = 20
JOB_TTL = timedelta(hours=6)
GOOD_MEAN_SCORE = 0.88
GOOD_MIN_LINES = 1
ROTATE_BELOW_SCORE = 0.8
IMPROVEMENT_FACTOR = 1.08  # biến thể phải tốt hơn ảnh gốc ≥ 8% mới được chọn
SKEW_MIN_DEG = 7.0

PREPROCESS_LABELS = {
    "original": "Ảnh gốc",
    "contrast": "Tăng tương phản",
    "denoise": "Giảm nhiễu",
    "rotate_90": "Xoay 90°",
    "rotate_180": "Xoay 180°",
    "rotate_270": "Xoay 270°",
    "deskew": "Nắn nghiêng",
}


@dataclass
class OcrJob:
    id: str
    source: str
    status: str = "queued"  # queued | preprocessing | recognizing | matching | done | error
    progress: int = 0
    message: str = "Đang chờ xử lý"
    created_at: Any = field(default_factory=clock.now)
    finished_at: Any = None
    image_path: Path | None = None
    result: dict[str, Any] | None = None
    error: str | None = None
    crop: Sequence[float] | None = None

    def public(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "source": self.source,
            "status": self.status,
            "progress": self.progress,
            "message": self.message,
            "created_at": self.created_at.isoformat(),
            "finished_at": self.finished_at.isoformat() if self.finished_at else None,
            "has_image": bool(self.image_path and self.image_path.exists()),
            "result": self.result,
            "error": self.error,
        }


def recognize_best(
    engine: OcrEngine,
    image: np.ndarray,
    *,
    auto_enhance: bool = True,
    on_stage: Callable[[str], None] | None = None,
) -> tuple[OcrOutput, str, list[dict[str, Any]]]:
    """OCR ảnh gốc; chỉ thử biến thể tiền xử lý khi kết quả gốc chưa tốt.

    Trả về (kết quả tốt nhất, tên biến thể được chọn, nhật ký các lần thử).
    """
    attempts: list[dict[str, Any]] = []

    def run(name: str, img: np.ndarray) -> OcrOutput:
        if on_stage:
            on_stage(name)
        out = engine.recognize(img)
        attempts.append(
            {"variant": name, "lines": len(out.lines), "quality": round(out.quality(), 1),
             "mean_score": round(out.mean_score(), 3), "elapsed_ms": out.elapsed_ms}
        )
        return out

    def is_good(out: OcrOutput) -> bool:
        return len(out.lines) >= GOOD_MIN_LINES and out.mean_score() >= GOOD_MEAN_SCORE

    best, best_name = run("original", image), "original"
    if is_good(best) or not auto_enhance:
        return best, best_name, attempts

    best_image = image
    variants: list[tuple[str, Callable[[], np.ndarray]]] = [("contrast", lambda: preprocess.enhance_contrast(image))]
    if preprocess.sharpness(image) > 900:  # ảnh nhiễu hạt → thử khử nhiễu
        variants.append(("denoise", lambda: preprocess.denoise(image)))
    # Ảnh có thể bị xoay: chữ lộn ngược thường cho độ tin cậy thấp hoặc không ra chữ.
    if not best.lines or best.mean_score() < ROTATE_BELOW_SCORE:
        variants += [
            ("rotate_180", lambda: preprocess.rotate_quarter(image, 2)),
            ("rotate_90", lambda: preprocess.rotate_quarter(image, 1)),
            ("rotate_270", lambda: preprocess.rotate_quarter(image, 3)),
        ]
    base_quality = best.quality()
    for name, make in variants:
        candidate_image = make()
        out = run(name, candidate_image)
        if out.quality() > max(base_quality * IMPROVEMENT_FACTOR, best.quality()):
            best, best_name, best_image = out, name, candidate_image
            if is_good(out):
                break
    if is_good(best):
        return best, best_name, attempts
    return _maybe_deskew(engine, best_image, best, best_name, attempts, run)


def _maybe_deskew(engine, image, best, best_name, attempts, run):  # noqa: ANN001
    angle = preprocess.skew_angle(best.polys)
    if SKEW_MIN_DEG <= abs(angle) <= 45:
        out = run("deskew", preprocess.rotate_angle(image, angle))
        if out.quality() > best.quality() * IMPROVEMENT_FACTOR:
            return out, ("deskew" if best_name == "original" else f"{best_name}+deskew"), attempts
    return best, best_name, attempts


class OcrService:
    def __init__(
        self,
        db: Database,
        uploads_dir: Path,
        cache_dir: Path,
        model_roots: list[Path],
        engine_factory: Callable[[OcrConfig], OcrEngine] | None = None,
        enabled: bool = True,
    ):
        self.db = db
        self.uploads_dir = uploads_dir
        self.cache_dir = cache_dir
        self.model_roots = model_roots
        self.enabled = enabled
        self._engine_factory = engine_factory or (lambda cfg: PaddleOcrEngine(cfg, model_roots, cache_dir))
        self._engine: OcrEngine | None = None
        self._engine_config: OcrConfig | None = None
        self._engine_state = "not_loaded" if enabled else "disabled"  # not_loaded | loading | ready | error | disabled
        self._engine_error: str | None = None
        self._jobs: dict[str, OcrJob] = {}
        self._queue: queue.Queue[str | None] = queue.Queue()
        self._lock = threading.Lock()
        self._worker: threading.Thread | None = None

    # ---- cấu hình --------------------------------------------------------- #
    @staticmethod
    def config_from(settings: AppSettings) -> OcrConfig:
        return OcrConfig(
            engine=settings.ocr_engine,
            profile=settings.ocr_profile,
            det_limit_side_len=settings.ocr_det_limit_side_len,
            use_textline_orientation=settings.ocr_use_textline_orientation,
            cpu_threads=settings.ocr_cpu_threads,
            device=settings.ocr_device,
        )

    def _settings(self) -> AppSettings:
        with self.db.session() as s:
            return settings_store.load_settings(s)

    def _get_engine(self, settings: AppSettings) -> OcrEngine:
        if not self.enabled:
            raise OcrEngineError("OCR đang tắt trong cấu hình này.")
        config = self.config_from(settings)
        with self._lock:
            if self._engine is None or config != self._engine_config:
                if self._engine is not None and hasattr(self._engine, "close"):
                    self._engine.close()  # type: ignore[attr-defined]
                self._engine = self._engine_factory(config)
                self._engine_config = config
                self._engine_state = "not_loaded"
            engine = self._engine
        if hasattr(engine, "load") and not getattr(engine, "is_loaded", lambda: True)():
            self._engine_state = "loading"
            try:
                engine.load()  # type: ignore[attr-defined]
            except Exception as exc:
                self._engine_state, self._engine_error = "error", str(exc)
                raise
        self._engine_state, self._engine_error = "ready", None
        return engine

    def status(self) -> dict[str, Any]:
        info: dict[str, Any] = {}
        if self._engine is not None:
            try:
                info = self._engine.info()
            except Exception:
                info = {}
        return {
            "state": self._engine_state,
            "error": self._engine_error,
            "dependencies": PaddleOcrEngine.dependency_status(),
            "engine": info,
            "queue_size": self._queue.qsize(),
        }

    def warmup(self) -> None:
        """Nạp mô hình ở nền để lần quét đầu tiên không phải chờ."""
        if not self.enabled:
            return

        def _run() -> None:
            try:
                self._get_engine(self._settings())
            except Exception as exc:  # trạng thái lỗi đã được ghi lại
                log.warning("Không nạp sẵn được OCR: %s", exc)

        threading.Thread(target=_run, name="ocr-warmup", daemon=True).start()

    # ---- công việc -------------------------------------------------------- #
    def submit(self, data: bytes, source: str = "upload", crop: Sequence[float] | None = None) -> OcrJob:
        image = preprocess.decode_image(data)  # ném ImageError nếu không phải ảnh
        job = OcrJob(id=uuid.uuid4().hex[:16], source=source, crop=crop)
        self.uploads_dir.mkdir(parents=True, exist_ok=True)
        image = preprocess.crop_relative(preprocess.limit_size(image), crop)
        job.image_path = self.uploads_dir / f"scan_{job.id}.jpg"
        job.image_path.write_bytes(preprocess.encode_jpeg(image))
        with self._lock:
            self._jobs[job.id] = job
        self._cleanup()
        self._ensure_worker()
        self._queue.put(job.id)
        with self.db.session() as s:
            history.record(
                s, "scan", "scan", "Quét thuốc",
                "Chụp từ camera" if source == "camera" else "Chọn ảnh từ máy tính",
                {"job_id": job.id, "source": source},
            )
        return job

    def get(self, job_id: str) -> OcrJob | None:
        return self._jobs.get(job_id)

    def _ensure_worker(self) -> None:
        if self._worker is None or not self._worker.is_alive():
            self._worker = threading.Thread(target=self._work, name="ocr-worker", daemon=True)
            self._worker.start()

    def _work(self) -> None:
        while True:
            job_id = self._queue.get()
            if job_id is None:
                return
            job = self._jobs.get(job_id)
            if job is None:
                continue
            try:
                self._process(job)
            except Exception as exc:  # không để luồng nền chết
                log.exception("OCR job %s lỗi", job_id)
                self._fail(job, str(exc) if isinstance(exc, (OcrEngineError, preprocess.ImageError)) else f"Lỗi không mong muốn: {exc}")

    def _update(self, job: OcrJob, status: str, progress: int, message: str) -> None:
        job.status, job.progress, job.message = status, progress, message

    def _fail(self, job: OcrJob, message: str) -> None:
        job.status, job.error, job.message, job.progress = "error", message, "Nhận diện thất bại", 100
        job.finished_at = clock.now()
        try:
            with self.db.session() as s:
                alert_engine.raise_system(s, "ocr_error", message)
                history.record(s, "scan", "ocr_failed", "OCR gặp lỗi", message, {"job_id": job.id})
        except Exception:
            log.exception("Không ghi được lỗi OCR")

    def _process(self, job: OcrJob) -> None:
        started = time.perf_counter()
        settings = self._settings()
        self._update(job, "preprocessing", 10, "Đang chuẩn bị ảnh")
        assert job.image_path is not None
        image = preprocess.decode_image(job.image_path.read_bytes())
        image_info = {
            "width": int(image.shape[1]), "height": int(image.shape[0]),
            "sharpness": round(preprocess.sharpness(image), 1), "brightness": round(preprocess.brightness(image), 1),
        }

        loading = self._engine is None or self._engine_state != "ready"
        self._update(job, "recognizing", 25, "Đang nạp mô hình OCR" if loading else "Đang nhận dạng chữ")
        engine = self._get_engine(settings)
        self._update(job, "recognizing", 40, "Đang nhận dạng chữ")

        def on_stage(name: str) -> None:
            if name != "original":
                self._update(job, "recognizing", min(75, job.progress + 8), f"Thử tiền xử lý: {PREPROCESS_LABELS.get(name, name)}")

        output, variant, attempts = recognize_best(engine, image, auto_enhance=settings.ocr_auto_enhance, on_stage=on_stage)

        self._update(job, "matching", 82, "Đang đối chiếu danh mục thuốc")
        with self.db.session() as s:
            repo = CatalogRepository(s)
            catalog_count = repo.count()
            match = MedicineMatcher(repo).match(output.lines)
            if catalog_count == 0:
                match["status"] = "no_catalog"
                match["message"] = "Chưa nhập danh mục thuốc. Hãy nhập file Excel trong Cài đặt."
            top = match["candidates"][0] if match["candidates"] else None
            history.record(
                s, "scan", "ocr_completed", "OCR hoàn thành",
                (f"Ứng viên tốt nhất: {top['medicine']['ten_thuoc']}" if top else "Không có ứng viên phù hợp")
                + f" · {len(output.lines)} dòng chữ",
                {"job_id": job.id, "status": match["status"], "lines": len(output.lines),
                 "top_id": top["medicine"]["id"] if top else None},
            )
            alert_engine.resolve_system(s, "ocr_error")

        variant_label = " + ".join(PREPROCESS_LABELS.get(v, v) for v in variant.split("+"))
        job.result = {
            "ocr": {
                "lines": [
                    {"text": ln.text, "score": None if ln.score is None else round(ln.score, 4),
                     "box": None if ln.box is None else [round(v, 1) for v in ln.box]}
                    for ln in output.lines
                ],
                "line_count": len(output.lines),
                "mean_score": round(output.mean_score(), 3),
                "preprocess": variant,
                "preprocess_label": variant_label,
                "attempts": attempts,
                "engine": engine.info(),
            },
            "image": image_info,
            "expiry_suggestion": extract_expiry([ln.text for ln in output.lines]),
            "match": match,
            "elapsed_ms": int((time.perf_counter() - started) * 1000),
        }
        self._update(job, "done", 100, "Hoàn tất")
        job.finished_at = clock.now()

    # ---- dọn dẹp ---------------------------------------------------------- #
    def _cleanup(self) -> None:
        now = clock.now()
        with self._lock:
            jobs = sorted(self._jobs.values(), key=lambda j: j.created_at)
            stale = [j for j in jobs if now - j.created_at > JOB_TTL]
            extra = jobs[: max(0, len(jobs) - MAX_JOBS_KEPT)]
            for job in {j.id: j for j in stale + extra}.values():
                if job.status in ("queued", "preprocessing", "recognizing", "matching"):
                    continue
                self._jobs.pop(job.id, None)
                self._delete_image(job)

    @staticmethod
    def _delete_image(job: OcrJob) -> None:
        if job.image_path:
            try:
                job.image_path.unlink(missing_ok=True)
            except OSError:
                pass

    def purge_orphan_uploads(self) -> int:
        """Xóa ảnh quét tạm còn sót từ lần chạy trước."""
        removed = 0
        if not self.uploads_dir.is_dir():
            return 0
        known = {j.image_path for j in self._jobs.values()}
        for path in self.uploads_dir.glob("scan_*.jpg"):
            if path not in known:
                try:
                    path.unlink()
                    removed += 1
                except OSError:
                    pass
        return removed

    def shutdown(self) -> None:
        self._queue.put(None)
        if self._engine is not None and hasattr(self._engine, "close"):
            try:
                self._engine.close()  # type: ignore[attr-defined]
            except Exception:
                pass
