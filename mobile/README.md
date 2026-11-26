# Tủ thuốc thông minh — ứng dụng điện thoại (SCANNER)

Android / iOS, Expo SDK 58 + Expo Router. Chỉ có quyền **SCANNER**: quét ảnh hộp/vỉ thuốc, xem tối đa 3 kết quả,
xem chi tiết thuốc (chỉ đọc, có nút loa **đọc thông tin bằng giọng tiếng Việt**), xem lại lịch sử quét của chính mình,
và **xem thuốc trong tủ + sửa NGÀY HẾT HẠN** (*Hồ sơ → Hạn dùng thuốc trong tủ*). **Không** thêm/xóa thuốc, không sửa tên,
số lượng hay thông tin khác, **không** điều khiển ESP32 — kể cả khi đăng nhập bằng tài khoản quản trị (máy chủ chỉ cấp quyền
SCANNER cho token của kênh công khai).

**Tài khoản**: đăng ký ngay trong ứng dụng (màn *Đăng ký*) → tài khoản lưu trên PostgreSQL của Mini PC (mật khẩu băm
Argon2, phiên làm mới xoay vòng, khóa tạm khi sai nhiều lần), **luôn là SCANNER**; không đăng nhập được ứng dụng Windows.
Quyền SCANNER: `catalog:read, scan:create, scan:read_own, profile:manage_own, cabinet:read, cabinet:update_expiry`
(`cabinet:update_expiry` chỉ cho `PATCH /api/v1/cabinet/medicines/<id>/expiry` với đúng một trường `expiry_date`; mọi lần sửa
ghi nhật ký kiểm toán + lịch sử hoạt động kèm email người sửa, cảnh báo hết hạn tính lại ngay).

```
Điện thoại ──HTTPS──► Tailscale Funnel :8443 (hoặc Cloudflare Tunnel) ──► 127.0.0.1:8000 /api/v1 (API công khai, Mini PC)
```

Điện thoại không cần chung mạng Wi-Fi với Mini PC và không cần cài Tailscale. Ứng dụng chỉ biết địa chỉ API công khai,
không biết địa chỉ quản trị.

## Chạy thử

```powershell
cd mobile
npm install
npx expo start          # quét mã QR bằng Expo Go (SDK 58) trên điện thoại — app tự kết nối máy chủ, không phải nhập gì
```

- **Địa chỉ máy chủ được gài sẵn** trong `app.json` → `expo.extra.apiUrl` (địa chỉ Tailscale Funnel cố định của Mini PC,
  do `deploy\tailscale\setup-funnel.ps1` in ra). Mọi bản chạy/build đều tự dùng địa chỉ này.
- Khi mở app, nếu địa chỉ đang dùng không trả lời (ví dụ địa chỉ tunnel thử cũ), app **tự chuyển** sang địa chỉ gài sẵn còn
  hoạt động. Sau khi đổi `app.json`/`SMC_API_URL`, chạy `npx expo start -c` (xóa bộ nhớ đệm, nhất là với bản web).
- Ghi đè khi cần (máy chủ thử, chuyển sang Cloudflare): `$env:SMC_API_URL = "https://..."` trước `npx expo start`/`eas build`,
  hoặc sửa `app.json`. Người dùng vẫn đổi được trong app: *Hồ sơ → Cài đặt ứng dụng → Máy chủ* (ở màn Đăng nhập chỉ hiện
  liên kết “Kiểm tra địa chỉ máy chủ” khi không kết nối được) — chỉ cần khi máy chủ đổi địa chỉ.
- Qua Internet bắt buộc `https://`. API trên Mini PC chỉ nghe 127.0.0.1 (cố ý), nên điện thoại luôn đi qua kênh công khai:
  Tailscale Funnel (`deploy/tailscale/setup-funnel.ps1`, không cần tên miền) hoặc Cloudflare Tunnel có tên miền
  (`deploy/cloudflare/setup-cloudflared.ps1`). `-QuickTest` của Cloudflare chỉ để thử (địa chỉ đổi mỗi lần chạy).
- `npx expo start` cần điện thoại chung Wi-Fi với máy đang chạy Expo (chỉ để tải mã ứng dụng khi thử); khác mạng thì dùng
  `npx expo start --tunnel`. Bản APK không cần điều này.
