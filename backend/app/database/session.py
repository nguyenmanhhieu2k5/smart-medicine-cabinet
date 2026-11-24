"""Kết nối PostgreSQL qua SQLAlchemy 2 + psycopg 3.

PostgreSQL chạy trên Mini PC là cơ sở dữ liệu duy nhất của hệ thống (không dùng SQLite).
Lược đồ do Alembic quản lý (``backend/migrations``) — module này không tự tạo bảng.

Thời gian: cột lưu ``timestamptz`` (thời điểm tuyệt đối). Mã nghiệp vụ (lời nhắc, cảnh báo,
hạn dùng) làm việc theo giờ địa phương của tủ thuốc, nên kiểu :class:`LocalDateTime` đổi qua lại
giữa ``datetime`` không múi giờ (giờ ``SMC_TIMEZONE``, mặc định Asia/Ho_Chi_Minh) và ``timestamptz``.
"""
from __future__ import annotations

import os
from contextlib import contextmanager
from datetime import datetime, timezone
from typing import Iterator
from zoneinfo import ZoneInfo

from sqlalchemy import DateTime, create_engine, text
from sqlalchemy.engine import Engine, make_url
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker
from sqlalchemy.types import TypeDecorator

APP_TIMEZONE = ZoneInfo(os.environ.get("SMC_TIMEZONE", "Asia/Ho_Chi_Minh"))


class Base(DeclarativeBase):
    pass


class LocalDateTime(TypeDecorator):
    """``datetime`` giờ địa phương (không múi giờ) trong Python ↔ ``timestamptz`` trong PostgreSQL."""

    impl = DateTime(timezone=True)
    cache_ok = True

    def process_bind_param(self, value, dialect):  # noqa: ANN001, ANN201
        if value is None:
            return None
        if value.tzinfo is None:
            value = value.replace(tzinfo=APP_TIMEZONE)
        return value

    def process_result_value(self, value, dialect):  # noqa: ANN001, ANN201
        if value is None:
            return None
        if value.tzinfo is None:  # pragma: no cover — timestamptz luôn có múi giờ
            return value
        return value.astimezone(APP_TIMEZONE).replace(tzinfo=None)


def iso_local(value: datetime | None) -> str | None:
    """ISO 8601 có kèm độ lệch múi giờ (cho ứng dụng mobile ở múi giờ bất kỳ)."""
    if value is None:
        return None
    if value.tzinfo is None:
        value = value.replace(tzinfo=APP_TIMEZONE)
    return value.isoformat()


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def redact_url(url: str) -> str:
    """URL kết nối không kèm mật khẩu (để ghi nhật ký/hiển thị)."""
    try:
        return make_url(url).render_as_string(hide_password=True)
    except Exception:  # noqa: BLE001
        return "postgresql://***"


class DatabaseError(RuntimeError):
    """Không kết nối/không dùng được PostgreSQL (thông báo hiển thị được cho quản trị viên)."""


class Database:
    """Engine + session factory cho một CSDL PostgreSQL."""

    def __init__(self, url: str, *, pool_size: int = 10, max_overflow: int = 10, application_name: str = "smart-medicine-server"):
        parsed = make_url(url)
        if parsed.get_backend_name() != "postgresql":
            raise DatabaseError("Chỉ hỗ trợ PostgreSQL (DATABASE_URL phải bắt đầu bằng postgresql+psycopg://).")
        if parsed.drivername == "postgresql":
            parsed = parsed.set(drivername="postgresql+psycopg")
        self.url = parsed.render_as_string(hide_password=False)
        self.engine: Engine = create_engine(
            self.url,
            pool_pre_ping=True,
            pool_size=pool_size,
            max_overflow=max_overflow,
            pool_recycle=1800,
            connect_args={"connect_timeout": 10, "application_name": application_name},
        )
        self.session_factory = sessionmaker(bind=self.engine, expire_on_commit=False)

    @property
    def display_url(self) -> str:
        return redact_url(self.url)

    @contextmanager
    def session(self) -> Iterator[Session]:
        s = self.session_factory()
        try:
            yield s
            s.commit()
        except Exception:
            s.rollback()
            raise
        finally:
            s.close()

    def check(self) -> bool:
        """CSDL trả lời được truy vấn (dùng cho kiểm tra sức khỏe)."""
        try:
            with self.engine.connect() as conn:
                return conn.execute(text("SELECT 1")).scalar() == 1
        except SQLAlchemyError:
            return False

    def schema_revision(self) -> str | None:
        """Phiên bản lược đồ Alembic hiện tại (None nếu chưa chạy migration)."""
        try:
            with self.engine.connect() as conn:
                return conn.execute(text("SELECT version_num FROM alembic_version LIMIT 1")).scalar()
        except SQLAlchemyError:
            return None

    def server_info(self) -> dict[str, object]:
        with self.engine.connect() as conn:
            row = conn.execute(
                text(
                    "SELECT current_setting('server_version'), pg_database_size(current_database()), "
                    "current_database(), current_user, inet_server_addr()::text"
                )
            ).one()
        return {"version": row[0], "size_bytes": int(row[1]), "database": row[2], "user": row[3], "server_addr": row[4]}

    def dispose(self) -> None:
        self.engine.dispose()
