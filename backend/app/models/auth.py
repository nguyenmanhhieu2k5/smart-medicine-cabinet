"""Tài khoản, vai trò, quyền, phiên đăng nhập và nhật ký kiểm toán."""
from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import (
    BigInteger, Boolean, CheckConstraint, Column, ForeignKey, Identity, Index, Integer, SmallInteger, String, Table, Text, Uuid, func,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database.session import Base, LocalDateTime

ROLE_ADMIN = "ADMIN"
ROLE_SCANNER = "SCANNER"

role_permissions = Table(
    "role_permissions",
    Base.metadata,
    Column("role_id", SmallInteger, ForeignKey("roles.id", ondelete="CASCADE"), primary_key=True),
    Column("permission_id", SmallInteger, ForeignKey("permissions.id", ondelete="CASCADE"), primary_key=True),
)


class Role(Base):
    __tablename__ = "roles"

    id: Mapped[int] = mapped_column(SmallInteger, primary_key=True, autoincrement=False)
    code: Mapped[str] = mapped_column(String(32), unique=True)
    name: Mapped[str] = mapped_column(Text)
    description: Mapped[str | None] = mapped_column(Text)

    permissions: Mapped[list["Permission"]] = relationship(secondary=role_permissions, lazy="selectin")


class Permission(Base):
    __tablename__ = "permissions"

    id: Mapped[int] = mapped_column(SmallInteger, primary_key=True, autoincrement=False)
    code: Mapped[str] = mapped_column(String(64), unique=True)
    description: Mapped[str] = mapped_column(Text)


class User(Base):
    __tablename__ = "users"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    email: Mapped[str] = mapped_column(String(254))
    full_name: Mapped[str] = mapped_column(String(120), default="", server_default="")
    phone: Mapped[str | None] = mapped_column(String(32))
    password_hash: Mapped[str] = mapped_column(Text)
    role_id: Mapped[int] = mapped_column(SmallInteger, ForeignKey("roles.id", ondelete="RESTRICT"))
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, server_default="true")
    failed_logins: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    locked_until: Mapped[datetime | None] = mapped_column(LocalDateTime)
    last_login_at: Mapped[datetime | None] = mapped_column(LocalDateTime)
    password_changed_at: Mapped[datetime | None] = mapped_column(LocalDateTime)
    created_at: Mapped[datetime] = mapped_column(LocalDateTime)
    updated_at: Mapped[datetime] = mapped_column(LocalDateTime)
    preferences: Mapped[dict] = mapped_column(JSONB, default=dict)

    role: Mapped[Role] = relationship(lazy="joined")

    __table_args__ = (
        CheckConstraint("char_length(email) BETWEEN 3 AND 254 AND position('@' in email) > 1", name="ck_users_email"),
        CheckConstraint("failed_logins >= 0", name="ck_users_failed_logins"),
        Index("uq_users_email_lower", func.lower(email), unique=True),
    )

    @property
    def role_code(self) -> str:
        return self.role.code if self.role else ""

    @property
    def permission_codes(self) -> set[str]:
        return {p.code for p in (self.role.permissions if self.role else [])}


class UserSession(Base):
    """Một phiên đăng nhập = một refresh token (chỉ lưu SHA-256 của token)."""

    __tablename__ = "user_sessions"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("users.id", ondelete="CASCADE"))
    refresh_hash: Mapped[str] = mapped_column(String(64), unique=True)
    audience: Mapped[str] = mapped_column(String(16))  # scanner | admin
    client: Mapped[str | None] = mapped_column(String(32))  # mobile | desktop | web | test
    user_agent: Mapped[str | None] = mapped_column(Text)
    ip: Mapped[str | None] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(LocalDateTime)
    last_used_at: Mapped[datetime] = mapped_column(LocalDateTime)
    expires_at: Mapped[datetime] = mapped_column(LocalDateTime)
    revoked_at: Mapped[datetime | None] = mapped_column(LocalDateTime)
    revoked_reason: Mapped[str | None] = mapped_column(String(32))

    user: Mapped[User] = relationship(lazy="joined")

    __table_args__ = (
        CheckConstraint("audience IN ('scanner', 'admin')", name="ck_user_sessions_audience"),
        CheckConstraint("expires_at > created_at", name="ck_user_sessions_expiry"),
        Index("ix_user_sessions_user", "user_id", "revoked_at"),
    )


class PasswordReset(Base):
    """Mã đặt lại mật khẩu gửi qua email (chỉ lưu băm, có hạn và giới hạn số lần nhập)."""

    __tablename__ = "password_resets"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("users.id", ondelete="CASCADE"), index=True)
    code_hash: Mapped[str] = mapped_column(String(64))
    attempts: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    created_at: Mapped[datetime] = mapped_column(LocalDateTime)
    expires_at: Mapped[datetime] = mapped_column(LocalDateTime)
    used_at: Mapped[datetime | None] = mapped_column(LocalDateTime)

    __table_args__ = (CheckConstraint("attempts >= 0", name="ck_password_resets_attempts"),)


class AuditLog(Base):
    """Ai làm gì, qua kênh nào, khi nào — cho mọi thao tác quản trị và sự kiện bảo mật."""

    __tablename__ = "audit_logs"

    id: Mapped[int] = mapped_column(BigInteger, Identity(), primary_key=True)
    created_at: Mapped[datetime] = mapped_column(LocalDateTime)
    user_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, ForeignKey("users.id", ondelete="SET NULL"))
    actor: Mapped[str | None] = mapped_column(String(254))  # email / "device:<id>" / "system"
    channel: Mapped[str] = mapped_column(String(16))  # admin | public | device | system | cli
    action: Mapped[str] = mapped_column(String(64))
    resource_type: Mapped[str | None] = mapped_column(String(32))
    resource_id: Mapped[str | None] = mapped_column(String(64))
    success: Mapped[bool] = mapped_column(Boolean, default=True, server_default="true")
    ip: Mapped[str | None] = mapped_column(String(64))
    detail: Mapped[dict | None] = mapped_column(JSONB)

    __table_args__ = (
        CheckConstraint("channel IN ('admin', 'public', 'device', 'system', 'cli')", name="ck_audit_logs_channel"),
        Index("ix_audit_logs_created", "created_at"),
        Index("ix_audit_logs_user", "user_id", "created_at"),
        Index("ix_audit_logs_action", "action"),
    )
