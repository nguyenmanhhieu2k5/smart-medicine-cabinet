# Ứng dụng di động SCANNER — đối chiếu thiết kế

Ảnh thiết kế gốc nằm trong `01-auth/`, `02-main-screens/`, `03-overviews/` và **không bị sửa hay xóa**.
Mã nguồn: Expo SDK 58 + Expo Router (`app/` = màn hình, `src/` = API, thành phần giao diện).

## 1. Hệ thiết kế (lấy từ ảnh mẫu) — `src/theme.ts`

| Token | Giá trị | Dùng cho |
|---|---|---|
| Nền | `#F8F8F7` | mọi màn hình |
| Bề mặt | `#FFFFFF` | thẻ, ô nhập, thanh tab |
| Chính | `#0878F9` | nút chính, liên kết, mục tab đang chọn, viền thẻ được chọn |
| Navy | `#111B39` | tiêu đề, chữ chính |
| Chữ phụ | `#667085` | mô tả, nhãn |
| Viền | `#E8ECF2` | ô nhập, đường kẻ |
| Thành công | `#16A36A` | “Hoàn thành”, “Phù hợp nhất”, “Đã tra cứu” |
| Cảnh báo | `#E89324` | “Nhiều kết quả”, “Mức độ phù hợp: Trung bình” |
| Nguy hiểm | `#E5484D` | lỗi, “Đăng xuất”, huy hiệu lỗi |
| Phông | Inter 400/500/600/700/800 (`@expo-google-fonts/inter`, đóng gói sẵn — không cần mạng) | |

Bo góc: thẻ 20, ô nhập 16, nút 18. Lề hai bên: 24 dp (≥ 400 dp), 22 dp (375–399 dp), 18 dp (< 375 dp).
Biểu tượng: `lucide-react-native` (nét mảnh giống thiết kế và giống ứng dụng Windows).

## 2. Màn hình ↔ thiết kế

| Thiết kế | Màn hình | Tệp |
|---|---|---|
| 01 Đăng nhập | Đăng nhập email + mật khẩu, quên mật khẩu, đăng ký, hộp “Tài khoản Scanner” | `app/(auth)/login.tsx` |
| 02 Đăng ký | Họ tên, email, mật khẩu; tài khoản mới luôn là SCANNER (máy chủ quyết định) | `app/(auth)/register.tsx` |
| 03 Quên mật khẩu | Gửi mã khôi phục qua email (cần SMTP trên máy chủ; chưa bật thì hướng dẫn liên hệ quản trị) | `app/(auth)/forgot-password.tsx` |
| 04 Xác minh | 6 ô mã + mật khẩu mới, đếm ngược “Gửi lại” | `app/(auth)/reset-password.tsx` |
| 05 Quét thuốc | Camera trực tiếp trong khung bo góc 4 góc, nút chụp tròn xanh ở giữa, Chọn ảnh trái, Đèn flash phải, quyền camera. Bổ sung: tự nhận mã vạch trong khung (dải thông báo tối mờ ở đáy khung khi đang tra / mã chưa có trong dữ liệu); lời nhắc dưới khung thêm “hoặc mã vạch” | `app/(app)/(tabs)/scan/index.tsx`, `src/scan/barcode.ts` |
| 06 Đang xử lý | Vòng tiến độ, % thật từ máy chủ, 4 bước (máy chủ trả), giới hạn 30 giây, Hủy xử lý | `app/(app)/(tabs)/scan/processing/[jobId].tsx` |
| 07 Kết quả | Tối đa 3 ứng viên, mức độ phù hợp, chọn một, Quét lại / Xem chi tiết | `src/screens/ResultView.tsx` |
| 08 Chi tiết thuốc | Chỉ đọc, dữ liệu DAV_unique trong PostgreSQL. Bổ sung: nút loa ở góc phải tiêu đề (chỗ trống đối xứng nút Quay lại) đọc thông tin bằng giọng tiếng Việt; đang đọc → nút xanh đặc, biểu tượng dừng | `app/(app)/medicine/[id].tsx`, `src/speech/*` |
| 09 Lịch sử quét | Tìm kiếm, lọc trạng thái, nhóm Hôm nay / Hôm qua / Trước đó, mở lại kết quả | `app/(app)/(tabs)/history/*.tsx` |
| Tổng quan 14 | Khởi động, Hồ sơ, Không nhận diện được, Không thể kết nối | `src/screens/SplashView.tsx`, `profile/index.tsx`, `src/components/states.tsx` |
| Tổng quan 13 (11, 12) | Thông tin tài khoản, Cài đặt ứng dụng | `profile/account.tsx`, `profile/settings.tsx` |

