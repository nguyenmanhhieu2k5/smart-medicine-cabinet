# Tủ thuốc thông minh (Smart Medicine Cabinet) — phiên bản 2.0

Hệ thống nhiều nền tảng cho đề tài nghiên cứu khoa học ngành Kỹ thuật máy tính: quản lý tủ thuốc, **nhận diện thuốc
bằng OCR**, đối chiếu với danh mục ~55.000 thuốc (`DAV_unique.xlsx`), theo dõi **nhiệt độ / độ ẩm và điều khiển còi
ESP32 qua Internet**, cảnh báo hạn dùng, nhắc uống thuốc.

| Thành phần | Vai trò | Công nghệ |
|---|---|---|
| **Mini PC** (HP Z2 Mini G4) | Máy chủ tự vận hành 24/7: CSDL, API, OCR, kết nối thiết bị | FastAPI · PostgreSQL 17 · PaddleOCR 3.7 (GPU Quadro P1000) · Alembic · dịch vụ Windows |
| **Ứng dụng Windows** | Toàn quyền **ADMIN** qua Tailscale | Electron 45 · React 19 · TypeScript · Tailwind 4 |
| **Ứng dụng điện thoại** | Chỉ quyền **SCANNER** (quét, tra cứu, lịch sử của mình) qua HTTPS | Expo SDK 58 · Expo Router · React Native 0.88 |
| **ESP32** | DHT22 + còi; tự kết nối ra Internet (WSS), nhận lệnh có ACK | Arduino · WebSockets · ArduinoJson |

```
 Windows ADMIN ──Tailscale──► tailscale serve :443 ────► 127.0.0.1:8001  API quản trị  ┐
 Điện thoại    ──HTTPS──────► Tailscale Funnel :8443* ─► 127.0.0.1:8000  API công khai ├─ 1 tiến trình FastAPI + PaddleOCR (GPU)
 ESP32         ──WSS────────► Tailscale Funnel :8443* ─► 127.0.0.1:8000  /device/ws    ┘        │
                                                                              PostgreSQL 17 (chỉ 127.0.0.1:5432)
 * hoặc Cloudflare Tunnel khi có tên miền riêng — chỉ dùng một trong hai
```

Không thiết bị nào cần chung Wi-Fi với Mini PC; không mở cổng router; PostgreSQL và API quản trị không ra Internet công khai.

**Tài liệu:** [Triển khai từng bước](docs/DEPLOYMENT.md) · [Kiến trúc Cloud](docs/CLOUD_ARCHITECTURE.md) ·
[Giao thức ESP32](docs/ESP32_PROTOCOL.md) · [Ứng dụng điện thoại](mobile/README.md) · [Đối chiếu thiết kế mobile](mobile/DESIGN.md) ·
[Báo cáo kiểm thử](docs/TEST_REPORT.md)

---

## 1. Đã kiểm chứng gì, chưa kiểm chứng gì

### Đã chạy và kiểm thử thật (trên chính Mini PC, Windows 10, 19/11/2026)

