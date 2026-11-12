"""Kiểm thử OCR thật: PaddleOCR + bộ ảnh tổng hợp trong tests/fixtures/ocr.

Tự bỏ qua khi máy không có paddleocr/onnxruntime hoặc chưa có mô hình. Đặt
biến môi trường SMC_TEST_OCR_MODELS trỏ tới thư mục mô hình nếu cần.
Các ảnh là ảnh tổng hợp, kết quả ở đây KHÔNG phải là độ chính xác trên ảnh chụp thật.
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from app.services.medicine_matcher.catalog import CatalogRepository
from app.services.medicine_matcher.matcher import MedicineMatcher
from app.services.medicine_matcher.normalize import name_core, normalize_text, strength_tokens
from app.services.ocr import preprocess
from app.services.ocr.engine import OcrConfig, PaddleOcrEngine
from app.services.ocr.expiry import extract_expiry
from app.services.ocr.service import recognize_best

from .conftest import FIXTURES, find_ocr_models

pytestmark = pytest.mark.ocr
CASES = json.loads((FIXTURES / "ocr" / "cases.json").read_text(encoding="utf-8"))


@pytest.fixture(scope="module")
def engine(tmp_path_factory):
    deps = PaddleOcrEngine.dependency_status()
    models = find_ocr_models()
    if not (deps["paddleocr"] and deps["onnxruntime"]) or models is None:
        pytest.skip("Thiếu paddleocr/onnxruntime hoặc mô hình PP-OCRv6 small (ONNX)")
    eng = PaddleOcrEngine(OcrConfig(engine="onnxruntime", profile="v6_small"), [models], tmp_path_factory.mktemp("pdx"))
    eng.load()
    yield eng
    eng.close()


def read(engine, file_name: str):
    image = preprocess.limit_size(preprocess.decode_image((FIXTURES / "ocr" / file_name).read_bytes()))
    return recognize_best(engine, image)


def test_engine_reports_paddleocr_and_keeps_text_score_and_position(engine):
    info = engine.info()
    assert info["library"] == "PaddleOCR" and info["version"] and info["loaded"] is True
    assert info["recognition_model"] == "PP-OCRv6_small_rec"
    output, variant, attempts = read(engine, "01_ro_net_augmentin_625.jpg")
    assert variant == "original" and len(attempts) == 1  # ảnh rõ: không tiền xử lý thừa
    texts = [normalize_text(line.text) for line in output.lines]
    assert "augmentin 625mg" in texts
    first = output.lines[0]
    assert first.score is not None and 0.5 < first.score <= 1.0
    assert first.box is not None and first.box[2] > first.box[0] and first.box[3] > first.box[1]
    assert len(output.polys) == len(output.lines)


@pytest.mark.parametrize("case", CASES, ids=[c["file"] for c in CASES])
def test_ocr_test_set(engine, db, case):
    output, variant, _attempts = read(engine, case["file"])
    with db.session() as s:
        result = MedicineMatcher(CatalogRepository(s)).match(output.lines)
    expect = case["expect"]
    candidates = result["candidates"]
    top = candidates[0] if candidates else None

    if "top_ids" in expect:
        assert top is not None and top["medicine"]["id"] in expect["top_ids"], [c["medicine"]["ten_thuoc"] for c in candidates]
    if "not_ids" in expect and top is not None:
        for cand in candidates[1:]:
            if cand["medicine"]["id"] in expect["not_ids"]:
                assert cand["score"] <= top["score"] - 20
        assert top["medicine"]["id"] not in expect["not_ids"]
    if "top_name_core" in expect:
        assert top is not None and name_core(top["medicine"]["ten_thuoc"]) == expect["top_name_core"]
    if "strength_tokens" in expect:
        have = set(strength_tokens(top["medicine"]["ham_luong"], top["medicine"]["hoat_chat_chinh"], top["medicine"]["ten_thuoc"]))
        assert set(expect["strength_tokens"]) <= have
    if "status" in expect:
        assert result["status"] == expect["status"]
    if "status_in" in expect:
        assert result["status"] in expect["status_in"]
    if expect.get("never_confident"):
        assert result["status"] != "confident"
    if "preprocess_contains" in expect:
        assert expect["preprocess_contains"] in variant
    if "expiry" in expect:
        assert extract_expiry([line.text for line in output.lines])["date"] == expect["expiry"]


def test_two_products_with_same_name_get_different_records(engine, db):
    tops = []
    for file_name in ("02_cung_ten_augmentin_250.jpg", "03_cung_ten_augmentin_500_62.jpg", "04_cung_ten_augmentin_1g.jpg"):
        output, _, _ = read(engine, file_name)
        with db.session() as s:
            tops.append(MedicineMatcher(CatalogRepository(s)).match(output.lines)["candidates"][0]["medicine"])
    assert len({m["id"] for m in tops}) == 3
    assert all(normalize_text(m["ten_thuoc"]).startswith("augmentin") for m in tops)


def test_missing_models_give_actionable_error(tmp_path):
    if not PaddleOcrEngine.dependency_status()["paddleocr"]:
        pytest.skip("Chưa cài paddleocr")
    engine = PaddleOcrEngine(OcrConfig(engine="paddle"), [tmp_path], tmp_path / "cache")
    if PaddleOcrEngine.dependency_status()["paddle"]:
        pytest.skip("Máy có PaddlePaddle — không kiểm tra nhánh thiếu thư viện")
    with pytest.raises(Exception, match="PaddlePaddle"):
        engine.load()
