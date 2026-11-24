"""Mã vạch (GTIN) → thuốc trong danh mục DAV, và nhật ký các lần nhập file mã vạch.

Chỉ THÊM hai bảng mới — không sửa/xóa dữ liệu hiện có.

Revision ID: 0002
Revises: 0001
Create Date: 2026-11-20 05:30:00
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0002"
down_revision = "0001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "barcode_imports",
        sa.Column("id", sa.BigInteger(), sa.Identity(always=False), nullable=False),
        sa.Column("file_name", sa.Text(), nullable=False),
        sa.Column("rows_total", sa.Integer(), server_default="0", nullable=False),
        sa.Column("linked", sa.Integer(), server_default="0", nullable=False),
        sa.Column("unchanged", sa.Integer(), server_default="0", nullable=False),
        sa.Column("conflicts", sa.Integer(), server_default="0", nullable=False),
        sa.Column("unmatched", sa.Integer(), server_default="0", nullable=False),
        sa.Column("invalid", sa.Integer(), server_default="0", nullable=False),
        sa.Column("started_by", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_table(
        "medicine_catalog_barcodes",
        sa.Column("gtin", sa.String(length=14), nullable=False),
        sa.Column("medicine_id", sa.Integer(), nullable=False),
        sa.Column("unit", sa.Text(), nullable=True),
        sa.Column("source", sa.String(length=16), nullable=False),
        sa.Column("match_method", sa.String(length=16), nullable=False),
        sa.Column("import_id", sa.BigInteger(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint("gtin ~ '^[0-9]{14}$'", name="ck_medicine_catalog_barcodes_gtin"),
        sa.CheckConstraint("source IN ('excel', 'csdlduoc')", name="ck_medicine_catalog_barcodes_source"),
        sa.CheckConstraint("match_method IN ('registration', 'name')", name="ck_medicine_catalog_barcodes_method"),
        sa.ForeignKeyConstraint(["medicine_id"], ["medicine_catalog.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["import_id"], ["barcode_imports.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("gtin"),
    )
    op.create_index("ix_medicine_catalog_barcodes_medicine", "medicine_catalog_barcodes", ["medicine_id"], unique=False)


def downgrade() -> None:
    op.drop_index("ix_medicine_catalog_barcodes_medicine", table_name="medicine_catalog_barcodes")
    op.drop_table("medicine_catalog_barcodes")
    op.drop_table("barcode_imports")
