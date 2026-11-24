"""Lược đồ PostgreSQL ban đầu: danh mục thuốc, tủ thuốc, tài khoản/phân quyền, OCR, IoT, kiểm toán.

Revision ID: 0001
Revises: 
Create Date: 2026-11-18 21:50:17.210569
"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = '0001'
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    # pg_trgm: tìm gần đúng khi OCR đọc sai ký tự; unaccent: tìm không dấu tiếng Việt.
    # Cả hai là extension "trusted" nên chủ sở hữu CSDL (không phải superuser) tạo được.
    op.execute("CREATE EXTENSION IF NOT EXISTS pg_trgm")
    op.execute("CREATE EXTENSION IF NOT EXISTS unaccent")

    op.create_table('alerts',
    sa.Column('id', sa.BigInteger(), sa.Identity(always=False), nullable=False),
    sa.Column('category', sa.String(length=16), nullable=False),
    sa.Column('type', sa.String(length=32), nullable=False),
    sa.Column('severity', sa.String(length=12), nullable=False),
    sa.Column('title', sa.Text(), nullable=False),
    sa.Column('message', sa.Text(), nullable=False),
    sa.Column('dedupe_key', sa.String(length=96), nullable=False),
    sa.Column('status', sa.String(length=16), server_default='active', nullable=False),
    sa.Column('data', postgresql.JSONB(astext_type=sa.Text()), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('resolved_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('notified_at', sa.DateTime(timezone=True), nullable=True),
    sa.CheckConstraint("category IN ('environment', 'medicine', 'system')", name='ck_alerts_category'),
    sa.CheckConstraint("severity IN ('normal', 'info', 'warning', 'danger')", name='ck_alerts_severity'),
    sa.CheckConstraint("status IN ('active', 'seen', 'acknowledged', 'resolved')", name='ck_alerts_status'),
    sa.PrimaryKeyConstraint('id')
    )
    op.create_index('ix_alerts_created', 'alerts', ['created_at'], unique=False)
    op.create_index('ix_alerts_status_key', 'alerts', ['status', 'dedupe_key'], unique=False)
    op.create_table('catalog_imports',
    sa.Column('id', sa.BigInteger(), sa.Identity(always=False), nullable=False),
    sa.Column('file_path', sa.Text(), nullable=False),
    sa.Column('file_name', sa.Text(), nullable=False),
    sa.Column('file_hash', sa.String(length=64), nullable=True),
    sa.Column('file_size', sa.BigInteger(), nullable=True),
    sa.Column('status', sa.String(length=16), server_default='running', nullable=False),
    sa.Column('rows_total', sa.Integer(), server_default='0', nullable=False),
    sa.Column('inserted', sa.Integer(), server_default='0', nullable=False),
    sa.Column('updated', sa.Integer(), server_default='0', nullable=False),
    sa.Column('unchanged', sa.Integer(), server_default='0', nullable=False),
    sa.Column('skipped', sa.Integer(), server_default='0', nullable=False),
    sa.Column('removed', sa.Integer(), server_default='0', nullable=False),
    sa.Column('duplicate_ids', sa.Integer(), server_default='0', nullable=False),
    sa.Column('error_rows', sa.Integer(), server_default='0', nullable=False),
    sa.Column('message', sa.Text(), nullable=True),
    sa.Column('started_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('finished_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('started_by', sa.Text(), nullable=True),
    sa.CheckConstraint("status IN ('running', 'success', 'failed', 'skipped')", name='ck_catalog_imports_status'),
    sa.PrimaryKeyConstraint('id')
    )
    op.create_table('history_events',
    sa.Column('id', sa.BigInteger(), sa.Identity(always=False), nullable=False),
    sa.Column('grp', sa.String(length=16), nullable=False),
    sa.Column('type', sa.String(length=32), nullable=False),
    sa.Column('title', sa.Text(), nullable=False),
    sa.Column('description', sa.Text(), nullable=True),
    sa.Column('data', postgresql.JSONB(astext_type=sa.Text()), nullable=True),
    sa.Column('image_path', sa.Text(), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.PrimaryKeyConstraint('id')
    )
    op.create_index('ix_history_created', 'history_events', ['created_at'], unique=False)
    op.create_index('ix_history_group', 'history_events', ['grp'], unique=False)
    op.create_table('permissions',
    sa.Column('id', sa.SmallInteger(), autoincrement=False, nullable=False),
    sa.Column('code', sa.String(length=64), nullable=False),
    sa.Column('description', sa.Text(), nullable=False),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('code')
    )
    op.create_table('roles',
    sa.Column('id', sa.SmallInteger(), autoincrement=False, nullable=False),
    sa.Column('code', sa.String(length=32), nullable=False),
    sa.Column('name', sa.Text(), nullable=False),
    sa.Column('description', sa.Text(), nullable=True),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('code')
    )
    op.create_table('settings',
    sa.Column('key', sa.String(length=64), nullable=False),
    sa.Column('value', postgresql.JSONB(astext_type=sa.Text()), nullable=False),
    sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
    sa.PrimaryKeyConstraint('key')
    )
    op.create_table('medicine_catalog',
    sa.Column('id', sa.Integer(), autoincrement=False, nullable=False),
    sa.Column('ten_thuoc', sa.Text(), nullable=False),
    sa.Column('so_dang_ky', sa.Text(), nullable=True),
    sa.Column('so_dang_ky_cu', sa.Text(), nullable=True),
    sa.Column('hoat_chat_chinh', sa.Text(), nullable=True),
    sa.Column('ham_luong', sa.Text(), nullable=True),
    sa.Column('dang_bao_che', sa.Text(), nullable=True),
    sa.Column('dong_goi', sa.Text(), nullable=True),
    sa.Column('tieu_chuan', sa.Text(), nullable=True),
    sa.Column('tuoi_tho', sa.Text(), nullable=True),
    sa.Column('ten_duong_dung', sa.Text(), nullable=True),
    sa.Column('ngay_cap_so_dang_ky', sa.Text(), nullable=True),
    sa.Column('ngay_gia_han_so_dang_ky', sa.Text(), nullable=True),
    sa.Column('ngay_het_han_so_dang_ky', sa.Text(), nullable=True),
    sa.Column('so_quyet_dinh', sa.Text(), nullable=True),
    sa.Column('dot_cap', sa.Text(), nullable=True),
    sa.Column('ten_cong_ty_dang_ky', sa.Text(), nullable=True),
    sa.Column('dia_chi_dang_ky', sa.Text(), nullable=True),
    sa.Column('nuoc_dang_ky', sa.Text(), nullable=True),
    sa.Column('ten_cong_ty_san_xuat', sa.Text(), nullable=True),
    sa.Column('dia_chi_san_xuat', sa.Text(), nullable=True),
    sa.Column('nuoc_san_xuat', sa.Text(), nullable=True),
    sa.Column('is_active', sa.Boolean(), nullable=True),
    sa.Column('is_het_han', sa.Boolean(), nullable=True),
    sa.Column('is_da_rut_so_dang_ky', sa.Boolean(), nullable=True),
    sa.Column('is_deleted', sa.Boolean(), nullable=True),
    sa.Column('is_dong_bo', sa.Boolean(), nullable=True),
    sa.Column('phan_loai_thuoc_enum', sa.Text(), nullable=True),
    sa.Column('creation_time', sa.Text(), nullable=True),
    sa.Column('name_norm', sa.Text(), server_default='', nullable=False),
    sa.Column('name_core', sa.Text(), server_default='', nullable=False),
    sa.Column('ingredient_norm', sa.Text(), server_default='', nullable=False),
    sa.Column('strength_norm', sa.Text(), server_default='', nullable=False),
    sa.Column('form_norm', sa.Text(), server_default='', nullable=False),
    sa.Column('shelf_life_months', sa.Integer(), nullable=True),
    sa.Column('row_hash', sa.String(length=40), nullable=False),
    sa.Column('import_id', sa.BigInteger(), nullable=True),
    sa.Column('in_source', sa.Boolean(), server_default='true', nullable=False),
    sa.Column('fts_name', sa.Text(), server_default='', nullable=False),
    sa.Column('fts_ingredient', sa.Text(), server_default='', nullable=False),
    sa.Column('fts_strength', sa.Text(), server_default='', nullable=False),
    sa.Column('fts_form', sa.Text(), server_default='', nullable=False),
    sa.Column('fts_reg', sa.Text(), server_default='', nullable=False),
    sa.Column('search_vector', postgresql.TSVECTOR(), sa.Computed("coalesce(setweight(array_to_tsvector(string_to_array(nullif(fts_name, ''), ' ')), 'A'), ''::tsvector) || coalesce(setweight(array_to_tsvector(string_to_array(nullif(fts_ingredient, ''), ' ')), 'B'), ''::tsvector) || coalesce(setweight(array_to_tsvector(string_to_array(nullif(fts_strength, ''), ' ')), 'C'), ''::tsvector) || coalesce(setweight(array_to_tsvector(string_to_array(nullif(fts_form, ''), ' ')), 'D'), ''::tsvector) || coalesce(setweight(array_to_tsvector(string_to_array(nullif(fts_reg, ''), ' ')), 'D'), ''::tsvector)", persisted=True), nullable=True),
    sa.Column('trgm_name', sa.Text(), server_default='', nullable=False),
    sa.Column('trgm_ingredient', sa.Text(), server_default='', nullable=False),
    sa.CheckConstraint('id > 0', name='ck_medicine_catalog_id_positive'),
    sa.ForeignKeyConstraint(['import_id'], ['catalog_imports.id'], ondelete='SET NULL'),
    sa.PrimaryKeyConstraint('id')
    )
    op.create_index('ix_medicine_catalog_name_core', 'medicine_catalog', ['name_core'], unique=False)
    op.create_index('ix_medicine_catalog_name_norm', 'medicine_catalog', ['name_norm'], unique=False)
    op.create_index('ix_medicine_catalog_search', 'medicine_catalog', ['search_vector'], unique=False, postgresql_using='gin')
    op.create_index('ix_medicine_catalog_trgm_ingredient', 'medicine_catalog', ['trgm_ingredient'], unique=False, postgresql_using='gin', postgresql_ops={'trgm_ingredient': 'gin_trgm_ops'})
    op.create_index('ix_medicine_catalog_trgm_name', 'medicine_catalog', ['trgm_name'], unique=False, postgresql_using='gin', postgresql_ops={'trgm_name': 'gin_trgm_ops'})
    op.create_table('role_permissions',
    sa.Column('role_id', sa.SmallInteger(), nullable=False),
    sa.Column('permission_id', sa.SmallInteger(), nullable=False),
    sa.ForeignKeyConstraint(['permission_id'], ['permissions.id'], ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['role_id'], ['roles.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('role_id', 'permission_id')
    )
    op.create_table('users',
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.Column('email', sa.String(length=254), nullable=False),
    sa.Column('full_name', sa.String(length=120), server_default='', nullable=False),
    sa.Column('phone', sa.String(length=32), nullable=True),
    sa.Column('password_hash', sa.Text(), nullable=False),
    sa.Column('role_id', sa.SmallInteger(), nullable=False),
    sa.Column('is_active', sa.Boolean(), server_default='true', nullable=False),
    sa.Column('failed_logins', sa.Integer(), server_default='0', nullable=False),
    sa.Column('locked_until', sa.DateTime(timezone=True), nullable=True),
    sa.Column('last_login_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('password_changed_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('preferences', postgresql.JSONB(astext_type=sa.Text()), nullable=False),
    sa.CheckConstraint("char_length(email) BETWEEN 3 AND 254 AND position('@' in email) > 1", name='ck_users_email'),
    sa.CheckConstraint('failed_logins >= 0', name='ck_users_failed_logins'),
    sa.ForeignKeyConstraint(['role_id'], ['roles.id'], ondelete='RESTRICT'),
    sa.PrimaryKeyConstraint('id')
    )
    op.create_index('uq_users_email_lower', 'users', [sa.literal_column('lower(email)')], unique=True)
    op.create_table('audit_logs',
    sa.Column('id', sa.BigInteger(), sa.Identity(always=False), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('user_id', sa.Uuid(), nullable=True),
    sa.Column('actor', sa.String(length=254), nullable=True),
    sa.Column('channel', sa.String(length=16), nullable=False),
    sa.Column('action', sa.String(length=64), nullable=False),
    sa.Column('resource_type', sa.String(length=32), nullable=True),
    sa.Column('resource_id', sa.String(length=64), nullable=True),
    sa.Column('success', sa.Boolean(), server_default='true', nullable=False),
    sa.Column('ip', sa.String(length=64), nullable=True),
    sa.Column('detail', postgresql.JSONB(astext_type=sa.Text()), nullable=True),
    sa.CheckConstraint("channel IN ('admin', 'public', 'device', 'system', 'cli')", name='ck_audit_logs_channel'),
    sa.ForeignKeyConstraint(['user_id'], ['users.id'], ondelete='SET NULL'),
    sa.PrimaryKeyConstraint('id')
    )
    op.create_index('ix_audit_logs_action', 'audit_logs', ['action'], unique=False)
    op.create_index('ix_audit_logs_created', 'audit_logs', ['created_at'], unique=False)
    op.create_index('ix_audit_logs_user', 'audit_logs', ['user_id', 'created_at'], unique=False)
    op.create_table('cabinet_medicines',
    sa.Column('id', sa.BigInteger(), sa.Identity(always=False), nullable=False),
    sa.Column('catalog_id', sa.Integer(), nullable=True),
    sa.Column('name', sa.Text(), nullable=False),
    sa.Column('ingredient', sa.Text(), nullable=True),
    sa.Column('strength', sa.Text(), nullable=True),
    sa.Column('dosage_form', sa.Text(), nullable=True),
    sa.Column('registration_no', sa.Text(), nullable=True),
    sa.Column('manufacturer', sa.Text(), nullable=True),
    sa.Column('quantity', sa.Float(), server_default='0', nullable=False),
    sa.Column('unit', sa.String(length=24), server_default='viên', nullable=False),
    sa.Column('expiry_date', sa.Date(), nullable=True),
    sa.Column('expiry_source', sa.String(length=16), nullable=True),
    sa.Column('lot_number', sa.String(length=64), nullable=True),
    sa.Column('low_stock_threshold', sa.Float(), nullable=True),
    sa.Column('location', sa.Text(), nullable=True),
    sa.Column('note', sa.Text(), nullable=True),
    sa.Column('image_path', sa.Text(), nullable=True),
    sa.Column('source', sa.String(length=16), server_default='manual', nullable=False),
    sa.Column('created_by', sa.Uuid(), nullable=True),
    sa.Column('updated_by', sa.Uuid(), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
    sa.CheckConstraint("expiry_source IS NULL OR expiry_source IN ('manual', 'ocr_confirmed')", name='ck_cabinet_medicines_expiry_source'),
    sa.CheckConstraint("source IN ('scan', 'manual', 'migrated')", name='ck_cabinet_medicines_source'),
    sa.CheckConstraint('low_stock_threshold IS NULL OR low_stock_threshold >= 0', name='ck_cabinet_medicines_threshold'),
    sa.CheckConstraint('quantity >= 0', name='ck_cabinet_medicines_quantity'),
    sa.ForeignKeyConstraint(['catalog_id'], ['medicine_catalog.id'], ondelete='SET NULL'),
    sa.ForeignKeyConstraint(['created_by'], ['users.id'], ondelete='SET NULL'),
    sa.ForeignKeyConstraint(['updated_by'], ['users.id'], ondelete='SET NULL'),
    sa.PrimaryKeyConstraint('id')
    )
    op.create_index(op.f('ix_cabinet_medicines_catalog_id'), 'cabinet_medicines', ['catalog_id'], unique=False)
    op.create_index(op.f('ix_cabinet_medicines_expiry_date'), 'cabinet_medicines', ['expiry_date'], unique=False)
    op.create_table('devices',
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.Column('name', sa.String(length=80), nullable=False),
    sa.Column('token_hash', sa.String(length=64), nullable=False),
    sa.Column('token_hint', sa.String(length=12), nullable=False),
    sa.Column('firmware', sa.String(length=32), nullable=True),
    sa.Column('capabilities', postgresql.JSONB(astext_type=sa.Text()), nullable=False),
    sa.Column('is_active', sa.Boolean(), server_default='true', nullable=False),
    sa.Column('is_primary', sa.Boolean(), server_default='false', nullable=False),
    sa.Column('last_seen_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('last_ip', sa.String(length=64), nullable=True),
    sa.Column('last_state', postgresql.JSONB(astext_type=sa.Text()), nullable=True),
    sa.Column('note', sa.Text(), nullable=True),
    sa.Column('created_by', sa.Uuid(), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
    sa.CheckConstraint('char_length(name) BETWEEN 1 AND 80', name='ck_devices_name'),
    sa.ForeignKeyConstraint(['created_by'], ['users.id'], ondelete='SET NULL'),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('token_hash')
    )
    op.create_index('uq_devices_primary', 'devices', ['is_primary'], unique=True, postgresql_where='is_primary')
    op.create_table('medicine_catalog_regs',
    sa.Column('reg_norm', sa.String(length=40), nullable=False),
    sa.Column('medicine_id', sa.Integer(), nullable=False),
    sa.Column('kind', sa.String(length=8), server_default='current', nullable=False),
    sa.CheckConstraint("kind IN ('current', 'old')", name='ck_medicine_catalog_regs_kind'),
    sa.ForeignKeyConstraint(['medicine_id'], ['medicine_catalog.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('reg_norm', 'medicine_id')
    )
    op.create_index('ix_medicine_catalog_regs_medicine', 'medicine_catalog_regs', ['medicine_id'], unique=False)
    op.create_index('ix_medicine_catalog_regs_prefix', 'medicine_catalog_regs', ['reg_norm'], unique=False, postgresql_ops={'reg_norm': 'text_pattern_ops'})
    op.create_table('ocr_jobs',
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.Column('user_id', sa.Uuid(), nullable=True),
    sa.Column('channel', sa.String(length=8), nullable=False),
    sa.Column('source', sa.String(length=16), nullable=False),
    sa.Column('status', sa.String(length=16), server_default='queued', nullable=False),
    sa.Column('progress', sa.SmallInteger(), server_default='0', nullable=False),
    sa.Column('message', sa.Text(), nullable=True),
    sa.Column('image_path', sa.Text(), nullable=True),
    sa.Column('thumb_path', sa.Text(), nullable=True),
    sa.Column('image_width', sa.Integer(), nullable=True),
    sa.Column('image_height', sa.Integer(), nullable=True),
    sa.Column('error', sa.Text(), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('started_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('finished_at', sa.DateTime(timezone=True), nullable=True),
    sa.CheckConstraint("channel IN ('admin', 'public')", name='ck_ocr_jobs_channel'),
    sa.CheckConstraint("source IN ('camera', 'upload')", name='ck_ocr_jobs_source'),
    sa.CheckConstraint("status IN ('queued', 'preprocessing', 'recognizing', 'matching', 'done', 'error', 'cancelled')", name='ck_ocr_jobs_status'),
    sa.CheckConstraint('progress BETWEEN 0 AND 100', name='ck_ocr_jobs_progress'),
    sa.ForeignKeyConstraint(['user_id'], ['users.id'], ondelete='SET NULL'),
    sa.PrimaryKeyConstraint('id')
    )
    op.create_index('ix_ocr_jobs_status', 'ocr_jobs', ['status'], unique=False)
    op.create_index('ix_ocr_jobs_user_created', 'ocr_jobs', ['user_id', 'created_at'], unique=False)
    op.create_table('password_resets',
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.Column('user_id', sa.Uuid(), nullable=False),
    sa.Column('code_hash', sa.String(length=64), nullable=False),
    sa.Column('attempts', sa.Integer(), server_default='0', nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('expires_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('used_at', sa.DateTime(timezone=True), nullable=True),
    sa.CheckConstraint('attempts >= 0', name='ck_password_resets_attempts'),
    sa.ForeignKeyConstraint(['user_id'], ['users.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id')
    )
    op.create_index(op.f('ix_password_resets_user_id'), 'password_resets', ['user_id'], unique=False)
    op.create_table('user_sessions',
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.Column('user_id', sa.Uuid(), nullable=False),
    sa.Column('refresh_hash', sa.String(length=64), nullable=False),
    sa.Column('audience', sa.String(length=16), nullable=False),
    sa.Column('client', sa.String(length=32), nullable=True),
    sa.Column('user_agent', sa.Text(), nullable=True),
    sa.Column('ip', sa.String(length=64), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('last_used_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('expires_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('revoked_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('revoked_reason', sa.String(length=32), nullable=True),
    sa.CheckConstraint("audience IN ('scanner', 'admin')", name='ck_user_sessions_audience'),
    sa.CheckConstraint('expires_at > created_at', name='ck_user_sessions_expiry'),
    sa.ForeignKeyConstraint(['user_id'], ['users.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('refresh_hash')
    )
    op.create_index('ix_user_sessions_user', 'user_sessions', ['user_id', 'revoked_at'], unique=False)
    op.create_table('device_commands',
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.Column('device_id', sa.Uuid(), nullable=False),
    sa.Column('action', sa.String(length=40), nullable=False),
    sa.Column('payload', postgresql.JSONB(astext_type=sa.Text()), nullable=False),
    sa.Column('status', sa.String(length=16), server_default='pending', nullable=False),
    sa.Column('created_by', sa.Uuid(), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('expires_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('sent_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('acknowledged_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('completed_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('attempts', sa.Integer(), server_default='0', nullable=False),
    sa.Column('error', sa.Text(), nullable=True),
    sa.Column('result', postgresql.JSONB(astext_type=sa.Text()), nullable=True),
    sa.CheckConstraint("status IN ('pending', 'sent', 'acknowledged', 'applied', 'failed', 'timed_out', 'cancelled')", name='ck_device_commands_status'),
    sa.CheckConstraint('expires_at > created_at', name='ck_device_commands_expiry'),
    sa.ForeignKeyConstraint(['created_by'], ['users.id'], ondelete='SET NULL'),
    sa.ForeignKeyConstraint(['device_id'], ['devices.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id')
    )
    op.create_index('ix_device_commands_created', 'device_commands', ['created_at'], unique=False)
    op.create_index('ix_device_commands_device_status', 'device_commands', ['device_id', 'status'], unique=False)
    op.create_table('device_telemetry',
    sa.Column('id', sa.BigInteger(), sa.Identity(always=False), nullable=False),
    sa.Column('device_id', sa.Uuid(), nullable=False),
    sa.Column('recorded_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('temperature', sa.Float(), nullable=True),
    sa.Column('humidity', sa.Float(), nullable=True),
    sa.Column('sensor_ok', sa.Boolean(), nullable=True),
    sa.Column('simulated', sa.Boolean(), server_default='false', nullable=False),
    sa.Column('extra', postgresql.JSONB(astext_type=sa.Text()), nullable=True),
    sa.CheckConstraint('humidity IS NULL OR humidity BETWEEN 0 AND 100', name='ck_device_telemetry_humidity'),
    sa.CheckConstraint('temperature IS NULL OR temperature BETWEEN -40 AND 85', name='ck_device_telemetry_temperature'),
    sa.ForeignKeyConstraint(['device_id'], ['devices.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id')
    )
    op.create_index('ix_device_telemetry_device_time', 'device_telemetry', ['device_id', 'recorded_at'], unique=False)
    op.create_table('medicine_inventory_logs',
    sa.Column('id', sa.BigInteger(), sa.Identity(always=False), nullable=False),
    sa.Column('cabinet_medicine_id', sa.BigInteger(), nullable=True),
    sa.Column('medicine_name', sa.Text(), nullable=False),
    sa.Column('action', sa.String(length=16), nullable=False),
    sa.Column('quantity_before', sa.Float(), nullable=True),
    sa.Column('quantity_after', sa.Float(), nullable=True),
    sa.Column('delta', sa.Float(), nullable=True),
    sa.Column('unit', sa.String(length=24), nullable=True),
    sa.Column('note', sa.Text(), nullable=True),
    sa.Column('user_id', sa.Uuid(), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.CheckConstraint("action IN ('create', 'add', 'consume', 'adjust', 'update', 'delete', 'migrate')", name='ck_inventory_logs_action'),
    sa.ForeignKeyConstraint(['cabinet_medicine_id'], ['cabinet_medicines.id'], ondelete='SET NULL'),
    sa.ForeignKeyConstraint(['user_id'], ['users.id'], ondelete='SET NULL'),
    sa.PrimaryKeyConstraint('id')
    )
    op.create_index('ix_inventory_logs_created', 'medicine_inventory_logs', ['created_at'], unique=False)
    op.create_index('ix_inventory_logs_item_created', 'medicine_inventory_logs', ['cabinet_medicine_id', 'created_at'], unique=False)
    op.create_table('ocr_candidates',
    sa.Column('id', sa.BigInteger(), sa.Identity(always=False), nullable=False),
    sa.Column('job_id', sa.Uuid(), nullable=False),
    sa.Column('rank', sa.SmallInteger(), nullable=False),
    sa.Column('medicine_id', sa.Integer(), nullable=True),
    sa.Column('medicine_name', sa.Text(), nullable=False),
    sa.Column('score', sa.Float(), nullable=False),
    sa.Column('level', sa.String(length=8), nullable=False),
    sa.Column('details', postgresql.JSONB(astext_type=sa.Text()), nullable=True),
    sa.CheckConstraint("level IN ('high', 'medium', 'low')", name='ck_ocr_candidates_level'),
    sa.CheckConstraint('rank BETWEEN 1 AND 3', name='ck_ocr_candidates_rank'),
    sa.CheckConstraint('score >= 0', name='ck_ocr_candidates_score'),
    sa.ForeignKeyConstraint(['job_id'], ['ocr_jobs.id'], ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['medicine_id'], ['medicine_catalog.id'], ondelete='SET NULL'),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('job_id', 'rank', name='uq_ocr_candidates_job_rank')
    )
    op.create_table('ocr_results',
    sa.Column('job_id', sa.Uuid(), nullable=False),
    sa.Column('raw_text', sa.Text(), server_default='', nullable=False),
    sa.Column('lines', postgresql.JSONB(astext_type=sa.Text()), nullable=False),
    sa.Column('line_count', sa.Integer(), server_default='0', nullable=False),
    sa.Column('mean_score', sa.Float(), nullable=True),
    sa.Column('preprocess', sa.String(length=64), nullable=True),
    sa.Column('engine', postgresql.JSONB(astext_type=sa.Text()), nullable=True),
    sa.Column('image_info', postgresql.JSONB(astext_type=sa.Text()), nullable=True),
    sa.Column('expiry_suggestion', postgresql.JSONB(astext_type=sa.Text()), nullable=True),
    sa.Column('match_status', sa.String(length=16), nullable=False),
    sa.Column('match_message', sa.Text(), nullable=True),
    sa.Column('extracted', postgresql.JSONB(astext_type=sa.Text()), nullable=True),
    sa.Column('elapsed_ms', sa.Integer(), nullable=True),
    sa.Column('payload', postgresql.JSONB(astext_type=sa.Text()), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.ForeignKeyConstraint(['job_id'], ['ocr_jobs.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('job_id')
    )
    op.create_table('reminders',
    sa.Column('id', sa.BigInteger(), sa.Identity(always=False), nullable=False),
    sa.Column('cabinet_item_id', sa.BigInteger(), nullable=True),
    sa.Column('medicine_name', sa.Text(), nullable=False),
    sa.Column('dose_text', sa.Text(), nullable=True),
    sa.Column('dose_quantity', sa.Float(), nullable=True),
    sa.Column('times', postgresql.JSONB(astext_type=sa.Text()), nullable=False),
    sa.Column('frequency', sa.String(length=16), server_default='daily', nullable=False),
    sa.Column('days_of_week', postgresql.JSONB(astext_type=sa.Text()), nullable=False),
    sa.Column('interval_days', sa.Integer(), server_default='1', nullable=False),
    sa.Column('start_date', sa.Date(), nullable=False),
    sa.Column('end_date', sa.Date(), nullable=True),
    sa.Column('enabled', sa.Boolean(), server_default='true', nullable=False),
    sa.Column('note', sa.Text(), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
    sa.CheckConstraint("frequency IN ('daily', 'weekly', 'interval')", name='ck_reminders_frequency'),
    sa.CheckConstraint('dose_quantity IS NULL OR dose_quantity > 0', name='ck_reminders_dose_quantity'),
    sa.CheckConstraint('end_date IS NULL OR end_date >= start_date', name='ck_reminders_dates'),
    sa.CheckConstraint('interval_days >= 1', name='ck_reminders_interval'),
    sa.ForeignKeyConstraint(['cabinet_item_id'], ['cabinet_medicines.id'], ondelete='SET NULL'),
    sa.PrimaryKeyConstraint('id')
    )
    op.create_index(op.f('ix_reminders_cabinet_item_id'), 'reminders', ['cabinet_item_id'], unique=False)
    op.create_table('scan_history',
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.Column('user_id', sa.Uuid(), nullable=False),
    sa.Column('job_id', sa.Uuid(), nullable=True),
    sa.Column('status', sa.String(length=16), nullable=False),
    sa.Column('title', sa.Text(), nullable=False),
    sa.Column('subtitle', sa.Text(), nullable=True),
    sa.Column('candidate_count', sa.SmallInteger(), server_default='0', nullable=False),
    sa.Column('top_medicine_id', sa.Integer(), nullable=True),
    sa.Column('selected_medicine_id', sa.Integer(), nullable=True),
    sa.Column('search_text', sa.Text(), server_default='', nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.CheckConstraint("status IN ('confident', 'uncertain', 'no_text', 'no_match', 'no_catalog', 'failed', 'cancelled')", name='ck_scan_history_status'),
    sa.ForeignKeyConstraint(['job_id'], ['ocr_jobs.id'], ondelete='SET NULL'),
    sa.ForeignKeyConstraint(['selected_medicine_id'], ['medicine_catalog.id'], ondelete='SET NULL'),
    sa.ForeignKeyConstraint(['top_medicine_id'], ['medicine_catalog.id'], ondelete='SET NULL'),
    sa.ForeignKeyConstraint(['user_id'], ['users.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('job_id')
    )
    op.create_index('ix_scan_history_user_created', 'scan_history', ['user_id', 'created_at'], unique=False)
    op.create_table('device_command_ack',
    sa.Column('id', sa.BigInteger(), sa.Identity(always=False), nullable=False),
    sa.Column('command_id', sa.Uuid(), nullable=False),
    sa.Column('status', sa.String(length=16), nullable=False),
    sa.Column('message', sa.Text(), nullable=True),
    sa.Column('payload', postgresql.JSONB(astext_type=sa.Text()), nullable=True),
    sa.Column('received_at', sa.DateTime(timezone=True), nullable=False),
    sa.CheckConstraint("status IN ('received', 'applied', 'failed')", name='ck_device_command_ack_status'),
    sa.ForeignKeyConstraint(['command_id'], ['device_commands.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id')
    )
    op.create_index(op.f('ix_device_command_ack_command_id'), 'device_command_ack', ['command_id'], unique=False)
    op.create_table('reminder_logs',
    sa.Column('id', sa.BigInteger(), sa.Identity(always=False), nullable=False),
    sa.Column('reminder_id', sa.BigInteger(), nullable=False),
    sa.Column('scheduled_for', sa.DateTime(timezone=True), nullable=False),
    sa.Column('status', sa.String(length=12), nullable=False),
    sa.Column('acted_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('notified_at', sa.DateTime(timezone=True), nullable=True),
    sa.CheckConstraint("status IN ('notified', 'taken', 'skipped')", name='ck_reminder_logs_status'),
    sa.ForeignKeyConstraint(['reminder_id'], ['reminders.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('reminder_id', 'scheduled_for', name='uq_reminder_occurrence')
    )
    op.create_index(op.f('ix_reminder_logs_reminder_id'), 'reminder_logs', ['reminder_id'], unique=False)

    # ---- vai trò và quyền mặc định ------------------------------------------------ #
    roles = sa.table("roles", sa.column("id", sa.SmallInteger), sa.column("code", sa.String), sa.column("name", sa.Text), sa.column("description", sa.Text))
    permissions = sa.table("permissions", sa.column("id", sa.SmallInteger), sa.column("code", sa.String), sa.column("description", sa.Text))
    role_permissions = sa.table("role_permissions", sa.column("role_id", sa.SmallInteger), sa.column("permission_id", sa.SmallInteger))
    op.bulk_insert(roles, [
        {"id": 1, "code": "ADMIN", "name": "Quản trị viên", "description": "Toàn quyền, chỉ qua ứng dụng Windows trên mạng quản trị (Tailscale)."},
        {"id": 2, "code": "SCANNER", "name": "Người quét", "description": "Ứng dụng di động: quét OCR, tra cứu, xem lịch sử quét của chính mình."},
    ])
    perms = [
        (1, "catalog:read", "Tra cứu danh mục thuốc"),
        (2, "catalog:manage", "Nhập/cập nhật danh mục thuốc từ Excel"),
        (3, "scan:create", "Gửi ảnh để nhận diện thuốc"),
        (4, "scan:read_own", "Xem lịch sử quét của chính mình"),
        (5, "scan:read_all", "Xem lịch sử quét của mọi tài khoản"),
        (6, "cabinet:read", "Xem thuốc trong tủ"),
        (7, "cabinet:write", "Thêm, sửa, xóa thuốc và số lượng trong tủ"),
        (8, "reminders:manage", "Quản lý lời nhắc uống thuốc"),
        (9, "alerts:manage", "Xem và xử lý cảnh báo"),
        (10, "history:read", "Xem lịch sử hoạt động"),
        (11, "settings:manage", "Thay đổi cài đặt và ngưỡng"),
        (12, "devices:manage", "Quản lý thiết bị ESP32"),
        (13, "device:command", "Gửi lệnh điều khiển ESP32"),
        (14, "users:manage", "Quản lý tài khoản và phân quyền"),
        (15, "audit:read", "Xem nhật ký kiểm toán"),
        (16, "backup:manage", "Sao lưu dữ liệu"),
        (17, "system:read", "Xem trạng thái máy chủ"),
        (18, "profile:manage_own", "Sửa hồ sơ và mật khẩu của chính mình"),
    ]
    op.bulk_insert(permissions, [{"id": i, "code": c, "description": d} for i, c, d in perms])
    scanner = {"catalog:read", "scan:create", "scan:read_own", "profile:manage_own"}
    op.bulk_insert(role_permissions, [{"role_id": 1, "permission_id": i} for i, _, _ in perms]
                   + [{"role_id": 2, "permission_id": i} for i, c, _ in perms if c in scanner])


def downgrade() -> None:
    op.drop_index(op.f('ix_reminder_logs_reminder_id'), table_name='reminder_logs')
    op.drop_table('reminder_logs')
    op.drop_index(op.f('ix_device_command_ack_command_id'), table_name='device_command_ack')
    op.drop_table('device_command_ack')
    op.drop_index('ix_scan_history_user_created', table_name='scan_history')
    op.drop_table('scan_history')
    op.drop_index(op.f('ix_reminders_cabinet_item_id'), table_name='reminders')
    op.drop_table('reminders')
    op.drop_table('ocr_results')
    op.drop_table('ocr_candidates')
    op.drop_index('ix_inventory_logs_item_created', table_name='medicine_inventory_logs')
    op.drop_index('ix_inventory_logs_created', table_name='medicine_inventory_logs')
    op.drop_table('medicine_inventory_logs')
    op.drop_index('ix_device_telemetry_device_time', table_name='device_telemetry')
    op.drop_table('device_telemetry')
    op.drop_index('ix_device_commands_device_status', table_name='device_commands')
    op.drop_index('ix_device_commands_created', table_name='device_commands')
    op.drop_table('device_commands')
    op.drop_index('ix_user_sessions_user', table_name='user_sessions')
    op.drop_table('user_sessions')
    op.drop_index(op.f('ix_password_resets_user_id'), table_name='password_resets')
    op.drop_table('password_resets')
    op.drop_index('ix_ocr_jobs_user_created', table_name='ocr_jobs')
    op.drop_index('ix_ocr_jobs_status', table_name='ocr_jobs')
    op.drop_table('ocr_jobs')
    op.drop_index('ix_medicine_catalog_regs_prefix', table_name='medicine_catalog_regs', postgresql_ops={'reg_norm': 'text_pattern_ops'})
    op.drop_index('ix_medicine_catalog_regs_medicine', table_name='medicine_catalog_regs')
    op.drop_table('medicine_catalog_regs')
    op.drop_index('uq_devices_primary', table_name='devices', postgresql_where='is_primary')
    op.drop_table('devices')
    op.drop_index(op.f('ix_cabinet_medicines_expiry_date'), table_name='cabinet_medicines')
    op.drop_index(op.f('ix_cabinet_medicines_catalog_id'), table_name='cabinet_medicines')
    op.drop_table('cabinet_medicines')
    op.drop_index('ix_audit_logs_user', table_name='audit_logs')
    op.drop_index('ix_audit_logs_created', table_name='audit_logs')
    op.drop_index('ix_audit_logs_action', table_name='audit_logs')
    op.drop_table('audit_logs')
    op.drop_index('uq_users_email_lower', table_name='users')
    op.drop_table('users')
    op.drop_table('role_permissions')
    op.drop_index('ix_medicine_catalog_trgm_name', table_name='medicine_catalog', postgresql_using='gin', postgresql_ops={'trgm_name': 'gin_trgm_ops'})
    op.drop_index('ix_medicine_catalog_trgm_ingredient', table_name='medicine_catalog', postgresql_using='gin', postgresql_ops={'trgm_ingredient': 'gin_trgm_ops'})
    op.drop_index('ix_medicine_catalog_search', table_name='medicine_catalog', postgresql_using='gin')
    op.drop_index('ix_medicine_catalog_name_norm', table_name='medicine_catalog')
    op.drop_index('ix_medicine_catalog_name_core', table_name='medicine_catalog')
    op.drop_table('medicine_catalog')
    op.drop_table('settings')
    op.drop_table('roles')
    op.drop_table('permissions')
    op.drop_index('ix_history_group', table_name='history_events')
    op.drop_index('ix_history_created', table_name='history_events')
    op.drop_table('history_events')
    op.drop_table('catalog_imports')
    op.drop_index('ix_alerts_status_key', table_name='alerts')
    op.drop_index('ix_alerts_created', table_name='alerts')
    op.drop_table('alerts')
