# Hướng dẫn triển khai — Mini PC làm máy chủ, Windows quản trị, điện thoại quét, ESP32 qua Internet

```
 Máy Windows quản trị (Electron) ──Tailscale (chỉ tailnet)──► tailscale serve :443 ──► 127.0.0.1:8001  API QUẢN TRỊ
 Điện thoại SCANNER (Expo)        ──HTTPS──► kênh công khai ─────────────────────────► 127.0.0.1:8000  API CÔNG KHAI
 ESP32 (DHT22 + còi)              ──WSS───► kênh công khai ─────────────────────────► 127.0.0.1:8000  /api/v1/device/ws
      kênh công khai = Tailscale Funnel :8443 (không cần tên miền)  HOẶC  Cloudflare Tunnel (có tên miền riêng)
                                                     Mini PC: FastAPI + PaddleOCR (GPU) + PostgreSQL 17 (127.0.0.1:5432)
```

Không thiết bị nào cần chung mạng Wi-Fi với Mini PC. Không mở cổng router. PostgreSQL và API quản trị không ra Internet.

> Các bước đánh dấu **[Admin]** cần mở PowerShell bằng *Run as administrator*. Mọi script đã có trong `deploy/`.
> Máy phát triển đã chạy thử các bước 1–3 trên cụm PostgreSQL tạm; bước 4–7 cần tài khoản/quyền của chủ máy nên
> **chưa được chạy thật** — làm theo đúng thứ tự dưới đây và xem kết quả của `health-check.ps1` ở bước 8.

## 0. Chuẩn bị (một lần)

| Cần có | Ghi chú |
|---|---|
| PostgreSQL 17 | Đã cài trên Mini PC (dịch vụ `postgresql-x64-17`). Cần mật khẩu tài khoản `postgres` đặt lúc cài. |
| Python 3.12 + `backend\.venv` | `python -m venv backend\.venv` rồi `backend\.venv\Scripts\python -m pip install -r backend\requirements.txt` |
| PaddlePaddle GPU (tùy chọn) | `pip install paddlepaddle-gpu==3.3.1 -i https://www.paddlepaddle.org.cn/packages/stable/cu118/` (đã kiểm chứng trên Quadro P1000) |
| Mô hình OCR | `backend\.venv\Scripts\python scripts\download_ocr_models.py --profile v6_medium --format paddle` |
| Giọng đọc tiếng Việt (tùy chọn) | `backend\.venv\Scripts\python scripts\download_tts_model.py` — Piper `vi_VN-vais1000-medium` (CC BY 4.0) vào `<SMC_DATA_DIR>\tts`; không có thì ứng dụng Windows đọc bằng giọng của Windows |
| `data\DAV_unique.xlsx` | Danh mục 55.005 thuốc — máy chủ tự nhập vào PostgreSQL lần chạy đầu |
| Tài khoản Tailscale | Miễn phí — cho kênh quản trị, và kênh công khai nếu dùng Funnel (bước 6A) |
| Tài khoản Cloudflare + tên miền | Chỉ khi chọn Cloudflare Tunnel cho kênh công khai (bước 6B) |

## 1. Cơ sở dữ liệu **[Admin]**

```
powershell -ExecutionPolicy Bypass -File deploy\postgres\setup-postgres.ps1
```

Script hỏi mật khẩu `postgres` (không lưu), rồi:
- giới hạn `listen_addresses = 'localhost'` và chỉ cho kết nối từ 127.0.0.1/::1 (khởi động lại dịch vụ PostgreSQL);
- tạo vai trò `smc_app` **không phải superuser** (mật khẩu ngẫu nhiên), CSDL `smart_medicine` thuộc `smc_app`;
- ghi `C:\ProgramData\SmartMedicineCabinet\server\server.env` (chỉ SYSTEM, Administrators và người chạy được đọc);
- chạy migration Alembic (25 bảng, `pg_trgm`, `unaccent`).

Chạy lại an toàn (giữ mật khẩu cũ; đổi mật khẩu: thêm `-RotatePassword`).
Có tên miền Cloudflare thì thêm `-PublicBaseUrl https://api.<tên-miền>` (để ứng dụng Windows hiện đúng địa chỉ WSS cho ESP32).

## 2. Tài khoản quản trị đầu tiên

```
cd backend
.venv\Scripts\python -m app.cli create-admin --email <email-quản-trị> --name "<Họ tên>"
```

Mật khẩu nhập trong cửa sổ dòng lệnh (không nằm trong mã nguồn, không ghi ra file). Mật khẩu ≥ 8 ký tự, có chữ và số.

