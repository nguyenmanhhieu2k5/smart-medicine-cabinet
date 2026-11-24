"""Ghép ảnh THIẾT KẾ (mobile/01-auth, 02-main-screens — chỉ đọc, không sửa) cạnh ảnh chụp BẢN THẬT (visual-check/output/393x852).

    backend\\.venv\\Scripts\\python mobile\\visual-check\\compare.py

Kết quả: mobile/visual-check/output/compare/<màn hình>.png (trái: thiết kế, phải: ứng dụng) để đối chiếu bằng mắt.
"""
from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

HERE = Path(__file__).resolve().parent
MOBILE = HERE.parent
SHOTS = HERE / "output" / "393x852"
OUT = HERE / "output" / "compare"
PAIRS = {
    "01_dang_nhap": "01-auth/01_dang_nhap.png",
    "02_dang_ky": "01-auth/02_dang_ky.png",
    "03_quen_mat_khau": "01-auth/03_quen_mat_khau.png",
    "04_nhap_ma": "01-auth/04_xac_minh_otp.png",
    "05_quet_thuoc": "02-main-screens/05_quet_thuoc.png",
    "06_dang_xu_ly_ocr": "02-main-screens/06_dang_xu_ly_ocr.png",
    "07_ket_qua_ocr": "02-main-screens/07_ket_qua_ocr.png",
    "08_chi_tiet_thuoc": "02-main-screens/08_chi_tiet_thuoc.png",
    "09_lich_su_quet": "02-main-screens/09_lich_su_quet.png",
}
HEIGHT = 1400


def fit(img: Image.Image) -> Image.Image:
    img = img.convert("RGB")
    return img.resize((round(img.width * HEIGHT / img.height), HEIGHT), Image.LANCZOS)


def label(img: Image.Image, text: str) -> Image.Image:
    canvas = Image.new("RGB", (img.width, img.height + 56), "#FFFFFF")
    canvas.paste(img, (0, 56))
    draw = ImageDraw.Draw(canvas)
    try:
        font = ImageFont.truetype("arial.ttf", 30)
    except OSError:
        font = ImageFont.load_default()
    draw.text((16, 12), text, fill="#111B39", font=font)
    return canvas


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    for name, design in PAIRS.items():
        shot = SHOTS / f"{name}.png"
        if not shot.is_file():
            print("thiếu ảnh chụp:", shot.name)
            continue
        left = label(fit(Image.open(MOBILE / design)), "THIET KE")
        right = label(fit(Image.open(shot)), "UNG DUNG (393x852)")
        out = Image.new("RGB", (left.width + right.width + 24, max(left.height, right.height)), "#E8ECF2")
        out.paste(left, (0, 0))
        out.paste(right, (left.width + 24, 0))
        out.save(OUT / f"{name}.png", optimize=True)
        print("đã ghép:", name)


if __name__ == "__main__":
    main()
