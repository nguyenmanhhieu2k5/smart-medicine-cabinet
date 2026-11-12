# Báo cáo kiểm thử

Lần chạy: **11/11/2026**, môi trường phát triển Linux x64 (Python 3.13.18, Node 22.23, Electron 45.3,
PaddleOCR 3.7.0 / PaddleX 3.7.2 / ONNX Runtime 1.31.1). **Chưa có lần chạy nào trên Windows** — xem mục 6.

## 1. Tóm tắt

| Bộ kiểm thử | Lệnh | Kết quả |
|---|---|---|
| Backend (pytest) — môi trường sạch chỉ cài `backend/requirements-dev.txt` | `npm run test:backend` | **162 đạt**, 0 lỗi, 0 bỏ qua (≈ 50 giây) |
| Backend (pytest) — môi trường phát triển (có cài thêm PaddlePaddle) | như trên | 161 đạt, 1 bỏ qua có chủ đích¹ |
| Giao diện (vitest + Testing Library) | `npm run test:frontend` | **31 đạt** / 4 tệp |
| Kiểu dữ liệu + lint | `npm run lint` | TypeScript 0 lỗi, ESLint 0 cảnh báo |
| Desktop — chạy từ mã nguồn (Electron thật + backend thật) | `npm run test:desktop` | **9/9 bước đạt** |
| Desktop — bản đóng gói `release/linux-unpacked` | `npm run test:desktop:packed` | **9/9 bước đạt** |

¹ `test_missing_models_give_actionable_error` kiểm tra thông báo khi thiếu PaddlePaddle; trên máy đã cài
PaddlePaddle thì nhánh này không xảy ra nên được bỏ qua.

## 2. Đối chiếu 15 mục kiểm thử bắt buộc

| # | Yêu cầu | Tệp kiểm thử | Số ca |
|---|---|---|---|
| 1 | Import Excel → SQLite | `tests/backend/test_01_excel_import.py` (gồm nhập **toàn bộ 55.005 dòng** của file thật, nhập lại không trùng, chỉ cập nhật dòng thay đổi, từ chối file sai) | 9 |
| 2 | Chuẩn hoá tên thuốc | `test_02_normalize.py` | 31 |
| 3 | Tìm theo tên | `test_03_search.py` | 9 (chung 3–5) |
| 4 | Tìm theo hoạt chất | `test_03_search.py` | |
| 5 | Tìm theo số đăng ký | `test_03_search.py` | |
| 6 | Phân biệt thuốc cùng tên khác hàm lượng | `test_04_matcher.py`, `test_09_ocr_real.py` (3 ảnh Augmentin → 3 bản ghi khác nhau) | 23 (chung 6–9) |
| 7 | OCR thiếu / sai ký tự | `test_02_normalize.py`, `test_04_matcher.py`, `test_09_ocr_real.py` | |
| 8 | Xếp hạng tối đa 3 ứng viên | `test_04_matcher.py` | |
| 9 | Không tự động xác nhận thuốc sai | `test_04_matcher.py`; giao diện: `pages.test.tsx` ("buộc người dùng chọn ứng viên trước khi lưu", "chỉ lưu sau khi bấm xác nhận") | |
| 10 | Lưu thuốc vào tủ | `test_05_cabinet.py` | 16 (chung 10–11) |
| 11 | Tính ngày hết hạn thực tế (không dùng hạn số đăng ký) | `test_05_cabinet.py`, `test_10_expiry_ocr_text.py` | + 14 |
| 12 | Ngưỡng môi trường | `test_06_environment_esp32.py` | 20 (chung 12, 14) |
| 13 | Lưu lịch sử và cảnh báo | `test_07_alerts_history.py` | 12 |
| 14 | Mất kết nối ESP32 | `test_06_environment_esp32.py` (2 lần lỗi → mất kết nối, xoá số đo cũ, không số giả) | |
| 15 | Giao diện đồng nhất giữa các trang | `frontend/src/test/ui-consistency.test.tsx` (Sidebar/Topbar là **cùng phần tử DOM** qua 9 trang) + bước 5 của `tests/desktop/smoke.mjs` | 12 |

Ngoài 15 mục: `test_08_settings_backup_security.py` (10 ca — cài đặt, sao lưu/khôi phục, token API, kiểm tra
`Host`, ép địa chỉ loopback), `test_11_parent_watch.py` (4 ca — backend tự thoát khi ứng dụng desktop mất),
`backend-gate.test.tsx` (3 ca — màn hình khởi động/lỗi của bản desktop).

## 3. Bộ ảnh kiểm thử OCR (`tests/fixtures/ocr/`)

11 ảnh **tổng hợp** (vẽ bằng Pillow từ dữ liệu trong danh mục, rồi làm mờ/nghiêng/xoay/tối), chạy qua
**PaddleOCR thật** (PP-OCRv6 small, ONNX Runtime, CPU) rồi qua bộ so khớp:

