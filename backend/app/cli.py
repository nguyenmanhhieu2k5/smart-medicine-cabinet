"""Công cụ dòng lệnh quản trị máy chủ Mini PC.

    backend\\.venv\\Scripts\\python -m app.cli <lệnh> ...

Lệnh:
  check                         Kiểm tra cấu hình, kết nối PostgreSQL, lược đồ, danh mục
  db upgrade | db current       Chạy migration Alembic / xem phiên bản lược đồ
  create-admin --email E        Tạo tài khoản ADMIN (mật khẩu nhập ẩn, hoặc biến SMC_ADMIN_PASSWORD)
  import-catalog [--file F]     Nhập DAV_unique.xlsx vào PostgreSQL (không trùng khi nhập lại)
  migrate-sqlite --source F     Chuyển dữ liệu SQLite cũ (1.x) sang PostgreSQL (sao lưu file gốc trước)
  backup create|list            Sao lưu PostgreSQL bằng pg_dump / liệt kê
  backup verify F | restore F   Kiểm tra / khôi phục bản sao lưu (tạo bản an toàn trước khi khôi phục)
  device create --name N        Tạo thiết bị ESP32, in token (chỉ hiển thị một lần)
  serve                         Chạy máy chủ (giống python -m app.server)
"""
from __future__ import annotations

import argparse
import getpass
import json
import os
import sys
from pathlib import Path

from app.core.config import load_settings


def _db():
    from app.database.session import Database

    settings = load_settings()
    if not settings.database_url:
        raise SystemExit("Thiếu DATABASE_URL (chạy deploy\\postgres\\setup-postgres.ps1 hoặc đặt biến môi trường).")
    return settings, Database(settings.database_url)


def cmd_check(_: argparse.Namespace) -> int:
    from app.database import migrate
    from app.database.session import redact_url
    from app.services.medicine_matcher.catalog import CatalogRepository

    settings, db = _db()
    print(f"CSDL          : {redact_url(settings.database_url)}")
    print(f"Thư mục dữ liệu: {settings.data_dir}")
    print(f"Public API    : http://{settings.public_host}:{settings.public_port}/api/v1")
    print(f"Admin API     : http://{settings.admin_host}:{settings.admin_port}/api")
    print(f"Tên miền public: {settings.public_base_url or '(chưa cấu hình SMC_PUBLIC_BASE_URL)'}")
    print(f"SMTP          : {'đã cấu hình' if settings.smtp.configured else 'chưa cấu hình (không có đặt lại mật khẩu qua email)'}")
    if not db.check():
        print("PostgreSQL    : KHÔNG KẾT NỐI ĐƯỢC")
        return 1
    info = db.server_info()
    print(f"PostgreSQL    : {info['version']} · CSDL {info['database']} · user {info['user']} · {info['size_bytes'] // 1_000_000} MB")
    current, head = db.schema_revision(), migrate.head_revision()
    print(f"Lược đồ       : {current or 'chưa có'} (mới nhất {head}){'' if current == head else '  → chạy: python -m app.cli db upgrade'}")
    if current == head:
        with db.session() as s:
            print(f"Danh mục      : {CatalogRepository(s).count():,} thuốc".replace(",", "."))
    db.dispose()
    return 0 if current == head else 1


def cmd_db(args: argparse.Namespace) -> int:
    from app.database import migrate

    settings, db = _db()
    if args.action == "upgrade":
        migrate.upgrade(settings.database_url)
        print("Đã cập nhật lược đồ tới", migrate.head_revision())
    else:
        print(db.schema_revision() or "(chưa có lược đồ)")
    db.dispose()
    return 0


def cmd_create_admin(args: argparse.Namespace) -> int:
    from app.auth.service import AuthError, AuthService, audit
    from app.models import ROLE_ADMIN

    settings, db = _db()
    password = os.environ.get("SMC_ADMIN_PASSWORD")
    if not password:
        if not sys.stdin.isatty():
            raise SystemExit("Đặt biến SMC_ADMIN_PASSWORD hoặc chạy trong cửa sổ dòng lệnh để nhập mật khẩu.")
        password = getpass.getpass("Mật khẩu cho tài khoản quản trị: ")
        if password != getpass.getpass("Nhập lại mật khẩu: "):
            raise SystemExit("Hai lần nhập không khớp.")
    auth = AuthService(db, settings)
    try:
        with db.session() as s:
            user = auth.create_user(s, email=args.email, password=password, full_name=args.name or "Quản trị viên", role_code=ROLE_ADMIN)
            audit(s, "user.create", channel="cli", actor="cli", resource_type="user", resource_id=str(user.id),
                  detail={"email": user.email, "role": ROLE_ADMIN})
            print(f"Đã tạo tài khoản ADMIN {user.email} ({user.id})")
    except AuthError as exc:
        raise SystemExit(exc.message) from exc
    finally:
        db.dispose()
    return 0


def cmd_import_catalog(args: argparse.Namespace) -> int:
    from app.services.excel_import.importer import CatalogImporter, CatalogImportError

    settings, db = _db()
    path = Path(args.file) if args.file else settings.find_default_catalog()
    if path is None:
        raise SystemExit("Không tìm thấy DAV_unique.xlsx — chỉ định bằng --file.")

    last = {"stage": ""}

    def progress(p) -> None:  # noqa: ANN001
        if p.stage != last["stage"] or p.rows_read % 10000 < 4000:
            last["stage"] = p.stage
            print(f"  {p.stage:9} {p.rows_read:>6} dòng  {p.message}", flush=True)

    try:
        result = CatalogImporter(db).run(path, force=args.force, progress_cb=progress)
    except CatalogImportError as exc:
        raise SystemExit(str(exc)) from exc
    finally:
        db.dispose()
    print(result.message)
    return 0 if result.status in ("success", "skipped") else 1


