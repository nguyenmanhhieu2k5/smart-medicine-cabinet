"""Dựng thư mục mô hình PP-OCRv6 (ONNX) cho PaddleOCR từ gói `rapidocr` trên PyPI.

Dùng khi máy không truy cập được Hugging Face / BOS / ModelScope để tải gói
mô hình chính thức. Gói wheel `rapidocr` kèm sẵn hai file ONNX của PP-OCRv6
small (phát hiện + nhận dạng chữ). Script này:

1. tải wheel `rapidocr` về thư mục tạm (pip download, không cài đặt);
2. chép các file .onnx thành `<out>/PP-OCRv6_small_det/inference.onnx` …;
3. sinh `inference.yml` theo cấu hình PP-OCR chuẩn (bộ ký tự lấy từ metadata
   của mô hình nhận dạng).

Cách chạy:
    python scripts/build_ocr_models_from_rapidocr.py --out ocr_models

Lưu ý: `inference.yml` ở đây do script sinh ra theo quy ước PP-OCR, không phải
file cấu hình chính thức đi kèm gói mô hình của PaddlePaddle. Khi có mạng, nên
ưu tiên `scripts/download_ocr_models.py` để lấy gói chính thức.
"""
from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path

import yaml

DET_YML = {
    "Global": {"model_name": "PP-OCRv6_small_det"},
    "PreProcess": {
        "transform_ops": [
            {"DecodeImage": {"channel_first": False, "img_mode": "BGR"}},
            {"DetLabelEncode": None},
            {"DetResizeForTest": {"resize_long": 960}},
            {"NormalizeImage": {"mean": [0.485, 0.456, 0.406], "std": [0.229, 0.224, 0.225], "scale": "1./255.", "order": "hwc"}},
            {"ToCHWImage": None},
            {"KeepKeys": {"keep_keys": ["image", "shape", "polys", "ignore_tags"]}},
        ]
    },
    "PostProcess": {"name": "DBPostProcess", "thresh": 0.3, "box_thresh": 0.6, "max_candidates": 1000, "unclip_ratio": 1.5},
}


def rec_yml(characters: list[str]) -> dict:
    return {
        "Global": {"model_name": "PP-OCRv6_small_rec"},
        "PreProcess": {
            "transform_ops": [
                {"DecodeImage": {"channel_first": False, "img_mode": "BGR"}},
                {"MultiLabelEncode": {"gtc_encode": "NRTRLabelEncode"}},
                {"RecResizeImg": {"image_shape": [3, 48, 320]}},
                {"KeepKeys": {"keep_keys": ["image", "label_ctc", "label_gtc", "length", "valid_ratio"]}},
            ]
        },
        "PostProcess": {"name": "CTCLabelDecode", "character_dict": characters},
    }


def find_wheel(wheel: str | None, workdir: Path) -> Path:
    if wheel:
        return Path(wheel)
    subprocess.check_call([sys.executable, "-m", "pip", "download", "rapidocr", "--no-deps", "-q", "-d", str(workdir)])
    wheels = sorted(workdir.glob("rapidocr-*.whl"))
    if not wheels:
        raise SystemExit("Không tải được wheel rapidocr từ PyPI.")
    return wheels[-1]


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", default="ocr_models", help="Thư mục đích (mặc định: ocr_models)")
    ap.add_argument("--wheel", help="Đường dẫn wheel rapidocr đã tải sẵn (bỏ qua bước pip download)")
    args = ap.parse_args()

    import onnxruntime as ort

    out = Path(args.out)
    with tempfile.TemporaryDirectory() as tmp:
        tmp_path = Path(tmp)
        wheel = find_wheel(args.wheel, tmp_path)
        with zipfile.ZipFile(wheel) as zf:
            names = {Path(n).name: n for n in zf.namelist() if n.endswith(".onnx")}
            wanted = {"PP-OCRv6_det_small.onnx": "PP-OCRv6_small_det", "PP-OCRv6_rec_small.onnx": "PP-OCRv6_small_rec"}
            for file_name, model_name in wanted.items():
                if file_name not in names:
                    raise SystemExit(f"Wheel {wheel.name} không chứa {file_name}.")
                target_dir = out / model_name
                target_dir.mkdir(parents=True, exist_ok=True)
                with zf.open(names[file_name]) as src, open(target_dir / "inference.onnx", "wb") as dst:
                    shutil.copyfileobj(src, dst)

    (out / "PP-OCRv6_small_det" / "inference.yml").write_text(yaml.safe_dump(DET_YML, allow_unicode=True, sort_keys=False), encoding="utf-8")
    session = ort.InferenceSession(str(out / "PP-OCRv6_small_rec" / "inference.onnx"), providers=["CPUExecutionProvider"])
    meta = session.get_modelmeta().custom_metadata_map
    if "character" not in meta:
        raise SystemExit("Mô hình nhận dạng không kèm bộ ký tự trong metadata.")
    characters = meta["character"].split("\n")
    (out / "PP-OCRv6_small_rec" / "inference.yml").write_text(
        yaml.safe_dump(rec_yml(characters), allow_unicode=True, sort_keys=False, width=1000), encoding="utf-8"
    )
    (out / "SOURCE.txt").write_text(
        f"Mô hình PP-OCRv6 small (ONNX) trích từ {wheel.name} (PyPI).\n"
        "inference.yml do scripts/build_ocr_models_from_rapidocr.py sinh ra.\n",
        encoding="utf-8",
    )
    print(f"Đã dựng mô hình tại {out.resolve()} ({len(characters)} ký tự).")


if __name__ == "__main__":
    main()
