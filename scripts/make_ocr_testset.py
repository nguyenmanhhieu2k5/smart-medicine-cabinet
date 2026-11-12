"""Sinh bộ ảnh kiểm thử OCR (ảnh bao bì TỔNG HỢP, không phải ảnh sản phẩm thật).

    python scripts/make_ocr_testset.py tests/fixtures/ocr

Nội dung chữ lấy đúng theo các bản ghi trong DAV_unique.xlsx để có thể đối
chiếu. Mỗi ảnh ứng với một tình huống: rõ nét, mờ, nghiêng, xoay ngược, tối,
thiếu chữ, hai sản phẩm cùng tên khác hàm lượng, và ảnh không phải thuốc.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageEnhance, ImageFilter, ImageFont

FONT_CANDIDATES = {
    "bold": [
        "/usr/share/fonts/opentype/inter/Inter-Bold.otf", "C:/Windows/Fonts/arialbd.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
    ],
    "regular": [
        "/usr/share/fonts/opentype/inter/Inter-Regular.otf", "C:/Windows/Fonts/arial.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", "/System/Library/Fonts/Supplemental/Arial.ttf",
    ],
}


def font(kind: str, size: int) -> ImageFont.FreeTypeFont:
    for path in FONT_CANDIDATES[kind]:
        if Path(path).is_file():
            return ImageFont.truetype(path, size)
    raise SystemExit("Không tìm thấy font TrueType để vẽ ảnh kiểm thử.")


def box(lines: list[tuple[str, str, int]], accent=(8, 120, 249), size=(1200, 760)) -> Image.Image:
    """Vẽ một "mặt hộp thuốc": nền sáng, dải màu, các dòng chữ (text, kiểu, cỡ)."""
    w, h = size
    img = Image.new("RGB", size, (228, 232, 238))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle((70, 70, w - 70, h - 70), 22, fill=(253, 253, 252), outline=(205, 210, 220), width=2)
    d.rounded_rectangle((70, h - 190, w - 70, h - 70), 22, fill=accent)
    d.rectangle((70, h - 190, w - 70, h - 160), fill=accent)
    y = 120
    for text, kind, px in lines:
        fill = (17, 27, 57) if kind == "bold" else (60, 70, 95)
        d.text((120, y), text, font=font(kind, px), fill=fill)
        y += int(px * 1.45)
    return img


CASES: list[dict] = [
    {
        "file": "01_ro_net_augmentin_625.jpg", "kind": "clear",
        "lines": [("Augmentin 625mg", "bold", 92), ("Amoxicillin 500mg / Acid clavulanic 125mg", "regular", 36),
                  ("Viên nén bao phim", "regular", 36), ("Hộp 2 vỉ x 7 viên", "regular", 30), ("SĐK: VN-20169-16", "regular", 30)],
        "expect": {"top_ids": [34382], "status": "confident", "strength_tokens": ["500mg", "125mg"]},
    },
    {
        "file": "02_cung_ten_augmentin_250.jpg", "kind": "same_name_other_strength",
        "lines": [("Augmentin", "bold", 96), ("250mg/31,25mg", "bold", 60), ("Bột pha hỗn dịch uống", "regular", 36), ("Hộp 12 gói", "regular", 30)],
        "expect": {"top_ids": [31802], "not_ids": [30930, 34382, 34381]},
    },
    {
        "file": "03_cung_ten_augmentin_500_62.jpg", "kind": "same_name_other_strength",
        "lines": [("Augmentin", "bold", 96), ("500mg/62,5mg", "bold", 60), ("Bột pha hỗn dịch uống", "regular", 36), ("Hộp 12 gói", "regular", 30)],
        "expect": {"top_ids": [30930], "not_ids": [31802, 34382, 34381]},
    },
    {
        "file": "04_cung_ten_augmentin_1g.jpg", "kind": "same_name_other_strength",
        "lines": [("Augmentin 1g", "bold", 96), ("Amoxicillin 875mg + Acid clavulanic 125mg", "regular", 36), ("Viên nén bao phim", "regular", 36)],
        "expect": {"top_ids": [34381, 23159], "not_ids": [34382, 31802, 30930]},
    },
    {
        "file": "05_mo_paracetamol_500.jpg", "kind": "blurred", "blur": 2.2,
        "lines": [("Paracetamol 500mg", "bold", 88), ("Viên nén", "regular", 40), ("Hộp 10 vỉ x 10 viên", "regular", 32)],
        "expect": {"top_name_core": "paracetamol", "strength_tokens": ["500mg"]},
    },
    {
        "file": "06_nghieng_hapacol_250.jpg", "kind": "tilted", "rotate": 12,
        "lines": [("Hapacol 250", "bold", 100), ("Paracetamol 250mg", "regular", 40), ("Thuốc bột sủi bọt", "regular", 36), ("Hộp 24 gói x 1,5g", "regular", 30)],
        "expect": {"top_ids": [6365, 6364]},
    },
    {
        "file": "07_xoay_nguoc_efferalgan.jpg", "kind": "upside_down", "rotate": 180,
        "lines": [("Efferalgan", "bold", 110), ("Paracetamol 500mg", "regular", 44), ("Viên nén sủi bọt", "regular", 38)],
        "expect": {"top_name_core": "efferalgan", "preprocess_contains": "rotate_180"},
    },
    {
        "file": "08_toi_panadol_extra.jpg", "kind": "dark", "brightness": 0.32, "contrast": 0.55,
        "lines": [("Panadol Extra", "bold", 100), ("Paracetamol 500mg  Caffeine 65mg", "regular", 40), ("Viên nén bao phim", "regular", 36)],
        "expect": {"top_name_core": "panadol extra"},
    },
    {
        "file": "09_thieu_chu_chi_co_ten.jpg", "kind": "missing_text",
        "lines": [("Augmentin", "bold", 120)],
        "expect": {"status": "uncertain", "top_name_core": "augmentin"},
    },
    {
        "file": "10_co_han_dung.jpg", "kind": "expiry",
        "lines": [("Fogicap 40", "bold", 100), ("Omeprazol 40mg", "regular", 40), ("SĐK: VD-34703-20", "regular", 34),
                  ("Số lô: 010225   NSX: 12/02/2025", "regular", 32), ("HSD: 12/02/2028", "regular", 32)],
        "expect": {"top_ids": [52211], "expiry": "2028-02-12"},
    },
    {
        "file": "11_khong_phai_thuoc.jpg", "kind": "not_medicine",
        "lines": [("Sổ tay ghi chép", "bold", 96), ("Lớp 12A1 - Năm học 2026", "regular", 44), ("Trường THPT", "regular", 40)],
        "expect": {"status_in": ["no_match", "uncertain"], "never_confident": True},
    },
]


def main(out_dir: str) -> None:
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    manifest = []
    for case in CASES:
        img = box(case["lines"])
        if case.get("blur"):
            img = img.filter(ImageFilter.GaussianBlur(case["blur"]))
        if case.get("brightness"):
            img = ImageEnhance.Brightness(img).enhance(case["brightness"])
        if case.get("contrast"):
            img = ImageEnhance.Contrast(img).enhance(case["contrast"])
        if case.get("rotate"):
            img = img.rotate(case["rotate"], expand=True, fillcolor=(214, 218, 226), resample=Image.BICUBIC)
        img.save(out / case["file"], quality=90)
        manifest.append({"file": case["file"], "kind": case["kind"], "text": [t for t, _, _ in case["lines"]], "expect": case["expect"]})
    (out / "cases.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"Đã tạo {len(manifest)} ảnh tại {out}")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "tests/fixtures/ocr")
