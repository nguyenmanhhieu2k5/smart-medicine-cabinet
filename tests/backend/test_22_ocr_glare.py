"""Lóa sáng khi quét (vỉ thuốc giấy bạc, hộp bóng, màn hình điện thoại): đo để nhắc người dùng chụp lại."""
from __future__ import annotations

import cv2
import numpy as np

from app.services.ocr import preprocess


def foil_with_glare(glare: bool) -> np.ndarray:
    """Vỉ giấy bạc xám có chữ đỏ; tùy chọn thêm một điểm lóa trắng lớn đè lên chữ."""
    img = np.full((360, 640, 3), 150, np.uint8)
    cv2.putText(img, "CEDIPECT", (60, 200), cv2.FONT_HERSHEY_SIMPLEX, 3.0, (40, 30, 190), 8)
    if glare:
        yy, xx = np.mgrid[0:360, 0:640]
        spot = np.exp(-(((xx - 330) / 120.0) ** 2 + ((yy - 180) / 60.0) ** 2)) * 260
        img = np.clip(img.astype(np.float32) + spot[..., None], 0, 255).astype(np.uint8)
    return img


def test_glare_ratio_measures_blown_out_white_in_the_middle_only():
    assert preprocess.glare_ratio(foil_with_glare(False)) == 0.0
    assert preprocess.glare_ratio(foil_with_glare(True)) > 0.03
    yellow = np.zeros((200, 200, 3), np.uint8)
    yellow[:] = (40, 240, 255)  # vàng chói (BGR) có màu → không phải lóa
    assert preprocess.glare_ratio(yellow) == 0.0
    edge = np.full((400, 400, 3), 120, np.uint8)
    edge[:, :40] = 255  # mép trái cháy sáng (bàn trắng, cửa sổ) — ngoài vùng đặt thuốc
    assert preprocess.glare_ratio(edge) == 0.0
    big = cv2.resize(foil_with_glare(True), (3840, 2160))  # ảnh lớn vẫn đo nhanh (thu nhỏ trước)
    assert abs(preprocess.glare_ratio(big) - preprocess.glare_ratio(foil_with_glare(True))) < 0.01


def test_scan_result_reports_glare_percent(client):
    ok, jpeg = cv2.imencode(".jpg", foil_with_glare(True))
    job = client.post("/api/ocr", files={"file": ("vi.jpg", jpeg.tobytes(), "image/jpeg")}, data={"source": "camera"}).json()
    for _ in range(200):
        job = client.get(f"/api/ocr/jobs/{job['id']}").json()
        if job["status"] in ("done", "error"):
            break
    assert job["status"] == "done", job
    assert job["result"]["image"]["glare"] > 3


def test_phone_scan_result_reports_glare_too(public_client, scanner):
    """Điện thoại không đo được khung hình trực tiếp → dựa vào % lóa máy chủ trả về để nhắc tắt đèn flash/chụp lại."""
    from .test_14_public_scan import wait_done

    headers, _ = scanner
    for glare, expect_high in ((True, True), (False, False)):
        ok, jpeg = cv2.imencode(".jpg", foil_with_glare(glare))
        r = public_client.post("/api/v1/scans", headers=headers, data={"source": "camera"}, files={"file": ("vi.jpg", jpeg.tobytes(), "image/jpeg")})
        assert r.status_code == 202, r.text
        done = wait_done(public_client, r.json()["id"], headers)
        assert done["status"] == "done", done
        assert (done["result"]["glare"] > 3) is expect_high
