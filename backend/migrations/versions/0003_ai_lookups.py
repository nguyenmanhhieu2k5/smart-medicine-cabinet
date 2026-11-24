"""Lưu đệm kết quả tra cứu thuốc bằng AI (Gemini + Google Search).

Chỉ THÊM một bảng mới — không sửa/xóa dữ liệu hiện có.

Revision ID: 0003
Revises: 0002
Create Date: 2026-11-24 23:00:00
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0003"
down_revision = "0002"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "ai_lookups",
        sa.Column("id", sa.BigInteger(), sa.Identity(always=False), nullable=False),
        sa.Column("kind", sa.String(length=16), nullable=False),
        sa.Column("query_key", sa.String(length=160), nullable=False),
        sa.Column("status", sa.String(length=16), nullable=False),
        sa.Column("mode", sa.String(length=16), nullable=False),
        sa.Column("model", sa.String(length=64), nullable=False),
        sa.Column("result", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("sources", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("catalog_ids", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=True),
        sa.Column("elapsed_ms", sa.Integer(), server_default="0", nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint("kind IN ('barcode', 'qr', 'scan')", name="ck_ai_lookups_kind"),
        sa.CheckConstraint("status IN ('found', 'not_found')", name="ck_ai_lookups_status"),
        sa.CheckConstraint("mode IN ('web', 'offline')", name="ck_ai_lookups_mode"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_ai_lookups_key_created", "ai_lookups", ["query_key", "created_at"], unique=False)


def downgrade() -> None:
    op.drop_index("ix_ai_lookups_key_created", table_name="ai_lookups")
    op.drop_table("ai_lookups")
