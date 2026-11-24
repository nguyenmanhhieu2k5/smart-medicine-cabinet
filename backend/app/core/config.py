"""Cấu hình máy chủ (Mini PC).

Nguồn cấu hình theo thứ tự ưu tiên: biến môi trường → file ``server.env`` (mặc định
``%ProgramData%\\SmartMedicineCabinet\\server\\server.env``) → giá trị mặc định.
Không có mật khẩu hay khóa bí mật nào nằm trong mã nguồn.
"""
from __future__ import annotations

import os
import secrets
import sys
from dataclasses import dataclass, field
from pathlib import Path

APP_NAME = "SmartMedicineCabinet"
APP_VERSION = "2.0.0"
DEFAULT_PUBLIC_PORT = 8000
DEFAULT_ADMIN_PORT = 8001
DEFAULT_CATALOG_FILENAMES = ("DAV_unique.xlsx", "DAV_unique (1).xlsx")
# Mô hình Gemini (đổi bằng SMC_GEMINI_MODELS; nhiều mô hình cách nhau dấu phẩy: quá tải thì tự chuyển mô hình sau).
DEFAULT_GEMINI_MODELS = ("gemini-3.5-flash",)
# Nguồn tra cứu trên mạng khi dữ liệu nội bộ không có (SMC_LOOKUP_PROVIDER):
#  - "tavily": CHỈ tìm kiếm web Tavily + quy tắc đối chiếu số đăng ký với danh mục, không gọi AI (mặc định).
#  - "auto":   Gemini (AI + Google Search) trước, không được thì Tavily.
#  - "gemini": chỉ Gemini.
LOOKUP_PROVIDERS = ("tavily", "auto", "gemini")
LOOPBACK_HOSTS = ("127.0.0.1", "localhost", "::1")


def loopback_host(value: str | None) -> str:
    """Chỉ chấp nhận địa chỉ loopback; giá trị khác (vd. 0.0.0.0) bị thay bằng 127.0.0.1.

    Cả hai cổng API chỉ nghe cục bộ: ra Internet qua Tailscale Funnel/Cloudflare Tunnel (Public) và Tailscale serve (Admin),
    không bao giờ mở thẳng cổng ra mạng, kể cả khi cấu hình nhầm.
    """
    host = (value or "").strip().lower()
    return host if host in LOOPBACK_HOSTS else "127.0.0.1"


def default_data_dir() -> Path:
    """Thư mục dữ liệu của máy chủ (ảnh quét, sao lưu, khóa JWT, nhật ký)."""
    env = os.environ.get("SMC_DATA_DIR")
    if env:
        return Path(env).expanduser()
    if sys.platform == "win32":
        base = os.environ.get("PROGRAMDATA") or r"C:\ProgramData"
        return Path(base) / APP_NAME / "server"
    base = os.environ.get("XDG_DATA_HOME") or str(Path.home() / ".local" / "share")
    return Path(base) / APP_NAME / "server"


def resource_dir() -> Path:
    """Thư mục chứa tài nguyên đi kèm (mô hình OCR, file Excel)."""
    env = os.environ.get("SMC_RESOURCE_DIR")
    if env:
        return Path(env)
    if getattr(sys, "frozen", False):  # PyInstaller
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parents[3]  # gốc repository


def load_env_file(path: Path) -> dict[str, str]:
    """Đọc file KEY=VALUE (bỏ qua dòng trống/#). Không ghi đè biến môi trường đã có."""
    values: dict[str, str] = {}
    if not path.is_file():
        return values
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        values[key.strip()] = value
    return values


def _bool(value: str | None, default: bool) -> bool:
    if value is None or value == "":
        return default
    return value.strip().lower() in ("1", "true", "yes", "on")


def _list(value: str | None, default: list[str]) -> list[str]:
    if not value:
        return list(default)
    return [v.strip() for v in value.split(",") if v.strip()]


@dataclass
class SmtpConfig:
    host: str | None = None
    port: int = 587
    username: str | None = None
    password: str | None = None
    sender: str | None = None
    starttls: bool = True
    use_ssl: bool = False

    @property
    def configured(self) -> bool:
        return bool(self.host and self.sender)


