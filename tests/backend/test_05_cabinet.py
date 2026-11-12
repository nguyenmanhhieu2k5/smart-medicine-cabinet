"""10. Lưu thuốc vào tủ · 11. Tính ngày hết hạn thực tế."""
from __future__ import annotations

import time
from datetime import date, timedelta

import pytest

from app.services.cabinet import expiry_status

from .conftest import AUGMENTIN_625, FROZEN_NOW, png_bytes

TODAY = FROZEN_NOW.date()


def add(client, **overrides) -> dict:
    body = {"catalog_id": AUGMENTIN_625, "quantity": 14, "unit": "viên", "expiry_date": "2027-06-15"} | overrides
    response = client.post("/api/cabinet/medicines", json=body)
    assert response.status_code == 201, response.text
    return response.json()


# ---- 11. Hạn dùng thực tế ---------------------------------------------------- #
@pytest.mark.parametrize(
    ("expiry", "status", "days"),
    [
        (None, "unknown", None),
        (TODAY - timedelta(days=1), "expired", -1),
        (TODAY, "expiring", 0),  # vẫn dùng được trong ngày ghi trên bao bì
        (TODAY + timedelta(days=30), "expiring", 30),
        (TODAY + timedelta(days=31), "ok", 31),
        (date(2027, 6, 15), "ok", 217),
    ],
)
def test_expiry_status_boundaries(expiry, status, days):
    assert expiry_status(expiry, 30, TODAY) == (status, days)


def test_expiry_threshold_is_configurable():
    in_45_days = TODAY + timedelta(days=45)
    assert expiry_status(in_45_days, 30, TODAY)[0] == "ok"
    assert expiry_status(in_45_days, 60, TODAY)[0] == "expiring"


def test_registration_expiry_is_never_used_as_package_expiry(client):
    catalog = client.get(f"/api/medicines/{AUGMENTIN_625}").json()
    assert catalog["ngay_het_han_so_dang_ky"]  # danh mục có hạn SỐ ĐĂNG KÝ
    item = add(client, expiry_date=None)
    assert item["expiry_date"] is None and item["expiry_status"] == "unknown"
    assert item["expiry_status_label"] == "Chưa có hạn dùng"
    detail = client.get(f"/api/cabinet/medicines/{item['id']}").json()
    assert detail["expiry_date"] is None
    assert detail["catalog"]["ngay_het_han_so_dang_ky"] == catalog["ngay_het_han_so_dang_ky"]


# ---- 10. Lưu vào tủ ----------------------------------------------------------- #
def test_cabinet_starts_empty_even_though_catalog_has_data(client):
    assert client.get("/api/health").json()["catalog_count"] > 500
    listing = client.get("/api/cabinet/medicines").json()
    assert listing["items"] == [] and listing["total"] == 0 and listing["counts"]["all"] == 0


def test_add_from_catalog_copies_identity_from_source_data(client):
    item = add(client)
    assert item["name"] == "Augmentin 625mg tablets" and item["registration_no"] == "VN-20169-16"
    assert item["catalog_id"] == AUGMENTIN_625 and item["source"] == "manual"
    assert item["quantity"] == 14 and item["quantity_text"] == "14 viên"
    assert item["expiry_source"] == "manual" and item["expiry_status"] == "ok"
    assert client.get("/api/cabinet/medicines").json()["total"] == 1
    assert client.get(f"/api/medicines/{AUGMENTIN_625}").json()["in_cabinet_count"] == 1


def test_add_manual_medicine_and_validation(client):
    manual = add(client, catalog_id=None, name="  Thuốc tự nhập  ", quantity=2, unit="chai", expiry_date=None)
    assert manual["name"] == "Thuốc tự nhập" and manual["catalog_id"] is None
    assert client.post("/api/cabinet/medicines", json={"quantity": 1}).status_code == 400  # thiếu tên
    assert client.post("/api/cabinet/medicines", json={"name": "x", "quantity": -1}).status_code == 422
    assert client.post("/api/cabinet/medicines", json={"catalog_id": 987654321, "quantity": 1}).status_code == 404
    assert client.post("/api/cabinet/medicines", json={"name": "x", "quantity": 1, "expiry_date": "1890-01-01"}).status_code == 422


def test_update_adjust_and_delete(client):
    item = add(client)
    url = f"/api/cabinet/medicines/{item['id']}"
    updated = client.patch(url, json={"expiry_date": TODAY.isoformat(), "note": "Tủ trên", "quantity": 10}).json()
    assert updated["expiry_status"] == "expiring" and updated["days_left"] == 0 and updated["note"] == "Tủ trên"
    assert client.post(url + "/adjust", json={"delta": -4, "reason": "Đã dùng"}).json()["quantity"] == 6
    too_many = client.post(url + "/adjust", json={"delta": -7})
    assert too_many.status_code == 400 and "không thể âm" in too_many.json()["detail"]
    assert client.patch(url, json={"name": " "}).status_code == 400
    assert client.patch(url, json={"expiry_date": None}).json()["expiry_status"] == "unknown"
    assert client.delete(url).json() == {"deleted": True, "id": item["id"]}
    assert client.get(url).status_code == 404 and client.delete(url).status_code == 404


