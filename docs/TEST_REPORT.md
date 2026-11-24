# Báo cáo kiểm thử — phiên bản 2.0

Lần chạy: **19/11/2026** trên chính Mini PC (HP Z2 Mini G4, Windows 10 Pro for Workstations 22H2, Xeon E-2144G,
32 GB RAM, Quadro P1000). Python 3.12.0, PostgreSQL 17 (cụm tạm cho kiểm thử), Node 26.13, Electron 45.3,
Expo SDK 58 / React Native 0.88, PaddleOCR 3.7.0 + PaddlePaddle GPU 3.3.1 (CUDA 11.8).

## 1. Tóm tắt

| Bộ kiểm thử | Lệnh | Kết quả |
|---|---|---|
| Máy chủ (pytest, PostgreSQL thật — cụm tạm, mỗi ca một CSDL sao từ template) | `npm run test:backend` | **216 đạt**, 1 bỏ qua có chủ đích¹ (≈ 3 phút) |
| Đầu-cuối bằng tiến trình thật | `npm run test:e2e` (`scripts/e2e_server.py`) | **13/13** |
| Giao diện Windows (vitest + Testing Library) | `npm run test:frontend` | **41 đạt** / 5 tệp |
| Kiểu dữ liệu + lint (Windows) | `npm run lint` | TypeScript 0 lỗi, ESLint 0 cảnh báo |
| Ứng dụng Windows thật (Electron + máy chủ thật + PostgreSQL tạm) | `npm run test:desktop` | **11/11** |
| Ứng dụng điện thoại (Jest) | `cd mobile && npm test` | **100 đạt** / 5 tệp |
| Kiểu dữ liệu + lint (điện thoại) | `npm run typecheck`, `npx eslint app src` | 0 lỗi |
| Giao diện điện thoại bằng ảnh chụp thật (5 kích thước) | `node mobile/visual-check/run.mjs` | 36 ảnh, đối chiếu với thiết kế — [mobile/DESIGN.md](../mobile/DESIGN.md) |

¹ `test_missing_models_give_actionable_error` kiểm tra thông báo khi thiếu PaddlePaddle; máy này đã cài nên bỏ qua.

## 2. Máy chủ (pytest) theo tệp

| Tệp | Nội dung | Số ca |
|---|---|---|
| `test_01_excel_import.py` | Nhập `DAV_unique.xlsx` vào PostgreSQL (**toàn bộ 55.005 dòng**), nhập lại không trùng, chỉ cập nhật dòng đổi | 9 |
| `test_02_normalize.py` | Chuẩn hóa tên, sửa lỗi OCR | 31 |
| `test_03_search.py` | Tìm theo tên, hoạt chất, số đăng ký (FTS + `pg_trgm` + `unaccent`) | 9 |
| `test_04_matcher.py` | So khớp, phân biệt cùng tên khác hàm lượng | 23 |
| `test_05_cabinet.py` | Tủ thuốc, nhật ký tồn kho | 16 |
| `test_06_iot_devices.py` | Thiết bị, token, WSS, lệnh `pending → sent → acknowledged → applied/failed/timed_out`, gửi lại khi kết nối lại, phản hồi muộn | 20 |
| `test_07_alerts_history.py` | Cảnh báo, lịch sử | 12 |
| `test_08_settings_backup_security.py` | Cài đặt, `pg_dump` → `pg_restore` khôi phục đúng dữ liệu, bảo mật cổng | 15 |
| `test_09_ocr_real.py` | PaddleOCR thật trên 11 ảnh tổng hợp | 14 |
| `test_10_expiry_ocr_text.py` | Gợi ý hạn dùng từ chữ OCR | 14 |
| `test_12_ocr_device.py` | Chọn GPU/CPU, tự lùi CPU | 14 |
| `test_13_auth_rbac.py` | Đăng nhập, khóa tạm, refresh xoay vòng + phát hiện dùng lại, phân quyền, **Scanner không leo thang bằng HTTP thủ công**, tài khoản Admin trên mobile chỉ có quyền SCANNER | 27 |
| `test_14_public_scan.py` | Quét qua API công khai: tối đa 3 ứng viên, không ghi vào tủ, lịch sử riêng từng tài khoản, lọc trạng thái, giới hạn hàng đợi | 8 |
| `test_15_sqlite_migration.py` | Chuyển SQLite → PostgreSQL: sao lưu trước, đối chiếu, chạy lại không trùng, từ chối nguồn thứ hai | 5 |

## 3. Đầu-cuối (`scripts/e2e_server.py`, tiến trình thật)

