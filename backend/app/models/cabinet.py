"""Thuốc trong tủ — chỉ gồm những gì người dùng thực sự thêm vào."""
from __future__ import annotations

from datetime import date, datetime

from sqlalchemy import Date, DateTime, Float, ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.database.session import Base


class CabinetItem(Base):
    __tablename__ = "cabinet_items"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    catalog_id: Mapped[int | None] = mapped_column(
        Integer, ForeignKey("catalog_medicines.id", ondelete="SET NULL"), index=True
    )
    # Ảnh chụp thông tin tại thời điểm lưu để tủ thuốc vẫn đọc được khi danh mục thay đổi.
    name: Mapped[str] = mapped_column(Text)
    ingredient: Mapped[str | None] = mapped_column(Text)
    strength: Mapped[str | None] = mapped_column(Text)
    dosage_form: Mapped[str | None] = mapped_column(Text)
    registration_no: Mapped[str | None] = mapped_column(Text)
    manufacturer: Mapped[str | None] = mapped_column(Text)

    quantity: Mapped[float] = mapped_column(Float, default=0)
    unit: Mapped[str] = mapped_column(String(24), default="viên")
    # Hạn sử dụng THỰC TẾ in trên bao bì — do người dùng nhập/xác nhận.
    # Không bao giờ lấy từ "ngày hết hạn số đăng ký" của danh mục.
    expiry_date: Mapped[date | None] = mapped_column(Date, index=True)
    expiry_source: Mapped[str | None] = mapped_column(String(16))  # manual | ocr_confirmed
    lot_number: Mapped[str | None] = mapped_column(String(64))
    low_stock_threshold: Mapped[float | None] = mapped_column(Float)
    location: Mapped[str | None] = mapped_column(Text)
    note: Mapped[str | None] = mapped_column(Text)
    image_path: Mapped[str | None] = mapped_column(Text)
    source: Mapped[str] = mapped_column(String(16), default="manual")  # scan | manual

    created_at: Mapped[datetime] = mapped_column(DateTime)
    updated_at: Mapped[datetime] = mapped_column(DateTime)