- Mở bằng trình duyệt (phím `w`) chỉ để xem giao diện: máy chủ phải cho phép `http://localhost:8081` trong
  `SMC_CORS_ORIGINS` (server.env); camera máy tính bị soi gương trên bản web.

## Quét mã vạch

Không cần chế độ riêng: trong màn *Quét*, đưa mã vạch trên hộp vào khung camera → app gọi `POST /api/v1/barcodes/lookup`
→ có trong dữ liệu thì mở *Chi tiết thuốc* (kèm dòng “Mã vạch …”, và **HSD + số lô** nếu là mã 2D GS1 DataMatrix — giọng
đọc đọc luôn hạn dùng của hộp) và ghi vào *Lịch sử*; chưa có thì hiện nhắc “chụp mặt hộp có tên thuốc” ngay trong khung.
Nhận EAN-13/8, UPC, ITF-14, DataMatrix, QR (GS1 Digital Link), Code 128. Camera báo cùng một mã liên tục → mỗi mã chỉ tra
lại sau 10 giây; QR quảng cáo và mã nội bộ của cửa hàng bị bỏ qua. Điện thoại **chỉ tra cứu** — dữ liệu mã vạch do quản trị
viên nhập trên ứng dụng Windows (`src/scan/barcode.ts`).

**Ảnh chọn từ thư viện cũng quét được mã**: máy chủ đọc mã vạch/QR trên ảnh cùng lúc với OCR (zxing-cpp). Màn *Kết quả* hiện
các mã đọc được; mã khớp dữ liệu thì thuốc đó đứng đầu; mã chưa có dữ liệu thì *“Không có thuốc đúng?”* tra **đúng mã đó**
trên mạng thay cho chữ trên hộp (`src/screens/ResultView.tsx`).

## Tìm trên mạng

Màn `app/(app)/ai-lookup.tsx`: mã vạch hợp lệ nhưng chưa có trong dữ liệu, hoặc mã QR không theo chuẩn GS1 → **tự mở**; ở
màn Kết quả, mục *“Không có thuốc đúng? Tìm tên thuốc trên hộp vừa chụp trên mạng”* (cả khi không nhận diện được) → máy chủ
tìm trên mạng (`POST /api/v1/ai/lookup`, `/api/v1/ai/scans/<id>`). Máy chủ mặc định dùng **Tavily, không AI**
(`SMC_LOOKUP_PROVIDER=tavily`); có thể bật Gemini — **điện thoại không giữ khóa nào**. Màn hiện: thời gian chờ, thông tin
nhận dạng, độ tin cậy, chế độ (*Tra trên mạng · không dùng AI* / *AI · đã tra trên mạng* / *AI · chỉ đọc ảnh/mã*), thuốc khớp
trong danh mục (mở Chi tiết thuốc), nguồn tham khảo, lưu ý an toàn. Không tự thêm gì vào tủ thuốc.

## Giọng đọc tiếng Việt

Màn *Chi tiết thuốc* → nút loa góc phải: đọc tên, hàm lượng, dạng bào chế, hoạt chất, đóng gói, số đăng ký, hiệu lực,
nơi sản xuất. Dùng bộ chuyển văn bản thành giọng nói **có sẵn của máy** (`expo-speech`) — chạy không cần mạng, không gửi
gì lên máy chủ. Chữ viết tắt được chuyển cho dễ nghe (`src/speech/medicineSpeech.ts`): “500mg” → “500 mi li gam”,
“100mg/5ml” → “100 mi li gam trong 5 mi li lít”, “Hộp 3 vỉ x 10 viên” → “Hộp 3 vỉ, mỗi vỉ 10 viên”, số đăng ký đọc từng
chữ số. Bấm lại để dừng; rời màn hình thì tự dừng.

Máy chưa có giọng tiếng Việt thì ứng dụng **không** đọc bằng giọng khác mà hiện hướng dẫn cài:
- Android: Cài đặt → Hệ thống/Hỗ trợ tiếp cận → Ngôn ngữ → Chuyển văn bản thành giọng nói → Google → Cài đặt dữ liệu
  giọng nói → Tiếng Việt (máy ảo Android Studio cũng cần bước này).