def cmd_migrate_sqlite(args: argparse.Namespace) -> int:
    from app.services.sqlite_migration import MigrationError, SqliteMigrator

    settings, db = _db()
    settings.ensure_dirs()
    migrator = SqliteMigrator(db, data_dir=settings.data_dir, images_dir=settings.images_dir, backups_dir=settings.backups_dir,
                              progress=lambda m: print("•", m))
    try:
        report = migrator.run(Path(args.source), dry_run=args.dry_run, allow_other_source=args.allow_other_source)
    except MigrationError as exc:
        raise SystemExit(str(exc)) from exc
    finally:
        db.dispose()
    print(json.dumps(report.to_dict(), ensure_ascii=False, indent=2))
    if args.dry_run:
        print("Chạy thử: chưa ghi gì vào PostgreSQL.")
        return 0
    print("KẾT QUẢ:", "ĐẠT — dữ liệu khớp nguồn" if report.ok else "CÓ KHÁC BIỆT — xem cảnh báo ở trên")
    return 0 if report.ok else 1


def cmd_backup(args: argparse.Namespace) -> int:
    from app.services import backup

    settings, db = _db()
    db.dispose()
    if args.action == "create":
        info = backup.create_backup(settings.database_url, settings.backups_dir, label=args.label, pg_bin=settings.pg_bin_dir,
                                    copy_dir=settings.backup_copy_dir, keep_auto=settings.backup_keep)
        print(json.dumps(info, ensure_ascii=False, indent=2))
    elif args.action == "list":
        for item in backup.list_backups(settings.backups_dir):
            print(f"{item['name']}  {item['size'] / 1_000_000:.1f} MB  {item['created_at']}")
    else:
        if not args.file:
            raise SystemExit("Thiếu tên file .dump")
        path = Path(args.file)
        if not path.is_file():
            path = backup.resolve_backup(settings.backups_dir, args.file)
        entries = backup.verify_backup(path, pg_bin=settings.pg_bin_dir)
        print(f"Bản sao lưu hợp lệ: {path.name} ({entries} mục)")
        if args.action == "restore":
            if not args.yes:
                answer = input("Khôi phục sẽ GHI ĐÈ toàn bộ dữ liệu hiện tại (đã tạo bản an toàn trước). Gõ 'dong y' để tiếp tục: ")
                if answer.strip().lower() not in ("dong y", "đồng ý"):
                    print("Đã hủy.")
                    return 1
            safety = backup.create_backup(settings.database_url, settings.backups_dir, label="truoc-khoi-phuc", pg_bin=settings.pg_bin_dir)
            print("Bản an toàn:", safety["name"])
            backup.restore_backup(settings.database_url, path, pg_bin=settings.pg_bin_dir)
            print("Đã khôi phục từ", path.name)
    return 0


def cmd_device(args: argparse.Namespace) -> int:
    from app.iot.hub import DeviceHub

    settings, db = _db()
    with db.session() as s:
        device, token = DeviceHub(db, settings).create_device(s, name=args.name, created_by=None)
        print(f"Thiết bị: {device.name} ({device.id})")
        print(f"TOKEN (chỉ hiển thị một lần): {token}")
        if settings.public_base_url:
            print("WebSocket:", settings.public_base_url.replace("https://", "wss://") + "/api/v1/device/ws")
    db.dispose()
    return 0


def cmd_serve(_: argparse.Namespace) -> int:
    from app.server import main

    main()
    return 0


def main(argv: list[str] | None = None) -> int:
    for stream in (sys.stdout, sys.stderr):  # cửa sổ lệnh Windows dùng cp1252: in tiếng Việt không lỗi
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):
            pass
    parser = argparse.ArgumentParser(prog="python -m app.cli", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("check").set_defaults(func=cmd_check)
    p = sub.add_parser("db")
    p.add_argument("action", choices=["upgrade", "current"])
    p.set_defaults(func=cmd_db)
    p = sub.add_parser("create-admin")
    p.add_argument("--email", required=True)
    p.add_argument("--name", default="")
    p.set_defaults(func=cmd_create_admin)
    p = sub.add_parser("import-catalog")
    p.add_argument("--file")
    p.add_argument("--force", action="store_true")
    p.set_defaults(func=cmd_import_catalog)
    p = sub.add_parser("migrate-sqlite")
    p.add_argument("--source", required=True, help="Đường dẫn cabinet.db cũ")
    p.add_argument("--dry-run", action="store_true")
    p.add_argument("--allow-other-source", action="store_true", help="Cho phép chuyển thêm một file SQLite khác (không khuyến nghị)")
    p.set_defaults(func=cmd_migrate_sqlite)
    p = sub.add_parser("backup")
    p.add_argument("action", choices=["create", "list", "verify", "restore"])
    p.add_argument("file", nargs="?")
    p.add_argument("--label", default="manual")
    p.add_argument("--yes", action="store_true", help="Không hỏi lại khi khôi phục")
    p.set_defaults(func=cmd_backup)
    p = sub.add_parser("device")
    p.add_argument("action", choices=["create"])
    p.add_argument("--name", required=True)
    p.set_defaults(func=cmd_device)
    sub.add_parser("serve").set_defaults(func=cmd_serve)
    args = parser.parse_args(argv)
    return int(args.func(args) or 0)


if __name__ == "__main__":
    sys.exit(main())
