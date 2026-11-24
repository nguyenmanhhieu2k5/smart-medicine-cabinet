"""Tài khoản đăng ký (SCANNER) được XEM thuốc trong tủ và SỬA NGÀY HẾT HẠN — không thêm/xóa/sửa thông tin khác.

Thêm quyền `cabinet:update_expiry` (ADMIN cũng có); SCANNER thêm `cabinet:read` + `cabinet:update_expiry`.
Chỉ THÊM dữ liệu phân quyền — không sửa/xóa dữ liệu hiện có (trừ cập nhật mô tả vai trò SCANNER).

Revision ID: 0004
Revises: 0003
Create Date: 2026-11-25 00:30:00
"""
from __future__ import annotations

from alembic import op

revision = "0004"
down_revision = "0003"
branch_labels = None
depends_on = None

OLD_DESC = "Ứng dụng di động: quét OCR, tra cứu, xem lịch sử quét của chính mình."
NEW_DESC = ("Tài khoản tự đăng ký (ứng dụng di động): quét thuốc, tra cứu, xem lịch sử quét của chính mình, "
            "xem thuốc trong tủ và sửa ngày hết hạn. Không thêm/xóa thuốc, không điều khiển ESP32.")


def upgrade() -> None:
    op.execute(
        "INSERT INTO permissions (id, code, description) VALUES "
        "(19, 'cabinet:update_expiry', 'Sửa ngày hết hạn thuốc trong tủ (không thêm, xóa hay sửa thông tin khác)') "
        "ON CONFLICT (id) DO NOTHING"
    )
    op.execute(
        "INSERT INTO role_permissions (role_id, permission_id) "
        "SELECT r.id, p.id FROM roles r JOIN permissions p ON "
        "(r.code = 'ADMIN' AND p.code = 'cabinet:update_expiry') OR "
        "(r.code = 'SCANNER' AND p.code IN ('cabinet:read', 'cabinet:update_expiry')) "
        "ON CONFLICT DO NOTHING"
    )
    op.execute(f"UPDATE roles SET description = '{NEW_DESC}' WHERE code = 'SCANNER'")


def downgrade() -> None:
    op.execute(
        "DELETE FROM role_permissions WHERE role_id = (SELECT id FROM roles WHERE code = 'SCANNER') "
        "AND permission_id IN (SELECT id FROM permissions WHERE code IN ('cabinet:read', 'cabinet:update_expiry'))"
    )
    op.execute("DELETE FROM role_permissions WHERE permission_id = (SELECT id FROM permissions WHERE code = 'cabinet:update_expiry')")
    op.execute("DELETE FROM permissions WHERE code = 'cabinet:update_expiry'")
    op.execute(f"UPDATE roles SET description = '{OLD_DESC}' WHERE code = 'SCANNER'")
