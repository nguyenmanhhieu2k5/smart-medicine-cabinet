"""Giọng đọc tiếng Việt tự nhiên cho ứng dụng Windows (Piper vi_VN-vais1000 qua sherpa-onnx)."""
from __future__ import annotations

import io
import threading
import wave

import pytest
from fastapi.testclient import TestClient

from app.services import tts as tts_module
from app.services.tts import TtsService, spoken_text


@pytest.mark.parametrize("raw,spoken", [
    ("Augmentin 625mg", "Augmentin 625 mi-li-gam"),
    ("Hàm lượng: 500mg/125mg", "Hàm lượng: 500 mi-li-gam, 125 mi-li-gam"),
    ("Hộp 2 vỉ x 7 viên", "Hộp 2 vỉ, mỗi vỉ 7 viên"),
    ("SĐK: VN-20169-16", "số đăng ký: VN-20169-16"),
    ("HSD 15/06/2027", "hạn sử dụng ngày 15 tháng 6 năm 2027"),
    ("HSD 06/2027", "hạn sử dụng tháng 6 năm 2027"),
    ("Vitamin D3 400IU; Povidon 10%; siro 5ml", "Vitamin D3 400 đơn vị quốc tế; Povidon 10 phần trăm; siro 5 mi-li-lít"),
    ("Mã 13/2027 sai tháng", "Mã 13, 2027 sai tháng"),  # tháng 13 không phải ngày → không đọc thành ngày
])
def test_spoken_text_reads_units_dates_and_abbreviations(raw, spoken):
    assert spoken_text(raw) == spoken


class FakeAudio:
    samples = [0.0, 0.5, -0.5, 1.5]  # 1.5 bị chặn về 1.0
    sample_rate = 22050


class FakeEngine:
    calls: list[tuple[str, float]] = []

    def generate(self, text, sid=0, speed=1.0):
        FakeEngine.calls.append((text, speed))
        return FakeAudio()


def test_synthesize_returns_wav_and_caches(settings, tmp_path, monkeypatch):
    model = tmp_path / tts_module.VOICE_DIR
    model.mkdir()
    (model / f"{tts_module.VOICE}.onnx").write_bytes(b"x")
    (model / "tokens.txt").write_text("x")
    settings.tts_model_dir = model
    service = TtsService(settings)
    monkeypatch.setattr(tts_module, "sherpa_onnx", object())
    monkeypatch.setattr(service, "_engine", lambda: FakeEngine())
    FakeEngine.calls = []
    assert service.status()["available"] is True
    data = service.synthesize("Augmentin 625mg", speed=3.0)  # tốc độ bị giới hạn 0.5–2.0
    with wave.open(io.BytesIO(data)) as w:
        assert (w.getnchannels(), w.getsampwidth(), w.getframerate(), w.getnframes()) == (1, 2, 22050, 4)
    assert FakeEngine.calls == [("Augmentin 625 mi-li-gam", 2.0)]
    assert service.synthesize("Augmentin 625mg", speed=2.0) == data and len(FakeEngine.calls) == 1  # lấy từ bộ đệm


def test_missing_model_falls_back_cleanly(settings, tmp_path):
    settings.tts_model_dir = tmp_path / "khong-co"
    service = TtsService(settings)
    status = service.status()
    assert status["available"] is False and status["reason"]
    service.warmup()  # không có mô hình → bỏ qua, không lỗi
    with pytest.raises(tts_module.TtsError):
        service.synthesize("Xin chào")


def test_warmup_loads_engine_in_background(settings, tmp_path, monkeypatch):
    model = tmp_path / tts_module.VOICE_DIR
    model.mkdir()
    (model / f"{tts_module.VOICE}.onnx").write_bytes(b"x")
    (model / "tokens.txt").write_text("x")
    settings.tts_model_dir = model
    service = TtsService(settings)
    monkeypatch.setattr(tts_module, "sherpa_onnx", object())
    loaded = threading.Event()
    monkeypatch.setattr(service, "_engine", lambda: loaded.set())
    service.warmup()
    assert loaded.wait(5)


def test_tts_api_requires_login_and_reports_status(client, admin_app):
    assert TestClient(admin_app).get("/api/tts/status").status_code == 401  # chưa đăng nhập
    status = client.get("/api/tts/status").json()
    assert {"available", "name", "license", "id"} <= set(status)
    r = client.post("/api/tts", json={"text": "Xin chào", "speed": 1.0})
    assert r.status_code in (200, 503)  # máy kiểm thử có thể không có mô hình giọng đọc
    if r.status_code == 200:
        assert r.headers["content-type"] == "audio/wav" and r.content[:4] == b"RIFF"
    assert client.post("/api/tts", json={"text": "", "speed": 1.0}).status_code == 422
    assert client.post("/api/tts", json={"text": "x", "speed": 5}).status_code == 422
