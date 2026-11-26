"""Trang web quét thuốc (tên miền riêng, ví dụ tuthuoc.id.vn): khách quét thử 5 lần, lần 6 phải đăng nhập;
đăng nhập rồi dùng như ứng dụng điện thoại. Máy chủ phục vụ luôn trang web ở cổng Public (cùng địa chỉ với API)."""
from __future__ import annotations

import time
import uuid

import pytest

from app.main import create_app
from fastapi.testclient import TestClient

from .conftest import AUGMENTIN_625, SCANNER_EMAIL, SCANNER_PASSWORD, png_bytes

WEB = {"X-SMC-Client": "mobile-web"}


def guest_headers(guest_id: str | None = None) -> dict[str, str]:
    return {"X-Guest-Id": guest_id or str(uuid.uuid4())}


def submit(client, headers):
    return client.post("/api/v1/guest/scans", headers=headers, data={"source": "camera"},
                       files={"file": ("hop.png", png_bytes(), "image/png")})


def wait_done(client, job_id: str, headers: dict) -> dict:
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        job = client.get(f"/api/v1/guest/scans/{job_id}", headers=headers).json()
        if job["status"] in ("done", "error", "cancelled"):
            return job
        time.sleep(0.05)
    raise AssertionError("OCR không xong kịp")


# ---- khách quét thử ------------------------------------------------------- #
def test_guest_gets_five_free_scans_then_must_log_in(public_client, ctx):
    config = public_client.get("/api/v1/app/config").json()
    assert config["guest"] == {"enabled": True, "scans": 5}
    me = guest_headers()
    assert public_client.get("/api/v1/guest/status", headers=me).json() == {"enabled": True, "limit": 5, "used": 0, "remaining": 5}

    for n in range(1, 6):
        r = submit(public_client, me)
        assert r.status_code == 202, r.text
        assert r.json()["guest"]["remaining"] == 5 - n
        done = wait_done(public_client, r.json()["id"], me)
        assert done["status"] == "done" and done["history_id"] is None  # khách không có lịch sử quét
        assert done["result"]["match"]["candidates"][0]["medicine"]["id"] == AUGMENTIN_625

    sixth = submit(public_client, me)
    assert sixth.status_code == 401
    assert sixth.json()["code"] == "guest_limit" and "đăng nhập" in sixth.json()["detail"]
    assert sixth.json()["guest"]["remaining"] == 0
    # Một trình duyệt khách khác vẫn có 5 lượt của riêng nó.
    assert submit(public_client, guest_headers()).status_code == 202


def test_logged_in_web_user_scans_without_guest_limit(public_client, scanner):
    headers, _ = scanner
    for _ in range(7):  # vượt 5 lượt của khách
        r = public_client.post("/api/v1/scans", headers=headers, data={"source": "camera"},
                               files={"file": ("hop.png", png_bytes(), "image/png")})
        assert r.status_code == 202, r.text
        deadline = time.monotonic() + 10
        while public_client.get(f"/api/v1/scans/{r.json()['id']}", headers=headers).json()["status"] not in ("done", "error"):
            assert time.monotonic() < deadline
            time.sleep(0.05)
    assert public_client.get("/api/v1/history", headers=headers).json()["items"]  # có lịch sử như ứng dụng điện thoại


def test_guest_only_sees_own_scans(public_client, scanner, ctx):
    mine, other = guest_headers(), guest_headers()
    job_id = submit(public_client, mine).json()["id"]
    wait_done(public_client, job_id, mine)
    assert public_client.get(f"/api/v1/guest/scans/{job_id}/thumbnail", headers=mine).status_code == 200
    for method, path in (("GET", f"/api/v1/guest/scans/{job_id}"), ("GET", f"/api/v1/guest/scans/{job_id}/thumbnail"),
                         ("DELETE", f"/api/v1/guest/scans/{job_id}"), ("POST", f"/api/v1/guest/ai/scans/{job_id}")):
        assert public_client.request(method, path, headers=other).status_code == 404, path
    # Tài khoản đã đăng nhập cũng không xem được lượt quét của khách (và ngược lại).
    user_headers, _ = scanner
    assert public_client.get(f"/api/v1/scans/{job_id}", headers=user_headers).status_code == 404
    r = public_client.post("/api/v1/scans", headers=user_headers, data={"source": "camera"}, files={"file": ("a.png", png_bytes(), "image/png")})
    assert public_client.get(f"/api/v1/guest/scans/{r.json()['id']}", headers=mine).status_code == 404


