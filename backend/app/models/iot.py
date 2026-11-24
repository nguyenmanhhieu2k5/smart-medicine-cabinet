"""Thiết bị ESP32, số đo cảm biến, lệnh điều khiển qua Internet và phản hồi (ACK)."""
from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import BigInteger, Boolean, CheckConstraint, Float, ForeignKey, Identity, Index, String, Text, Uuid
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.database.session import Base, LocalDateTime

COMMAND_STATUSES = ("pending", "sent", "acknowledged", "applied", "failed", "timed_out", "cancelled")
FINAL_COMMAND_STATUSES = ("applied", "failed", "timed_out", "cancelled")


class Device(Base):
    __tablename__ = "devices"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    name: Mapped[str] = mapped_column(String(80))
    token_hash: Mapped[str] = mapped_column(String(64), unique=True)  # SHA-256 của token thiết bị
    token_hint: Mapped[str] = mapped_column(String(12))  # vài ký tự cuối để nhận diện, không đủ để dùng
    firmware: Mapped[str | None] = mapped_column(String(32))
    capabilities: Mapped[list[str]] = mapped_column(JSONB, default=list)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, server_default="true")
    is_primary: Mapped[bool] = mapped_column(Boolean, default=False, server_default="false")  # tủ hiển thị ở trang chủ
    last_seen_at: Mapped[datetime | None] = mapped_column(LocalDateTime)
    last_ip: Mapped[str | None] = mapped_column(String(64))
    last_state: Mapped[dict | None] = mapped_column(JSONB)  # bản tin trạng thái gần nhất (còi, ngưỡng cục bộ…)
    note: Mapped[str | None] = mapped_column(Text)
    created_by: Mapped[uuid.UUID | None] = mapped_column(Uuid, ForeignKey("users.id", ondelete="SET NULL"))
    created_at: Mapped[datetime] = mapped_column(LocalDateTime)
    updated_at: Mapped[datetime] = mapped_column(LocalDateTime)

    __table_args__ = (
        CheckConstraint("char_length(name) BETWEEN 1 AND 80", name="ck_devices_name"),
        # Tối đa một tủ chính.
        Index("uq_devices_primary", "is_primary", unique=True, postgresql_where="is_primary"),
    )


class DeviceTelemetry(Base):
    """Số đo THẬT nhận từ thiết bị. Không bao giờ ghi dữ liệu tự tạo vào đây."""

    __tablename__ = "device_telemetry"

    id: Mapped[int] = mapped_column(BigInteger, Identity(), primary_key=True)
    device_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("devices.id", ondelete="CASCADE"))
    recorded_at: Mapped[datetime] = mapped_column(LocalDateTime)
    temperature: Mapped[float | None] = mapped_column(Float)
    humidity: Mapped[float | None] = mapped_column(Float)
    sensor_ok: Mapped[bool | None] = mapped_column(Boolean)
    simulated: Mapped[bool] = mapped_column(Boolean, default=False, server_default="false")
    extra: Mapped[dict | None] = mapped_column(JSONB)

    __table_args__ = (
        CheckConstraint("temperature IS NULL OR temperature BETWEEN -40 AND 85", name="ck_device_telemetry_temperature"),
        CheckConstraint("humidity IS NULL OR humidity BETWEEN 0 AND 100", name="ck_device_telemetry_humidity"),
        Index("ix_device_telemetry_device_time", "device_id", "recorded_at"),
    )


class DeviceCommand(Base):
    __tablename__ = "device_commands"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    device_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("devices.id", ondelete="CASCADE"))
    action: Mapped[str] = mapped_column(String(40))
    payload: Mapped[dict] = mapped_column(JSONB, default=dict)
    status: Mapped[str] = mapped_column(String(16), default="pending", server_default="pending")
    created_by: Mapped[uuid.UUID | None] = mapped_column(Uuid, ForeignKey("users.id", ondelete="SET NULL"))
    created_at: Mapped[datetime] = mapped_column(LocalDateTime)
    expires_at: Mapped[datetime] = mapped_column(LocalDateTime)
    sent_at: Mapped[datetime | None] = mapped_column(LocalDateTime)
    acknowledged_at: Mapped[datetime | None] = mapped_column(LocalDateTime)
    completed_at: Mapped[datetime | None] = mapped_column(LocalDateTime)
    attempts: Mapped[int] = mapped_column(default=0, server_default="0")
    error: Mapped[str | None] = mapped_column(Text)
    result: Mapped[dict | None] = mapped_column(JSONB)

    __table_args__ = (
        CheckConstraint(f"status IN {COMMAND_STATUSES!r}", name="ck_device_commands_status"),
        CheckConstraint("expires_at > created_at", name="ck_device_commands_expiry"),
        Index("ix_device_commands_device_status", "device_id", "status"),
        Index("ix_device_commands_created", "created_at"),
    )


class DeviceCommandAck(Base):
    __tablename__ = "device_command_ack"

    id: Mapped[int] = mapped_column(BigInteger, Identity(), primary_key=True)
    command_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("device_commands.id", ondelete="CASCADE"), index=True)
    status: Mapped[str] = mapped_column(String(16))  # received | applied | failed
    message: Mapped[str | None] = mapped_column(Text)
    payload: Mapped[dict | None] = mapped_column(JSONB)
    received_at: Mapped[datetime] = mapped_column(LocalDateTime)

    __table_args__ = (CheckConstraint("status IN ('received', 'applied', 'failed')", name="ck_device_command_ack_status"),)
