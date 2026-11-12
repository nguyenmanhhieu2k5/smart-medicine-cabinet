"""Tạo file Excel mẫu cho kiểm thử từ file danh mục thật.

    python scripts/make_test_fixture.py data/DAV_unique.xlsx tests/fixtures/catalog_sample.xlsx

File kết quả là TẬP CON của dữ liệu thật (giữ nguyên giá trị từng ô), chỉ dùng
cho kiểm thử tự động. Ứng dụng không bao giờ dùng file này làm danh mục.
"""
from __future__ import annotations

import sys

import pandas as pd

NAME_PATTERNS = [
    r"^augmentin", r"^paracetamol( \d|$)", r"^hapacol \d", r"^efferalgan", r"^panadol", r"^amoxicilin 500$",
    r"^klamentin", r"^vitamin c 500", r"^fogicap", r"^cetirizin", r"^omeprazol( \d|$)", r"^ibuprofen( \d|$)",
    r"^hezepril", r"^taromentin", r"^viartril", r"^humira", r"^atilair", r"^cao khô ngải cứu",
]


def main(src: str, dst: str) -> None:
    df = pd.read_excel(src, dtype=object, engine="openpyxl")
    names = df["tenThuoc"].astype(str).str.strip().str.lower()
    mask = pd.Series(False, index=df.index)
    for pattern in NAME_PATTERNS:
        mask |= names.str.contains(pattern, regex=True, na=False)
    picked = df[mask]
    # Thêm một mẫu ngẫu nhiên cố định để có dữ liệu "nhiễu" đa dạng (thiếu hàm lượng, giá trị "--"…).
    rest = df[~mask]
    extra = pd.concat([
        rest.sample(260, random_state=7),
        rest[rest["hamLuong"].astype(str).str.strip() == "--"].head(5),
        rest[rest["soDangKy"].astype(str).str.contains(r"\(", regex=True, na=False)].head(3),
    ])
    out = pd.concat([picked, extra]).drop_duplicates(subset="id").sort_values("id")
    out.to_excel(dst, index=False, engine="openpyxl")
    print(f"{len(out)} dòng → {dst}")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit(__doc__)
    main(sys.argv[1], sys.argv[2])