1. Hai cổng (Public 8000 + Admin 8001) chạy, migration tự chạy; **cả hai chỉ nghe 127.0.0.1**.
2. Tạo Admin bằng CLI (mật khẩu qua biến môi trường, không ghi ra file).
3. Admin đăng nhập kênh Admin. 4. Scanner đăng ký qua kênh Public (vai trò SCANNER).
5. Tách kênh: `[401, 403, 401, 404, 403]` — token Scanner bị từ chối ở Admin, Scanner không đăng nhập được kênh Admin,
   token Admin không dùng được ở Public, Public không có `/api/cabinet`, cổng Admin chặn header Cloudflare.
6. Danh mục 55.005 thuốc tự nhập vào PostgreSQL lần chạy đầu.
7. ESP32 mô phỏng kết nối WSS ra ngoài, số đo gắn nhãn mô phỏng.
8. Lệnh còi qua Internet: ACK `received → applied`, trạng thái `applied`.
9. Scanner quét ảnh thật → PaddleOCR trên GPU (Quadro P1000) ~1 s → Augmentin 625 mg, ≤ 3 ứng viên.
10. Lịch sử quét lưu trong PostgreSQL. 11. `pg_dump` qua API Admin (~9,8 MB). 12. Dừng bằng tín hiệu → đóng cả hai cổng.

## 4. Ứng dụng Windows thật (`tests/desktop/smoke.mjs`)

1. Màn hình đăng nhập (máy chủ đặt sẵn) → mật khẩu sai bị từ chối → đăng nhập Admin.
2. Renderer bị cô lập (không `require`/`process`), cầu nối `window.smc` **không lộ refresh token**.
3. Phiên lưu mã hóa bằng `safeStorage` (DPAPI) — file không chứa mật khẩu, access token hay chuỗi kết nối CSDL.
4. API quản trị bắt buộc Bearer token; từ các card mạng ngoài không kết nối được cổng Admin.
5. Sidebar/Topbar giữ nguyên qua 10 trang (gồm trang Quản trị).
6. *Quản trị → Thiết bị*: gửi lệnh còi tới ESP32 mô phỏng, chỉ hiện “Đã thực hiện” sau ACK `applied`.
7. Camera giả lập → OCR trên máy chủ → xác nhận → lưu vào tủ (trước khi xác nhận tủ vẫn trống).
8. Mở lại ứng dụng: tự khôi phục phiên (refresh token đã xoay vòng).
9. Đăng xuất → phiên bị thu hồi trên máy chủ (access token cũ bị từ chối), mở lại phải đăng nhập.
10. Đóng ứng dụng Windows: máy chủ vẫn chạy độc lập.

## 5. Ứng dụng điện thoại

- `src/api/client.test.ts`: danh sách endpoint Scanner cho phép/chặn (`/admin/*`, `/devices`, `/cabinet/*`, `/settings`,
  `/backup`, đường dẫn `..`…), mọi URL nằm dưới `/api/v1`, đăng nhập lưu refresh token vào kho an toàn, 401 → làm mới đúng
  một lần + lưu token xoay vòng, làm mới bị từ chối → xóa phiên, mất mạng → giữ phiên để thử lại, đăng xuất thu hồi phiên.
- `src/test/no-admin-endpoints.test.ts`: quét **toàn bộ mã nguồn mobile** — không có URL `/api/...` ngoài `/api/v1`,
  không có endpoint quản trị.
- `src/screens/ResultView.test.tsx`: tối đa 3 kết quả, “Xem chi tiết” chỉ ghi lịch sử rồi mở chi tiết (không thêm vào tủ),
  trạng thái chưa chắc chắn, “Không nhận diện được”.
- Ảnh chụp thật (`visual-check/run.mjs`): đăng ký tài khoản thật, quét OCR thật bằng camera giả, 12 màn ở 393×852 và
  6 màn ở 360×800 / 375×812 / 390×844 / 412×915. Lỗi tìm thấy nhờ ảnh chụp và đã sửa: xem `mobile/DESIGN.md` mục 4.

## 6. Chưa kiểm chứng

| Hạng mục | Lý do |
|---|---|
| Script cài dịch vụ Windows, Tailscale, Cloudflare trên hệ thống thật | Cần quyền Administrator và tài khoản của nhóm (`docs/DEPLOYMENT.md`) |
| Firmware ESP32 v2 trên mạch thật | Chưa biên dịch thử, chưa nạp (không được phép tải/chạy arduino-cli trong phiên phát triển) |
| Ứng dụng điện thoại trên Android/iOS thật | Không có Android SDK trên máy; dùng Expo Go hoặc EAS build |
| Gửi email đặt lại mật khẩu | Chưa có SMTP |
| Độ chính xác OCR trên ảnh bao bì thật | Mới có ảnh tổng hợp |
