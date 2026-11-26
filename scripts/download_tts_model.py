"""Tải mô hình giọng đọc tiếng Việt tự nhiên (Piper vi_VN-vais1000-medium, ~78 MB) cho máy chủ Mini PC.

    backend\\.venv\\Scripts\\python scripts\\download_tts_model.py            (vào <thư mục dữ liệu>\\tts)
    backend\\.venv\\Scripts\\python scripts\\download_tts_model.py --dir D:\\tts

Nguồn: bản đóng gói cho sherpa-onnx của k2-fsa (github.com/k2-fsa/sherpa-onnx, mục release "tts-models").
Giấy phép giọng: CC BY 4.0 (dữ liệu VAIS-1000) — xem MODEL_CARD trong thư mục mô hình.
Xong thì khởi động lại dịch vụ: Restart-Service SmartMedicineServer
"""
from __future__ import annotations

import argparse
import shutil
import sys
import tarfile
import tempfile
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from app.core.config import load_settings  # noqa: E402
from app.services.tts import VOICE, VOICE_DIR  # noqa: E402

URL = f"https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/{VOICE_DIR}.tar.bz2"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--dir", help="thư mục chứa mô hình (mặc định: <thư mục dữ liệu máy chủ>/tts)")
    args = parser.parse_args()
    target = Path(args.dir) if args.dir else load_settings().data_dir / "tts"
    final = target / VOICE_DIR
    if (final / f"{VOICE}.onnx").is_file():
        print(f"Đã có mô hình: {final}")
        return 0
    target.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as tmp:
        archive = Path(tmp) / "voice.tar.bz2"
        print(f"Đang tải {URL} …")
        with urllib.request.urlopen(URL, timeout=60) as response, archive.open("wb") as out:  # noqa: S310 — URL cố định
            shutil.copyfileobj(response, out)
        print(f"Đã tải {archive.stat().st_size / 1e6:.1f} MB, đang giải nén…")
        with tarfile.open(archive, "r:bz2") as tar:
            tar.extractall(Path(tmp) / "x", filter="data")
        shutil.move(str(Path(tmp) / "x" / VOICE_DIR), str(final))
    if not (final / f"{VOICE}.onnx").is_file():
        print("Giải nén xong nhưng không thấy file mô hình .onnx", file=sys.stderr)
        return 1
    print(f"Xong: {final}\nKhởi động lại dịch vụ máy chủ để dùng giọng mới: Restart-Service SmartMedicineServer")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
