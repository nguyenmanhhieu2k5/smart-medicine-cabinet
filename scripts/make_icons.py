"""Tạo assets/icon.png và assets/icon.ico từ biểu tượng SVG của ứng dụng.

Chỉ cần chạy lại khi đổi biểu tượng (frontend/public/favicon.svg). Cần: playwright (Chromium/Chrome) + Pillow.

    python scripts/make_icons.py [--chrome /duong/dan/chrome]
"""
from __future__ import annotations

import argparse
import io
from pathlib import Path

from PIL import Image
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
SVG = ROOT / "frontend" / "public" / "favicon.svg"
ASSETS = ROOT / "assets"
ICO_SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256]


def render_png(size: int, chrome: str | None) -> Image.Image:
    svg = SVG.read_text(encoding="utf-8")
    html = f"<html><body style='margin:0;background:transparent'><div style='width:{size}px;height:{size}px'>{svg}</div></body></html>"
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path=chrome) if chrome else p.chromium.launch()
        page = browser.new_page(viewport={"width": size, "height": size})
        page.set_content(html)
        page.add_style_tag(content="svg{width:100%;height:100%;display:block}")
        data = page.screenshot(omit_background=True, clip={"x": 0, "y": 0, "width": size, "height": size})
        browser.close()
    return Image.open(io.BytesIO(data)).convert("RGBA")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--chrome", default=None, help="đường dẫn Chrome/Chromium (mặc định: trình duyệt của Playwright)")
    args = parser.parse_args()
    ASSETS.mkdir(exist_ok=True)
    master = render_png(1024, args.chrome)
    master.resize((512, 512), Image.LANCZOS).save(ASSETS / "icon.png")
    master.resize((256, 256), Image.LANCZOS).save(ASSETS / "icon.ico", sizes=[(s, s) for s in ICO_SIZES])
    print("Đã tạo:", ASSETS / "icon.png", ASSETS / "icon.ico")


if __name__ == "__main__":
    main()