@dataclass
class Settings:
    database_url: str = ""
    data_dir: Path = field(default_factory=default_data_dir)
    public_host: str = "127.0.0.1"
    public_port: int = DEFAULT_PUBLIC_PORT
    admin_host: str = "127.0.0.1"
    admin_port: int = DEFAULT_ADMIN_PORT
    # Host header được chấp nhận ở cổng Admin (tailscale serve đặt Host = <máy>.<tailnet>.ts.net).
    admin_allowed_hosts: list[str] = field(default_factory=lambda: ["127.0.0.1", "localhost", "*.ts.net", "testserver"])
    cors_origins: list[str] = field(default_factory=list)  # chỉ cần cho bản web phát triển của mobile
    jwt_secret: str | None = None
    access_token_minutes: int = 15
    refresh_token_days: int = 30
    allow_registration: bool = True
    max_login_failures: int = 5
    lockout_minutes: int = 15
    smtp: SmtpConfig = field(default_factory=SmtpConfig)
    public_base_url: str | None = None  # https://api.<tên-miền> (hiển thị trong hướng dẫn kết nối)
    catalog_xlsx: Path | None = None
    ocr_model_dir: Path | None = None
    ocr_engine: str = "paddle"  # "paddle" | "disabled" (dùng cho kiểm thử không có OCR)
    max_ocr_queue: int = 16  # tối đa số ảnh chờ OCR (toàn hệ thống)
    max_active_scans_per_user: int = 2
    scan_image_retention_days: int = 30
    device_stale_seconds: int = 45  # không nhận bản tin quá thời gian này → coi như mất kết nối
    command_ttl_seconds: int = 60
    backup_keep: int = 14
    backup_copy_dir: Path | None = None  # bản sao thứ hai (ổ ngoài/OneDrive…)
    pg_bin_dir: Path | None = None
    start_background_tasks: bool = True
    auto_migrate: bool = True
    # AI tra cứu thuốc trên mạng (Google Gemini + Google Search). Khóa CHỈ nằm trong server.env trên Mini PC —
    # không bao giờ gửi xuống ứng dụng Windows/điện thoại, không ghi vào nhật ký, không trả ra qua API.
    gemini_api_key: str | None = field(default=None, repr=False)
    gemini_models: list[str] = field(default_factory=lambda: list(DEFAULT_GEMINI_MODELS))
    gemini_timeout: float = 25.0
    # Tra mã vạch trên mạng KHÔNG dùng AI (Tavily Search API + quy tắc đối chiếu số đăng ký). Khóa chỉ nằm trong server.env.
    tavily_api_key: str | None = field(default=None, repr=False)
    lookup_provider: str = "tavily"

    @property
    def images_dir(self) -> Path:
        return self.data_dir / "images"

    @property
    def backups_dir(self) -> Path:
        return self.data_dir / "backups"

    @property
    def uploads_dir(self) -> Path:
        return self.data_dir / "uploads"

    @property
    def scans_dir(self) -> Path:
        return self.data_dir / "scans"

    @property
    def logs_dir(self) -> Path:
        return self.data_dir / "logs"

    def ensure_dirs(self) -> None:
        for p in (self.data_dir, self.images_dir, self.backups_dir, self.uploads_dir, self.scans_dir, self.logs_dir):
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

    def resolve_jwt_secret(self) -> str:
        """Khóa ký JWT: biến SMC_JWT_SECRET, hoặc file ``jwt_secret`` trong thư mục dữ liệu (tự tạo lần đầu)."""
        if self.jwt_secret:
            return self.jwt_secret
        path = self.data_dir / "jwt_secret"
        if path.is_file():
            value = path.read_text(encoding="utf-8").strip()
            if len(value) >= 32:
                self.jwt_secret = value
                return value
        self.data_dir.mkdir(parents=True, exist_ok=True)
        value = secrets.token_urlsafe(48)
        path.write_text(value, encoding="utf-8")
        self.jwt_secret = value
        return value


