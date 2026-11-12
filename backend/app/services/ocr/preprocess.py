"""Tiền xử lý ảnh bằng OpenCV.

Nguyên tắc: luôn OCR ảnh gốc trước. Các biến thể (tăng tương phản, xoay, nắn
nghiêng) chỉ được dùng khi kết quả OCR của chúng tốt hơn rõ rệt so với ảnh gốc.
"""
from __future__ import annotations

import math
from typing import Sequence

import cv2
import numpy as np

MAX_SIDE = 1920


class ImageError(ValueError):
    """Ảnh không đọc được hoặc không hợp lệ."""


def decode_image(data: bytes) -> np.ndarray:
    """Giải mã ảnh (JPEG/PNG/WebP/BMP) thành mảng BGR; tự áp dụng hướng EXIF."""
    if not data:
        raise ImageError("File ảnh rỗng.")
    array = np.frombuffer(data, dtype=np.uint8)
    image = cv2.imdecode(array, cv2.IMREAD_COLOR)
    if image is None:
        raise ImageError("Không đọc được ảnh. Hãy dùng JPEG, PNG, WebP hoặc BMP.")
    if min(image.shape[:2]) < 32:
        raise ImageError("Ảnh quá nhỏ để nhận diện.")
    return image


def limit_size(image: np.ndarray, max_side: int = MAX_SIDE) -> np.ndarray:
    h, w = image.shape[:2]
    scale = max_side / max(h, w)
    if scale >= 1:
        return image
    return cv2.resize(image, (max(1, int(w * scale)), max(1, int(h * scale))), interpolation=cv2.INTER_AREA)


def crop_relative(image: np.ndarray, rect: Sequence[float] | None, margin: float = 0.04) -> np.ndarray:
    """Cắt theo khung quét (x, y, w, h trong [0, 1]) kèm lề an toàn."""
    if not rect or len(rect) != 4:
        return image
    x, y, w, h = (float(v) for v in rect)
    if not (0 <= x < 1 and 0 <= y < 1 and 0 < w <= 1 and 0 < h <= 1):
        return image
    ih, iw = image.shape[:2]
    x0 = int(max(0.0, x - margin) * iw)
    y0 = int(max(0.0, y - margin) * ih)
    x1 = int(min(1.0, x + w + margin) * iw)
    y1 = int(min(1.0, y + h + margin) * ih)
    if x1 - x0 < 32 or y1 - y0 < 32:
        return image
    return image[y0:y1, x0:x1].copy()


def sharpness(image: np.ndarray) -> float:
    """Phương sai Laplacian — càng lớn ảnh càng nét."""
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    if max(gray.shape) > 640:
        scale = 640 / max(gray.shape)
        gray = cv2.resize(gray, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA)
    return float(cv2.Laplacian(gray, cv2.CV_64F).var())


def brightness(image: np.ndarray) -> float:
    return float(cv2.cvtColor(image, cv2.COLOR_BGR2GRAY).mean())


def enhance_contrast(image: np.ndarray) -> np.ndarray:
    """CLAHE trên kênh sáng + làm nét nhẹ (cho ảnh tối, mờ, tương phản thấp)."""
    lab = cv2.cvtColor(image, cv2.COLOR_BGR2LAB)
    l_channel, a_channel, b_channel = cv2.split(lab)
    clahe = cv2.createCLAHE(clipLimit=2.5, tileGridSize=(8, 8))
    merged = cv2.merge((clahe.apply(l_channel), a_channel, b_channel))
    out = cv2.cvtColor(merged, cv2.COLOR_LAB2BGR)
    blurred = cv2.GaussianBlur(out, (0, 0), sigmaX=2.0)
    return cv2.addWeighted(out, 1.6, blurred, -0.6, 0)


def denoise(image: np.ndarray) -> np.ndarray:
    return cv2.bilateralFilter(image, d=7, sigmaColor=45, sigmaSpace=45)


def rotate_quarter(image: np.ndarray, turns: int) -> np.ndarray:
    turns %= 4
    if turns == 1:
        return cv2.rotate(image, cv2.ROTATE_90_CLOCKWISE)
    if turns == 2:
        return cv2.rotate(image, cv2.ROTATE_180)
    if turns == 3:
        return cv2.rotate(image, cv2.ROTATE_90_COUNTERCLOCKWISE)
    return image


def rotate_angle(image: np.ndarray, angle_deg: float) -> np.ndarray:
    """Xoay quanh tâm, mở rộng khung để không cắt mất nội dung."""
    h, w = image.shape[:2]
    matrix = cv2.getRotationMatrix2D((w / 2, h / 2), angle_deg, 1.0)
    cos, sin = abs(matrix[0, 0]), abs(matrix[0, 1])
    new_w, new_h = int(h * sin + w * cos), int(h * cos + w * sin)
    matrix[0, 2] += new_w / 2 - w / 2
    matrix[1, 2] += new_h / 2 - h / 2
    return cv2.warpAffine(image, matrix, (new_w, new_h), flags=cv2.INTER_CUBIC, borderMode=cv2.BORDER_REPLICATE)


def skew_angle(polys: Sequence[Sequence[Sequence[float]]]) -> float:
    """Góc nghiêng trung vị (độ) của các dòng chữ, tính từ đa giác 4 điểm của OCR.

    Chỉ tính trên các khung dài (rộng ≥ 2 × cao) để tránh nhiễu từ khung vuông.
    """
    angles: list[float] = []
    for poly in polys:
        pts = np.asarray(poly, dtype=np.float32).reshape(-1, 2)
        if len(pts) < 4:
            continue
        top = pts[1] - pts[0]
        side = pts[3] - pts[0]
        width, height = float(np.hypot(*top)), float(np.hypot(*side))
        if width < 2 * height or width < 20:
            continue
        angles.append(math.degrees(math.atan2(float(top[1]), float(top[0]))))
    if len(angles) < 2:
        return angles[0] if angles else 0.0
    return float(np.median(angles))


def encode_jpeg(image: np.ndarray, quality: int = 88) -> bytes:
    ok, buffer = cv2.imencode(".jpg", image, [cv2.IMWRITE_JPEG_QUALITY, quality])
    if not ok:
        raise ImageError("Không mã hóa được ảnh.")
    return buffer.tobytes()
