"""Giọng đọc tiếng Việt TỰ NHIÊN (neural) cho ứng dụng Windows — chạy offline trên Mini PC.

Windows 10 chỉ có giọng "Microsoft An" đời cũ (khó nghe). Máy chủ đọc bằng mô hình Piper `vi_VN-vais1000-medium`
(giấy phép CC BY 4.0, dữ liệu VAIS-1000) qua thư viện sherpa-onnx (Apache-2.0, CPU, ~0,06 giây cho 1 giây tiếng),
trả file WAV cho ứng dụng phát. Không cần Internet hay khóa API.

Thiếu thư viện hoặc thiếu mô hình → `available = False`, ứng dụng tự dùng giọng của Windows như trước.
Tải mô hình: `python scripts/download_tts_model.py` (vào <data_dir>/tts).
"""
from __future__ import annotations

import io
import logging
import re
import threading
import wave
from collections import OrderedDict
from pathlib import Path
from typing import Any

import numpy as np

from app.core.config import Settings

log = logging.getLogger("smc.tts")

try:  # thư viện tùy chọn
    import sherpa_onnx
except ImportError:  # pragma: no cover
    sherpa_onnx = None

VOICE = "vi_VN-vais1000-medium"
VOICE_DIR = f"vits-piper-{VOICE}"
VOICE_INFO = {
    "id": "server:vi_VN-vais1000",
    "name": "Giọng tự nhiên tiếng Việt (Piper · VAIS-1000)",
    "license": "CC BY 4.0 — VAIS-1000 Vietnamese Speech Synthesis Corpus",
}
MAX_CHARS = 1500
CACHE_SIZE = 32

# Đọc chữ viết tắt / đơn vị thường gặp trên hộp thuốc cho rõ (espeak-ng tự đọc số tiếng Việt).
_UNITS = [
    (r"(?<=\d)\s*(?:mcg|µg|μg)\b", " mi-crô-gam"),
    (r"(?<=\d)\s*mg\b", " mi-li-gam"),
    (r"(?<=\d)\s*ml\b", " mi-li-lít"),
    (r"(?<=\d)\s*(?:IU|UI)\b", " đơn vị quốc tế"),
    (r"(?<=\d)\s*kg\b", " ki-lô-gam"),
    (r"(?<=\d)\s*g\b", " gam"),
    (r"(?<=\d)\s*%", " phần trăm"),
]
_WORDS = [
    (r"\bSĐK\b|\bSDK\b", "số đăng ký"),
    (r"\bHSD\b", "hạn sử dụng"),
    (r"\bNSX\b", "ngày sản xuất"),
    (r"\bTP\.?\s*HCM\b", "thành phố Hồ Chí Minh"),
]


def _date(match: re.Match[str]) -> str:
    day, month, year = match.group("d"), int(match.group("m")), match.group("y")
    if not 1 <= month <= 12:
        return match.group(0)
    return (f"ngày {int(day)} " if day else "") + f"tháng {month} năm {year}"


def spoken_text(text: str) -> str:
    """Chuẩn hóa câu cho dễ nghe: ngày (15/06/2027 → ngày 15 tháng 6 năm 2027), đơn vị (mg → mi-li-gam),
    viết tắt (SĐK → số đăng ký), "2 vỉ x 7 viên" → "2 vỉ, mỗi vỉ 7 viên", "500mg/125mg" → "500 mi-li-gam, 125 mi-li-gam"."""
    out = " ".join(str(text or "").split())
    out = re.sub(r"(?<!\d)(?:(?P<d>\d{1,2})[/.-])?(?P<m>\d{1,2})[/.-](?P<y>(?:19|20)\d{2})(?!\d)", _date, out)
    for pattern, repl in _UNITS:
        out = re.sub(pattern, repl, out, flags=re.IGNORECASE)
    for pattern, repl in _WORDS:
        out = re.sub(pattern, repl, out)
    out = re.sub(r"(\d+)\s*(vỉ|gói|ống|lọ)\s*[x×]\s*(\d+)", r"\1 \2, mỗi \2 \3", out, flags=re.IGNORECASE)
    out = re.sub(r"\s*/\s*(?=\d)", ", ", out)  # 500 mi-li-gam/125 mi-li-gam → 500 mi-li-gam, 125 mi-li-gam
    return out[:MAX_CHARS]