def env_file_path() -> Path:
    env = os.environ.get("SMC_ENV_FILE")
    return Path(env) if env else default_data_dir() / "server.env"


def load_settings() -> Settings:
    file_values = load_env_file(env_file_path())

    def get(key: str, default: str | None = None) -> str | None:
        value = os.environ.get(key)
        if value is None or value == "":
            value = file_values.get(key)
        return value if value not in (None, "") else default

    s = Settings()
    if get("SMC_DATA_DIR"):
        s.data_dir = Path(str(get("SMC_DATA_DIR"))).expanduser()
    s.database_url = get("DATABASE_URL", "") or ""
    s.public_host = loopback_host(get("SMC_PUBLIC_HOST", "127.0.0.1"))
    s.public_port = int(get("SMC_PUBLIC_PORT", str(DEFAULT_PUBLIC_PORT)) or DEFAULT_PUBLIC_PORT)
    s.admin_host = loopback_host(get("SMC_ADMIN_HOST", "127.0.0.1"))
    s.admin_port = int(get("SMC_ADMIN_PORT", str(DEFAULT_ADMIN_PORT)) or DEFAULT_ADMIN_PORT)
    s.admin_allowed_hosts = _list(get("SMC_ADMIN_ALLOWED_HOSTS"), s.admin_allowed_hosts)
    s.cors_origins = _list(get("SMC_CORS_ORIGINS"), [])
    s.jwt_secret = get("SMC_JWT_SECRET")
    s.access_token_minutes = int(get("SMC_ACCESS_TOKEN_MINUTES", "15") or 15)
    s.refresh_token_days = int(get("SMC_REFRESH_TOKEN_DAYS", "30") or 30)
    s.allow_registration = _bool(get("SMC_ALLOW_REGISTRATION"), True)
    s.smtp = SmtpConfig(
        host=get("SMC_SMTP_HOST"), port=int(get("SMC_SMTP_PORT", "587") or 587), username=get("SMC_SMTP_USER"),
        password=get("SMC_SMTP_PASSWORD"), sender=get("SMC_SMTP_FROM"),
        starttls=_bool(get("SMC_SMTP_STARTTLS"), True), use_ssl=_bool(get("SMC_SMTP_SSL"), False),
    )
    s.public_base_url = get("SMC_PUBLIC_BASE_URL")
    if get("SMC_CATALOG_XLSX"):
        s.catalog_xlsx = Path(str(get("SMC_CATALOG_XLSX")))
    if get("SMC_OCR_MODEL_DIR"):
        s.ocr_model_dir = Path(str(get("SMC_OCR_MODEL_DIR")))
    else:
        bundled = resource_dir() / "ocr_models"
        if bundled.is_dir():
            s.ocr_model_dir = bundled
    s.ocr_engine = get("SMC_OCR_ENGINE", "paddle") or "paddle"
    s.scan_image_retention_days = int(get("SMC_SCAN_RETENTION_DAYS", "30") or 30)
    s.backup_keep = int(get("SMC_BACKUP_KEEP", "14") or 14)
    if get("SMC_BACKUP_COPY_DIR"):
        s.backup_copy_dir = Path(str(get("SMC_BACKUP_COPY_DIR")))
    if get("SMC_PG_BIN"):
        s.pg_bin_dir = Path(str(get("SMC_PG_BIN")))
    s.auto_migrate = _bool(get("SMC_AUTO_MIGRATE"), True)
    s.gemini_api_key = (get("SMC_GEMINI_API_KEY") or "").strip() or None
    s.gemini_models = _list(get("SMC_GEMINI_MODELS"), list(DEFAULT_GEMINI_MODELS))
    s.gemini_timeout = float(get("SMC_GEMINI_TIMEOUT", "25") or 25)
    s.tavily_api_key = (get("SMC_TAVILY_API_KEY") or "").strip() or None
    provider = (get("SMC_LOOKUP_PROVIDER") or "tavily").strip().lower()
    s.lookup_provider = provider if provider in LOOKUP_PROVIDERS else "tavily"
    return s