def test_guest_header_required_and_bad_image_does_not_cost_a_scan(public_client):
    assert public_client.get("/api/v1/guest/status").status_code == 400
    assert public_client.get("/api/v1/guest/status", headers={"X-Guest-Id": "khong-phai-uuid"}).status_code == 400
    me = guest_headers()
    bad = public_client.post("/api/v1/guest/scans", headers=me, data={"source": "upload"}, files={"file": ("x.png", b"khong phai anh", "image/png")})
    assert bad.status_code == 400
    assert public_client.get("/api/v1/guest/status", headers=me).json()["remaining"] == 5


def test_guest_code_scans_count_once_per_code(public_client):
    me = guest_headers()
    first = public_client.post("/api/v1/guest/barcodes/lookup", headers=me, json={"code": "8935206010121"})
    assert first.status_code == 200 and first.json()["guest"]["remaining"] == 4
    again = public_client.post("/api/v1/guest/barcodes/lookup", headers=me, json={"code": "8935206010121"})
    assert again.json()["guest"]["remaining"] == 4  # camera thấy lại cùng mã: không tính thêm
    # "Tìm trên mạng" cho mã vừa quét: không tính thêm lượt (máy kiểm thử không có khóa tra cứu → báo chưa cấu hình).
    web = public_client.post("/api/v1/guest/ai/lookup", headers=me, json={"kind": "barcode", "code": "8935206010121"})
    assert web.status_code == 200
    assert public_client.get("/api/v1/guest/status", headers=me).json()["remaining"] == 4
    # Mã chưa từng quét: tính một lượt.
    public_client.post("/api/v1/guest/ai/lookup", headers=me, json={"kind": "qr", "code": "SDK VN-20169-16"})
    assert public_client.get("/api/v1/guest/status", headers=me).json()["remaining"] == 3


def test_guest_can_open_medicine_details_from_results(public_client):
    detail = public_client.get(f"/api/v1/guest/catalog/{AUGMENTIN_625}", headers=guest_headers())
    assert detail.status_code == 200 and detail.json()["read_only"] is True
    assert public_client.get(f"/api/v1/catalog/{AUGMENTIN_625}").status_code == 401  # đường thường vẫn cần đăng nhập


def test_guest_scans_capped_per_ip_per_day(public_client, ctx):
    ctx.limiter.rules["guest_scan_ip"] = (3, 86400)
    for _ in range(3):
        assert submit(public_client, guest_headers()).status_code == 202
    capped = submit(public_client, guest_headers())  # trình duyệt "mới" (xóa dữ liệu) từ cùng mạng
    assert capped.status_code == 429 and "đăng nhập" in capped.json()["detail"]


def test_guest_mode_can_be_turned_off(public_client, ctx):
    ctx.settings.guest_scans = 0
    assert public_client.get("/api/v1/app/config").json()["guest"]["enabled"] is False
    assert submit(public_client, guest_headers()).status_code == 404


