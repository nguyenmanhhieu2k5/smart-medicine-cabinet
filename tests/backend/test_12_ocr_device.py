"""Chọn thiết bị chạy OCR (GPU/CPU) cho engine Paddle và cấu hình mặc định của bản đóng gói.

Không cần GPU hay PaddlePaddle thật: trạng thái GPU và PaddleOCR được thay bằng bản giả.
"""
from __future__ import annotations

import pytest

from app.schemas import settings as settings_schema
from app.schemas.settings import AppSettings
from app.services.ocr import engine as engine_module
from app.services.ocr.engine import OcrConfig, PaddleOcrEngine, choose_device
from app.services.ocr.service import OcrService


# --------------------------------------------------------------------------- #
# Chọn thiết bị
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize(
    ("engine", "requested", "gpu", "expected_device", "has_note"),
    [
        ("onnxruntime", "auto", (True, "GPU"), "cpu", False),  # ONNX Runtime trong ứng dụng là bản CPU
        ("onnxruntime", "gpu", (True, "GPU"), "cpu", False),
        ("paddle", "cpu", (True, "GPU"), "cpu", False),
        ("paddle", "auto", (True, "Quadro P1000"), "gpu:0", False),
        ("paddle", "gpu", (True, "Quadro P1000"), "gpu:0", False),
        ("paddle", "auto", (False, "không tìm thấy GPU NVIDIA"), "cpu", False),  # tự lùi, không cần báo
        ("paddle", "gpu", (False, "không tìm thấy GPU NVIDIA"), "cpu", True),  # đã chọn GPU → báo lý do
    ],
)
def test_choose_device(engine, requested, gpu, expected_device, has_note):
    device, note = choose_device(engine, requested, gpu)
    assert device == expected_device
    assert (note is not None) is has_note
    if has_note:
        assert "không tìm thấy GPU NVIDIA" in note


def test_service_passes_device_setting():
    config = OcrService.config_from(AppSettings(ocr_engine="paddle", ocr_profile="v6_medium", ocr_device="gpu"))
    assert (config.engine, config.profile, config.device) == ("paddle", "v6_medium", "gpu")


# --------------------------------------------------------------------------- #
# Cấu hình mặc định
# --------------------------------------------------------------------------- #
def test_defaults_from_source_use_onnxruntime():
    s = AppSettings()
    assert (s.ocr_engine, s.ocr_profile, s.ocr_device) == ("onnxruntime", "v6_small", "auto")


def test_defaults_in_build_with_paddle(monkeypatch):
    monkeypatch.setattr(settings_schema, "paddle_bundled", lambda: True)
    s = AppSettings()
    assert (s.ocr_engine, s.ocr_profile, s.ocr_device) == ("paddle", "v6_medium", "auto")
    # Giá trị người dùng đã lưu vẫn được ưu tiên hơn mặc định.
    assert AppSettings(ocr_engine="onnxruntime", ocr_profile="v6_small").ocr_engine == "onnxruntime"


def test_settings_api_saves_device(client):
    body = client.patch("/api/settings", json={"ocr_device": "cpu"}).json()["settings"]
    assert body["ocr_device"] == "cpu"
    assert client.get("/api/settings").json()["settings"]["ocr_device"] == "cpu"
    assert "paddle_gpu" in client.get("/api/settings").json()["options"]["ocr_dependencies"]
    assert client.patch("/api/settings", json={"ocr_device": "tpu"}).status_code in (400, 422)


# --------------------------------------------------------------------------- #
# Nạp engine: GPU lỗi thì tự chuyển CPU; Paddle trên CPU tắt oneDNN
# --------------------------------------------------------------------------- #
class _FakePipeline:
    created: list[dict] = []
    fail_on_gpu = False

    def __init__(self, **kwargs):
        self.kwargs = kwargs
        _FakePipeline.created.append(kwargs)

    def predict(self, image):
        if self.kwargs["device"].startswith("gpu") and _FakePipeline.fail_on_gpu:
            raise RuntimeError("no kernel image is available for execution on the device")
        return []

    def close(self):
        pass


@pytest.fixture
def fake_paddle(monkeypatch):
    paddleocr = pytest.importorskip("paddleocr")
    monkeypatch.setattr(paddleocr, "PaddleOCR", _FakePipeline)
    monkeypatch.setattr(PaddleOcrEngine, "dependency_status", staticmethod(lambda: {"paddleocr": True, "onnxruntime": True, "paddle": True, "paddle_gpu": True}))
    _FakePipeline.created, _FakePipeline.fail_on_gpu = [], False
    return _FakePipeline


def _engine(tmp_path, **config):
    return PaddleOcrEngine(OcrConfig(engine="paddle", profile="v6_medium", **config), [tmp_path], tmp_path / "cache")


def test_load_uses_gpu_when_available(tmp_path, monkeypatch, fake_paddle):
    monkeypatch.setattr(engine_module, "paddle_gpu_status", lambda: (True, "Quadro P1000"))
    eng = _engine(tmp_path, device="auto")
    eng.load()
    info = eng.info()
    assert (info["device"], info["gpu_name"], info["device_note"]) == ("gpu:0", "Quadro P1000", None)
    assert fake_paddle.created[-1]["device"] == "gpu:0" and "enable_mkldnn" not in fake_paddle.created[-1]


def test_load_falls_back_to_cpu_when_gpu_fails(tmp_path, monkeypatch, fake_paddle):
    monkeypatch.setattr(engine_module, "paddle_gpu_status", lambda: (True, "Quadro P1000"))
    fake_paddle.fail_on_gpu = True
    eng = _engine(tmp_path, device="auto")
    eng.load()
    info = eng.info()
    assert info["device"] == "cpu" and info["gpu_name"] is None
    assert "no kernel image" in info["device_note"]
    assert [k["device"] for k in fake_paddle.created] == ["gpu:0", "cpu"]
    assert fake_paddle.created[-1]["enable_mkldnn"] is False


def test_paddle_on_cpu_disables_onednn(tmp_path, monkeypatch, fake_paddle):
    monkeypatch.setattr(engine_module, "paddle_gpu_status", lambda: pytest.fail("không được kiểm tra GPU khi đã chọn CPU"))
    eng = _engine(tmp_path, device="cpu")
    eng.load()
    assert fake_paddle.created == [fake_paddle.created[0]]
    assert fake_paddle.created[0]["device"] == "cpu" and fake_paddle.created[0]["enable_mkldnn"] is False
    assert eng.info()["device"] == "cpu"
