"""Danh mục thuốc — dữ liệu gốc nhập từ Excel DAV_unique.xlsx (không phải thuốc trong tủ)."""
from __future__ import annotations

from datetime import datetime

from sqlalchemy import BigInteger, Boolean, CheckConstraint, Computed, ForeignKey, Identity, Index, Integer, String, Text
from sqlalchemy.dialects.postgresql import TSVECTOR
from sqlalchemy.orm import Mapped, mapped_column

from app.database.session import Base, LocalDateTime

# Tên cột trong Excel → tên cột trong PostgreSQL. Thứ tự giữ nguyên như file nguồn.
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


def _weighted(column: str, weight: str) -> str:
    # Token đã được chuẩn hóa sẵn (chỉ [a-z0-9], cách nhau một dấu cách) nên dựng tsvector trực tiếp từ mảng
    # token, không qua bộ tách từ của PostgreSQL — cùng ngữ nghĩa với chỉ mục FTS5 trước đây.
    return f"coalesce(setweight(array_to_tsvector(string_to_array(nullif({column}, ''), ' ')), '{weight}'), ''::tsvector)"


# Trọng số: A = tên thuốc, B = hoạt chất, C = hàm lượng, D = dạng bào chế + số đăng ký.
SEARCH_VECTOR_SQL = " || ".join(
    [_weighted("fts_name", "A"), _weighted("fts_ingredient", "B"), _weighted("fts_strength", "C"),
     _weighted("fts_form", "D"), _weighted("fts_reg", "D")]
)


class CatalogMedicine(Base):
    __tablename__ = "medicine_catalog"

    # --- giá trị gốc từ Excel (chỉ cắt khoảng trắng đầu/cuối); `id` là mã của Cục Quản lý Dược ---
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
    name_norm: Mapped[str] = mapped_column(Text, default="", server_default="")
    name_core: Mapped[str] = mapped_column(Text, default="", server_default="")
    ingredient_norm: Mapped[str] = mapped_column(Text, default="", server_default="")
    strength_norm: Mapped[str] = mapped_column(Text, default="", server_default="")  # token chuẩn, cách nhau bởi dấu cách
    form_norm: Mapped[str] = mapped_column(Text, default="", server_default="")
    shelf_life_months: Mapped[int | None] = mapped_column(Integer)
    row_hash: Mapped[str] = mapped_column(String(40))
    import_id: Mapped[int | None] = mapped_column(BigInteger, ForeignKey("catalog_imports.id", ondelete="SET NULL"))
    in_source: Mapped[bool] = mapped_column(Boolean, default=True, server_default="true")  # False nếu đã biến mất khỏi file nguồn

    # --- token tìm kiếm toàn văn (đã chuẩn hóa) + vector sinh tự động ---
    fts_name: Mapped[str] = mapped_column(Text, default="", server_default="")
    fts_ingredient: Mapped[str] = mapped_column(Text, default="", server_default="")
    fts_strength: Mapped[str] = mapped_column(Text, default="", server_default="")
    fts_form: Mapped[str] = mapped_column(Text, default="", server_default="")
    fts_reg: Mapped[str] = mapped_column(Text, default="", server_default="")
    search_vector: Mapped[str | None] = mapped_column(TSVECTOR, Computed(SEARCH_VECTOR_SQL, persisted=True))
    # --- chuỗi cho tìm kiếm gần đúng (pg_trgm) khi OCR đọc sai/thiếu ký tự ---
    trgm_name: Mapped[str] = mapped_column(Text, default="", server_default="")
    trgm_ingredient: Mapped[str] = mapped_column(Text, default="", server_default="")

    __table_args__ = (
        CheckConstraint("id > 0", name="ck_medicine_catalog_id_positive"),
        Index("ix_medicine_catalog_name_norm", "name_norm"),
        Index("ix_medicine_catalog_name_core", "name_core"),
        Index("ix_medicine_catalog_search", "search_vector", postgresql_using="gin"),
        Index("ix_medicine_catalog_trgm_name", "trgm_name", postgresql_using="gin", postgresql_ops={"trgm_name": "gin_trgm_ops"}),
        Index(
            "ix_medicine_catalog_trgm_ingredient", "trgm_ingredient",
            postgresql_using="gin", postgresql_ops={"trgm_ingredient": "gin_trgm_ops"},
        ),
    )