# ---- phiên đăng nhập của trang web: cookie HttpOnly ---------------------------------- #
def test_web_login_keeps_refresh_token_in_httponly_cookie(public_client):
    r = public_client.post("/api/v1/auth/register", headers=WEB,
                           json={"full_name": "Khách web", "email": "web@example.com", "password": SCANNER_PASSWORD})
    assert r.status_code == 201, r.text
    assert r.json()["refresh_token"] is None and r.json()["access_token"]  # JavaScript không cầm refresh token
    cookies = r.headers.get_list("set-cookie")
    session = next(c for c in cookies if c.startswith("smc_refresh="))
    assert "HttpOnly" in session and "Path=/api/v1/auth" in session and "SameSite=strict" in session.replace("Strict", "strict")
    assert any(c.startswith("smc_web=1") and "HttpOnly" not in c for c in cookies)

    # Tải lại trang: làm mới chỉ bằng cookie (thân yêu cầu rỗng) → phiên mới, cookie xoay vòng.
    refreshed = public_client.post("/api/v1/auth/refresh", headers=WEB, json={})
    assert refreshed.status_code == 200 and refreshed.json()["refresh_token"] is None
    me = public_client.get("/api/v1/me", headers={"Authorization": f"Bearer {refreshed.json()['access_token']}"})
    assert me.json()["user"]["email"] == "web@example.com"

    out = public_client.post("/api/v1/auth/logout", headers=WEB, json={})
    assert out.status_code == 200
    assert any(c.startswith("smc_refresh=") and ("Max-Age=0" in c or "expires=" in c.lower()) for c in out.headers.get_list("set-cookie"))
    assert public_client.post("/api/v1/auth/refresh", headers=WEB, json={}).status_code == 401


def test_phone_app_session_unchanged(public_client):
    r = public_client.post("/api/v1/auth/register", headers={"X-SMC-Client": "mobile-android"},
                           json={"full_name": "Điện thoại", "email": SCANNER_EMAIL, "password": SCANNER_PASSWORD})
    tokens = r.json()
    assert tokens["refresh_token"] and not any(c.startswith("smc_refresh=") for c in r.headers.get_list("set-cookie"))
    public_client.cookies.clear()
    again = public_client.post("/api/v1/auth/refresh", json={"refresh_token": tokens["refresh_token"]})
    assert again.status_code == 200 and again.json()["refresh_token"]
    assert public_client.post("/api/v1/auth/refresh", json={}).status_code == 401  # ứng dụng không dùng cookie


# ---- máy chủ phục vụ trang web ------------------------------------------------------- #
@pytest.fixture
def web_client(ctx, tmp_path):
    site = tmp_path / "dist-web"
    (site / "_expo" / "static" / "js" / "web").mkdir(parents=True)
    (site / "index.html").write_text("<!doctype html><title>Tủ thuốc thông minh</title><div id=root></div>", encoding="utf-8")
    (site / "_expo" / "static" / "js" / "web" / "entry-abc123.js").write_text("console.log(1)", encoding="utf-8")
    (site / "zxing_reader.wasm").write_bytes(b"\0asm\1\0\0\0")
    (tmp_path / "bi-mat.txt").write_text("không được lộ", encoding="utf-8")
    ctx.settings.web_dir = site
    with TestClient(create_app(ctx=ctx, channel="public", manage_lifecycle=False)) as c:
        yield c


def test_public_port_serves_the_web_app_without_hiding_the_api(web_client):
    home = web_client.get("/")
    assert home.status_code == 200 and "Tủ thuốc thông minh" in home.text
    assert "script-src 'self'" in home.headers["content-security-policy"] and "camera=(self)" in home.headers["permissions-policy"]
    route = web_client.get("/scan/processing/123")  # đường dẫn của ứng dụng một trang → index.html
    assert route.status_code == 200 and "<div id=root>" in route.text
    js = web_client.get("/_expo/static/js/web/entry-abc123.js")
    assert js.headers["content-type"].startswith("text/javascript") and "immutable" in js.headers["cache-control"]
    assert web_client.get("/zxing_reader.wasm").headers["content-type"] == "application/wasm"
    assert web_client.get("/_expo/static/js/web/khong-co.js").status_code == 404  # thiếu file: không trả HTML
    assert web_client.get("/api/v1/health").json()["status"] == "ok"
    missing_api = web_client.get("/api/v1/khong-co-duong-nay")
    assert missing_api.status_code == 404 and missing_api.headers["content-type"].startswith("application/json")
    for sneaky in ("/../bi-mat.txt", "/%2e%2e/bi-mat.txt", "/..%2fbi-mat.txt"):
        r = web_client.get(sneaky)
        assert "không được lộ" not in r.text, sneaky
