"""Luồng quét của ứng dụng di động (kênh Public): ảnh → OCR trên máy chủ → PostgreSQL → ≤3 ứng viên → lịch sử."""
from __future__ import annotations

import time

from sqlalchemy import func, select

from app.models import CabinetItem, OcrCandidateRecord, OcrJobRecord, OcrResultRecord, ScanHistory

from .conftest import AUGMENTIN_625, png_bytes


def wait_done(public_client, job_id: str, headers: dict, timeout: float = 10.0) -> dict:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        job = public_client.get(f"/api/v1/scans/{job_id}", headers=headers).json()
        if job["status"] in ("done", "error", "cancelled"):
            return job
        time.sleep(0.05)
    raise AssertionError("OCR không xong kịp")


def submit(public_client, headers, source="camera"):
    return public_client.post("/api/v1/scans", headers=headers, data={"source": source},
                              files={"file": ("hop-thuoc.jpg", png_bytes(), "image/png")})


def test_scan_returns_at_most_three_candidates_and_never_saves_to_cabinet(public_client, scanner, ctx):
    headers, _ = scanner
    r = submit(public_client, headers)
    assert r.status_code == 202, r.text
    job = r.json()
    assert job["status"] == "queued" and [s["label"] for s in job["stages"]] == [
        "Xử lý hình ảnh", "Nhận dạng văn bản (OCR)", "Tra cứu trong cơ sở dữ liệu", "Tổng hợp kết quả"]
    done = wait_done(public_client, job["id"], headers)
    assert done["status"] == "done" and all(s["state"] == "done" for s in done["stages"])
    match = done["result"]["match"]
    assert match["status"] == "confident" and 1 <= len(match["candidates"]) <= 3
    top = match["candidates"][0]
    assert top["rank"] == 1 and top["medicine"]["id"] == AUGMENTIN_625 and top["level"] == "high"
    assert {"ten_thuoc", "hoat_chat_chinh", "ham_luong", "so_dang_ky"} <= set(top["medicine"])
    assert "Augmentin 625mg" in done["result"]["ocr_text"]
    assert "engine" not in done["result"] and "attempts" not in str(done["result"])  # không lộ thông tin nội bộ
    with ctx.db.session() as s:
        rec = s.get(OcrJobRecord, __import__("uuid").UUID(job["id"]))
        assert rec.status == "done" and rec.channel == "public" and rec.user_id is not None
        assert s.get(OcrResultRecord, rec.id).match_status == "confident"
        cands = s.scalars(select(OcrCandidateRecord).where(OcrCandidateRecord.job_id == rec.id).order_by(OcrCandidateRecord.rank)).all()
        assert [c.rank for c in cands] == list(range(1, len(cands) + 1)) and cands[0].medicine_id == AUGMENTIN_625
        assert s.scalar(select(func.count()).select_from(CabinetItem)) == 0  # quét trên mobile không thêm thuốc vào tủ


def test_history_is_per_account_searchable_and_reopenable(public_client, scanner, ctx):
    headers, _ = scanner
    job = submit(public_client, headers).json()
    wait_done(public_client, job["id"], headers)
    history = public_client.get("/api/v1/history", headers=headers).json()
    assert len(history["items"]) == 1 and history["has_more"] is False
    item = history["items"][0]
    assert item["title"] == "Augmentin 625mg tablets" and item["status"] == "confident" and item["created_at"].endswith("+07:00")
    assert public_client.get("/api/v1/history", params={"q": "AUGMENTÍN"}, headers=headers).json()["items"]  # không phân biệt dấu/hoa
    assert public_client.get("/api/v1/history", params={"q": "paracetamol"}, headers=headers).json()["items"] == []
    # Bộ lọc trạng thái (nút lọc trên màn hình Lịch sử quét).
    assert len(public_client.get("/api/v1/history", params={"status": "found"}, headers=headers).json()["items"]) == 1
    assert public_client.get("/api/v1/history", params={"status": "multiple"}, headers=headers).json()["items"] == []
    assert public_client.get("/api/v1/history", params={"status": "unrecognized"}, headers=headers).json()["items"] == []
    assert public_client.get("/api/v1/history", params={"status": "khac"}, headers=headers).status_code == 422
    assert public_client.get(f"/api/v1/scans/{job['id']}", headers=headers).json()["history_id"] == item["id"]
    detail = public_client.get(f"/api/v1/history/{item['id']}", headers=headers).json()
    assert detail["scan"]["result"]["match"]["candidates"][0]["medicine"]["id"] == AUGMENTIN_625
    thumb = public_client.get(f"/api/v1/scans/{job['id']}/thumbnail", headers=headers)
    assert thumb.status_code == 200 and thumb.headers["content-type"] == "image/jpeg"
    picked = public_client.post(f"/api/v1/history/{item['id']}/select", headers=headers, json={"medicine_id": AUGMENTIN_625})
    assert picked.json()["item"]["selected_medicine_id"] == AUGMENTIN_625
    assert public_client.post(f"/api/v1/history/{item['id']}/select", headers=headers, json={"medicine_id": 1}).status_code == 400

    # Kết quả vẫn mở lại được khi không còn trong bộ nhớ (máy chủ khởi động lại).
    ctx.ocr._jobs.clear()  # noqa: SLF001
    reopened = public_client.get(f"/api/v1/scans/{job['id']}", headers=headers).json()
    assert reopened["status"] == "done" and reopened["result"]["match"]["candidates"][0]["medicine"]["id"] == AUGMENTIN_625