## 3. Chuyển dữ liệu cũ từ SQLite (nếu đã dùng bản 1.0)

```
.venv\Scripts\python -m app.cli migrate-sqlite --source "%APPDATA%\SmartMedicineCabinet\data\cabinet.db" --dry-run
.venv\Scripts\python -m app.cli migrate-sqlite --source "%APPDATA%\SmartMedicineCabinet\data\cabinet.db"
```

- Trước khi chuyển, công cụ chép nguyên file SQLite (+ `-wal`, `-shm`) vào `backups\pre-postgres-<thời gian>\`; file gốc
  **không bị sửa hay xóa**.
- Sau khi chuyển, công cụ so số bản ghi + tổng kiểm tra từng bảng; khác biệt → báo lỗi và dừng.
- Chỉ chuyển **một** nguồn dữ liệu (bản cài `data\cabinet.db`). Không chuyển thêm `data-dev\cabinet.db`: hai file
  dùng chung dãy mã nên sẽ trùng (công cụ từ chối nếu không thêm `--allow-other-source`).

## 4. Chạy máy chủ 24/7 **[Admin]**

```
powershell -ExecutionPolicy Bypass -File deploy\windows\install-server-service.ps1
powershell -ExecutionPolicy Bypass -File deploy\windows\configure-server-power.ps1
```

- Dịch vụ `SmartMedicineServer` (WinSW 2.12.0, kiểm tra SHA-256): tự chạy khi bật máy, sau PostgreSQL; tự khởi động
  lại khi lỗi (10 s / 30 s / 60 s); nhật ký xoay vòng trong `C:\ProgramData\SmartMedicineCabinet\server\logs`.
- Không ngủ / không ngủ đông khi cắm điện. Nên bật BIOS *Advanced → Power-On Options → After Power Loss = Power On*.
- Sao lưu tự động `pg_dump` mỗi ngày 02:00, giữ 14 bản (`SMC_BACKUP_KEEP`), thư mục `C:\ProgramData\SmartMedicineCabinet\server\backups`
  (đặt `SMC_BACKUP_COPY_DIR` trong `server.env` để chép thêm sang ổ khác/USB).

## 5. Kênh quản trị qua Tailscale **[Admin]**

1. https://login.tailscale.com/admin → **DNS**: bật *MagicDNS* và *HTTPS Certificates*.
2. Trên Mini PC: `powershell -ExecutionPolicy Bypass -File deploy\tailscale\setup-tailscale.ps1` (đăng nhập tailnet,
   chế độ Unattended, `tailscale serve` → `https://<mini-pc>.<tailnet>.ts.net` trỏ vào 127.0.0.1:8001).
3. Cài Tailscale trên máy Windows quản trị, đăng nhập **cùng tailnet**.
4. Khuyến nghị giới hạn ACL: chỉ máy quản trị được vào Mini PC (mẫu trong `deploy\tailscale\README.md`).

## 6. Kênh công khai cho điện thoại + ESP32 — chọn MỘT trong hai

### 6A. Tailscale Funnel — không cần tên miền (đang dùng)

```
powershell -ExecutionPolicy Bypass -File deploy\tailscale\setup-funnel.ps1
```

- Địa chỉ cố định `https://<mini-pc>.<tailnet>.ts.net:8443`, chứng chỉ Let's Encrypt, tự chạy cùng dịch vụ Tailscale
  khi bật máy (Tailscale ở chế độ Unattended — bước 5).
- Funnel **chỉ** mở cổng 8443 → `127.0.0.1:8000`. Cổng 443 (API quản trị) vẫn chỉ trong tailnet; script kiểm tra lại và
  tự tắt Funnel nếu thấy API quản trị bị đưa ra ngoài. Máy chủ cũng từ chối mọi yêu cầu mang header Funnel ở cổng quản trị.
- Lần đầu, script in liên kết `https://login.tailscale.com/f/funnel?node=…`: đăng nhập Tailscale, bấm **Enable**, script tự chạy tiếp.
- Script ghi `SMC_PUBLIC_BASE_URL` vào `server.env`; chạy bằng PowerShell Administrator thì tự khởi động lại dịch vụ.
- Tắt: `-Disable`. **Không** dùng `tailscale funnel reset` (lệnh đó xóa cả kênh quản trị).

### 6B. Cloudflare Tunnel — khi có tên miền riêng **[Admin]**

