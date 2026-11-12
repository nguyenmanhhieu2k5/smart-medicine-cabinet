"""Cấu hình ứng dụng.

Mọi đường dẫn đều suy ra từ biến môi trường hoặc thư mục dữ liệu người dùng,
không phụ thuộc đường dẫn tuyệt đối trên máy lập trình viên.
"""
from __future__ import annotations

import os
import sys
from dataclasses import dataclass, field
from pathlib import Path

APP_NAME = "SmartMedicineCabinet"
APP_VERSION = "1.0.0"
DEFAULT_PORT = 8756
DEFAULT_CATALOG_FILENAMES = ("DAV_unique.xlsx", "DAV_unique (1).xlsx")
LOOPBACK_HOSTS = ("127.0.0.1", "localhost", "::1")


def loopback_host(value: str | None) -> str:
    """Chỉ chấp nhận địa chỉ loopback; giá trị khác (vd. 0.0.0.0) bị thay bằng 127.0.0.1.

    API cục bộ không bao giờ được mở ra mạng ngoài, kể cả khi cấu hình nhầm biến ``SMC_HOST``.
    """
    host = (value or "").strip().lower()
    return host if host in LOOPBACK_HOSTS else "127.0.0.1"


def default_data_dir() -> Path:
    """Thư mục dữ liệu người dùng (ghi được), không nằm trong vùng cài đặt."""
    env = os.environ.get("SMC_DATA_DIR")
    if env:
        return Path(env).expanduser()
    if sys.platform == "win32":
        base = os.environ.get("APPDATA") or str(Path.home() / "AppData" / "Roaming")
        return Path(base) / APP_NAME
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / APP_NAME
    base = os.environ.get("XDG_DATA_HOME") or str(Path.home() / ".local" / "share")
    return Path(base) / APP_NAME


def resource_dir() -> Path:
    """Thư mục chứa tài nguyên đi kèm (khi chạy từ mã nguồn hoặc bản đóng gói)."""
    env = os.environ.get("SMC_RESOURCE_DIR")
    if env:
        return Path(env)
    if getattr(sys, "frozen", False):  # PyInstaller
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parents[3]  # gốc repository


@dataclass
class Settings:
    data_dir: Path = field(default_factory=default_data_dir)
    host: str = "127.0.0.1"  # chỉ lắng nghe cục bộ, không mở ra mạng ngoài
    port: int = DEFAULT_PORT
    api_token: str | None = None
    catalog_xlsx: Path | None = None
    ocr_model_dir: Path | None = None
    ocr_engine: str = "paddle"  # "paddle" | "disabled" (dùng cho kiểm thử không có OCR)
    start_background_tasks: bool = True
    supabase_url: str | None = None
    supabase_anon_key: str | None = None

    @property
    def db_path(self) -> Path:
        return self.data_dir / "cabinet.db"

    @property
    def images_dir(self) -> Path:
        return self.data_dir / "images"

    @property
    def backups_dir(self) -> Path:
        return self.data_dir / "backups"

    @property
    def uploads_dir(self) -> Path:
        return self.data_dir / "uploads"

    def ensure_dirs(self) -> None:
        for p in (self.data_dir, self.images_dir, self.backups_dir, self.uploads_dir):
            p.mkdir(parents=True, exist_ok=True)

    def find_default_catalog(self) -> Path | None:
        """Tìm file Excel danh mục đi kèm (nếu có)."""
        if self.catalog_xlsx and Path(self.catalog_xlsx).is_file():
            return Path(self.catalog_xlsx)
        roots = [resource_dir() / "data", resource_dir(), self.data_dir]
        for root in roots:
            for name in DEFAULT_CATALOG_FILENAMES:
                candidate = root / name
                if candidate.is_file():
                    return candidate
        return None


def load_settings() -> Settings:
    env = os.environ
    s = Settings()
    if env.get("SMC_HOST"):
        s.host = loopback_host(env["SMC_HOST"])
    if env.get("SMC_PORT"):
        s.port = int(env["SMC_PORT"])
    s.api_token = env.get("SMC_API_TOKEN") or None
    if env.get("SMC_CATALOG_XLSX"):
        s.catalog_xlsx = Path(env["SMC_CATALOG_XLSX"])
    if env.get("SMC_OCR_MODEL_DIR"):
        s.ocr_model_dir = Path(env["SMC_OCR_MODEL_DIR"])
    else:
        bundled = resource_dir() / "ocr_models"
        if bundled.is_dir():
            s.ocr_model_dir = bundled
    if env.get("SMC_OCR_ENGINE"):
        s.ocr_engine = env["SMC_OCR_ENGINE"]
    s.supabase_url = env.get("SUPABASE_URL") or None
    s.supabase_anon_key = env.get("SUPABASE_ANON_KEY") or None
    return s
