"""Cài đặt, hồ sơ quản trị, sao lưu/khôi phục PostgreSQL và các lớp bảo vệ của cổng Admin."""
from __future__ import annotations

from sqlalchemy import func, select, text

from app.core.config import Settings, load_env_file, load_settings, loopback_host
from app.database.migrate import head_revision
from app.models import AuditLog, CabinetItem
from app.services import backup

from .conftest import ADMIN_EMAIL, AUGMENTIN_625, png_bytes


def test_settings_defaults_and_partial_update(client):
    body = client.get("/api/settings").json()
    settings = body["settings"]
    assert settings["expiry_warning_days"] == 30 and settings["theme"] == "light" and settings["language"] == "vi"
    assert settings["ocr_engine"] == "onnxruntime"
    assert not any(k.startswith("esp32_") for k in settings)  # kết nối thiết bị nay quản lý ở bảng devices
    assert body["paths"]["database"].startswith("postgresql+psycopg://")  # không có mật khẩu CSDL (đã che bằng ***)
    assert {p["value"] for p in body["options"]["ocr_profiles"]} == {"v6_small", "v6_tiny", "v6_medium", "v5_latin"}
    updated = client.patch("/api/settings", json={"theme": "dark", "tts_rate": 1.25}).json()["settings"]
    assert updated["theme"] == "dark" and updated["tts_rate"] == 1.25
    assert client.get("/api/settings").json()["settings"]["expiry_warning_days"] == 30  # khóa khác giữ nguyên
    assert client.patch("/api/settings", json={"expiry_warning_days": 0}).status_code == 400
    assert client.patch("/api/settings", json={"theme": "pink"}).status_code == 422
    assert client.patch("/api/settings", json={"temp_min": 31, "temp_max": 30}).status_code == 400


def test_settings_changes_are_audited(client, ctx):
    client.patch("/api/settings", json={"expiry_warning_days": 45})
    with ctx.db.session() as s:
        row = s.scalar(select(AuditLog).where(AuditLog.action == "settings.update"))
        assert row.actor == ADMIN_EMAIL and row.detail == {"keys": ["expiry_warning_days"]}


def test_profile_is_the_signed_in_admin_account(client):
    profile = client.get("/api/profile").json()
    assert profile["email"] == ADMIN_EMAIL and profile["name"] == "Quản trị viên"
    assert profile["auth"]["provider"] == "server" and profile["auth"]["signed_in"] is True
    saved = client.patch("/api/profile", json={"name": "  Hiếu ", "phone": "0987654321"}).json()
    assert saved["name"] == "Hiếu" and saved["phone"] == "0987654321"
    uploaded = client.post("/api/profile/avatar", files={"file": ("me.png", png_bytes(900, 700), "image/png")}).json()
    assert uploaded["has_avatar"] is True
    assert client.get("/api/profile/avatar").headers["content-type"] == "image/jpeg"
    assert client.post("/api/profile/avatar", files={"file": ("x.txt", b"abc", "text/plain")}).status_code == 400
    assert client.delete("/api/profile/avatar").json()["has_avatar"] is False
    assert client.get("/api/profile/avatar").status_code == 404


def test_pg_dump_backup_and_restore_roundtrip(client, ctx):
    """Sao lưu bằng pg_dump, khôi phục bằng pg_restore, dữ liệu trở lại đúng trạng thái."""
    client.post("/api/cabinet/medicines", json={"catalog_id": AUGMENTIN_625, "quantity": 14, "unit": "viên"})
    made = client.post("/api/backup")
    assert made.status_code == 201, made.text
    info = made.json()
    assert info["name"].endswith("-manual.dump") and info["size"] > 10_000
    listed = client.get("/api/backup").json()
    assert [b["name"] for b in listed["items"]] == [info["name"]] and "app.cli backup restore" in listed["restore_hint"]
    download = client.get(f"/api/backup/{info['name']}/download")
    assert download.status_code == 200 and download.content[:5] == b"PGDMP"  # định dạng custom của pg_dump
    path = ctx.settings.backups_dir / info["name"]
    assert backup.verify_backup(path) > 20

    # Thay đổi sau khi sao lưu…
    client.post("/api/cabinet/medicines", json={"name": "Thuốc thêm sau khi sao lưu", "quantity": 1})
    with ctx.db.session() as s:
        assert s.scalar(select(func.count()).select_from(CabinetItem)) == 2
    # …khôi phục (công cụ dòng lệnh làm đúng việc này trên Mini PC).
    ctx.db.dispose()
    backup.restore_backup(ctx.settings.database_url, path)
    with ctx.db.session() as s:
        names = [r.name for r in s.scalars(select(CabinetItem)).all()]
        assert names == ["Augmentin 625mg tablets"]
        assert s.execute(text("SELECT count(*) FROM medicine_catalog")).scalar() == 799
        assert s.execute(text("SELECT version_num FROM alembic_version")).scalar() == head_revision()


def test_backup_rejects_path_tricks_and_corrupt_files(client, ctx, tmp_path):
    assert client.get("/api/backup/..%2Fserver.env/download").status_code in (400, 404)
    assert client.delete("/api/backup/khong-co.dump").status_code == 400
    fake = tmp_path / "smart_medicine-20261110-143200-manual.dump"
    fake.write_bytes(b"not a dump")
    try:
        backup.verify_backup(fake)
        raise AssertionError("phải báo lỗi")
    except backup.BackupError as exc:
        assert "không hợp lệ" in str(exc)


