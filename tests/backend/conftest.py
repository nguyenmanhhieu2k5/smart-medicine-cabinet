"""Fixture dùng chung cho kiểm thử máy chủ — chạy trên PostgreSQL THẬT.

Mặc định mỗi phiên kiểm thử dựng một cụm PostgreSQL tạm (initdb/pg_ctl của bộ cài PostgreSQL trên
máy, chỉ nghe 127.0.0.1) nên không cần mật khẩu superuser và không đụng tới CSDL production.
Có thể chỉ định máy chủ khác: SMC_TEST_DATABASE_URL=postgresql+psycopg://user:pass@host:port/postgres
(user cần quyền CREATEDB).

Mỗi test có một CSDL riêng, sao chép từ CSDL mẫu đã chạy migration + nhập danh mục mẫu (nhanh).
"""
from __future__ import annotations

import asyncio
import io
import os
import uuid
from datetime import datetime
from pathlib import Path

os.environ.setdefault("SMC_OCR_DEFAULT_ENGINE", "onnxruntime")  # kết quả mặc định ổn định giữa các máy

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.engine import make_url

from app.core import clock
from app.core.config import Settings
from app.core.context import AppContext
from app.database.cluster import LocalCluster, admin_execute, find_pg_bin, free_port
from app.database.migrate import upgrade
from app.database.session import Database
from app.main import create_app
from app.models import ROLE_ADMIN, ROLE_SCANNER
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

ADMIN_EMAIL, ADMIN_PASSWORD = "admin@example.com", "QuanTri2026"
SCANNER_EMAIL, SCANNER_PASSWORD = "scanner@example.com", "Scanner2026"
TEMPLATE_EMPTY = "smc_template_empty"
TEMPLATE_CATALOG = "smc_template_catalog"


@pytest.fixture(autouse=True)
def frozen_clock():
    clock.set_now_fn(lambda: FROZEN_NOW)
    yield
    clock.set_now_fn(None)


# --------------------------------------------------------------------------- #
# PostgreSQL
# --------------------------------------------------------------------------- #
@pytest.fixture(scope="session")
def pg_server(tmp_path_factory):
    """URL tới CSDL `postgres` của một máy chủ PostgreSQL dùng cho kiểm thử."""
    external = os.environ.get("SMC_TEST_DATABASE_URL")
    if external:
        yield external
        return
    cluster = LocalCluster(tmp_path_factory.mktemp("pg") / "data", free_port(), find_pg_bin())
    cluster.start()
    try:
        yield cluster.url("postgres")
    finally:
        cluster.destroy()


def _db_url(server_url: str, name: str) -> str:
    return make_url(server_url).set(database=name).render_as_string(hide_password=False)


@pytest.fixture(scope="session")
def pg_templates(pg_server):
    """Tạo 2 CSDL mẫu: chỉ lược đồ, và lược đồ + danh mục mẫu (799 thuốc thật)."""
    admin_execute(pg_server, f"DROP DATABASE IF EXISTS {TEMPLATE_CATALOG}", f"DROP DATABASE IF EXISTS {TEMPLATE_EMPTY}",
                  f"CREATE DATABASE {TEMPLATE_EMPTY}")
    upgrade(_db_url(pg_server, TEMPLATE_EMPTY))
    admin_execute(pg_server, f"CREATE DATABASE {TEMPLATE_CATALOG} TEMPLATE {TEMPLATE_EMPTY}")
    clock.set_now_fn(lambda: FROZEN_NOW)
    db = Database(_db_url(pg_server, TEMPLATE_CATALOG))
    try:
        result = CatalogImporter(db).run(SAMPLE_XLSX)
        assert result.status == "success", result.message
    finally:
        db.dispose()
        clock.set_now_fn(None)
    yield {"empty": TEMPLATE_EMPTY, "catalog": TEMPLATE_CATALOG}


def _clone(pg_server: str, template: str) -> tuple[str, str]:
    name = "t_" + uuid.uuid4().hex[:16]
    admin_execute(pg_server, f"CREATE DATABASE {name} TEMPLATE {template}")
    return name, _db_url(pg_server, name)


@pytest.fixture
def db_url(pg_server, pg_templates):
    name, url = _clone(pg_server, pg_templates["catalog"])
    yield url
    admin_execute(pg_server, f"DROP DATABASE IF EXISTS {name} WITH (FORCE)")