| Hạng mục | Cách kiểm chứng |
|---|---|
| Máy chủ trên PostgreSQL (API, danh mục, OCR, tủ thuốc, lời nhắc, cảnh báo, tài khoản, thiết bị, sao lưu) | 216 kiểm thử `pytest` trên cụm PostgreSQL 17 tạm (1 bỏ qua có chủ đích) |
| Tách kênh + phân quyền: token Scanner không dùng ở cổng Admin, cổng Public không có API quản trị, Admin chặn header Cloudflare, Scanner không leo thang bằng HTTP thủ công | Kiểm thử tự động + `scripts/e2e_server.py` |
| Đầu-cuối bằng tiến trình thật: 2 cổng chỉ nghe 127.0.0.1, nhập 55.005 thuốc, ESP32 mô phỏng kết nối WSS, lệnh còi `received → applied`, quét ảnh thật bằng PaddleOCR GPU (~1 s), lịch sử, `pg_dump` | `scripts/e2e_server.py` — 13/13 |
| Ứng dụng Windows ADMIN thật (Electron) với máy chủ thật: đăng nhập, phiên mã hóa DPAPI, gửi lệnh ESP32 đến khi ACK `applied`, quét OCR camera → lưu tủ, mở lại tự khôi phục phiên, đăng xuất thu hồi phiên, máy chủ chạy độc lập | `npm run test:desktop` — 11/11 |
| Giao diện Windows | 41 kiểm thử `vitest`, TypeScript + ESLint sạch |
| Ứng dụng điện thoại | 100 kiểm thử Jest (chặn endpoint quản trị, làm mới phiên, lỗi mạng, màn Kết quả…), TypeScript + ESLint sạch; **ảnh chụp thật** 12 màn ở 393×852 + 6 màn × 4 kích thước khác, đăng ký và quét OCR thật — [mobile/DESIGN.md](mobile/DESIGN.md) |
| Chuyển dữ liệu SQLite cũ → PostgreSQL (sao lưu trước, đối chiếu từng bảng) | Kiểm thử + chạy thử với dữ liệu thật vào CSDL tạm |
| `deploy/postgres/setup-postgres.ps1` | Chạy 2 lần trên cụm tạm (`-SkipSystemChanges`): chạy lại an toàn, giữ mật khẩu, phân quyền file cấu hình đúng |

### CHƯA kiểm chứng — cần chủ máy thực hiện (quyền Administrator / tài khoản bên ngoài)

| Hạng mục | Ghi chú |
|---|---|
| Chạy `setup-postgres.ps1` trên dịch vụ PostgreSQL thật, cài dịch vụ `SmartMedicineServer`, chống ngủ | Cần mật khẩu `postgres` và quyền Administrator — [DEPLOYMENT.md](docs/DEPLOYMENT.md) bước 1, 4 |
| Tailscale + kênh công khai (Funnel hoặc Cloudflare Tunnel) | Cần tài khoản của nhóm — bước 5, 6 |
| Firmware ESP32 v2 | **Chưa biên dịch thử, chưa nạp lên mạch thật** (máy phát triển không được phép tải/chạy arduino-cli). Máy chủ + giao thức đã thử với trình mô phỏng. |
| Ứng dụng điện thoại trên Android/iOS thật | Máy không có Android SDK; giao diện đã kiểm tra bằng bản web (cùng mã React Native). Chạy bằng Expo Go hoặc build APK bằng EAS. |
| Gửi email đặt lại mật khẩu | Cần cấu hình SMTP (`SMC_SMTP_*`); khi chưa có, ứng dụng hướng dẫn liên hệ quản trị viên. |
| Độ chính xác OCR trên ảnh bao bì thật | Mới thử với ảnh tổng hợp; chưa có số liệu trên ảnh chụp thật. |

---

## 2. Chạy thử nhanh trên một máy (không cần dịch vụ thật)

```powershell
scripts\setup-windows.ps1                                   # môi trường Python + Node (lần đầu)
backend\.venv\Scripts\python scripts\dev_server.py          # PostgreSQL tạm + máy chủ + Admin mật khẩu ngẫu nhiên + ESP32 mô phỏng
npm run build:frontend
$env:SMC_SERVER_URL = "http://127.0.0.1:<cổng-admin>"; npx electron .   # đăng nhập bằng thông tin dev_server in ra
```

Triển khai thật trên Mini PC: **[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)**.

## 3. Bản cài đặt Windows (ADMIN)

```powershell
powershell -ExecutionPolicy Bypass -File scripts\build-windows.ps1     # → release\SmartMedicineCabinet-Admin-Setup-2.0.0.exe
```

Từ 2.0, bản cài Windows **chỉ gồm giao diện + Electron**, không kèm backend, PostgreSQL hay mô hình OCR (máy chủ chạy
trên Mini PC). `npm run check:resources` chặn việc vô tình đóng gói backend/CSDL hoặc chuỗi kết nối vào bản cài.

## 4. Nhận diện thuốc hoạt động thế nào

1. **Ảnh** từ camera (Windows hoặc điện thoại) hoặc thư viện ảnh → gửi lên máy chủ (điện thoại thu nhỏ ≤ 1600/2000 px).
2. **OCR** trên Mini PC: PaddleOCR PP-OCRv6 (GPU nếu có, tự lùi CPU); chỉ thử tiền xử lý khi kết quả kém. Hàng đợi có
   giới hạn; mỗi người dùng có giới hạn tần suất quét.
