"""Cài đặt, hồ sơ, sao lưu/khôi phục và bảo vệ API cục bộ."""
from __future__ import annotations

import httpx
from fastapi.testclient import TestClient

from app.core.config import Settings
from app.main import create_app
from app.services.auth import SupabaseAuth

from .conftest import AUGMENTIN_625, png_bytes


def test_settings_defaults_and_partial_update(client):
    body = client.get("/api/settings").json()
    settings = body["settings"]
    assert settings["expiry_warning_days"] == 30 and settings["theme"] == "light" and settings["language"] == "vi"
    assert settings["ocr_engine"] == "onnxruntime" and settings["esp32_enabled"] is False
    assert "esp32_token" not in settings and settings["esp32_token_set"] is False  # không trả token ra giao diện
    assert {p["value"] for p in body["options"]["ocr_profiles"]} == {"v6_small", "v6_tiny", "v6_medium", "v5_latin"}
    updated = client.patch("/api/settings", json={"theme": "dark", "tts_rate": 1.25, "esp32_token": "secret"}).json()["settings"]
    assert updated["theme"] == "dark" and updated["tts_rate"] == 1.25 and updated["esp32_token_set"] is True
    assert client.get("/api/settings").json()["settings"]["expiry_warning_days"] == 30  # khóa khác giữ nguyên
    assert client.patch("/api/settings", json={"expiry_warning_days": 0}).status_code == 400
    assert client.patch("/api/settings", json={"theme": "pink"}).status_code == 422


def test_profile_is_local_and_login_is_not_faked(client):
    profile = client.get("/api/profile").json()
    assert profile["name"] == "" and profile["auth"] == {"provider": "local", "configured": False, "signed_in": False, "email": None, "user_id": None}
    saved = client.patch("/api/profile", json={"name": "  Hiếu ", "email": "hieu@example.com"}).json()
    assert saved["name"] == "Hiếu" and saved["email"] == "hieu@example.com"
    assert client.patch("/api/profile", json={"email": "khong-phai-email"}).status_code == 422
    login = client.post("/api/auth/login", json={"email": "a@b.co", "password": "x"})
    assert login.status_code == 503 and "Chưa cấu hình" in login.json()["detail"]
    assert client.get("/api/profile").json()["auth"]["signed_in"] is False

    uploaded = client.post("/api/profile/avatar", files={"file": ("me.png", png_bytes(900, 700), "image/png")}).json()
    assert uploaded["has_avatar"] is True
    assert client.get("/api/profile/avatar").headers["content-type"] == "image/jpeg"
    assert client.post("/api/profile/avatar", files={"file": ("x.txt", b"abc", "text/plain")}).status_code == 400
    assert client.delete("/api/profile/avatar").json()["has_avatar"] is False
    assert client.get("/api/profile/avatar").status_code == 404


def test_supabase_auth_uses_real_endpoint_contract():
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        if request.url.path == "/auth/v1/token":
            import json

            body = json.loads(request.content)
            if body["password"] == "dung":
                return httpx.Response(200, json={"access_token": "jwt", "user": {"id": "u1", "email": body["email"]}})
            return httpx.Response(400, json={"error_description": "Invalid login credentials"})
        return httpx.Response(204)

    auth = SupabaseAuth("https://demo.supabase.co/", "anon-key", transport=httpx.MockTransport(handler))
    assert auth.configured
    try:
        auth.sign_in("a@b.co", "sai")
        raise AssertionError("phải ném lỗi")
    except Exception as exc:
        assert "Invalid login credentials" in str(exc) and auth.status()["signed_in"] is False
    status = auth.sign_in("a@b.co", "dung")
    assert status == {"provider": "supabase", "configured": True, "signed_in": True, "email": "a@b.co", "user_id": "u1"}
    assert seen[-1].headers["apikey"] == "anon-key" and seen[-1].url.params["grant_type"] == "password"
    assert auth.sign_out()["signed_in"] is False
    assert seen[-1].url.path == "/auth/v1/logout" and seen[-1].headers["authorization"] == "Bearer jwt"


