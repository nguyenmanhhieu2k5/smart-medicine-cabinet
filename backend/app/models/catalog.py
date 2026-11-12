"""Danh mục thuốc — dữ liệu gốc nhập từ Excel (không phải thuốc trong tủ)."""
from __future__ import annotations

from datetime import datetime

from sqlalchemy import Boolean, DateTime, ForeignKey, Index, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.database.session import Base

# Tên cột trong Excel → tên cột trong SQLite. Thứ tự giữ nguyên như file nguồn.
CATALOG_COLUMNS: dict[str, str] = {
    "id": "id",
    "tenThuoc": "ten_thuoc",
    "soDangKy": "so_dang_ky",
    "soDangKyCu": "so_dang_ky_cu",
    "hoatChatChinh": "hoat_chat_chinh",
    "hamLuong": "ham_luong",
    "dangBaoChe": "dang_bao_che",
    "dongGoi": "dong_goi",
    "tieuChuan": "tieu_chuan",
    "tuoiTho": "tuoi_tho",
    "tenDuongDung": "ten_duong_dung",
    "ngayCapSoDangKy": "ngay_cap_so_dang_ky",
    "ngayGiaHanSoDangKy": "ngay_gia_han_so_dang_ky",
    "ngayHetHanSoDangKy": "ngay_het_han_so_dang_ky",
    "soQuyetDinh": "so_quyet_dinh",
    "dotCap": "dot_cap",
    "tenCongTyDangKy": "ten_cong_ty_dang_ky",
    "diaChiDangKy": "dia_chi_dang_ky",
    "nuocDangKy": "nuoc_dang_ky",
    "tenCongTySanXuat": "ten_cong_ty_san_xuat",
    "diaChiSanXuat": "dia_chi_san_xuat",
    "nuocSanXuat": "nuoc_san_xuat",
    "isActive": "is_active",
    "isHetHan": "is_het_han",
    "isDaRutSoDangKy": "is_da_rut_so_dang_ky",
    "isDeleted": "is_deleted",
    "isDongBo": "is_dong_bo",
    "phanLoaiThuocEnum": "phan_loai_thuoc_enum",
    "creationTime": "creation_time",
}
BOOLEAN_COLUMNS = ("is_active", "is_het_han", "is_da_rut_so_dang_ky", "is_deleted", "is_dong_bo")


class CatalogMedicine(Base):
    __tablename__ = "catalog_medicines"

    # --- giá trị gốc từ Excel (chỉ cắt khoảng trắng đầu/cuối) ---
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=False)
    ten_thuoc: Mapped[str] = mapped_column(Text)
    so_dang_ky: Mapped[str | None] = mapped_column(Text)
    so_dang_ky_cu: Mapped[str | None] = mapped_column(Text)
    hoat_chat_chinh: Mapped[str | None] = mapped_column(Text)
    ham_luong: Mapped[str | None] = mapped_column(Text)
    dang_bao_che: Mapped[str | None] = mapped_column(Text)
    dong_goi: Mapped[str | None] = mapped_column(Text)
    tieu_chuan: Mapped[str | None] = mapped_column(Text)
    tuoi_tho: Mapped[str | None] = mapped_column(Text)
    ten_duong_dung: Mapped[str | None] = mapped_column(Text)
    ngay_cap_so_dang_ky: Mapped[str | None] = mapped_column(Text)
    ngay_gia_han_so_dang_ky: Mapped[str | None] = mapped_column(Text)
    ngay_het_han_so_dang_ky: Mapped[str | None] = mapped_column(Text)
    so_quyet_dinh: Mapped[str | None] = mapped_column(Text)
    dot_cap: Mapped[str | None] = mapped_column(Text)
    ten_cong_ty_dang_ky: Mapped[str | None] = mapped_column(Text)
    dia_chi_dang_ky: Mapped[str | None] = mapped_column(Text)
    nuoc_dang_ky: Mapped[str | None] = mapped_column(Text)
    ten_cong_ty_san_xuat: Mapped[str | None] = mapped_column(Text)
    dia_chi_san_xuat: Mapped[str | None] = mapped_column(Text)
    nuoc_san_xuat: Mapped[str | None] = mapped_column(Text)
    is_active: Mapped[bool | None] = mapped_column(Boolean)
    is_het_han: Mapped[bool | None] = mapped_column(Boolean)
    is_da_rut_so_dang_ky: Mapped[bool | None] = mapped_column(Boolean)
    is_deleted: Mapped[bool | None] = mapped_column(Boolean)
    is_dong_bo: Mapped[bool | None] = mapped_column(Boolean)
    phan_loai_thuoc_enum: Mapped[str | None] = mapped_column(Text)
    creation_time: Mapped[str | None] = mapped_column(Text)

    # --- trường dẫn xuất phục vụ tìm kiếm/đối chiếu ---
    name_norm: Mapped[str] = mapped_column(Text, default="")
    name_core: Mapped[str] = mapped_column(Text, default="")
    ingredient_norm: Mapped[str] = mapped_column(Text, default="")
    strength_norm: Mapped[str] = mapped_column(Text, default="")  # token chuẩn, cách nhau bởi dấu cách
    form_norm: Mapped[str] = mapped_column(Text, default="")
    shelf_life_months: Mapped[int | None] = mapped_column(Integer)
    row_hash: Mapped[str] = mapped_column(String(40))
    import_id: Mapped[int | None] = mapped_column(Integer)
    in_source: Mapped[bool] = mapped_column(Boolean, default=True)  # False nếu đã biến mất khỏi file nguồn

    __table_args__ = (
        Index("ix_catalog_name_norm", "name_norm"),
        Index("ix_catalog_name_core", "name_core"),
    )


class CatalogReg(Base):
    """Mọi số đăng ký (hiện tại, cũ, ghi trong ngoặc) của từng thuốc.

    Một thuốc có thể có nhiều số đăng ký và một số đăng ký có thể xuất hiện ở
    nhiều bản ghi, nên dùng bảng riêng thay vì cột duy nhất.
    """

    __tablename__ = "catalog_regs"

    reg_norm: Mapped[str] = mapped_column(String(40), primary_key=True)
    medicine_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("catalog_medicines.id", ondelete="CASCADE"), primary_key=True
    )
    kind: Mapped[str] = mapped_column(String(8), default="current")  # current | old

    __table_args__ = (Index("ix_catalog_regs_medicine", "medicine_id"),)


class CatalogImport(Base):
    __tablename__ = "catalog_imports"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    file_path: Mapped[str] = mapped_column(Text)
    file_name: Mapped[str] = mapped_column(Text)
    file_hash: Mapped[str | None] = mapped_column(String(64))
    file_size: Mapped[int | None] = mapped_column(Integer)
    status: Mapped[str] = mapped_column(String(16), default="running")  # running | success | failed | skipped
    rows_total: Mapped[int] = mapped_column(Integer, default=0)
    inserted: Mapped[int] = mapped_column(Integer, default=0)
    updated: Mapped[int] = mapped_column(Integer, default=0)
    unchanged: Mapped[int] = mapped_column(Integer, default=0)
    skipped: Mapped[int] = mapped_column(Integer, default=0)
    removed: Mapped[int] = mapped_column(Integer, default=0)
    duplicate_ids: Mapped[int] = mapped_column(Integer, default=0)
    message: Mapped[str | None] = mapped_column(Text)
    started_at: Mapped[datetime] = mapped_column(DateTime)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime)
