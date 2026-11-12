"""Bao bọc PaddleOCR 3.x (đã đối chiếu với mã nguồn paddleocr 3.7.0 / paddlex 3.7.2).

Các điểm API của phiên bản này mà module dựa vào:

* ``PaddleOCR(...).predict(ndarray)`` trả về list các ``OCRResult`` (dict-like)
  với khóa ``rec_texts``, ``rec_scores``, ``rec_polys``, ``rec_boxes``.
  (``ocr.ocr()`` và tham số ``cls=``/``use_angle_cls`` đã lỗi thời.)
* Tham số chung: ``device``, ``engine``, ``cpu_threads``, ``enable_mkldnn``…
* ``engine="onnxruntime"`` chạy mô hình ONNX chính thức (gói ``<tên>_onnx``)
  bằng ONNX Runtime trên CPU, không cần cài PaddlePaddle. ``engine="paddle"`` dùng
  PaddlePaddle; với bản ``paddlepaddle-gpu`` và card NVIDIA thì chạy GPU (``device="gpu:0"``).
* PaddlePaddle 3.3 chạy CPU với oneDNN (``enable_mkldnn=True``, mặc định) bị lỗi
  ``ConvertPirAttribute2RuntimeAttribute not support`` với mô hình PP-OCRv6 → khi Paddle chạy CPU
  module tắt oneDNN (chậm hơn nhưng đúng).
* Mô hình được tìm trong ``<PADDLE_PDX_CACHE_HOME>/official_models``; nếu đã có
  sẵn thì không cần mạng. Truyền ``*_model_dir`` để dùng thư mục mô hình kèm
  theo bản cài đặt.

Module không import paddleocr ở mức module để backend khởi động nhanh và để
kiểm thử có thể chạy khi không có OCR.
"""
from __future__ import annotations

import importlib.metadata
import importlib.util
import logging
import os
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Protocol

import numpy as np

from app.services.medicine_matcher.matcher import OcrLine

log = logging.getLogger("smc.ocr")

# Hồ sơ mô hình: (phát hiện chữ, nhận dạng chữ)
PROFILES: dict[str, tuple[str, str, str]] = {
    "v6_small": ("PP-OCRv6_small_det", "PP-OCRv6_small_rec", "PP-OCRv6 small — cân bằng, khuyến nghị cho CPU"),
    "v6_tiny": ("PP-OCRv6_tiny_det", "PP-OCRv6_tiny_rec", "PP-OCRv6 tiny — nhanh nhất, kém chính xác hơn"),
    "v6_medium": ("PP-OCRv6_medium_det", "PP-OCRv6_medium_rec", "PP-OCRv6 medium — chính xác hơn, chậm trên CPU"),
    "v5_latin": ("PP-OCRv5_mobile_det", "latin_PP-OCRv5_mobile_rec", "PP-OCRv5 mobile + bộ nhận dạng chữ Latin"),
}
TEXTLINE_ORI_MODEL = "PP-LCNet_x0_25_textline_ori"


class OcrEngineError(RuntimeError):
    """Lỗi có thể hiển thị cho người dùng (thiếu thư viện, thiếu mô hình…)."""


@dataclass
class OcrConfig:
    engine: str = "onnxruntime"  # onnxruntime | paddle
    profile: str = "v6_small"
    det_limit_side_len: int = 960
    use_textline_orientation: bool = False
    cpu_threads: int = 0  # 0 = tự chọn
    device: str = "auto"  # auto | gpu | cpu — chỉ có tác dụng với engine "paddle"

    @property
    def model_names(self) -> tuple[str, str]:
        det, rec, _ = PROFILES.get(self.profile, PROFILES["v6_small"])
        return det, rec


def paddle_gpu_status() -> tuple[bool, str]:
    """(dùng được GPU không, tên GPU hoặc lý do không dùng được). Có import paddle — chỉ gọi khi dùng engine Paddle."""
    try:
        import paddle
    except Exception as exc:  # noqa: BLE001 — thiếu DLL, sai phiên bản…
        return False, f"không nạp được PaddlePaddle: {exc}"
    try:
        if not paddle.device.is_compiled_with_cuda():
            return False, "PaddlePaddle bản CPU, không có CUDA"
        if paddle.device.cuda.device_count() < 1:
            return False, "không tìm thấy GPU NVIDIA"
        return True, str(paddle.device.cuda.get_device_name(0))
    except Exception as exc:  # noqa: BLE001 — thiếu driver NVIDIA…
        return False, f"không khởi tạo được GPU: {exc}"


