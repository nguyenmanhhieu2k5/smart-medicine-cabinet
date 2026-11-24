"""Tài khoản tự đăng ký (SCANNER): xem thuốc trong tủ + SỬA NGÀY HẾT HẠN — không thêm/xóa/sửa thông tin khác.

Tài khoản và phiên lưu trên PostgreSQL của Mini PC; kênh quản trị (ứng dụng Windows) vẫn chỉ nhận ADMIN.
"""
from __future__ import annotations

from sqlalchemy import select

from app.models import AuditLog, User

from .conftest import ADMIN_EMAIL, ADMIN_PASSWORD, AUGMENTIN_625, SCANNER_EMAIL, SCANNER_PASSWORD, make_user


def add_item(client, **extra) -> dict:
    r = client.post("/api/cabinet/medicines", json={"catalog_id": AUGMENTIN_625, "quantity": 14, "unit": "viên", "expiry_date": "2027-06-15", **extra})
    assert r.status_code in (200, 201), r.text
    return r.json()


def test_registration_creates_scanner_stored_on_server(public_client, scanner, ctx):
    _, tokens = scanner
    assert tokens["user"]["role"] == "SCANNER"
    perms = set(tokens["user"]["permissions"])
    assert {"scan:create", "scan:read_own", "cabinet:read", "cabinet:update_expiry"} <= perms
    assert "cabinet:write" not in perms and "users:manage" not in perms
    with ctx.db.session() as s:
        user = s.scalars(select(User).where(User.email == SCANNER_EMAIL)).one()
        assert user.role_code == "SCANNER" and user.password_hash and SCANNER_PASSWORD not in user.password_hash


def test_registered_account_cannot_use_admin_channel(anon_admin_client, scanner):
    r = anon_admin_client.post("/api/auth/login", json={"email": SCANNER_EMAIL, "password": SCANNER_PASSWORD})
    assert r.status_code in (401, 403)


def test_scanner_lists_cabinet_and_updates_only_expiry(public_client, scanner, client, ctx):
    headers, _ = scanner
    item = add_item(client)
    listed = public_client.get("/api/v1/cabinet/medicines", headers=headers).json()
    assert listed["total"] == 1 and listed["items"][0]["id"] == item["id"] and listed["items"][0]["expiry_date"] == "2027-06-15"
    assert "note" not in listed["items"][0] and "location" not in listed["items"][0]  # chỉ trường cần cho việc xem/sửa hạn dùng

    r = public_client.patch(f"/api/v1/cabinet/medicines/{item['id']}/expiry", headers=headers, json={"expiry_date": "2028-01-31"})
    assert r.status_code == 200, r.text
    assert r.json()["expiry_date"] == "2028-01-31" and r.json()["expiry_source"] == "manual"
    admin_view = client.get(f"/api/cabinet/medicines/{item['id']}").json()
    assert admin_view["expiry_date"] == "2028-01-31" and admin_view["quantity"] == 14 and admin_view["name"] == item["name"]
    with ctx.db.session() as s:
        log = s.scalars(select(AuditLog).where(AuditLog.action == "cabinet.expiry_update")).one()
        assert log.actor == SCANNER_EMAIL and log.channel == "public" and log.detail == {"from": "2027-06-15", "to": "2028-01-31"}
    events = client.get("/api/history", params={"group": "cabinet"}).json()["items"]
    assert any("31/01/2028" in (e.get("description") or "") and SCANNER_EMAIL in (e.get("description") or "") for e in events)


def test_scanner_cannot_change_anything_else(public_client, scanner, client):
    headers, _ = scanner
    item = add_item(client)
    for body in ({"expiry_date": "2028-01-31", "quantity": 999}, {"expiry_date": "2028-01-31", "name": "Đổi tên"}, {"quantity": 1}):
        assert public_client.patch(f"/api/v1/cabinet/medicines/{item['id']}/expiry", headers=headers, json=body).status_code == 422
    for method, path in (("POST", "/api/v1/cabinet/medicines"), ("PATCH", f"/api/v1/cabinet/medicines/{item['id']}"),
                         ("DELETE", f"/api/v1/cabinet/medicines/{item['id']}"), ("POST", f"/api/v1/cabinet/medicines/{item['id']}/adjust")):
        assert public_client.request(method, path, headers=headers, json={"quantity": 999}).status_code in (404, 405), (method, path)
    after = client.get(f"/api/cabinet/medicines/{item['id']}").json()
    assert after["quantity"] == 14 and after["expiry_date"] == "2027-06-15" and client.get("/api/cabinet/medicines").json()["total"] == 1


def test_expiry_validation_clear_and_alerts(public_client, scanner, client):
    headers, _ = scanner
    item = add_item(client)
    url = f"/api/v1/cabinet/medicines/{item['id']}/expiry"
    assert public_client.patch(url, headers=headers, json={"expiry_date": "1990-01-01"}).status_code == 400
    assert public_client.patch(url, headers=headers, json={"expiry_date": "khong-phai-ngay"}).status_code == 422
    assert public_client.patch("/api/v1/cabinet/medicines/999999/expiry", headers=headers, json={"expiry_date": "2028-01-01"}).status_code == 404
    cleared = public_client.patch(url, headers=headers, json={"expiry_date": None}).json()
    assert cleared["expiry_date"] is None and cleared["expiry_status"] == "unknown"
    expired = public_client.patch(url, headers=headers, json={"expiry_date": "2026-01-01"}).json()  # đồng hồ kiểm thử: 10/11/2026
    assert expired["expiry_status"] == "expired"
    alerts = client.get("/api/alerts").json()["items"]
    assert any(a["type"] == "expired" for a in alerts)  # cảnh báo hết hạn tính lại ngay


def test_requires_login_and_scanner_permission(public_client, ctx):
    assert public_client.get("/api/v1/cabinet/medicines").status_code == 401
    assert public_client.patch("/api/v1/cabinet/medicines/1/expiry", json={"expiry_date": "2028-01-01"}).status_code == 401
    # Admin đăng nhập trên điện thoại cũng chỉ có quyền SCANNER (xem + sửa hạn dùng), không hơn.
    make_user(ctx, ADMIN_EMAIL, ADMIN_PASSWORD, "ADMIN", "Quản trị viên")
    tokens = public_client.post("/api/v1/auth/login", json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD}).json()
    assert "cabinet:write" not in tokens["user"]["permissions"] and "cabinet:update_expiry" in tokens["user"]["permissions"]