@pytest.fixture
def empty_db_url(pg_server, pg_templates):
    name, url = _clone(pg_server, pg_templates["empty"])
    yield url
    admin_execute(pg_server, f"DROP DATABASE IF EXISTS {name} WITH (FORCE)")


@pytest.fixture
def db(db_url) -> Database:
    database = Database(db_url)
    yield database
    database.dispose()


@pytest.fixture
def empty_db(empty_db_url) -> Database:
    database = Database(empty_db_url)
    yield database
    database.dispose()


# --------------------------------------------------------------------------- #
# OCR giả + email giả
# --------------------------------------------------------------------------- #
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
    delay: float = 0.0

    def __init__(self, config=None):
        self.config = config

    def recognize(self, image) -> OcrOutput:
        type(self).calls += 1
        if type(self).delay:
            import time

            time.sleep(type(self).delay)
        if type(self).error is not None:
            raise type(self).error
        out_lines = [OcrLine(text=t, score=s, box=(10.0, 40.0 * i, 400.0, 40.0 * i + (60 if i == 0 else 30))) for i, (t, s) in enumerate(type(self).lines)]
        return OcrOutput(lines=out_lines, polys=[], elapsed_ms=1)

    def info(self) -> dict:
        return {"library": "fake", "loaded": True}


@pytest.fixture
def fake_engine():
    original = list(FakeOcrEngine.lines)
    FakeOcrEngine.error, FakeOcrEngine.calls, FakeOcrEngine.delay = None, 0, 0.0
    yield FakeOcrEngine
    FakeOcrEngine.lines, FakeOcrEngine.error, FakeOcrEngine.delay = original, None, 0.0


class FakeMailer:
    def __init__(self):
        self.sent: list[tuple[str, str]] = []

    def send_reset_code(self, to: str, code: str, minutes: int) -> None:
        self.sent.append((to, code))


@pytest.fixture
def mailer() -> FakeMailer:
    return FakeMailer()


# --------------------------------------------------------------------------- #
# Ứng dụng
# --------------------------------------------------------------------------- #
@pytest.fixture
def settings(db_url, tmp_path) -> Settings:
    s = Settings(database_url=db_url, data_dir=tmp_path / "data", start_background_tasks=False, catalog_xlsx=None,
                 jwt_secret="test-secret-" + "x" * 40, auto_migrate=False)
    s.smtp.host, s.smtp.sender = "smtp.test", "noreply@example.com"
    return s


@pytest.fixture
def ctx(settings, fake_engine, mailer):
    context = AppContext(settings, ocr_engine_factory=lambda cfg: fake_engine(cfg), mailer=mailer)
    asyncio.run(context.startup())
    yield context
    context.close()


def make_user(ctx: AppContext, email: str, password: str, role: str = ROLE_SCANNER, full_name: str = "Người dùng") -> str:
    with ctx.db.session() as s:
        user = ctx.auth.create_user(s, email=email, password=password, full_name=full_name, role_code=role)
        return str(user.id)


@pytest.fixture
def admin_user(ctx) -> str:
    return make_user(ctx, ADMIN_EMAIL, ADMIN_PASSWORD, ROLE_ADMIN, "Quản trị viên")


@pytest.fixture
def admin_app(ctx):
    return create_app(ctx=ctx, channel="admin", manage_lifecycle=False)


@pytest.fixture
def public_app(ctx):
    return create_app(ctx=ctx, channel="public", manage_lifecycle=False)


@pytest.fixture
def anon_admin_client(admin_app):
    with TestClient(admin_app) as c:
        yield c


@pytest.fixture
def client(admin_app, admin_user):
    """Client kênh Admin đã đăng nhập bằng tài khoản ADMIN (tương thích các test cũ)."""
    with TestClient(admin_app) as c:
        tokens = c.post("/api/auth/login", json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD}).json()
        c.headers["Authorization"] = f"Bearer {tokens['access_token']}"
        c.tokens = tokens  # type: ignore[attr-defined]
        yield c


@pytest.fixture
def public_client(public_app):
    with TestClient(public_app) as c:
        yield c


@pytest.fixture
def scanner(public_client):
    """Tài khoản SCANNER đăng ký qua API công khai; trả về (headers, tokens)."""
    r = public_client.post("/api/v1/auth/register", json={"full_name": "Người quét", "email": SCANNER_EMAIL, "password": SCANNER_PASSWORD})
    assert r.status_code == 201, r.text
    tokens = r.json()
    return {"Authorization": f"Bearer {tokens['access_token']}"}, tokens


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