1. Cloudflare → Zero Trust → Networks → Tunnels → *Create tunnel (Cloudflared)* → copy **token**.
2. *Public Hostname*: `api.<tên-miền>` → Service **HTTP** → `127.0.0.1:8000` (**không bao giờ** trỏ vào 8001).
3. Trên Mini PC:
   ```
   powershell -ExecutionPolicy Bypass -File deploy\cloudflare\setup-cloudflared.ps1 -TunnelToken <TOKEN> -PublicUrl https://api.<tên-miền>
   ```
   Thử nhanh không cần tài khoản: `-QuickTest` (địa chỉ `*.trycloudflare.com`, đổi mỗi lần chạy).
4. Ghi `SMC_PUBLIC_BASE_URL=https://api.<tên-miền>` vào `server.env` (bước 1 với `-PublicBaseUrl` đã làm) rồi khởi động
   lại dịch vụ: `Restart-Service SmartMedicineServer`. Nếu trước đó dùng Funnel: tắt bằng `setup-funnel.ps1 -Disable`.

### 6C. Trang web quét thuốc với tên miền `.id.vn` **[Admin]**

Trang web là **bản web của ứng dụng điện thoại**, do chính Mini PC phục vụ ở cổng Public (cùng địa chỉ với `/api/v1`,
không cần máy chủ khác). Khách chưa đăng nhập **quét thử 5 lần** (ảnh hoặc mã vạch/QR — máy chủ đếm, không phải trình
duyệt); từ lần thứ 6 phải đăng nhập/đăng ký; đăng nhập rồi dùng **như ứng dụng điện thoại** (quét không giới hạn, lịch sử,
hồ sơ, tủ thuốc và sửa hạn dùng). Phiên đăng nhập nằm trong cookie HttpOnly (JavaScript không đọc được).

1. Build trang web (đã có sẵn trong `mobile\dist-web`; build lại sau mỗi lần sửa ứng dụng):
   ```
   npm --prefix mobile run export:web
   ```
2. Bật trang web (PowerShell **Administrator**) — ghi `SMC_WEB_DIR`, `SMC_GUEST_SCANS=5` vào `server.env`, khởi động lại dịch vụ:
   ```
   powershell -ExecutionPolicy Bypass -File deploy\web\enable-web.ps1
   ```
   Dùng thử ngay qua địa chỉ Funnel hiện tại: `https://<mini-pc>.<tailnet>.ts.net:8443/`.
3. Đăng ký tên miền `.id.vn` (ví dụ `tuthuoc.id.vn`) ở một nhà đăng ký tên miền .vn được VNNIC công nhận
   (`id.vn` là tên miền cấp 2 dành cho cá nhân, có trong Public Suffix List nên dùng được với Cloudflare).
4. Cloudflare (gói Free): *Add a site* → nhập `tuthuoc.id.vn` → Cloudflare cho 2 nameserver → vào trang quản lý tên miền
   của nhà đăng ký, **đổi nameserver** sang 2 địa chỉ đó (chờ vài phút đến vài giờ đến khi Cloudflare báo *Active*).
5. Cloudflare → Zero Trust → Networks → Tunnels → *Create tunnel (Cloudflared)* → copy **token** →
   *Public Hostname*: hostname `tuthuoc.id.vn` (để trống subdomain) → Service **HTTP** → `127.0.0.1:8000`
   (**không bao giờ** trỏ vào 8001). Trên Mini PC:
   ```
   powershell -ExecutionPolicy Bypass -File deploy\cloudflare\setup-cloudflared.ps1 -TunnelToken <TOKEN>
   ```
6. Mở `https://tuthuoc.id.vn` trên điện thoại/máy tính: camera chỉ chạy qua HTTPS (Cloudflare cấp sẵn chứng chỉ).

Giới hạn chống lạm dụng (đổi trong `server.env`, khởi động lại dịch vụ): `SMC_GUEST_SCANS` (mặc định 5; `0` = phải
đăng nhập ngay), `SMC_GUEST_IP_DAILY` (30 lượt khách/IP/ngày — người xóa dữ liệu trình duyệt để lấy lượt mới vẫn bị chặn),
`SMC_GUEST_DAILY_TOTAL` (500 lượt khách/ngày cho toàn bộ trang — bảo vệ GPU và hạn mức Tavily). Ứng dụng điện thoại
(APK) không đổi: vẫn đăng nhập ngay từ đầu.

Trong các bước dưới, `<địa-chỉ-công-khai>` là `https://<mini-pc>.<tailnet>.ts.net:8443` (6A) hoặc `https://api.<tên-miền>` (6B).

