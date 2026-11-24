"""Tạo biểu tượng cho ứng dụng di động (mobile/assets) — cùng hình viên thuốc với ứng dụng Windows.

    backend\\.venv\\Scripts\\python mobile\\scripts\\make_icons.py

- icon.png           1024×1024, nền gradient phủ kín (iOS tự bo góc, không được có nền trong suốt)
- adaptive-icon.png  1024×1024, chỉ hình viên thuốc trắng trong vùng an toàn (nền #0878F9 khai báo trong app.json)
- splash-icon.png    biểu tượng bo góc cho màn hình khởi động
- favicon.png        48×48 cho bản web (chỉ dùng để kiểm tra giao diện)
"""
from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parents[1] / "assets"
TOP, BOTTOM = (0x2E, 0xA3, 0xF8), (0x08, 0x72, 0xF5)


def gradient(size: int) -> Image.Image:
    img = Image.new("RGB", (size, size))
    px = img.load()
    for y in range(size):
        for x in range(size):
            t = (x + y) / (2 * (size - 1))
            px[x, y] = tuple(round(a + (b - a) * t) for a, b in zip(TOP, BOTTOM))
    return img


def pill(size: int, scale: float) -> Image.Image:
    """Viên thuốc viền trắng xoay 45° (như favicon.svg: rect 64×144 bo 32, nét 14 trên khung 256)."""
    big = size * 4
    layer = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    draw = ImageDraw.Draw(layer)
    unit = big / 256 * scale
    cx = cy = big / 2
    w, h, stroke = 64 * unit, 144 * unit, 14 * unit
    box = (cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2)
    draw.rounded_rectangle(box, radius=w / 2, outline=(255, 255, 255, 255), width=round(stroke))
    draw.line((cx - w / 2 + stroke / 2, cy, cx + w / 2 - stroke / 2, cy), fill=(255, 255, 255, 255), width=round(stroke))
    return layer.rotate(-45, resample=Image.BICUBIC).resize((size, size), Image.LANCZOS)


def rounded(img: Image.Image, radius_ratio: float = 62 / 256) -> Image.Image:
    size = img.size[0]
    mask = Image.new("L", (size * 4, size * 4), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, size * 4 - 1, size * 4 - 1), radius=size * 4 * radius_ratio, fill=255)
    out = img.convert("RGBA")
    out.putalpha(mask.resize((size, size), Image.LANCZOS))
    return out


def main() -> None:
    OUT.mkdir(exist_ok=True)
    base = gradient(256).resize((1024, 1024), Image.BICUBIC).convert("RGBA")
    icon = Image.alpha_composite(base, pill(1024, 1.0))
    icon.convert("RGB").save(OUT / "icon.png")
    pill(1024, 0.62).save(OUT / "adaptive-icon.png")
    splash = rounded(Image.alpha_composite(gradient(256).resize((512, 512), Image.BICUBIC).convert("RGBA"), pill(512, 1.0)))
    splash.save(OUT / "splash-icon.png")
    splash.resize((48, 48), Image.LANCZOS).save(OUT / "favicon.png")
    print("Đã tạo:", ", ".join(p.name for p in sorted(OUT.glob("*.png"))))


if __name__ == "__main__":
    main()
