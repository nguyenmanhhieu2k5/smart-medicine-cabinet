"""Kết nối SQLite qua SQLAlchemy + các bảng tìm kiếm FTS5."""
from __future__ import annotations

from contextlib import contextmanager
from pathlib import Path
from typing import Iterator

from sqlalchemy import create_engine, event, text
from sqlalchemy.engine import Engine
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker


class Base(DeclarativeBase):
    pass


FTS_SCHEMA = [
    # Chỉ mục từ: tên, hoạt chất, hàm lượng, dạng bào chế, số đăng ký (đã chuẩn hóa).
    """
    CREATE VIRTUAL TABLE IF NOT EXISTS catalog_fts USING fts5(
        name, ingredient, strength, form, reg,
        tokenize = 'unicode61'
    )
    """,
    # Chỉ mục trigram: truy xuất ứng viên khi OCR sai/thiếu ký tự.
    """
    CREATE VIRTUAL TABLE IF NOT EXISTS catalog_trgm USING fts5(
        name, ingredient,
        tokenize = 'trigram'
    )
    """,
]


class Database:
    """Gói engine + session factory cho một file SQLite."""

    def __init__(self, db_path: Path | str):
        self.db_path = Path(db_path)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self.engine: Engine = create_engine(
            f"sqlite:///{self.db_path.as_posix()}",
            connect_args={"check_same_thread": False, "timeout": 30},
        )

        @event.listens_for(self.engine, "connect")
        def _pragmas(dbapi_conn, _record):  # noqa: ANN001
            cur = dbapi_conn.cursor()
            cur.execute("PRAGMA journal_mode=WAL")
            cur.execute("PRAGMA synchronous=NORMAL")
            cur.execute("PRAGMA foreign_keys=ON")
            cur.execute("PRAGMA busy_timeout=30000")
            cur.close()

        self.session_factory = sessionmaker(bind=self.engine, expire_on_commit=False)

    def create_all(self) -> None:
        from app import models  # noqa: F401  (đăng ký bảng)

        Base.metadata.create_all(self.engine)
        with self.engine.begin() as conn:
            for ddl in FTS_SCHEMA:
                conn.execute(text(ddl))

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
        with self.engine.connect() as conn:
            return conn.execute(text("PRAGMA quick_check")).scalar() == "ok"

    def dispose(self) -> None:
        self.engine.dispose()
