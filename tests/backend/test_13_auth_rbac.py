"""Xác thực JWT, phiên/refresh token, khóa tài khoản, phân quyền ADMIN/SCANNER và tách kênh.

Bao gồm các kiểm thử "vượt quyền bằng HTTP thủ công" theo yêu cầu: Scanner (hoặc Admin đăng nhập
trên mobile) không thể gọi chức năng quản trị dù tự soạn request.
"""
from __future__ import annotations

import time

import jwt
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import func, select

from app.models import AuditLog, User, UserSession

from .conftest import ADMIN_EMAIL, ADMIN_PASSWORD, AUGMENTIN_625, AUGMENTIN_625_OLD, SCANNER_EMAIL, SCANNER_PASSWORD, make_user


def bearer(tokens: dict) -> dict:
    return {"Authorization": f"Bearer {tokens['access_token']}"}


# --------------------------------------------------------------------------- #
# Đăng ký / đăng nhập
# --------------------------------------------------------------------------- #
def test_register_creates_scanner_and_validates_input(public_client):
    ok = public_client.post("/api/v1/auth/register", json={"full_name": "Lan", "email": "Lan@Example.com", "password": "MatKhau123"})
    assert ok.status_code == 201
    body = ok.json()
    assert body["user"]["role"] == "SCANNER" and body["user"]["email"] == "lan@example.com"
    assert body["token_type"] == "bearer" and body["expires_in"] == 15 * 60 and len(body["refresh_token"]) > 40
    dup = public_client.post("/api/v1/auth/register", json={"full_name": "Lan", "email": "lan@example.com", "password": "MatKhau123"})
    assert dup.status_code == 409
    weak = public_client.post("/api/v1/auth/register", json={"full_name": "A", "email": "a@example.com", "password": "12345678"})
    assert weak.status_code == 422 and "chữ và số" in weak.json()["detail"]
    short = public_client.post("/api/v1/auth/register", json={"full_name": "A", "email": "a@example.com", "password": "ab1"})
    assert short.status_code == 422 and "8 ký tự" in short.json()["detail"]
    bad_email = public_client.post("/api/v1/auth/register", json={"full_name": "A", "email": "khong-phai-email", "password": "MatKhau123"})
    assert bad_email.status_code == 422


def test_registration_can_be_disabled(public_client, ctx):
    ctx.settings.allow_registration = False
    r = public_client.post("/api/v1/auth/register", json={"full_name": "X", "email": "x@example.com", "password": "MatKhau123"})
    assert r.status_code == 403
    assert public_client.get("/api/v1/app/config").json()["registration_enabled"] is False


def test_passwords_are_hashed_with_argon2(ctx, scanner):
    with ctx.db.session() as s:
        user = s.scalar(select(User).where(User.email == SCANNER_EMAIL))
        assert user.password_hash.startswith("$argon2id$") and SCANNER_PASSWORD not in user.password_hash


def test_login_errors_do_not_reveal_which_part_is_wrong(public_client, scanner):
    wrong_pw = public_client.post("/api/v1/auth/login", json={"email": SCANNER_EMAIL, "password": "SaiMatKhau1"})
    no_user = public_client.post("/api/v1/auth/login", json={"email": "khongco@example.com", "password": "SaiMatKhau1"})
    assert wrong_pw.status_code == no_user.status_code == 401
    assert wrong_pw.json()["detail"] == no_user.json()["detail"] == "Email hoặc mật khẩu không đúng."


def test_account_locks_after_repeated_failures(public_client, ctx, scanner):
    for _ in range(ctx.settings.max_login_failures):
        assert public_client.post("/api/v1/auth/login", json={"email": SCANNER_EMAIL, "password": "SaiMatKhau1"}).status_code == 401
    locked = public_client.post("/api/v1/auth/login", json={"email": SCANNER_EMAIL, "password": SCANNER_PASSWORD})
    assert locked.status_code == 423 and "tạm khóa" in locked.json()["detail"]
    with ctx.db.session() as s:
        failures = s.scalar(select(func.count()).select_from(AuditLog).where(AuditLog.action == "auth.login", AuditLog.success.is_(False)))
        assert failures == ctx.settings.max_login_failures + 1


def test_login_rate_limit_per_ip(public_client, ctx):
    ctx.limiter.rules["login_ip"] = (3, 60)
    codes = [public_client.post("/api/v1/auth/login", json={"email": f"u{i}@example.com", "password": "x"}).status_code for i in range(4)]
    assert codes == [401, 401, 401, 429]