def test_filter_search_sort_and_counts(client):
    add(client, expiry_date=(TODAY - timedelta(days=3)).isoformat(), quantity=20)
    add(client, catalog_id=None, name="Paracetamol 500mg", expiry_date=(TODAY + timedelta(days=10)).isoformat(), quantity=3)
    add(client, catalog_id=None, name="Vitamin C", expiry_date=None, quantity=50)
    add(client, catalog_id=None, name="Oresol", expiry_date="2028-01-01", quantity=100, unit="gói")
    listing = client.get("/api/cabinet/medicines").json()
    assert listing["counts"] == {"all": 4, "ok": 1, "expiring": 1, "expired": 1, "unknown": 1, "low_stock": 1}
    assert [i["name"] for i in client.get("/api/cabinet/medicines", params={"status": "expired"}).json()["items"]] == ["Augmentin 625mg tablets"]
    assert [i["name"] for i in client.get("/api/cabinet/medicines", params={"status": "low_stock"}).json()["items"]] == ["Paracetamol 500mg"]
    assert [i["name"] for i in client.get("/api/cabinet/medicines", params={"q": "PARACETAMOL"}).json()["items"]] == ["Paracetamol 500mg"]
    by_expiry = [i["name"] for i in client.get("/api/cabinet/medicines", params={"sort": "expiry"}).json()["items"]]
    assert by_expiry == ["Augmentin 625mg tablets", "Paracetamol 500mg", "Oresol", "Vitamin C"]  # chưa có hạn xếp cuối
    page = client.get("/api/cabinet/medicines", params={"page": 2, "page_size": 3}).json()
    assert page["pages"] == 2 and len(page["items"]) == 1


def test_export_xlsx_and_csv(client):
    add(client)
    xlsx = client.get("/api/cabinet/export", params={"format": "xlsx"})
    assert xlsx.status_code == 200 and xlsx.content[:2] == b"PK"
    assert "thuoc-trong-tu-" in xlsx.headers["content-disposition"]
    csv = client.get("/api/cabinet/export", params={"format": "csv"})
    text = csv.content.decode("utf-8-sig")
    assert text.splitlines()[0].startswith("Tên thuốc,") and "Augmentin 625mg tablets" in text


# ---- Quét → xác nhận → lưu (9. không tự lưu) --------------------------------- #
def wait_job(client, job_id: str) -> dict:
    for _ in range(200):
        job = client.get(f"/api/ocr/jobs/{job_id}").json()
        if job["status"] in ("done", "error"):
            return job
        time.sleep(0.02)
    raise AssertionError("OCR job không kết thúc")


def test_scan_does_not_save_until_user_confirms(client):
    response = client.post("/api/ocr", files={"file": ("box.png", png_bytes(), "image/png")}, data={"source": "camera"})
    assert response.status_code == 202
    job = wait_job(client, response.json()["id"])
    assert job["status"] == "done", job
    match = job["result"]["match"]
    assert match["status"] == "confident" and match["candidates"][0]["medicine"]["id"] == AUGMENTIN_625
    assert job["result"]["ocr"]["lines"][0] == {"text": "Augmentin 625mg", "score": 0.99, "box": [10.0, 0.0, 400.0, 60.0]}
    assert job["result"]["expiry_suggestion"]["date"] == "2027-06-15"
    assert job["result"]["expiry_suggestion"]["needs_confirmation"] is True

    # Dù kết quả "confident", tủ thuốc vẫn trống cho tới khi người dùng xác nhận.
    assert client.get("/api/cabinet/medicines").json()["total"] == 0

    saved = client.post("/api/cabinet/medicines", json={
        "catalog_id": AUGMENTIN_625, "quantity": 14, "expiry_date": "2027-06-15",
        "expiry_source": "ocr_confirmed", "scan_job_id": job["id"],
    }).json()
    assert saved["source"] == "scan" and saved["expiry_source"] == "ocr_confirmed"
    types = [e["type"] for e in client.get("/api/history").json()["items"]]
    assert types[:4] == ["cabinet_add", "scan_confirmed", "ocr_completed", "scan"]


def test_ocr_rejects_non_images_and_reports_engine_errors(client, fake_engine):
    bad = client.post("/api/ocr", files={"file": ("a.txt", b"not an image", "text/plain")})
    assert bad.status_code == 400 and "Không đọc được ảnh" in bad.json()["detail"]
    assert client.get("/api/ocr/jobs/khongco").status_code == 404

    from app.services.ocr.engine import OcrEngineError

    fake_engine.error = OcrEngineError("Thiếu mô hình OCR")
    job = wait_job(client, client.post("/api/ocr", files={"file": ("b.png", png_bytes(), "image/png")}).json()["id"])
    assert job["status"] == "error" and job["error"] == "Thiếu mô hình OCR"
    alerts = client.get("/api/alerts", params={"category": "system"}).json()["items"]
    assert [a["type"] for a in alerts] == ["ocr_error"]

    fake_engine.error = None  # lần quét thành công kế tiếp tự đóng cảnh báo
    wait_job(client, client.post("/api/ocr", files={"file": ("c.png", png_bytes(), "image/png")}).json()["id"])
    assert client.get("/api/alerts", params={"category": "system"}).json()["items"] == []