| Ảnh | Loại | Điều được kiểm tra | Kết quả |
|---|---|---|---|
| `01_ro_net_augmentin_625` | rõ nét | đúng bản ghi 500 mg/125 mg, trạng thái `confident`, không tiền xử lý thừa | đạt |
| `02_…augmentin_250`, `03_…500_62`, `04_…1g` | cùng tên, khác hàm lượng | mỗi ảnh ra đúng bản ghi của hàm lượng đó; bản ghi hàm lượng khác thấp hơn ≥ 20 điểm | đạt |
| `05_mo_paracetamol_500` | mờ | ứng viên đầu là một thuốc paracetamol có hàm lượng 500 mg | đạt |
| `06_nghieng_hapacol_250` | nghiêng | ứng viên đầu là đúng bản ghi Hapacol 250 | đạt |
| `07_xoay_nguoc_efferalgan` | xoay 180° | bước xoay 180° được chọn; ứng viên đầu là Efferalgan | đạt |
| `08_toi_panadol_extra` | thiếu sáng | ứng viên đầu là Panadol Extra | đạt |
| `09_thieu_chu_chi_co_ten` | thiếu chữ (chỉ có tên) | trạng thái `uncertain` — **không** tự xác nhận | đạt |
| `10_co_han_dung` | có dòng HSD | đúng bản ghi thuốc; trích đúng ngày 12/02/2028 làm gợi ý hạn dùng (luôn cần người dùng xác nhận) | đạt |
| `11_khong_phai_thuoc` | không phải thuốc | không bao giờ `confident` | đạt |

**Giới hạn của bộ ảnh này:** là ảnh tổng hợp với phông chữ máy tính, nền phẳng. Kết quả trên **không phải** độ
chính xác trên ảnh chụp bao bì thật (bề mặt cong, phản sáng, phông chữ trang trí, chữ nhỏ). Dự án không tuyên bố
bất kỳ tỉ lệ chính xác OCR nào; cần thu thập ảnh thật để đánh giá trong phần thực nghiệm của đề tài.

## 4. Kiểm thử desktop (`tests/desktop/smoke.mjs`)

Chạy Electron thật (dưới màn hình ảo Xvfb) với backend Python thật:

| Bước | Nội dung | Mã nguồn | Bản đóng gói |
|---|---|---|---|
| 1 | Electron tự khởi động backend, giao diện vượt qua màn hình khởi động | đạt | đạt |
| 2 | Renderer không có `require`/`process`; `contextIsolation`, `sandbox` bật, `nodeIntegration` tắt | đạt | đạt |
| 3 | API chỉ nghe `127.0.0.1`; thiếu/sai token → 401; kết nối từ địa chỉ mạng khác bị từ chối | đạt | đạt |
| 4 | `cabinet.db` nằm trong thư mục dữ liệu người dùng, không có file CSDL trong mã nguồn/thư mục cài đặt | đạt | đạt |
| 5 | Sidebar/Topbar giữ nguyên qua 9 trang | đạt | đạt |
| 5b | Danh mục được nhập tự động vào SQLite | 799 thuốc (mẫu kiểm thử) | **55.005 thuốc** (file Excel thật trong `resources/data`) |
| 6 | Camera giả lập → chụp → PaddleOCR → ứng viên → xác nhận → lưu tủ thuốc với hạn dùng người dùng nhập | đạt (OCR + so khớp ≈ 2–3 giây) | đạt (≈ 3 giây) |
| 6b | Không có lỗi JavaScript | đạt | đạt |
| 7 | Thoát ứng dụng → backend dừng, cổng đóng | đạt | đạt |

Kiểm tra thủ công bổ sung (không nằm trong bộ tự động): backend không khởi động được → hiện màn hình lỗi kèm
đường dẫn nhật ký; tiến trình cha bị `kill -9` → backend tự thoát sau ~2 giây; đặt `SMC_HOST=0.0.0.0` → vẫn chỉ
nghe trên loopback; chế độ phát triển với Vite dev server.

## 5. Kiểm tra đóng gói

| Việc | Kết quả |
|---|---|
| PyInstaller đóng băng backend (`backend/smc_backend.spec`), không kèm PaddlePaddle | Tạo được trên Linux; chạy OCR thật từ bản đóng băng |
| `electron-builder --dir` với `extraResources` (backend, Excel, mô hình OCR, biểu tượng) | Tạo được `release/linux-unpacked`; `app.asar` chỉ chứa `desktop/`, `frontend/dist/`, `package.json` |
| `backend/requirements-dev.txt` trên Windows x64 | Giải phụ thuộc chỉ-wheel thành công cho Python 3.11 / 3.12 / 3.13 (90 gói) |
| `scripts/setup-windows.ps1`, `build-windows.ps1` | Phân tích cú pháp đạt; `setup-windows.ps1` chạy trọn vẹn trên PowerShell 7 (Linux) |
| `npm audit --omit=dev` | 0 lỗ hổng trong thư viện đi kèm ứng dụng |
| Giải nén gói mã nguồn vào thư mục trống → `setup-windows.ps1` → `npm test` → `npm run lint` → build → `npm run test:desktop` | Đạt toàn bộ (trên Linux, PowerShell 7) — gói mã nguồn tự đủ, không phụ thuộc máy phát triển |

## 6. Chưa kiểm thử

- Tạo và chạy file cài đặt NSIS trên Windows; chạy ứng dụng trên Windows 10/11.
- Webcam thật và ảnh chụp bao bì thuốc thật.
- ESP32 thật và firmware mẫu.
- Thông báo Windows, khay hệ thống, giọng đọc tiếng Việt của Windows.
- Đăng nhập Supabase với dự án Supabase thật.
- Tải gói mô hình OCR chính thức bằng `scripts/download_ocr_models.py` (máy chủ mô hình bị chặn ở môi trường phát triển).
- Engine PaddlePaddle gốc và GPU.

Khi build trên Windows, hãy chạy lại `npm test` và `npm run test:desktop:packed` rồi cập nhật báo cáo này.