def test_scans_and_history_of_other_accounts_are_invisible(public_client, scanner):
    headers, _ = scanner
    job = submit(public_client, headers).json()
    wait_done(public_client, job["id"], headers)
    item = public_client.get("/api/v1/history", headers=headers).json()["items"][0]
    other = public_client.post("/api/v1/auth/register", json={"full_name": "Khác", "email": "khac@example.com", "password": "NguoiKhac26"}).json()
    other_h = {"Authorization": f"Bearer {other['access_token']}"}
    assert public_client.get("/api/v1/history", headers=other_h).json()["items"] == []
    assert public_client.get(f"/api/v1/history/{item['id']}", headers=other_h).status_code == 404
    assert public_client.get(f"/api/v1/scans/{job['id']}", headers=other_h).status_code == 404
    assert public_client.get(f"/api/v1/scans/{job['id']}/thumbnail", headers=other_h).status_code == 404
    assert public_client.delete(f"/api/v1/scans/{job['id']}", headers=other_h).status_code == 404
    assert public_client.post(f"/api/v1/history/{item['id']}/select", headers=other_h, json={"medicine_id": AUGMENTIN_625}).status_code == 404


def test_queue_limits_and_cancel(public_client, scanner, ctx, fake_engine):
    headers, _ = scanner
    fake_engine.delay = 0.6
    first = submit(public_client, headers).json()
    second = submit(public_client, headers).json()
    third = submit(public_client, headers)
    assert third.status_code == 429 and "đợi kết quả" in third.json()["detail"]  # tối đa 2 ảnh chờ mỗi tài khoản
    cancelled = public_client.delete(f"/api/v1/scans/{second['id']}", headers=headers).json()
    assert cancelled == {"cancelled": True}
    assert public_client.get(f"/api/v1/scans/{second['id']}", headers=headers).json()["status"] == "cancelled"
    assert wait_done(public_client, first["id"], headers)["status"] == "done"
    ctx.ocr.max_queue = 0
    busy = submit(public_client, headers)
    assert busy.status_code == 503 and "bận" in busy.json()["detail"]


def test_ocr_failure_is_reported_and_recorded(public_client, scanner, fake_engine, ctx):
    headers, _ = scanner
    fake_engine.error = RuntimeError("GPU hết bộ nhớ")
    job = submit(public_client, headers).json()
    failed = wait_done(public_client, job["id"], headers)
    assert failed["status"] == "error" and failed["result"] is None and "GPU hết bộ nhớ" in failed["error"]
    with ctx.db.session() as s:
        h = s.scalar(select(ScanHistory))
        assert h.status == "failed" and h.title == "Nhận diện thất bại"


def test_unreadable_image_gives_not_found_status(public_client, scanner, fake_engine):
    headers, _ = scanner
    fake_engine.lines = [("Sổ tay ghi chép", 0.98), ("Lớp 12A1", 0.97)]
    job = submit(public_client, headers, source="upload").json()
    done = wait_done(public_client, job["id"], headers)
    assert done["result"]["match"]["status"] in ("no_match", "uncertain")
    assert done["result"]["match"]["status"] != "confident"


def test_scan_input_validation_and_rate_limit(public_client, scanner, ctx):
    headers, _ = scanner
    assert public_client.post("/api/v1/scans", headers=headers, files={"file": ("x.txt", b"khong phai anh", "text/plain")}).status_code == 400
    assert public_client.post("/api/v1/scans", headers=headers, data={"source": "hack"},
                              files={"file": ("a.png", png_bytes(), "image/png")}).status_code == 422
    assert public_client.post("/api/v1/scans", files={"file": ("a.png", png_bytes(), "image/png")}).status_code == 401
    ctx.limiter.rules["scan_user"] = (0, 3600)
    limited = submit(public_client, headers)
    assert limited.status_code == 429 and limited.headers.get("retry-after")


def test_public_health_and_config_need_no_login(public_client):
    health = public_client.get("/api/v1/health").json()
    assert health["status"] == "ok" and health["version"] == "2.0.0"
    config = public_client.get("/api/v1/app/config").json()
    assert config["max_candidates"] == 3 and config["providers"]["password"] is True and config["providers"]["google"] is False
