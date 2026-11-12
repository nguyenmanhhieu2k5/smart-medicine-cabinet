"""Fixture dùng chung cho kiểm thử backend."""
from __future__ import annotations

import io
import os
import shutil
import sqlite3
from datetime import datetime
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.core import clock
from app.core.config import Settings
from app.database.session import Database
from app.main import create_app
from app.services.excel_import.importer import CatalogImporter
from app.services.medicine_matcher.matcher import OcrLine
from app.services.ocr.engine import OcrOutput

ROOT = Path(__file__).resolve().parents[2]
FIXTURES = ROOT / "tests" / "fixtures"
SAMPLE_XLSX = FIXTURES / "catalog_sample.xlsx"
FULL_XLSX = ROOT / "data" / "DAV_unique.xlsx"
FROZEN_NOW = datetime(2026, 11, 10, 14, 32, 0)  # Thứ Ba 10/11/2026 như trong bản thiết kế

# Các id thật trong DAV_unique.xlsx dùng làm mốc kiểm thử.
AUGMENTIN_625 = 34382  # Augmentin 625mg tablets — VN-20169-16 (500mg/125mg)
AUGMENTIN_625_OLD = 25180  # cùng tên, số đăng ký khác (VN-11057-10)
AUGMENTIN_1G = 34381  # 875mg/125mg
AUGMENTIN_250 = 31802  # 250mg/31,25mg
AUGMENTIN_500_62 = 30930  # 500mg/62,5mg
FOGICAP_40 = 52211  # 893110205525, số cũ VD-34703-20


@pytest.fixture(autouse=True)
def frozen_clock():
    clock.set_now_fn(lambda: FROZEN_NOW)
    yield
    clock.set_now_fn(None)


@pytest.fixture(scope="session")
def catalog_template(tmp_path_factory) -> Path:
    """Nhập file Excel mẫu một lần cho cả phiên; mỗi test sao chép file SQLite."""
    folder = tmp_path_factory.mktemp("catalog")
    db = Database(folder / "cabinet.db")
    db.create_all()
    result = CatalogImporter(db).run(SAMPLE_XLSX)
    assert result.status == "success"
    db.dispose()
    conn = sqlite3.connect(folder / "cabinet.db")
    conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    conn.close()
    return folder / "cabinet.db"


@pytest.fixture
def data_dir(tmp_path, catalog_template) -> Path:
    folder = tmp_path / "data"
    folder.mkdir()
    shutil.copyfile(catalog_template, folder / "cabinet.db")
    return folder


@pytest.fixture
def db(data_dir) -> Database:
    database = Database(data_dir / "cabinet.db")
    database.create_all()
    yield database
    database.dispose()


@pytest.fixture
def empty_db(tmp_path) -> Database:
    database = Database(tmp_path / "empty" / "cabinet.db")
    database.create_all()
    yield database
    database.dispose()


class FakeOcrEngine:
    """Engine giả cho kiểm thử API: trả về các dòng chữ được đặt sẵn."""

    lines: list[tuple[str, float]] = [
        ("Augmentin 625mg", 0.99),
        ("Amoxicillin 500mg / Acid clavulanic 125mg", 0.98),
        ("Viên nén bao phim", 0.97),
        ("SĐK: VN-20169-16", 0.99),
        ("HSD: 15/06/2027", 0.99),
    ]
    error: Exception | None = None
    calls = 0

    def __init__(self, config=None):
        self.config = config

    def recognize(self, image) -> OcrOutput:
        type(self).calls += 1
        if type(self).error is not None:
            raise type(self).error
        out_lines = [OcrLine(text=t, score=s, box=(10.0, 40.0 * i, 400.0, 40.0 * i + (60 if i == 0 else 30))) for i, (t, s) in enumerate(type(self).lines)]
        return OcrOutput(lines=out_lines, polys=[], elapsed_ms=1)

    def info(self) -> dict:
        return {"library": "fake", "loaded": True}


@pytest.fixture
def fake_engine():
    original = list(FakeOcrEngine.lines)
    FakeOcrEngine.error, FakeOcrEngine.calls = None, 0
    yield FakeOcrEngine
    FakeOcrEngine.lines, FakeOcrEngine.error = original, None


@pytest.fixture
def settings(data_dir) -> Settings:
    return Settings(data_dir=data_dir, start_background_tasks=False, catalog_xlsx=None)


@pytest.fixture
def client(settings, fake_engine):
    app = create_app(settings, ocr_engine_factory=lambda cfg: fake_engine(cfg))
    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture
def ctx(client):
    return client.app.state.ctx


def png_bytes(width: int = 320, height: int = 200) -> bytes:
    from PIL import Image

    buffer = io.BytesIO()
    Image.new("RGB", (width, height), (240, 240, 240)).save(buffer, format="PNG")
    return buffer.getvalue()


def find_ocr_models() -> Path | None:
    candidates = [os.environ.get("SMC_TEST_OCR_MODELS"), ROOT / "ocr_models", Path.home() / "ocr_models_test"]
    for candidate in candidates:
        if candidate and (Path(candidate) / "PP-OCRv6_small_rec" / "inference.onnx").is_file():
            return Path(candidate)
    return None
