"""Trang web quét thuốc: khách (chưa đăng nhập) được quét thử vài lần.

* Bảng ``guest_usage``: số lượt quét đã dùng của mỗi trình duyệt khách (khóa = HMAC mã khách, không lưu IP).
* Cột ``ocr_jobs.guest_key``: lượt quét của khách nào — chỉ chính khách đó xem/hủy/tra tiếp được.

Chỉ THÊM bảng/cột mới — không sửa/xóa dữ liệu hiện có.

Revision ID: 0006
Revises: 0005
Create Date: 2026-11-26 10:00:00
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0006"
down_revision = "0005"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("ocr_jobs", sa.Column("guest_key", sa.String(length=64), nullable=True))
    op.create_index("ix_ocr_jobs_guest", "ocr_jobs", ["guest_key"], unique=False, postgresql_where=sa.text("guest_key IS NOT NULL"))
    op.create_table(
        "guest_usage",
        sa.Column("guest_key", sa.String(length=64), nullable=False),
        sa.Column("scans_used", sa.SmallInteger(), server_default="0", nullable=False),
        sa.Column("codes", postgresql.JSONB(astext_type=sa.Text()), server_default=sa.text("'[]'::jsonb"), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("last_used_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint("scans_used >= 0", name="ck_guest_usage_scans"),
        sa.PrimaryKeyConstraint("guest_key"),
    )


def downgrade() -> None:
    op.drop_table("guest_usage")
    op.drop_index("ix_ocr_jobs_guest", table_name="ocr_jobs")
    op.drop_column("ocr_jobs", "guest_key")