def _wav(samples: np.ndarray, sample_rate: int) -> bytes:
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sample_rate)
        w.writeframes((np.clip(samples, -1.0, 1.0) * 32767).astype("<i2").tobytes())
    return buffer.getvalue()


class TtsError(Exception):
    pass


class TtsService:
    def __init__(self, settings: Settings):
        self.model_dir: Path = settings.tts_model_dir or (settings.data_dir / "tts" / VOICE_DIR)
        self._tts: Any = None
        self._lock = threading.Lock()
        self._cache: OrderedDict[tuple[str, float], bytes] = OrderedDict()

    @property
    def available(self) -> bool:
        return sherpa_onnx is not None and (self.model_dir / f"{VOICE}.onnx").is_file() and (self.model_dir / "tokens.txt").is_file()

    def status(self) -> dict[str, Any]:
        reason = None
        if sherpa_onnx is None:
            reason = "Chưa cài thư viện sherpa-onnx trên máy chủ."
        elif not self.available:
            reason = "Chưa tải mô hình giọng đọc (chạy scripts/download_tts_model.py trên Mini PC)."
        return {**VOICE_INFO, "available": self.available, "engine": "sherpa-onnx (Piper)", "reason": reason}

    def _engine(self) -> Any:
        if self._tts is None:
            d = self.model_dir
            config = sherpa_onnx.OfflineTtsConfig(
                model=sherpa_onnx.OfflineTtsModelConfig(
                    vits=sherpa_onnx.OfflineTtsVitsModelConfig(
                        model=str(d / f"{VOICE}.onnx"), tokens=str(d / "tokens.txt"), data_dir=str(d / "espeak-ng-data")),
                    num_threads=2, provider="cpu"),
                max_num_sentences=2,
            )
            self._tts = sherpa_onnx.OfflineTts(config)
            log.info("Đã nạp giọng đọc %s", VOICE)
        return self._tts

    def warmup(self) -> None:
        """Nạp mô hình ở luồng nền (không chặn khởi động). Lỗi chỉ ghi log — giọng Windows vẫn là dự phòng."""
        if not self.available:
            return

        def load() -> None:
            try:
                with self._lock:
                    self._engine()
            except Exception:  # noqa: BLE001
                log.exception("Không nạp được giọng đọc %s", VOICE)

        threading.Thread(target=load, name="tts-warmup", daemon=True).start()

    def synthesize(self, text: str, speed: float = 1.0) -> bytes:
        """WAV 22 kHz mono. speed 0.5–2.0 (1.0 = bình thường)."""
        if not self.available:
            raise TtsError(self.status()["reason"])
        spoken = spoken_text(text)
        if not spoken:
            raise TtsError("Không có nội dung để đọc.")
        speed = min(2.0, max(0.5, float(speed)))
        key = (spoken, round(speed, 2))
        with self._lock:  # một mô hình dùng chung → đọc lần lượt
            cached = self._cache.get(key)
            if cached is not None:
                self._cache.move_to_end(key)
                return cached
            audio = self._engine().generate(spoken, sid=0, speed=speed)
            samples = np.asarray(audio.samples, dtype=np.float32)
            if samples.size == 0:
                raise TtsError("Không tạo được giọng đọc cho đoạn này.")
            data = _wav(samples, int(audio.sample_rate))
            self._cache[key] = data
            while len(self._cache) > CACHE_SIZE:
                self._cache.popitem(last=False)
            return data