# --------------------------------------------------------------------------- #
# Phiên / refresh token
# --------------------------------------------------------------------------- #
def test_refresh_rotates_and_reuse_revokes_everything(public_client, scanner):
    headers, tokens = scanner
    first = public_client.post("/api/v1/auth/refresh", json={"refresh_token": tokens["refresh_token"]})
    assert first.status_code == 200
    new = first.json()
    assert new["refresh_token"] != tokens["refresh_token"]
    assert public_client.get("/api/v1/me", headers=bearer(new)).status_code == 200
    # Dùng lại refresh token cũ (đã xoay vòng) → coi như bị lộ: thu hồi mọi phiên.
    reuse = public_client.post("/api/v1/auth/refresh", json={"refresh_token": tokens["refresh_token"]})
    assert reuse.status_code == 401
    assert public_client.get("/api/v1/me", headers=bearer(new)).status_code == 401
    assert public_client.post("/api/v1/auth/refresh", json={"refresh_token": new["refresh_token"]}).status_code == 401


def test_logout_revokes_session(public_client, scanner):
    headers, tokens = scanner
    assert public_client.post("/api/v1/auth/logout", json={"refresh_token": tokens["refresh_token"]}).json() == {"ok": True}
    assert public_client.get("/api/v1/me", headers=headers).status_code == 401
    assert public_client.post("/api/v1/auth/refresh", json={"refresh_token": tokens["refresh_token"]}).status_code == 401


def test_tampered_or_expired_tokens_are_rejected(public_client, ctx, scanner):
    headers, tokens = scanner
    claims = jwt.decode(tokens["access_token"], options={"verify_signature": False})
    forged = jwt.encode({**claims, "role": "ADMIN"}, "khoa-sai-" + "x" * 30, algorithm="HS256")
    assert public_client.get("/api/v1/me", headers={"Authorization": f"Bearer {forged}"}).status_code == 401
    expired = jwt.encode({**claims, "exp": int(time.time()) - 60}, ctx.auth.secret, algorithm="HS256")
    r = public_client.get("/api/v1/me", headers={"Authorization": f"Bearer {expired}"})
    assert r.status_code == 401 and "hết hạn" in r.json()["detail"]
    no_alg = jwt.encode(claims, None, algorithm="none") if hasattr(jwt, "encode") else None
    assert public_client.get("/api/v1/me", headers={"Authorization": f"Bearer {no_alg}"}).status_code == 401


def test_change_password_keeps_current_session_and_revokes_others(public_client, scanner):
    headers, tokens = scanner
    other = public_client.post("/api/v1/auth/login", json={"email": SCANNER_EMAIL, "password": SCANNER_PASSWORD}).json()
    assert public_client.post("/api/v1/me/password", headers=headers, json={"current_password": "Sai12345a", "new_password": "MoiMoi2026"}).status_code == 400
    assert public_client.post("/api/v1/me/password", headers=headers, json={"current_password": SCANNER_PASSWORD, "new_password": "MoiMoi2026"}).status_code == 200
    assert public_client.get("/api/v1/me", headers=headers).status_code == 200
    assert public_client.get("/api/v1/me", headers=bearer(other)).status_code == 401
    assert public_client.post("/api/v1/auth/login", json={"email": SCANNER_EMAIL, "password": "MoiMoi2026"}).status_code == 200


def test_password_reset_by_email_code(public_client, mailer, scanner):
    accepted = public_client.post("/api/v1/auth/password/forgot", json={"email": SCANNER_EMAIL})
    unknown = public_client.post("/api/v1/auth/password/forgot", json={"email": "khongco@example.com"})
    assert accepted.status_code == unknown.status_code == 202 and accepted.json() == unknown.json()  # không lộ email có tồn tại
    assert len(mailer.sent) == 1 and mailer.sent[0][0] == SCANNER_EMAIL
    code = mailer.sent[0][1]
    assert len(code) == 6 and code.isdigit()
    wrong = public_client.post("/api/v1/auth/password/reset", json={"email": SCANNER_EMAIL, "code": "000000" if code != "000000" else "111111", "new_password": "DatLai2026"})
    assert wrong.status_code == 400
    ok = public_client.post("/api/v1/auth/password/reset", json={"email": SCANNER_EMAIL, "code": code, "new_password": "DatLai2026"})
    assert ok.status_code == 200
    assert public_client.post("/api/v1/auth/password/reset", json={"email": SCANNER_EMAIL, "code": code, "new_password": "Khac2026ab"}).status_code == 400
    assert public_client.post("/api/v1/auth/login", json={"email": SCANNER_EMAIL, "password": "DatLai2026"}).status_code == 200


def test_reset_code_locks_after_five_wrong_attempts(public_client, mailer, scanner):
    public_client.post("/api/v1/auth/password/forgot", json={"email": SCANNER_EMAIL})
    code = mailer.sent[-1][1]
    wrong = "123456" if code != "123456" else "654321"
    for _ in range(5):
        public_client.post("/api/v1/auth/password/reset", json={"email": SCANNER_EMAIL, "code": wrong, "new_password": "DatLai2026"})
    assert public_client.post("/api/v1/auth/password/reset", json={"email": SCANNER_EMAIL, "code": code, "new_password": "DatLai2026"}).status_code == 400


