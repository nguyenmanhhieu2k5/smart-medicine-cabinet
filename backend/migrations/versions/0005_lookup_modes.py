"""Lưu đệm tra cứu: thêm chế độ không dùng AI — 'search' (tìm kiếm web Tavily + quy tắc) và 'text' (đọc số đăng ký
trong nội dung mã QR).

Chỉ nới ràng buộc CHECK — không sửa/xóa dữ liệu.

Revision ID: 0005
Revises: 0004
Create Date: 2026-11-25 10:00:00
"""
from __future__ import annotations

from alembic import op

revision = "0005"
down_revision = "0004"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.drop_constraint("ck_ai_lookups_mode", "ai_lookups", type_="check")
    op.create_check_constraint("ck_ai_lookups_mode", "ai_lookups", "mode IN ('web', 'offline', 'search', 'text')")


def downgrade() -> None:
    op.execute("DELETE FROM ai_lookups WHERE mode IN ('search', 'text')")
    op.drop_constraint("ck_ai_lookups_mode", "ai_lookups", type_="check")
    op.create_check_constraint("ck_ai_lookups_mode", "ai_lookups", "mode IN ('web', 'offline')")