## 7. Các ứng dụng và thiết bị

**Ứng dụng Windows (ADMIN)** — `release\SmartMedicineCabinet-Admin-Setup-2.0.0.exe` (tạo bằng `scripts\build-windows.ps1`).
Như ứng dụng điện thoại, địa chỉ máy chủ được **gài sẵn** trong `desktop/servers.json` (thứ tự ưu tiên:
`https://desktop-rt32kff.tail43c7d5.ts.net` qua Tailscale, rồi `http://127.0.0.1:8001` khi chạy ngay trên Mini PC): khi mở,
ứng dụng thử song song và tự chọn địa chỉ đầu tiên trả lời đúng là API quản trị → vào thẳng màn đăng nhập (tài khoản ở bước 2),
không phải nhập địa chỉ. Máy Windows khác chỉ cần cài Tailscale, đăng nhập cùng tài khoản với Mini PC. Không kết nối được thì
ứng dụng nhắc bật Tailscale, có *Thử lại* và *Đổi máy chủ* (nhập tay). Đổi Mini PC/tailnet: sửa `desktop/servers.json` rồi build
lại (hoặc đặt `SMC_SERVER_URL`). Phiên đăng nhập được mã hóa bằng DPAPI của Windows; ứng dụng không chứa mật khẩu CSDL.

**Điện thoại (SCANNER)** — xem `mobile/README.md`: chạy bằng Expo Go hoặc build APK bằng `eas build -p android --profile preview`.
Địa chỉ công khai được **gài sẵn** trong `mobile/app.json` → `expo.extra.apiUrl` (người dùng không phải nhập; đổi máy chủ thì
sửa giá trị này rồi build lại). Người dùng tự đăng ký (luôn là SCANNER) hoặc quản trị viên tạo tài khoản ở *Quản trị → Tài khoản*.

**Tìm thông tin thuốc trên mạng — Tavily, KHÔNG dùng AI (mặc định)** — đăng ký miễn phí tại tavily.com (1.000 lượt/tháng,
không cần thẻ), thêm vào `server.env` rồi khởi động lại dịch vụ:

```
SMC_TAVILY_API_KEY=tvly-…
SMC_LOOKUP_PROVIDER=tavily        # tavily (mặc định) | auto (Gemini trước rồi Tavily) | gemini
```

Mã vạch chưa có trong dữ liệu → tìm trang có ĐÚNG dãy số mã vạch, lấy số đăng ký ghi cạnh mã. Ảnh quét “không có thuốc
đúng” → chỉ dùng chữ có trong danh mục: tên thương mại trên hộp (không có thì hoạt chất), lấy số đăng ký gần tên trên trang
(thuốc phải đúng tên thương mại trên hộp); ảnh không có chữ nào trong danh mục thì báo ngay, không tốn lượt. Mã QR là
đường link → Tavily đọc trang đó; QR có số đăng ký → đọc thẳng, không cần mạng. Luôn đối chiếu danh mục DAV và hiển thị thông
tin của danh mục (ghi rõ “không dùng AI”, kèm nguồn). Mỗi lần tra tốn 1 lượt Tavily; mỗi mã/lượt quét chỉ tra một lần (lưu đệm
30 ngày). Trạng thái: ứng dụng Windows → *Cài đặt → Tra cứu thuốc trên mạng*.

**Gemini (tùy chọn, đang tắt)** — `SMC_GEMINI_API_KEY=<khóa Google AI Studio>`, `SMC_GEMINI_MODELS=gemini-3.5-flash`, rồi
`SMC_LOOKUP_PROVIDER=auto`. Đã thử ngày 25/11/2026 với khóa **miễn phí**: Google Search trả 429 “hết hạn mức” ngay lập tức, hỏi
thường mất ~16 giây, đọc ảnh mất ~38 giây (vượt thời gian chờ 24 giây của ứng dụng) → chỉ nên bật lại khi đã **bật thanh toán
(billing) cho khóa**. Khóa không bao giờ nằm trong ứng dụng Windows/điện thoại.

