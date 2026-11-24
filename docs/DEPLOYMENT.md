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

**AI tìm thông tin thuốc trên mạng (Gemini)** — thêm vào `server.env` rồi khởi động lại dịch vụ:
`SMC_GEMINI_API_KEY=<khóa từ Google AI Studio>` (tùy chọn `SMC_GEMINI_MODELS`, `SMC_GEMINI_TIMEOUT`). Kiểm tra ở ứng dụng
Windows → *Cài đặt → AI tra cứu thuốc (Gemini)*. Tìm kiếm trên mạng (Google Search grounding) cần khóa có hạn mức tìm kiếm —
khóa miễn phí thường báo 429 “hết hạn mức” và hay gặp 503 “quá tải” giờ cao điểm → **bật thanh toán (billing) cho khóa** trong
Google AI Studio. Khi chưa tra mạng được, ảnh quét/mã QR vẫn được AI đọc trực tiếp (ghi rõ “chỉ đọc ảnh”); mã vạch thì báo
không khả dụng (không đoán). Khóa không bao giờ nằm trong ứng dụng Windows/điện thoại.

**Tra mã vạch trên mạng KHÔNG dùng AI (Tavily)** — đăng ký miễn phí tại tavily.com (1.000 lượt/tháng, không cần thẻ),
thêm `SMC_TAVILY_API_KEY=tvly-…` vào `server.env` rồi khởi động lại dịch vụ. Mã vạch chưa có trong dữ liệu → nếu Gemini không
tra được mạng thì máy chủ tìm trang có ĐÚNG dãy số mã vạch, lấy số đăng ký ghi cạnh mã, đối chiếu danh mục DAV và hiển thị thông
tin của danh mục (ghi rõ “không dùng AI”, kèm nguồn). Mã QR có ghi số đăng ký được đọc thẳng (không cần mạng/AI). Mỗi mã chỉ
tra một lần (lưu đệm 30 ngày). Trạng thái: ứng dụng Windows → *Cài đặt → AI tra cứu thuốc*.

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