3. **Trích xuất**: số đăng ký, hàm lượng, dạng bào chế, tên, hoạt chất (sửa lỗi OCR thường gặp như `l00 mg`, `VN-2O169-16`).
4. **Truy xuất ứng viên trong PostgreSQL bằng chỉ mục** — số đăng ký (B-tree), full-text có trọng số (tên > hoạt chất >
   hàm lượng > dạng bào chế), `pg_trgm` cho chữ sai/thiếu, `unaccent` — chỉ lấy tập nhỏ, **không tải 55.000 bản ghi về Python**.
5. **Chấm điểm** bằng RapidFuzz: số đăng ký 35 %, tên 30 %, hàm lượng 20 %, hoạt chất 10 %, dạng bào chế 5 %; hàm lượng
   mâu thuẫn bị giới hạn điểm (*Augmentin 250 mg/31,25 mg*, *500 mg/125 mg*, *875 mg/125 mg* là ba sản phẩm khác nhau).
6. **Tối đa 3 ứng viên** với “Mức độ phù hợp” (Cao / Trung bình / Thấp).

**Tìm trên mạng khi dữ liệu nội bộ không có câu trả lời** — mã vạch/QR chưa có trong dữ liệu (tự động), hoặc người dùng
xác nhận *“không có thuốc đúng”* trong kết quả quét. Nguồn chọn bằng `SMC_LOOKUP_PROVIDER` trong `server.env`:

- `tavily` (**mặc định, đang dùng**) — tìm kiếm web Tavily + quy tắc, **không dùng AI**:
  - *Mã vạch*: chỉ tin trang có đúng dãy số mã vạch → số đăng ký ghi cạnh mã → thuốc trong danh mục 55.005 thuốc.
  - *Ảnh quét*: chỉ dùng chữ **có trong danh mục** để tìm (chữ OCR vô nghĩa như “CARTON RECYCLE” bị bỏ): tên thương mại
    (từ đầu tên thuốc trong danh mục, ưu tiên dòng ngắn, chữ to) + hàm lượng; chụp mặt sau không có tên thương mại → tìm theo
    **hoạt chất** (tối đa “trung bình”, ghi rõ có thể là thuốc khác cùng hoạt chất); không có chữ nào trong danh mục (thực
    phẩm chức năng, ảnh không phải thuốc) → báo ngay, không tốn lượt. Trang phải nhắc đúng tên → số đăng ký gần tên → danh
    mục; thuốc tìm được phải đúng tên thương mại trên hộp (trùng hoạt chất thôi là chưa đủ).
  - *Mã QR*: có số đăng ký → đọc thẳng (không cần mạng); là đường link → Tavily đọc trang đó; chữ khác → tìm như ảnh quét.
  - Thông tin hiển thị lấy từ **danh mục chính thức**, không lấy từ trang web; luôn kèm nguồn và độ tin cậy.
- `auto` — hỏi Gemini (`SMC_GEMINI_MODELS`, mặc định `gemini-3.5-flash`, có Google Search) trước, không được thì Tavily.
  Khóa Gemini **miễn phí** không dùng được Google Search (HTTP 429) và đọc ảnh mất 15–40 giây → cần bật thanh toán.
- `gemini` — chỉ Gemini.

Kết quả chỉ là thông tin **nhận dạng** (không liều dùng/chỉ định), đối chiếu lại với danh mục, lưu đệm (`ai_lookups`).
Mã vạch **bắt buộc tra mạng** — không tra được thì báo rõ, không đoán. Khóa API (`SMC_TAVILY_API_KEY`, `SMC_GEMINI_API_KEY`)
chỉ nằm trong `server.env` trên Mini PC, không có trong ứng dụng Windows/điện thoại, không ghi nhật ký.