def test_automatic_backups_are_pruned(ctx, tmp_path):
    folder = tmp_path / "b"
    folder.mkdir()
    for i in range(5):
        (folder / f"smart_medicine-2026111{i}-020000-auto.dump").write_bytes(b"x")
    (folder / "smart_medicine-20261101-020000-manual.dump").write_bytes(b"x")
    assert backup.prune(folder, keep_auto=3) == 2
    assert sorted(p.name for p in folder.iterdir())[0] == "smart_medicine-20261101-020000-manual.dump"  # bản thủ công giữ lại
    assert len(list(folder.glob("*-auto.dump"))) == 3


def test_admin_api_requires_admin_login(anon_admin_client):
    assert anon_admin_client.get("/api/settings").status_code == 401
    assert anon_admin_client.get("/api/cabinet/medicines").status_code == 401
    assert anon_admin_client.get("/api/settings", headers={"Authorization": "Bearer abc.def.ghi"}).status_code == 401
    assert anon_admin_client.get("/api/health").status_code == 200  # chỉ health là công khai trên tailnet


def test_admin_channel_rejects_requests_coming_through_cloudflare(client):
    # Cloudflare Tunnel và Tailscale Funnel (đều là kênh công khai) không bao giờ được vào cổng quản trị.
    for header in ("CF-Ray", "CF-Connecting-IP", "CF-Visitor", "Tailscale-Funnel-Request"):
        r = client.get("/api/settings", headers={header: "1"})
        assert r.status_code == 403 and "Tailscale" in r.json()["detail"]


def test_only_local_or_tailnet_host_header_is_accepted(client):
    assert client.get("/api/health", headers={"Host": "evil.example.com"}).status_code == 400
    assert client.get("/api/health", headers={"Host": "127.0.0.1"}).status_code == 200
    assert client.get("/api/health", headers={"Host": "minipc.tail1234.ts.net"}).status_code == 200


def test_security_headers_and_cors_for_desktop(client):
    r = client.get("/api/health")
    assert r.headers["x-content-type-options"] == "nosniff" and r.headers["cache-control"] == "no-store"
    preflight = client.options("/api/settings", headers={"Origin": "http://localhost:5173", "Access-Control-Request-Method": "GET",
                                                         "Access-Control-Request-Headers": "authorization"})
    assert preflight.status_code == 200


def test_health_and_openapi_cover_required_endpoints(client):
    health = client.get("/api/health").json()
    assert health["status"] == "ok" and health["database"] == "ok" and health["version"] == "2.0.0"
    paths = set(client.get("/api/openapi.json").json()["paths"])
    required = {
        "/api/health", "/api/auth/login", "/api/medicines/search", "/api/medicines/{medicine_id}", "/api/ocr",
        "/api/cabinet/medicines", "/api/reminders", "/api/alerts", "/api/history", "/api/device/status", "/api/settings",
        "/api/catalog/import", "/api/admin/users", "/api/devices", "/api/devices/{device_id}/commands", "/api/admin/audit",
        "/api/admin/system", "/api/backup",
    }
    assert required <= paths
    assert not any(p.startswith("/api/v1") for p in paths)  # API công khai không nằm trên cổng Admin


def test_public_channel_has_no_docs_and_no_admin_paths(public_client):
    assert public_client.get("/api/openapi.json").status_code == 404
    assert public_client.get("/api/docs").status_code == 404
    for path in ("/api/settings", "/api/cabinet/medicines", "/api/admin/users", "/api/backup", "/api/auth/login"):
        assert public_client.get(path).status_code == 404


def test_system_status_reports_postgres_and_host(client):
    status = client.get("/api/admin/system").json()
    assert status["database"]["ok"] is True and status["database"]["version"].startswith("17")
    assert status["database"]["catalog_count"] == 799 and status["database"]["schema_revision"] == head_revision()
    assert 0 <= status["host"]["memory_percent"] <= 100 and status["host"]["disk_total"] > 0
    assert set(status["services"]) == {"postgresql", "cloudflared", "tailscale", "server"}


def test_api_hosts_are_always_loopback(monkeypatch, tmp_path):
    """Cả hai cổng chỉ nghe cục bộ, kể cả khi biến môi trường bị đặt nhầm."""
    assert loopback_host("0.0.0.0") == "127.0.0.1"
    assert loopback_host("192.168.1.10") == "127.0.0.1"
    assert loopback_host(None) == "127.0.0.1"
    assert loopback_host("LOCALHOST") == "localhost"
    monkeypatch.setenv("SMC_ENV_FILE", str(tmp_path / "none.env"))
    monkeypatch.setenv("SMC_PUBLIC_HOST", "0.0.0.0")
    monkeypatch.setenv("SMC_ADMIN_HOST", "100.64.1.2")
    s = load_settings()
    assert (s.public_host, s.admin_host) == ("127.0.0.1", "127.0.0.1")
    assert (Settings().public_port, Settings().admin_port) == (8000, 8001)


def test_server_env_file_is_read_without_overriding_environment(monkeypatch, tmp_path):
    env = tmp_path / "server.env"
    env.write_text('# cấu hình\nDATABASE_URL="postgresql+psycopg://smc_app:p%40ss@127.0.0.1:5432/smart_medicine"\nSMC_ALLOW_REGISTRATION=false\n', encoding="utf-8")
    assert load_env_file(env)["SMC_ALLOW_REGISTRATION"] == "false"
    monkeypatch.setenv("SMC_ENV_FILE", str(env))
    monkeypatch.delenv("DATABASE_URL", raising=False)
    s = load_settings()
    assert s.database_url.endswith("/smart_medicine") and s.allow_registration is False
    monkeypatch.setenv("SMC_ALLOW_REGISTRATION", "true")
    assert load_settings().allow_registration is True  # biến môi trường được ưu tiên