def choose_device(engine: str, requested: str, gpu_status: tuple[bool, str] | None = None) -> tuple[str, str | None]:
    """Chọn thiết bị thật sự dùng → (thiết bị cho PaddleOCR, ghi chú cho người dùng nếu không như yêu cầu).

    ONNX Runtime trong ứng dụng là bản CPU nên luôn chạy CPU. Engine Paddle: ``auto``/``gpu`` dùng GPU nếu có,
    không thì lùi về CPU (``gpu`` kèm ghi chú vì người dùng đã chủ động chọn GPU).
    """
    if engine != "paddle" or requested == "cpu":
        return "cpu", None
    ok, detail = gpu_status if gpu_status is not None else paddle_gpu_status()
    if ok:
        return "gpu:0", None
    return "cpu", (f"Không dùng được GPU ({detail}) — đang chạy CPU." if requested == "gpu" else None)


def _probe_image() -> np.ndarray:
    """Ảnh nhỏ có chữ để chạy thử pipeline ngay khi nạp (phát hiện GPU không tương thích trước lần quét đầu)."""
    import cv2

    image = np.full((48, 240, 3), 255, dtype=np.uint8)
    cv2.putText(image, "OCR 125mg", (8, 34), cv2.FONT_HERSHEY_SIMPLEX, 0.9, (0, 0, 0), 2)
    return image


@dataclass
class OcrOutput:
    lines: list[OcrLine]
    polys: list[list[list[float]]] = field(default_factory=list)
    elapsed_ms: int = 0

    def quality(self) -> float:
        """Điểm chất lượng để so sánh giữa các biến thể tiền xử lý.

        Tổng (độ tin cậy × số ký tự chữ/số, tối đa 30) của các dòng tin cậy ≥ 0,6.
        """
        total = 0.0
        for line in self.lines:
            score = line.score if line.score is not None else 0.0
            if score < 0.6:
                continue
            chars = sum(ch.isalnum() for ch in line.text)
            total += score * min(chars, 30)
        return total

    def mean_score(self) -> float:
        scores = [ln.score for ln in self.lines if ln.score is not None]
        return float(sum(scores) / len(scores)) if scores else 0.0


class OcrEngine(Protocol):
    def recognize(self, image: np.ndarray) -> OcrOutput: ...

    def info(self) -> dict[str, Any]: ...


def default_cpu_threads() -> int:
    cores = os.cpu_count() or 2
    return max(1, min(4, cores - 1 if cores > 2 else cores))


def _distribution_installed(name: str) -> bool:
    try:
        importlib.metadata.version(name)
        return True
    except importlib.metadata.PackageNotFoundError:
        return False


def find_model_dir(name: str, engine: str, roots: list[Path]) -> Path | None:
    """Tìm thư mục mô hình có sẵn trên đĩa (kèm bản cài hoặc đã tải trước)."""
    wanted_file = "inference.onnx" if engine == "onnxruntime" else "inference.pdiparams"
    variants = [f"{name}_onnx", name] if engine == "onnxruntime" else [name]
    for root in roots:
        if not root:
            continue
        for base in (root, root / "official_models"):
            for variant in variants:
                candidate = base / variant
                if (candidate / wanted_file).is_file() and (candidate / "inference.yml").is_file():
                    return candidate
    return None


