"""Thuốc trong tủ — chỉ gồm những gì quản trị viên thực sự thêm vào — và nhật ký thay đổi số lượng."""
from __future__ import annotations

import uuid
from datetime import date, datetime

from sqlalchemy import BigInteger, CheckConstraint, Date, Float, ForeignKey, Identity, Index, Integer, String, Text, Uuid
from sqlalchemy.orm import Mapped, mapped_column

from app.database.session import Base, LocalDateTime


class CabinetItem(Base):
    __tablename__ = "cabinet_medicines"

    id: Mapped[int] = mapped_column(BigInteger, Identity(), primary_key=True)
    catalog_id: Mapped[int | None] = mapped_column(
        Integer, ForeignKey("medicine_catalog.id", ondelete="SET NULL"), index=True
    )
    # Ảnh chụp thông tin tại thời điểm lưu để tủ thuốc vẫn đọc được khi danh mục thay đổi.
    name: Mapped[str] = mapped_column(Text)
    ingredient: Mapped[str | None] = mapped_column(Text)
    strength: Mapped[str | None] = mapped_column(Text)
    dosage_form: Mapped[str | None] = mapped_column(Text)
    registration_no: Mapped[str | None] = mapped_column(Text)
    manufacturer: Mapped[str | None] = mapped_column(Text)

    quantity: Mapped[float] = mapped_column(Float, default=0, server_default="0")
    unit: Mapped[str] = mapped_column(String(24), default="viên", server_default="viên")
    # Hạn sử dụng THỰC TẾ in trên bao bì — do người dùng nhập/xác nhận.
    # Không bao giờ lấy từ "ngày hết hạn số đăng ký" của danh mục.
    expiry_date: Mapped[date | None] = mapped_column(Date, index=True)
    expiry_source: Mapped[str | None] = mapped_column(String(16))  # manual | ocr_confirmed
    lot_number: Mapped[str | None] = mapped_column(String(64))
    low_stock_threshold: Mapped[float | None] = mapped_column(Float)
    location: Mapped[str | None] = mapped_column(Text)
    note: Mapped[str | None] = mapped_column(Text)
    image_path: Mapped[str | None] = mapped_column(Text)
    source: Mapped[str] = mapped_column(String(16), default="manual", server_default="manual")  # scan | manual

    created_by: Mapped[uuid.UUID | None] = mapped_column(Uuid, ForeignKey("users.id", ondelete="SET NULL"))
    updated_by: Mapped[uuid.UUID | None] = mapped_column(Uuid, ForeignKey("users.id", ondelete="SET NULL"))
    created_at: Mapped[datetime] = mapped_column(LocalDateTime)
    updated_at: Mapped[datetime] = mapped_column(LocalDateTime)

    __table_args__ = (
        CheckConstraint("quantity >= 0", name="ck_cabinet_medicines_quantity"),
        CheckConstraint("low_stock_threshold IS NULL OR low_stock_threshold >= 0", name="ck_cabinet_medicines_threshold"),
        CheckConstraint("expiry_source IS NULL OR expiry_source IN ('manual', 'ocr_confirmed')", name="ck_cabinet_medicines_expiry_source"),
        CheckConstraint("source IN ('scan', 'manual', 'migrated')", name="ck_cabinet_medicines_source"),
    )


class InventoryLog(Base):
    """Mỗi lần số lượng thuốc trong tủ thay đổi (thêm, uống, chỉnh tay, xóa)."""

    __tablename__ = "medicine_inventory_logs"

    id: Mapped[int] = mapped_column(BigInteger, Identity(), primary_key=True)
    cabinet_medicine_id: Mapped[int | None] = mapped_column(
        BigInteger, ForeignKey("cabinet_medicines.id", ondelete="SET NULL")
    )
    medicine_name: Mapped[str] = mapped_column(Text)  # giữ lại khi thuốc đã bị xóa khỏi tủ
    action: Mapped[str] = mapped_column(String(16))
    quantity_before: Mapped[float | None] = mapped_column(Float)
    quantity_after: Mapped[float | None] = mapped_column(Float)
    delta: Mapped[float | None] = mapped_column(Float)
    unit: Mapped[str | None] = mapped_column(String(24))
    note: Mapped[str | None] = mapped_column(Text)
    user_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, ForeignKey("users.id", ondelete="SET NULL"))
    created_at: Mapped[datetime] = mapped_column(LocalDateTime)

    __table_args__ = (
        CheckConstraint("action IN ('create', 'add', 'consume', 'adjust', 'update', 'delete', 'migrate')", name="ck_inventory_logs_action"),
        Index("ix_inventory_logs_item_created", "cabinet_medicine_id", "created_at"),
        Index("ix_inventory_logs_created", "created_at"),
    )