- iOS: Cài đặt → Trợ năng → Nội dung được đọc → Giọng nói → Tiếng Việt.
- Bản web trên Windows dùng giọng “Microsoft An” (có khi cài gói ngôn ngữ tiếng Việt).

## Tạo file cài đặt Android (APK)

### Build ngay trên máy Windows (Android Studio đã cài)

APK chứa 3 kiến trúc: `arm64-v8a` + `armeabi-v7a` (điện thoại thật) và `x86_64` (máy ảo Android Studio trên PC).

**Phải build ở thư mục có đường dẫn NGẮN** (ví dụ `C:\smcb\m`). Windows giới hạn đường dẫn 260 ký tự (`MAX_PATH`);
build ngay trong `C:\Users\…\Downloads\smart-medicine-cabinet-v1.0.0-source\…\mobile` sẽ hỏng ở bước C++
(`ninja: manifest 'build.ninja' still dirty after 100 tries` hoặc `ninja: error: mkdir(…)`).
Plugin `plugins/withShortNativeObjectPaths.js` (khai báo trong `app.json`) lo phần đường dẫn file object của CMake;
gốc thư mục ngắn lo phần còn lại.

```powershell
# 1) Chép dự án sang đường dẫn ngắn (bỏ qua file build cũ, ảnh thiết kế).
#    /XD phải dùng ĐƯỜNG DẪN ĐẦY ĐỦ: ghi trơn "android" sẽ loại cả node_modules\*\android → hỏng build.
robocopy . C:\smcb\m /E /MT:16 /NFL /NDL /XD "$PWD\android" "$PWD\.expo" "$PWD\dist-web" "$PWD\visual-check" "$PWD\01-auth" "$PWD\02-main-screens" "$PWD\03-overviews" .cxx
cd C:\smcb\m
npx expo prebuild -p android --no-install

# 2) Build (lần đầu tự tải NDK + CMake ~1 GB; JDK lấy từ Android Studio)
$env:JAVA_HOME = "C:\Program Files\Android\Android Studio\jbr"
$env:ANDROID_HOME = "$env:LOCALAPPDATA\Android\Sdk"
cd android
.\gradlew.bat assembleRelease "-PreactNativeArchitectures=arm64-v8a,armeabi-v7a,x86_64"
# → android\app\build\outputs\apk\release\app-release.apk

# 3) Cài lên máy ảo/điện thoại đang cắm
& "$env:LOCALAPPDATA\Android\Sdk\platform-tools\adb.exe" install -r app\build\outputs\apk\release\app-release.apk
```

APK này ký bằng khóa debug của mẫu Expo — đủ để cài thử/nội bộ, **không** dùng để đưa lên Google Play.

### Hoặc build trên dịch vụ EAS của Expo (cần tài khoản Expo miễn phí)

```
npm install -g eas-cli
eas login
# APK tự dùng địa chỉ máy chủ trong app.json (SMC_API_URL trong eas.json để trống = dùng mặc định đó)
eas build -p android --profile preview      # → liên kết tải file .apk
```

## Kiểm tra

```
npm run typecheck      # TypeScript
npx eslint app src     # ESLint (eslint-config-expo)
npm test               # Jest: API client (chặn endpoint quản trị, làm mới phiên, lỗi mạng), định dạng, màn Kết quả,
                       #       quét toàn bộ mã nguồn để chắc chắn không có lời gọi API quản trị
node visual-check/run.mjs   # ảnh chụp thật ở 5 kích thước màn hình — xem DESIGN.md
```

## Bảo mật

- Refresh token lưu trong Keystore (Android) / Keychain (iOS) bằng `expo-secure-store`, xoay vòng mỗi lần làm mới;
  dùng lại token cũ → máy chủ thu hồi mọi phiên của tài khoản. Access token (15 phút) chỉ nằm trong bộ nhớ.
- Mọi đường dẫn gọi máy chủ phải khớp danh sách endpoint Scanner (`src/api/client.ts → PUBLIC_PATH`).
- Ảnh gửi lên được thu nhỏ (cạnh dài ≤ 1600/2000 px) và nén JPEG; kết quả quét **không** tự thêm vào tủ thuốc.