class PaddleOcrEngine:
    """PaddleOCR nạp lười, an toàn luồng (mỗi lần chỉ một ảnh được xử lý)."""

    def __init__(self, config: OcrConfig, model_roots: list[Path], cache_dir: Path):
        self.config = config
        self.model_roots = model_roots
        self.cache_dir = cache_dir
        self._pipeline: Any = None
        self._lock = threading.Lock()
        self._load_seconds: float | None = None
        self._model_sources: dict[str, str] = {}
        self._version: str | None = None
        self._device: str | None = None  # thiết bị thật sự dùng sau khi nạp
        self._gpu_name: str | None = None
        self._device_note: str | None = None

    # ------------------------------------------------------------------ #
    @staticmethod
    def dependency_status() -> dict[str, bool]:
        return {
            "paddleocr": importlib.util.find_spec("paddleocr") is not None,
            "onnxruntime": importlib.util.find_spec("onnxruntime") is not None,
            "paddle": importlib.util.find_spec("paddle") is not None,
            "paddle_gpu": _distribution_installed("paddlepaddle-gpu"),
        }

    def models_available_offline(self) -> bool:
        roots = self.model_roots + [self.cache_dir]
        return all(find_model_dir(name, self.config.engine, roots) is not None for name in self.config.model_names)

    def is_loaded(self) -> bool:
        return self._pipeline is not None

    def load(self) -> None:
        """Nạp pipeline (tải mô hình lần đầu nếu chưa có sẵn — cần Internet)."""
        with self._lock:
            if self._pipeline is not None:
                return
            deps = self.dependency_status()
            if not deps["paddleocr"]:
                raise OcrEngineError("Chưa cài thư viện paddleocr (pip install paddleocr).")
            if self.config.engine == "onnxruntime" and not deps["onnxruntime"]:
                raise OcrEngineError("Chưa cài onnxruntime (pip install onnxruntime).")
            if self.config.engine == "paddle" and not deps["paddle"]:
                raise OcrEngineError(
                    "Engine “paddle” cần PaddlePaddle (pip install paddlepaddle). "
                    "Hãy cài thêm hoặc chọn engine “onnxruntime” trong Cài đặt."
                )

            # Phải đặt trước khi import paddlex.
            self.cache_dir.mkdir(parents=True, exist_ok=True)
            os.environ.setdefault("PADDLE_PDX_CACHE_HOME", str(self.cache_dir))
            os.environ.setdefault("PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK", "True")

            started = time.perf_counter()
            det_name, rec_name = self.config.model_names
            roots = self.model_roots + [self.cache_dir]
            det_dir = find_model_dir(det_name, self.config.engine, roots)
            rec_dir = find_model_dir(rec_name, self.config.engine, roots)
            kwargs: dict[str, Any] = dict(
                engine=self.config.engine,
                cpu_threads=self.config.cpu_threads or default_cpu_threads(),
                text_detection_model_name=det_name,
                text_recognition_model_name=rec_name,
                use_doc_orientation_classify=False,
                use_doc_unwarping=False,
                use_textline_orientation=bool(self.config.use_textline_orientation),
                text_det_limit_side_len=int(self.config.det_limit_side_len),
                text_det_limit_type="max",
            )
            if det_dir is not None:
                kwargs["text_detection_model_dir"] = str(det_dir)
            if rec_dir is not None:
                kwargs["text_recognition_model_dir"] = str(rec_dir)
            if self.config.use_textline_orientation:
                kwargs["textline_orientation_model_name"] = TEXTLINE_ORI_MODEL
                ori_dir = find_model_dir(TEXTLINE_ORI_MODEL, self.config.engine, roots)
                if ori_dir is not None:
                    kwargs["textline_orientation_model_dir"] = str(ori_dir)
            self._model_sources = {
                det_name: str(det_dir) if det_dir else "tải về bộ nhớ đệm khi nạp",
                rec_name: str(rec_dir) if rec_dir else "tải về bộ nhớ đệm khi nạp",
            }
            gpu_status: tuple[bool, str] | None = None
            if self.config.engine == "paddle" and self.config.device != "cpu":
                gpu_status = paddle_gpu_status()
            device, note = choose_device(self.config.engine, self.config.device, gpu_status)
            try:
                import paddleocr
                from paddleocr import PaddleOCR

                self._version = getattr(paddleocr, "__version__", None)
                try:
                    self._pipeline = self._create_pipeline(PaddleOCR, kwargs, device)
                except Exception as exc:
                    if device == "cpu":
                        raise
                    # GPU có nhưng không chạy được mô hình (kiến trúc không hỗ trợ, thiếu DLL CUDA, hết VRAM…).
                    log.warning("Không chạy được OCR trên GPU (%s) — chuyển sang CPU.", exc)
                    device, note = "cpu", f"GPU không chạy được mô hình ({exc}) — đang chạy CPU."
                    self._pipeline = self._create_pipeline(PaddleOCR, kwargs, device)
            except OcrEngineError:
                raise
            except Exception as exc:
                missing = [n for n, d in ((det_name, det_dir), (rec_name, rec_dir)) if d is None]
                hint = ""
                if missing:
                    hint = (
                        " Mô hình " + ", ".join(missing) + " chưa có trên máy; lần chạy đầu cần Internet để tải, "
                        "hoặc chạy scripts/download_ocr_models.py để tải sẵn."
                    )
                raise OcrEngineError(f"Không khởi tạo được PaddleOCR: {exc}.{hint}") from exc
            self._device, self._device_note = device, note
            self._gpu_name = gpu_status[1] if gpu_status and gpu_status[0] and device != "cpu" else None
            self._load_seconds = round(time.perf_counter() - started, 2)
            where = f"GPU {self._gpu_name}" if self._gpu_name else "CPU"
            log.info("PaddleOCR %s sẵn sàng sau %.2fs (%s, %s)", self._version, self._load_seconds, self.config.engine, where)
            if note:
                log.warning(note)

    def _create_pipeline(self, factory: Any, kwargs: dict[str, Any], device: str) -> Any:
        options = {**kwargs, "device": device}
        if self.config.engine == "paddle" and device == "cpu":
            options["enable_mkldnn"] = False  # tránh lỗi oneDNN của PaddlePaddle 3.3 với PP-OCRv6 (xem đầu module)
        pipeline = factory(**options)
        if device != "cpu":
            try:
                pipeline.predict(_probe_image())  # lỗi GPU lộ ra ngay khi nạp, không đợi tới lần quét đầu
            except Exception:
                try:
                    pipeline.close()
                except Exception:  # noqa: BLE001
                    pass
                raise
        return pipeline

    # ------------------------------------------------------------------ #
    def recognize(self, image: np.ndarray) -> OcrOutput:
        """OCR một ảnh BGR (ndarray). Giữ nguyên văn bản gốc, độ tin cậy và vị trí."""
        self.load()
        started = time.perf_counter()
        with self._lock:
            try:
                results = self._pipeline.predict(image)
            except Exception as exc:
                raise OcrEngineError(f"PaddleOCR xử lý ảnh thất bại: {exc}") from exc
        lines: list[OcrLine] = []
        polys: list[list[list[float]]] = []
        for res in results or []:
            texts = list(res.get("rec_texts") or [])
            scores = list(res.get("rec_scores") if res.get("rec_scores") is not None else [])
            rec_polys = res.get("rec_polys")
            rec_polys = list(rec_polys) if rec_polys is not None else []
            for index, text in enumerate(texts):
                if not text or not str(text).strip():
                    continue
                score = float(scores[index]) if index < len(scores) else None
                box = None
                if index < len(rec_polys):
                    pts = np.asarray(rec_polys[index], dtype=np.float32).reshape(-1, 2)
                    polys.append(pts.tolist())
                    # Chiều cao chữ thật = cạnh ngắn của tứ giác (đúng cả khi chữ bị nghiêng).
                    if len(pts) >= 4:
                        edge_a = float(np.hypot(*(pts[1] - pts[0])))
                        edge_b = float(np.hypot(*(pts[3] - pts[0])))
                        height = min(edge_a, edge_b)
                        x1, y1 = float(pts[:, 0].min()), float(pts[:, 1].min())
                        x2 = float(pts[:, 0].max())
                        box = (x1, y1, x2, y1 + height)
                lines.append(OcrLine(text=str(text), score=score, box=box))
        return OcrOutput(lines=lines, polys=polys, elapsed_ms=int((time.perf_counter() - started) * 1000))

    def info(self) -> dict[str, Any]:
        det, rec = self.config.model_names
        return {
            "library": "PaddleOCR",
            "version": self._version,
            "engine": self.config.engine,
            "profile": self.config.profile,
            "detection_model": det,
            "recognition_model": rec,
            "device_requested": self.config.device,
            "device": self._device,  # thiết bị thật sự dùng (None khi chưa nạp): "gpu:0" | "cpu"
            "gpu_name": self._gpu_name,
            "device_note": self._device_note,
            "loaded": self.is_loaded(),
            "load_seconds": self._load_seconds,
            "model_sources": self._model_sources,
            "models_available_offline": self.models_available_offline(),
        }

    def close(self) -> None:
        with self._lock:
            if self._pipeline is not None:
                try:
                    self._pipeline.close()
                except Exception:
                    pass
                self._pipeline = None
                self._device = self._gpu_name = self._device_note = None