**Dữ liệu mã vạch** — danh mục DAV không có mã vạch. Xin file **danh mục hàng hóa** xuất từ phần mềm quản lý của nhà thuốc
(Excel/CSV có cột *Mã vạch* và *Số đăng ký*, có thì thêm *Tên thuốc*, *Hàm lượng*, *Hãng sản xuất*) → ứng dụng Windows →
*Cài đặt → Mã vạch thuốc → Chọn file…*: máy chủ **chỉ kiểm tra** và hiện báo cáo (khớp bao nhiêu dòng, dòng nào cần xem lại,
mã lỗi/nội bộ, xung đột) → bấm *Nhập N mã vạch*. Không tạo thuốc mới, không ghi đè mã đã gắn; gỡ mã gắn sai ở ô *Tra một
mã vạch*. Cột mã vạch trong Excel nên để dạng **Text** (dạng số làm Excel đổi thành `8.93E+12`, mất chữ số).
Nguồn đầy đủ: API *Hệ thống CSDL về Dược* (`https://api.csdlduoc.com.vn/v2`, QĐ 522 + 232/QĐ-TTYQG) — tài khoản do Trung tâm
Thông tin Y tế Quốc gia cấp cho cơ sở dược/đơn vị phần mềm dược (sandbox: 1900 8255 nhánh 2, ttyqg@moh.gov.vn).

**ESP32** — ứng dụng Windows → *Quản trị → Thiết bị → Thêm thiết bị* → chép **token** (chỉ hiện một lần) →
`firmware/esp32_cabinet/config.example.h` → `config.h`: Wi-Fi nơi đặt tủ, `SERVER_HOST` + `SERVER_PORT` theo địa chỉ công khai
(Funnel: tên máy `.ts.net` và cổng `8443`; Cloudflare: `api.<tên-miền>` và `443`), `DEVICE_TOKEN`.
Nạp bằng Arduino IDE (thư viện: *WebSockets* của Markus Sattler, *ArduinoJson* 7, *DHT sensor library*).
Firmware **chưa được biên dịch thử và chưa nạp lên mạch thật** trong quá trình phát triển — kiểm tra kỹ lần nạp đầu;
có thể thử trước bằng trình mô phỏng: `backend\.venv\Scripts\python scripts\esp32_simulator.py --url wss://<địa-chỉ-công-khai-không-có-https://>/api/v1/device/ws --token smcdev_...`.

## 8. Kiểm tra sau triển khai

```
powershell -ExecutionPolicy Bypass -File deploy\windows\health-check.ps1 -PublicUrl <địa-chỉ-công-khai>
```

Kiểm tra: dịch vụ PostgreSQL, máy chủ, Tailscale đang chạy; có kênh công khai (Funnel hoặc cloudflared) và Funnel chỉ trỏ
vào API công khai; PostgreSQL chỉ nghe localhost; hai API trả lời; địa chỉ công khai trả lời; API quản trị không lộ qua
địa chỉ công khai; chế độ ngủ đã tắt. Trên chính Mini PC, tên `.ts.net` đi qua tailnet — muốn thử đúng đường Internet,
mở `<địa-chỉ-công-khai>/api/v1/health` trên điện thoại đã tắt Wi-Fi. Ứng dụng Windows → *Quản trị → Máy chủ*
hiển thị cùng thông tin (CSDL, OCR GPU, CPU/RAM/ổ đĩa, dịch vụ, bản sao lưu gần nhất).

## 9. Sao lưu và khôi phục

- Tạo/tải/xóa bản sao lưu: ứng dụng Windows → *Cài đặt → Sao lưu cơ sở dữ liệu*, hoặc `python -m app.cli backup create`.
- **Khôi phục chỉ làm trực tiếp trên Mini PC** (ghi đè toàn bộ dữ liệu):
  ```
  Stop-Service SmartMedicineServer
  cd backend
  .venv\Scripts\python -m app.cli backup verify <tên-file>.dump
  .venv\Scripts\python -m app.cli backup restore <tên-file>.dump
  Start-Service SmartMedicineServer
  ```
  Kiểm thử tự động (`tests/backend/test_08_settings_backup_security.py`) tạo bản `pg_dump`, sửa dữ liệu, khôi phục bằng
  `pg_restore` và kiểm tra dữ liệu trở lại đúng trạng thái lúc sao lưu.

## 10. Thử toàn bộ hệ thống trên một máy (không cần dịch vụ thật)

```
backend\.venv\Scripts\python scripts\e2e_server.py      # 13 bước: 2 cổng, phân kênh, danh mục, ESP32 mô phỏng + ACK, OCR thật, pg_dump
backend\.venv\Scripts\python scripts\dev_server.py      # máy chủ tạm + Admin mật khẩu ngẫu nhiên + ESP32 mô phỏng để mở ứng dụng Windows
npm run test:desktop                                    # Electron thật đăng nhập Admin, lệnh ESP32, OCR, phiên mã hóa (11 bước)
```