class CatalogReg(Base):
    """Mọi số đăng ký (hiện tại, cũ, ghi trong ngoặc) của từng thuốc.

    Một thuốc có thể có nhiều số đăng ký và một số đăng ký có thể xuất hiện ở
    nhiều bản ghi, nên dùng bảng riêng thay vì cột duy nhất.
    """

    __tablename__ = "medicine_catalog_regs"

    reg_norm: Mapped[str] = mapped_column(String(40), primary_key=True)
    medicine_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("medicine_catalog.id", ondelete="CASCADE"), primary_key=True
    )
    kind: Mapped[str] = mapped_column(String(8), default="current", server_default="current")  # current | old

    __table_args__ = (
        CheckConstraint("kind IN ('current', 'old')", name="ck_medicine_catalog_regs_kind"),
        Index("ix_medicine_catalog_regs_medicine", "medicine_id"),
        # Tìm theo tiền tố (LIKE 'VN20%') không phụ thuộc collation của CSDL.
        Index("ix_medicine_catalog_regs_prefix", "reg_norm", postgresql_ops={"reg_norm": "text_pattern_ops"}),
    )


class CatalogBarcode(Base):
    """Mã vạch (GTIN) → thuốc trong danh mục DAV. Chỉ trỏ tới thuốc ĐÃ CÓ trong danh mục, không tạo thuốc mới.

    Một mã vạch chỉ thuộc về một thuốc (khóa chính là GTIN); một thuốc có thể có nhiều mã (hộp, vỉ, chai…).
    GTIN lưu dạng 14 chữ số (thêm 0 bên trái), nên EAN-13 / UPC-A / GTIN-14 của cùng sản phẩm trùng nhau.
    """

    __tablename__ = "medicine_catalog_barcodes"

    gtin: Mapped[str] = mapped_column(String(14), primary_key=True)
    medicine_id: Mapped[int] = mapped_column(Integer, ForeignKey("medicine_catalog.id", ondelete="CASCADE"))
    unit: Mapped[str | None] = mapped_column(Text)  # cấp đóng gói ghi trong file nguồn (Hộp, Vỉ…)
    source: Mapped[str] = mapped_column(String(16))  # excel | csdlduoc
    match_method: Mapped[str] = mapped_column(String(16))  # registration | name — cách đã khớp với danh mục
    import_id: Mapped[int | None] = mapped_column(BigInteger, ForeignKey("barcode_imports.id", ondelete="SET NULL"))
    created_at: Mapped[datetime] = mapped_column(LocalDateTime)

    __table_args__ = (
        CheckConstraint("gtin ~ '^[0-9]{14}$'", name="ck_medicine_catalog_barcodes_gtin"),
        CheckConstraint("source IN ('excel', 'csdlduoc')", name="ck_medicine_catalog_barcodes_source"),
        CheckConstraint("match_method IN ('registration', 'name')", name="ck_medicine_catalog_barcodes_method"),
        Index("ix_medicine_catalog_barcodes_medicine", "medicine_id"),
    )


class BarcodeImport(Base):
    """Mỗi lần nhập file mã vạch (Excel/CSV từ nhà thuốc) — để biết dữ liệu đến từ đâu, khi nào, ai nhập."""

    __tablename__ = "barcode_imports"

    id: Mapped[int] = mapped_column(BigInteger, Identity(), primary_key=True)
    file_name: Mapped[str] = mapped_column(Text)
    rows_total: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    linked: Mapped[int] = mapped_column(Integer, default=0, server_default="0")  # liên kết mới
    unchanged: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    conflicts: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    unmatched: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    invalid: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    started_by: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(LocalDateTime)


class CatalogImport(Base):
    __tablename__ = "catalog_imports"

    id: Mapped[int] = mapped_column(BigInteger, Identity(), primary_key=True)
    file_path: Mapped[str] = mapped_column(Text)
    file_name: Mapped[str] = mapped_column(Text)
    file_hash: Mapped[str | None] = mapped_column(String(64))
    file_size: Mapped[int | None] = mapped_column(BigInteger)
    status: Mapped[str] = mapped_column(String(16), default="running", server_default="running")
    rows_total: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    inserted: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    updated: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    unchanged: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    skipped: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    removed: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    duplicate_ids: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    error_rows: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    message: Mapped[str | None] = mapped_column(Text)
    started_at: Mapped[datetime] = mapped_column(LocalDateTime)
    finished_at: Mapped[datetime | None] = mapped_column(LocalDateTime)
    started_by: Mapped[str | None] = mapped_column(Text)  # email người khởi chạy (nếu có)

    __table_args__ = (
        CheckConstraint("status IN ('running', 'success', 'failed', 'skipped')", name="ck_catalog_imports_status"),
    )