def test_backup_and_restore_user_data_only(client):
    catalog_before = client.get("/api/health").json()["catalog_count"]
    item = client.post("/api/cabinet/medicines", json={"catalog_id": AUGMENTIN_625, "quantity": 7, "expiry_date": "2027-01-01"}).json()
    client.post("/api/reminders", json={"cabinet_item_id": item["id"], "times": ["08:00"], "start_date": "2026-11-10"})
    client.patch("/api/settings", json={"expiry_warning_days": 45})

    backup = client.post("/api/backup").json()
    assert backup["name"].endswith(".smcbak") and backup["counts"]["cabinet_items"] == 1 and backup["size"] < 200_000
    assert "catalog_medicines" not in backup["counts"]  # danh mục không nằm trong bản sao lưu
    download = client.get(f"/api/backup/{backup['name']}/download")
    assert download.status_code == 200 and download.content[:15] == b"SQLite format 3"

    client.delete(f"/api/cabinet/medicines/{item['id']}")
    client.post("/api/cabinet/medicines", json={"name": "Thêm sau", "quantity": 1})
    client.patch("/api/settings", json={"expiry_warning_days": 10})

    restored = client.post("/api/backup/restore", json={"name": backup["name"]}).json()
    assert restored["restored"]["cabinet_items"] == 1 and restored["safety_backup"].endswith("truoc-khi-khoi-phuc.smcbak")
    names = [i["name"] for i in client.get("/api/cabinet/medicines").json()["items"]]
    assert names == ["Augmentin 625mg tablets"]
    assert client.get("/api/settings").json()["settings"]["expiry_warning_days"] == 45
    assert len(client.get("/api/reminders").json()["items"]) == 1
    assert client.get("/api/health").json()["catalog_count"] == catalog_before
    assert len(client.get("/api/backup").json()["items"]) == 2

    upload = client.post("/api/backup/restore-upload", files={"file": ("old.smcbak", download.content, "application/octet-stream")})
    assert upload.status_code == 200 and upload.json()["restored"]["cabinet_items"] == 1


def test_restore_rejects_invalid_files_and_path_tricks(client):
    assert client.post("/api/backup/restore", json={"name": "../cabinet.db"}).status_code == 400
    assert client.post("/api/backup/restore", json={"name": "khong-co.smcbak"}).status_code == 400
    bad = client.post("/api/backup/restore-upload", files={"file": ("fake.smcbak", b"not sqlite", "application/octet-stream")})
    assert bad.status_code == 400 and "hợp lệ" in bad.json()["detail"]
    assert client.post("/api/backup/restore-upload", files={"file": ("a.db", b"x", "application/octet-stream")}).status_code == 400
    assert client.get("/api/backup/..%2Fcabinet.db/download").status_code in (400, 404)


def test_api_token_is_required_when_configured(data_dir, fake_engine):
    settings = Settings(data_dir=data_dir, start_background_tasks=False, api_token="bi-mat-123")
    app = create_app(settings, ocr_engine_factory=lambda cfg: fake_engine(cfg))
    with TestClient(app) as client:
        assert client.get("/api/health").status_code == 200  # health công khai để Electron chờ backend
        assert client.get("/api/settings").status_code == 401
        assert client.get("/api/settings", headers={"X-SMC-Token": "sai"}).status_code == 401
        assert client.get("/api/settings", headers={"X-SMC-Token": "bi-mat-123"}).status_code == 200
        assert client.get("/api/profile/avatar", params={"token": "bi-mat-123"}).status_code == 404  # qua được lớp token
        preflight = client.options("/api/settings", headers={"Origin": "http://localhost:5173", "Access-Control-Request-Method": "GET", "Access-Control-Request-Headers": "x-smc-token"})
        assert preflight.status_code == 200


def test_only_local_host_header_is_accepted(client):
    assert client.get("/api/health", headers={"Host": "evil.example.com"}).status_code == 400
    assert client.get("/api/health", headers={"Host": "127.0.0.1"}).status_code == 200


def test_backend_binds_to_loopback_by_default():
    assert Settings().host == "127.0.0.1"


def test_health_and_openapi_cover_required_endpoints(client):
    health = client.get("/api/health").json()
    assert health["status"] == "ok" and health["database"] == "ok" and health["version"]
    paths = set(client.get("/api/openapi.json").json()["paths"])
    required = {
        "/api/health", "/api/medicines/search", "/api/medicines/{medicine_id}", "/api/ocr", "/api/cabinet/medicines",
        "/api/reminders", "/api/alerts", "/api/history", "/api/device/status", "/api/settings", "/api/catalog/import",
    }
    assert required <= paths


def test_api_host_is_always_loopback(monkeypatch):
    """API cục bộ không được mở ra mạng ngoài, kể cả khi SMC_HOST bị đặt nhầm."""
    from app.core.config import load_settings, loopback_host

    assert loopback_host("0.0.0.0") == "127.0.0.1"
    assert loopback_host("192.168.1.10") == "127.0.0.1"
    assert loopback_host("") == "127.0.0.1"
    assert loopback_host(None) == "127.0.0.1"
    assert loopback_host("LOCALHOST") == "localhost"
    assert loopback_host("::1") == "::1"

    monkeypatch.setenv("SMC_HOST", "0.0.0.0")
    assert load_settings().host == "127.0.0.1"
    monkeypatch.delenv("SMC_HOST")
    assert load_settings().host == "127.0.0.1"