**Bảng màu chung** (ứng dụng Windows và điện thoại): nền #F0F7FF→#E2EEFF, thanh bên/thẻ #FFFFFF, mục chọn/nút chính/liên
kết #0066FF, vùng camera #E6F2FF, nút phụ #F0F7FF, thẻ thông số #F0F6FF, cảnh báo #FFF3D6/#FFECB3, thành công #10B981,
số thông báo #EF4444 — `frontend/src/styles/index.css` và `mobile/src/theme.ts`.

**Mã vạch** (song song với OCR): đưa mã vạch trên hộp vào khung camera của điện thoại → máy chủ tra bảng
`medicine_catalog_barcodes` (GTIN → thuốc trong danh mục 55.005 thuốc) → mở thẳng *Chi tiết thuốc*. Mã 2D GS1 DataMatrix
còn cho **hạn dùng và số lô** của chính hộp đó. Danh mục DAV không có mã vạch, nên dữ liệu mã vạch được **nhập từ file
Excel/CSV của nhà thuốc** (*Cài đặt → Mã vạch thuốc* trên ứng dụng Windows): mỗi mã chỉ gắn vào thuốc **đã có** trong danh
mục, ghép theo số đăng ký (mới/cũ, mọi cách viết), chỉ ghép theo tên + hàm lượng khi ra đúng một thuốc, khác hãng sản
xuất thì không đoán; chạy thử trước, dòng không chắc chắn được liệt kê để xem lại. Mã chưa có → app nhắc chụp mặt hộp.
Thử trên 500 thuốc ngẫu nhiên của danh mục thật: 469 gắn đúng, 0 gắn sai, 31 báo lại (chủ yếu dòng chỉ có tên chung như
“Paracetamol 500mg” của hàng chục hãng). Nguồn đầy đủ hơn về sau: API *Hệ thống CSDL về Dược* của Bộ Y tế
(`GET /master/drugs` có `packagings[].gtin` + số đăng ký) — cần tài khoản do Trung tâm Thông tin Y tế Quốc gia cấp.

**Tài khoản** (lưu trên PostgreSQL của Mini PC): *ADMIN* — toàn quyền, chỉ qua ứng dụng Windows (Tailscale); *SCANNER* —
tài khoản tự đăng ký trên điện thoại: quét thuốc, tra cứu, xem lịch sử quét của mình, xem thuốc trong tủ và **chỉ sửa ngày
hết hạn** (không thêm/xóa/sửa thông tin khác, không điều khiển ESP32).

Nguyên tắc an toàn (có kiểm thử): không bao giờ tự lưu ứng viên; **quét trên điện thoại không thêm thuốc vào tủ**; khi
chưa chắc chắn phải tự chọn; hạn dùng thực tế do người dùng nhập; không sinh thông tin y khoa hay liều dùng; chưa có
ESP32 thì hiện “Chưa kết nối”, không có số đo giả; số đo từ trình mô phỏng luôn gắn nhãn **Mô phỏng**.

## 5. ESP32 qua Internet

Thêm thiết bị ở *Quản trị → Thiết bị* (token chỉ hiện một lần) → nạp vào `firmware/esp32_cabinet/config.h`. Lệnh
(còi, đọc ngay, ngưỡng, còi tự động, chu kỳ) có trạng thái `pending → sent → acknowledged → applied | failed | timed_out`;
**chỉ `applied` mới báo thành công**. Mất Internet: ESP32 vẫn tự kêu còi theo ngưỡng lưu trong NVS. Chi tiết:
[docs/ESP32_PROTOCOL.md](docs/ESP32_PROTOCOL.md).

## 6. Kiểm thử

```powershell
npm test                        # pytest (máy chủ, PostgreSQL tạm) + vitest (giao diện Windows)
npm run lint                    # ESLint + TypeScript (giao diện Windows)
npm run test:desktop            # Electron thật + máy chủ thật (cần npm run build:frontend)
npm run test:e2e                # scripts/e2e_server.py — tiến trình thật, OCR thật
cd mobile; npm test; npm run typecheck; npx eslint app src; node visual-check/run.mjs
```

## 7. Bảo mật

- Mật khẩu Argon2id; JWT 15 phút có `aud` theo kênh; refresh token ngẫu nhiên (chỉ lưu SHA-256), xoay vòng, dùng lại
  token cũ → thu hồi mọi phiên; khóa tạm khi sai mật khẩu nhiều lần; giới hạn tần suất; nhật ký kiểm toán.