def test_password_reset_unavailable_without_smtp(public_client, ctx, scanner):
    ctx.auth.mailer = None
    r = public_client.post("/api/v1/auth/password/forgot", json={"email": SCANNER_EMAIL})
    assert r.status_code == 503
    assert public_client.get("/api/v1/app/config").json()["password_reset_enabled"] is False


# --------------------------------------------------------------------------- #
# Tách kênh và phân quyền
# --------------------------------------------------------------------------- #
def test_scanner_cannot_log_in_to_admin_channel(anon_admin_client, scanner):
    r = anon_admin_client.post("/api/auth/login", json={"email": SCANNER_EMAIL, "password": SCANNER_PASSWORD})
    assert r.status_code == 403 and "quyền quản trị" in r.json()["detail"]


def test_scanner_token_is_useless_on_admin_channel(anon_admin_client, scanner):
    headers, _ = scanner
    for method, path in (("GET", "/api/settings"), ("GET", "/api/cabinet/medicines"), ("POST", "/api/cabinet/medicines"),
                         ("GET", "/api/admin/users"), ("POST", "/api/backup"), ("GET", "/api/devices")):
        r = anon_admin_client.request(method, path, headers=headers, json={"name": "Hack", "quantity": 1})
        assert r.status_code == 401, (method, path, r.status_code)


def test_admin_token_is_useless_on_public_channel(client, public_client):
    admin_headers = {"Authorization": client.headers["Authorization"]}
    assert public_client.get("/api/v1/me", headers=admin_headers).status_code == 401


def test_admin_logged_in_on_mobile_only_gets_scanner_permissions(public_client, admin_user, client, ctx):
    mobile = public_client.post("/api/v1/auth/login", json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD}).json()
    me = public_client.get("/api/v1/me", headers=bearer(mobile)).json()["user"]
    # Ngay trong phản hồi đăng nhập/làm mới, mobile cũng chỉ thấy vai trò + quyền SCANNER.
    scanner_perms = {"catalog:read", "scan:create", "scan:read_own", "profile:manage_own", "cabinet:read", "cabinet:update_expiry"}
    assert mobile["user"]["role"] == "SCANNER" and set(mobile["user"]["permissions"]) == scanner_perms
    refreshed = public_client.post("/api/v1/auth/refresh", json={"refresh_token": mobile["refresh_token"]}).json()
    assert refreshed["user"]["role"] == "SCANNER" and set(refreshed["user"]["permissions"]) == scanner_perms
    mobile = refreshed
    assert me["role"] == "SCANNER" and me["account_role"] == "ADMIN"
    assert set(me["permissions"]) == scanner_perms and "cabinet:write" not in me["permissions"]
    # Token mobile của chính tài khoản Admin vẫn không mở được cổng Admin.
    assert client.get("/api/settings", headers=bearer(mobile)).status_code == 401
    with ctx.db.session() as s:
        assert s.scalar(select(UserSession.audience).where(UserSession.refresh_hash.isnot(None)).order_by(UserSession.created_at.desc()).limit(1)) in ("scanner", "admin")


def test_scanner_cannot_modify_cabinet_through_any_public_route(public_client, scanner, client):
    headers, _ = scanner
    attempts = [
        ("POST", "/api/v1/cabinet/medicines"), ("POST", "/api/cabinet/medicines"), ("PATCH", "/api/v1/cabinet/medicines/1"),
        ("DELETE", "/api/v1/cabinet/medicines/1"), ("POST", "/api/v1/catalog"), ("PATCH", f"/api/v1/catalog/{AUGMENTIN_625}"),
        ("DELETE", f"/api/v1/catalog/{AUGMENTIN_625}"), ("POST", "/api/v1/admin/users"), ("PATCH", "/api/v1/me/role"),
        ("POST", "/api/v1/settings"), ("PATCH", "/api/v1/settings"),
    ]
    for method, path in attempts:
        r = public_client.request(method, path, headers=headers, json={"catalog_id": AUGMENTIN_625, "quantity": 99, "role": "ADMIN"})
        assert r.status_code in (404, 405), (method, path, r.status_code)
    assert client.get("/api/cabinet/medicines").json()["total"] == 0


def test_scanner_cannot_raise_own_role_via_profile_update(public_client, scanner, ctx):
    headers, _ = scanner
    r = public_client.patch("/api/v1/me", headers=headers, json={"full_name": "Tên mới", "role": "ADMIN", "preferences": {"theme": "dark", "role": "ADMIN"}})
    assert r.status_code == 200
    user = r.json()["user"]
    assert user["full_name"] == "Tên mới" and user["account_role"] == "SCANNER" and "role" not in user["preferences"]