Thanh tab dưới: **QUÉT — LỊCH SỬ — HỒ SƠ** (`src/components/TabBar.tsx`); màn Đang xử lý ẩn thanh tab như thiết kế 06.

## 3. Khác thiết kế có chủ ý (vì “mọi chức năng phải triển khai thật”)

| Thiết kế | Ứng dụng | Lý do |
|---|---|---|
| Nút Google / Apple / “Đăng nhập bằng số điện thoại” | Không hiển thị | Máy chủ chưa hỗ trợ (`/api/v1/app/config → providers` đều `false`). Không đặt nút giả. |
| Chuông thông báo ở đầu màn Quét/Lịch sử | Không hiển thị | Tài khoản Scanner không có thông báo; nút sẽ không làm gì. |
| “Thông báo” trong Hồ sơ | “Cài đặt ứng dụng” (Rung khi quét, Chất lượng ảnh, Máy chủ, Xóa bộ nhớ đệm) | Đều là chức năng thật, lưu theo tài khoản trên máy chủ. |
| “Gửi liên kết khôi phục” | “Gửi mã khôi phục” (mã 6 số, 15 phút) | Máy chủ gửi mã, không gửi liên kết. Màn nhập mã dùng bố cục thiết kế 04. |
| Ảnh sản phẩm trong thẻ kết quả | Ảnh người dùng vừa chụp | Danh mục DAV_unique không có ảnh sản phẩm; không dùng ảnh minh họa giả. |
| Thẻ kết quả: nhãn mức độ cùng dòng tên thuốc | Nhãn ở dòng dưới tên; giá trị một dòng (…) | Tên/hoạt chất thật dài hơn nhiều so với “Paracetamol”. Nút Quét lại / Xem chi tiết ghim cuối màn để luôn thấy. |
| Chi tiết: mọi dòng nhãn — giá trị cùng hàng | Giá trị dài hiển thị dưới nhãn | Hàm lượng thật ghi đủ thành phần (ví dụ “Amoxicillin (dưới dạng Amoxicillin trihydrate) 500mg; …”). |
| — | Màn “Máy chủ” (Hồ sơ → Cài đặt ứng dụng; ở Đăng nhập chỉ hiện liên kết khi lỗi kết nối) | Địa chỉ máy chủ gài sẵn trong `app.json` nên màn Đăng nhập giữ đúng thiết kế 01; màn này chỉ dùng khi máy chủ đổi địa chỉ. |

## 4. Kiểm tra giao diện bằng ảnh chụp thật

```
cd mobile
SMC_API_URL=http://127.0.0.1:18000 npx expo export --platform web --output-dir dist-web
node visual-check/run.mjs                 # máy chủ thật dùng một lần + Chrome giả lập điện thoại + camera giả
..\backend\.venv\Scripts\python visual-check\compare.py   # ghép THIẾT KẾ | ỨNG DỤNG
```

- `visual-check/run.mjs` dựng máy chủ thật (`scripts/dev_server.py`: PostgreSQL tạm, danh mục mẫu), **đăng ký tài khoản thật**,
  **quét OCR thật** bằng camera giả phát ảnh hộp Augmentin, mở kết quả, chi tiết, lịch sử, hồ sơ; chụp ở
  360×800, 375×812, 390×844, 393×852, 412×915 dp (DPR 2) vào `visual-check/output/<rộng>x<cao>/`.
- Chỉ can thiệp mạng ở 3 chỗ để chụp đúng trạng thái trung gian: giữ màn Đang xử lý ở 62%, bật cờ quên mật khẩu
  (máy chủ thử không có SMTP), cắt mạng để chụp “Không thể kết nối”.
- `visual-check/compare.py` ghép ảnh thiết kế và ảnh chụp: `visual-check/output/compare/*.png`.
- Bản web chỉ dùng để chụp kiểm tra (cùng mã React Native). Trên web, expo-camera **soi gương** mọi camera báo là
  camera trước (webcam/camera giả) nên chữ trong khung xem trước bị ngược; ảnh gửi đi vẫn đúng chiều. Trên điện thoại,
  camera sau không bị soi gương.
- **Chưa chạy trên Android emulator/điện thoại thật** trong quá trình phát triển (máy không có Android SDK). Xem
  `README.md` để chạy bằng Expo Go hoặc tạo APK.

Các lỗi đã tìm thấy nhờ ảnh chụp và đã sửa: camera web soi gương (đặt `mirror={false}`), thẻ kết quả quá cao đẩy nút
khỏi màn hình, nhãn mức độ bị cắt, chip hàm lượng tràn khỏi thẻ, số lượt quét ở Hồ sơ không cập nhật, chuyển từ
“Đang xử lý” sang “Kết quả” tạo thêm một bộ tab (đã chuyển màn Đang xử lý vào ngăn xếp Quét).