- Quyền kiểm tra ở máy chủ bằng dependency theo từng router/endpoint; token kênh công khai chỉ mang quyền SCANNER kể cả
  với tài khoản ADMIN; giao diện chỉ ẩn nút cho dễ dùng.
- PostgreSQL: vai trò ứng dụng `smc_app` không phải superuser, chỉ nghe localhost; mật khẩu sinh ngẫu nhiên, lưu trong
  `C:\ProgramData\SmartMedicineCabinet\server\server.env` (giới hạn quyền đọc). Không có mật khẩu trong mã nguồn.
- Windows: refresh token mã hóa bằng DPAPI (`safeStorage`), không bao giờ vào renderer; renderer sandbox,
  `contextIsolation`, CSP; không có mật khẩu CSDL trong Electron.
- Điện thoại: refresh token trong Keystore/Keychain; mọi đường dẫn gọi máy chủ phải thuộc danh sách endpoint Scanner.

## 8. Cấu trúc thư mục

```
backend/app/        api/ (admin_*, public, ...) auth/ iot/ database/ models/ services/ core/ cli.py server.py
backend/migrations/ Alembic (25 bảng)
desktop/            Electron: main.cjs (kết nối máy chủ, đăng nhập Admin), preload.cjs
frontend/src/       giao diện Windows (pages/admin/: Thiết bị, Tài khoản, Lượt quét, Nhật ký, Máy chủ)
mobile/             ứng dụng Expo (app/, src/) + ảnh thiết kế gốc 01-auth/ 02-main-screens/ 03-overviews/
firmware/           esp32_cabinet/ (v2: WSS + ACK + NVS)
deploy/             postgres/ windows/ tailscale/ cloudflare/
scripts/            dev_server.py · e2e_server.py · esp32_simulator.py · build-windows.ps1 · download_ocr_models.py …
tests/              backend/ (pytest) · desktop/smoke.mjs · fixtures/
docs/               DEPLOYMENT.md · CLOUD_ARCHITECTURE.md · ESP32_PROTOCOL.md · TEST_REPORT.md · ARCHITECTURE.md (bản 1.0)
```

## 9. Sự cố thường gặp

| Hiện tượng | Cách xử lý |
|---|---|
| Ứng dụng Windows: “Không kết nối được máy chủ” | Bật Tailscale trên máy Windows; trên Mini PC chạy `deploy\windows\health-check.ps1`. |
| “Đây là API công khai…” khi nhập địa chỉ ở ứng dụng Windows | Đang nhập địa chỉ công khai (`:8443` hoặc Cloudflare); ứng dụng Windows cần `https://<mini-pc>.<tailnet>.ts.net` (không có `:8443`). |
| “Tài khoản này không có quyền quản trị” | Tài khoản SCANNER chỉ dùng ứng dụng điện thoại; đổi vai trò ở *Quản trị → Tài khoản*. |
| Điện thoại “Không thể kết nối đến máy chủ” | Mở `<địa-chỉ-công-khai>/api/v1/health` trên trình duyệt điện thoại; trên Mini PC chạy `tailscale funnel status` (hoặc kiểm tra dịch vụ `cloudflared`) và `deploy\windows\health-check.ps1`. |
| ESP32 “Ngoại tuyến” | Kiểm tra Wi-Fi nơi đặt tủ, `SERVER_HOST`, `DEVICE_TOKEN` (đổi token → phải nạp lại), đồng hồ NTP (TLS cần giờ đúng). |
| “OCR chưa sẵn sàng” | Thiếu mô hình trong `ocr_models\` của Mini PC: `scripts\download_ocr_models.py`. |

## 10. Lưu ý sử dụng

Đây là phần mềm phục vụ nghiên cứu, **không phải thiết bị y tế**. Thông tin thuốc lấy nguyên văn từ file danh mục;
kết quả OCR chỉ là gợi ý và luôn cần đối chiếu với bao bì thật. Hỏi dược sĩ hoặc bác sĩ trước khi dùng thuốc.