def test_catalog_is_read_only_for_scanner(public_client, scanner):
    headers, _ = scanner
    found = public_client.get("/api/v1/catalog/search", params={"q": "augmentin 625"}, headers=headers).json()
    # Hai bản ghi cùng tên "Augmentin 625mg tablets" (khác số đăng ký) đứng đầu.
    assert {i["id"] for i in found["items"][:2]} == {AUGMENTIN_625, AUGMENTIN_625_OLD}
    detail = public_client.get(f"/api/v1/catalog/{AUGMENTIN_625}", headers=headers).json()
    assert detail["read_only"] is True and "raw" not in detail and detail["source"].startswith("CSDL Dược")
    assert public_client.get("/api/v1/catalog/search", params={"q": "augmentin"}).status_code == 401  # phải đăng nhập


# --------------------------------------------------------------------------- #
# Quản lý tài khoản (Admin)
# --------------------------------------------------------------------------- #
def test_admin_manages_users_with_audit_and_last_admin_protection(client, ctx, admin_user, public_client):
    created = client.post("/api/admin/users", json={"email": "kho@example.com", "password": "KhoThuoc2026", "full_name": "Kho", "role": "SCANNER"})
    assert created.status_code == 201
    uid = created.json()["user"]["id"]
    listed = client.get("/api/admin/users", params={"q": "kho"}).json()
    assert listed["total"] == 1 and listed["items"][0]["email"] == "kho@example.com"
    login = public_client.post("/api/v1/auth/login", json={"email": "kho@example.com", "password": "KhoThuoc2026"}).json()
    # Vô hiệu hóa → phiên đang mở bị thu hồi ngay.
    assert client.patch(f"/api/admin/users/{uid}", json={"is_active": False}).status_code == 200
    assert public_client.get("/api/v1/me", headers=bearer(login)).status_code == 401
    assert public_client.post("/api/v1/auth/login", json={"email": "kho@example.com", "password": "KhoThuoc2026"}).status_code == 403
    client.patch(f"/api/admin/users/{uid}", json={"is_active": True})
    assert client.post(f"/api/admin/users/{uid}/password", json={"new_password": "MatKhauMoi9"}).status_code == 200
    assert public_client.post("/api/v1/auth/login", json={"email": "kho@example.com", "password": "MatKhauMoi9"}).status_code == 200
    # Không tự hạ quyền / xóa chính mình; luôn còn ít nhất một Admin.
    assert client.patch(f"/api/admin/users/{admin_user}", json={"role": "SCANNER"}).status_code == 400
    assert client.delete(f"/api/admin/users/{admin_user}").status_code == 400
    assert client.delete(f"/api/admin/users/{uid}").json() == {"deleted": True}
    audit = client.get("/api/admin/audit", params={"q": "user."}).json()
    actions = {i["action"] for i in audit["items"]}
    assert {"user.create", "user.update", "user.password_reset", "user.delete"} <= actions
    assert all(i["actor"] == ADMIN_EMAIL for i in audit["items"] if i["action"].startswith("user."))


def test_promoted_user_can_use_admin_channel_after_relogin(client, anon_admin_client, ctx):
    uid = make_user(ctx, "phoquanly@example.com", "PhoQuanLy26")
    assert anon_admin_client.post("/api/auth/login", json={"email": "phoquanly@example.com", "password": "PhoQuanLy26"}).status_code == 403
    client.patch(f"/api/admin/users/{uid}", json={"role": "ADMIN"})
    ok = anon_admin_client.post("/api/auth/login", json={"email": "phoquanly@example.com", "password": "PhoQuanLy26"})
    assert ok.status_code == 200 and ok.json()["user"]["role"] == "ADMIN"


def test_demoted_admin_loses_admin_access_immediately(client, anon_admin_client, ctx):
    uid = make_user(ctx, "admin2@example.com", "QuanTri2027", role="ADMIN")
    second = anon_admin_client.post("/api/auth/login", json={"email": "admin2@example.com", "password": "QuanTri2027"}).json()
    assert anon_admin_client.get("/api/settings", headers=bearer(second)).status_code == 200
    client.patch(f"/api/admin/users/{uid}", json={"role": "SCANNER"})
    assert anon_admin_client.get("/api/settings", headers=bearer(second)).status_code == 401


@pytest.mark.parametrize("path", ["/api/admin/users", "/api/admin/audit", "/api/admin/system", "/api/admin/scans"])
def test_admin_only_endpoints_reject_anonymous(anon_admin_client, path):
    assert anon_admin_client.get(path).status_code == 401
