# Dữ liệu kiểm thử

- `catalog_sample.xlsx` — **tập con** của `DAV_unique.xlsx` (giữ nguyên giá trị từng ô),
  sinh bằng `scripts/make_test_fixture.py`. Chỉ dùng cho kiểm thử tự động; ứng dụng
  không bao giờ nạp file này làm danh mục thuốc.
- `ocr/` — ảnh bao bì **tổng hợp** (vẽ bằng Pillow từ dữ liệu trong danh mục) để kiểm thử
  OCR: ảnh rõ, mờ, nghiêng, thiếu chữ, xoay ngược và hai sản phẩm cùng tên khác hàm lượng.
  Sinh bằng `scripts/make_ocr_testset.py`. Đây không phải ảnh chụp sản phẩm thật.
