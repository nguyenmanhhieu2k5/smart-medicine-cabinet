"""Tải gói mô hình OCR CHÍNH THỨC của PaddleOCR về thư mục ``ocr_models/`` để đóng gói kèm ứng dụng.

Ứng dụng tìm mô hình theo thứ tự:
  1. thư mục ``ocr_models`` đi kèm bản cài đặt (``resources/ocr_models``) hoặc ``SMC_OCR_MODEL_DIR``;
  2. bộ nhớ đệm trong thư mục dữ liệu người dùng (``<data>/paddlex/official_models``);
  3. nếu không có ở cả hai nơi, PaddleOCR tự tải lần đầu (cần Internet) vào (2).

Script này thực hiện bước tải trước để bản cài đặt chạy offline ngay từ lần đầu.
Nó dùng đúng trình quản lý mô hình của PaddleX 3.7 (``official_models.get_model_path``), nguồn tải lần lượt:
Hugging Face → AI Studio → ModelScope → BOS (đổi nguồn ưu tiên bằng ``--source``).

Ví dụ:
    python scripts/download_ocr_models.py                     # PP-OCRv6 small, ONNX (mặc định của ứng dụng)
    python scripts/download_ocr_models.py --profile v6_medium # chính xác hơn, chậm hơn
    python scripts/download_ocr_models.py --profile all --textline
    python scripts/download_ocr_models.py --format paddle     # cho engine Paddle gốc (cần paddlepaddle)

Nếu máy không vào được các nguồn trên nhưng vào được PyPI:
    python scripts/build_ocr_models_from_rapidocr.py --out ocr_models

LƯU Ý: script này CHƯA được chạy thành công trong môi trường phát triển của dự án (các máy chủ mô hình bị
chặn ở đó). Lần đầu chạy trên máy của bạn, hãy kiểm tra thông báo "ĐẠT" ở cuối.
"""
from __future__ import annotations

import argparse
import os
import shutil
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

# Trùng với PROFILES trong backend/app/services/ocr/engine.py
PROFILES: dict[str, tuple[str, str]] = {
    "v6_small": ("PP-OCRv6_small_det", "PP-OCRv6_small_rec"),
    "v6_tiny": ("PP-OCRv6_tiny_det", "PP-OCRv6_tiny_rec"),
    "v6_medium": ("PP-OCRv6_medium_det", "PP-OCRv6_medium_rec"),
    "v5_latin": ("PP-OCRv5_mobile_det", "latin_PP-OCRv5_mobile_rec"),
}
TEXTLINE_ORI_MODEL = "PP-LCNet_x0_25_textline_ori"
REQUIRED_FILES = {"onnx": ("inference.onnx", "inference.yml"), "paddle": ("inference.pdiparams", "inference.yml")}


def model_ready(directory: Path, model_format: str) -> bool:
    return all((directory / name).is_file() for name in REQUIRED_FILES[model_format])


def target_dir(out: Path, name: str, model_format: str) -> Path:
    return out / (f"{name}_onnx" if model_format == "onnx" else name)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--profile", default="v6_small", choices=[*PROFILES, "all"], help="bộ mô hình (mặc định: v6_small)")
    parser.add_argument("--format", dest="model_format", default="onnx", choices=["onnx", "paddle"], help="định dạng mô hình (mặc định: onnx)")
    parser.add_argument("--out", default=str(ROOT / "ocr_models"), help="thư mục đích (mặc định: ./ocr_models)")
    parser.add_argument("--source", choices=["huggingface", "aistudio", "modelscope", "bos"], help="nguồn tải ưu tiên")
    parser.add_argument("--textline", action="store_true", help="tải thêm mô hình xoay dòng chữ (tuỳ chọn 'ocr_use_textline_orientation')")
    parser.add_argument("--force", action="store_true", help="tải lại dù thư mục đích đã có mô hình")
    args = parser.parse_args()

    out = Path(args.out).resolve()
    out.mkdir(parents=True, exist_ok=True)

    names: list[str] = []
    for profile in PROFILES if args.profile == "all" else [args.profile]:
        for name in PROFILES[profile]:
            if name not in names:
                names.append(name)
    if args.textline:
        names.append(TEXTLINE_ORI_MODEL)

    pending = [name for name in names if args.force or not model_ready(target_dir(out, name, args.model_format), args.model_format)]
    for name in names:
        if name not in pending:
            print(f"[có sẵn] {target_dir(out, name, args.model_format)}")
    if not pending:
        print("ĐẠT: tất cả mô hình đã có sẵn.")
        return 0

    # Bộ nhớ đệm tạm — phải đặt TRƯỚC khi import paddlex.
    cache = Path(tempfile.mkdtemp(prefix="smc-ocr-models-"))
    os.environ["PADDLE_PDX_CACHE_HOME"] = str(cache)
    if args.source:
        os.environ["PADDLE_PDX_MODEL_SOURCE"] = args.source
    try:
        from paddlex.inference.utils.official_models import official_models
    except ImportError as error:
        print(f"LỖI: chưa cài paddleocr/paddlex trong môi trường Python này ({error}).", file=sys.stderr)
        print("      Hãy chạy bằng Python của backend: backend\\.venv\\Scripts\\python scripts\\download_ocr_models.py", file=sys.stderr)
        return 2

    failures: list[str] = []
    try:
        for name in pending:
            destination = target_dir(out, name, args.model_format)
            other = "paddle" if args.model_format == "onnx" else "onnx"
            if destination.exists() and model_ready(destination, other):
                # Ví dụ ocr_models/PP-OCRv6_small_det đang chứa mô hình ONNX đi kèm: không xoá để thay bằng định dạng khác.
                print(f"  LỖI: {destination} đang chứa mô hình định dạng {other}; không ghi đè. Dùng --out <thư mục khác>.", file=sys.stderr)
                failures.append(name)
                continue
            print(f"[tải] {name} ({args.model_format}) …", flush=True)
            try:
                source = Path(official_models.get_model_path(name, model_formats=(args.model_format,)))
            except Exception as error:  # lỗi mạng, gói không tồn tại…
                print(f"  LỖI: {error}", file=sys.stderr)
                failures.append(name)
                continue
            if not model_ready(source, args.model_format):
                print(f"  LỖI: gói tải về thiếu file {REQUIRED_FILES[args.model_format]} ({source})", file=sys.stderr)
                failures.append(name)
                continue
            if destination.exists():
                shutil.rmtree(destination)
            shutil.copytree(source, destination, ignore=shutil.ignore_patterns(".git*", ".cache", "*.lock", "README*"))
            size_mb = sum(item.stat().st_size for item in destination.rglob("*") if item.is_file()) / 1e6
            print(f"  -> {destination} ({size_mb:.1f} MB)")
    finally:
        shutil.rmtree(cache, ignore_errors=True)

    if failures:
        print(f"\nKHÔNG ĐẠT: chưa tải được {', '.join(failures)}.", file=sys.stderr)
        print("Kiểm tra mạng / thử nguồn khác (--source modelscope | bos | aistudio | huggingface),", file=sys.stderr)
        print("hoặc dùng mô hình từ PyPI: python scripts/build_ocr_models_from_rapidocr.py --out ocr_models", file=sys.stderr)
        return 1
    print("\nĐẠT: mô hình đã sẵn sàng trong", out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
