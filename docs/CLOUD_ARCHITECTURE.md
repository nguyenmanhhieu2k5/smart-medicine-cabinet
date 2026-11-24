# Kiến trúc Cloud trên Mini PC — kế hoạch và hiện trạng

Tài liệu này ghi lại kết quả kiểm tra hệ thống (Giai đoạn 1), kiến trúc mục tiêu và kế hoạch
chuyển dữ liệu từ SQLite sang PostgreSQL. Cập nhật mỗi khi một giai đoạn hoàn thành.

## 1. Kết quả kiểm tra (18/11/2026)

| Hạng mục | Hiện trạng |
|---|---|
| Mini PC | HP Z2 Mini G4, Windows 10 Pro for Workstations 22H2, Xeon E-2144G, 32 GB RAM, Quadro P1000 4 GB. Máy này vừa là máy phát triển vừa là máy chủ. |
| PostgreSQL | **17.11 đã cài**, dịch vụ `postgresql-x64-17`, tự khởi động. **Đang nghe trên 0.0.0.0:5432** → phải giới hạn về `localhost` (mục 6). |
| Docker / WSL | Không có → PostgreSQL chạy dạng Windows Service (đã có), FastAPI chạy dạng service. |
| Tailscale / cloudflared | Chưa cài. Cần tài khoản Tailscale và Cloudflare (+ tên miền) của nhóm. |
| Android SDK / Java | Chưa có. Kiểm tra giao diện mobile tự động bằng bản web của Expo; chạy trên điện thoại thật bằng Expo Go hoặc bản APK. |
| Điện năng | Máy tự ngủ sau 30 phút khi cắm điện → phải tắt khi làm máy chủ. |
| Backend cũ | FastAPI + SQLite (FTS5 + trigram), chạy kèm ứng dụng Electron, chỉ nghe `127.0.0.1`, token chung giữa Electron và backend. Không có tài khoản/phân quyền. |
| ESP32 cũ | Firmware là **máy chủ HTTP trong LAN** (`GET /api/status`, `POST /api/command` → còi). Ứng dụng gọi vào ESP32 → chỉ chạy khi cùng mạng. |
| `mobile/` | Lúc kiểm tra: **14 ảnh PNG thiết kế, chưa có mã nguồn** (`01-auth`, `02-main-screens`, `03-overviews`). Nay có ứng dụng Expo bên cạnh, ảnh thiết kế giữ nguyên. |
| Dữ liệu cũ (SQLite) | `%APPDATA%\SmartMedicineCabinet\data\cabinet.db` (bản cài) và `data-dev\cabinet.db` (bản phát triển): 55.005 thuốc danh mục, vài thuốc trong tủ, cài đặt. |

## 2. Kiến trúc mục tiêu

```text
 Windows Admin (Electron)                 Mobile Scanner (Expo)            ESP32
        │ Tailscale (HTTPS, tailnet)               │ HTTPS                   │ WSS (TLS)
        ▼                                          ▼                         ▼
 tailscale serve ──► 127.0.0.1:8001   Tailscale Funnel :8443 ──► 127.0.0.1:8000
   (:443, chỉ tailnet)                 (hoặc Cloudflare Tunnel)
                     ADMIN API                                   PUBLIC API
                     (JWT aud=admin,                             /api/v1/auth, /scan, /catalog,
                      role ADMIN)                                /me, /device/ws (token thiết bị)
                         └──────────────── cùng một tiến trình ─────┘
                                 FastAPI · PaddleOCR (GPU) · IoT hub
                                              │
                                 PostgreSQL 17 (127.0.0.1:5432, chỉ cục bộ)
```

Nguyên tắc:

- **Hai cổng, hai bộ API tách biệt trong cùng một tiến trình** (để mô hình OCR chỉ nạp một lần lên GPU):
  - `PUBLIC` (8000): đăng nhập/đăng ký, quét OCR, tra cứu danh mục (chỉ đọc), lịch sử quét của chính
    người dùng, hồ sơ cá nhân, kết nối thiết bị ESP32. **Không có endpoint quản trị nào.**
  - `ADMIN` (8001): toàn bộ chức năng quản trị của ứng dụng Windows + quản lý tài khoản, thiết bị, lệnh,
    nhật ký kiểm toán, sao lưu.
- Cả hai cổng chỉ nghe `127.0.0.1`. Cổng 8001 chỉ ra tailnet qua `tailscale serve` (cổng 443, không Funnel).
  Cổng 8000 ra Internet qua **Tailscale Funnel** (cổng 8443, địa chỉ `.ts.net` cố định, không cần tên miền — đang dùng
  từ 20/11/2026) **hoặc** Cloudflare Tunnel (khi có tên miền riêng). Cổng Admin từ chối mọi yêu cầu mang header của
  Cloudflare (`cf-ray`, `cf-connecting-ip`) hoặc Funnel (`tailscale-funnel-request`) — phòng cấu hình nhầm cổng.
- Token Admin (`aud=admin`) chỉ được cấp qua cổng Admin; token cấp ở cổng Public (`aud=scanner`) không dùng được
  ở cổng Admin, kể cả khi tài khoản có vai trò ADMIN.
- Windows **không** kết nối PostgreSQL trực tiếp; không có mật khẩu CSDL trong Electron.
- `backend/` giữ vai trò thư mục `server/` trong cấu trúc mục tiêu (giữ tên để không phá các script/kiểm thử hiện có).

## 3. Cơ sở dữ liệu PostgreSQL

- CSDL `smart_medicine`, chủ sở hữu là vai trò `smc_app` (không superuser, không CREATEDB/CREATEROLE).
  Mật khẩu sinh ngẫu nhiên, lưu ở `C:\ProgramData\SmartMedicineCabinet\server.env` (phân quyền hạn chế).
- Lược đồ quản lý bằng **Alembic** (`backend/migrations`). Tiện ích mở rộng: `pg_trgm`, `unaccent` (đều là
  extension “trusted”, chủ CSDL tạo được).
- Bảng: `users, roles, permissions, role_permissions, user_sessions, password_resets, medicine_catalog,
  medicine_catalog_regs, medicine_catalog_barcodes, barcode_imports, ai_lookups, catalog_imports, cabinet_medicines, medicine_inventory_logs, ocr_jobs, ocr_results,
  ocr_candidates, scan_history, devices, device_telemetry, device_commands, device_command_ack, alerts,
  reminders, reminder_logs, settings, history_events, audit_logs`.
- UUID cho tài nguyên phân tán (người dùng, phiên, thiết bị, lệnh, lần quét); thời gian lưu `timestamptz`.
- Tìm kiếm 55.000 thuốc: `tsvector` có trọng số (tên A, hoạt chất B, hàm lượng C, dạng bào chế + số đăng ký D,
  cột sinh tự động + chỉ mục GIN), `pg_trgm` (GIN) cho chữ OCR sai, B-tree cho số đăng ký. Mỗi lượt OCR chỉ lấy
  tập ứng viên nhỏ bằng chỉ mục rồi mới xếp hạng bằng RapidFuzz — không tải toàn bộ danh mục về Python.

## 4. Kế hoạch chuyển dữ liệu SQLite → PostgreSQL

1. **Sao lưu trước**: chép nguyên file `cabinet.db` (+ `-wal`, `-shm`) sang `backups\pre-postgres-<thời gian>\`.
   Không sửa, không xóa file gốc.
2. Tạo lược đồ PostgreSQL bằng `alembic upgrade head`.
3. Nhập danh mục từ `DAV_unique.xlsx` (giữ nguyên `id` của Cục Quản lý Dược để các tham chiếu cũ còn đúng).
4. Chuyển dữ liệu người dùng: cài đặt, thuốc trong tủ, lời nhắc + nhật ký, cảnh báo, lịch sử, số đo cảm biến
   (gắn vào một thiết bị “ESP32 cũ (LAN)”), ảnh thuốc.
5. **Kiểm tra toàn vẹn**: so số bản ghi từng bảng, so tổng kiểm tra (id, tên, số lượng, hạn dùng) giữa hai CSDL;
   báo cáo khác biệt. Chạy lại được nhiều lần (idempotent) mà không tạo bản ghi trùng.
6. Chỉ khi bước 5 đạt mới chuyển backend sang PostgreSQL. File SQLite cũ được giữ lại làm bản lưu.

Công cụ: `python -m app.cli migrate-sqlite --source <cabinet.db>`.

## 5. Xác thực, phân quyền, lệnh thiết bị

- Mật khẩu băm Argon2id; access token JWT 15 phút; refresh token ngẫu nhiên (chỉ lưu băm SHA-256) 30 ngày,
  xoay vòng mỗi lần làm mới, thu hồi khi đăng xuất; khóa tạm khi đăng nhập sai nhiều lần; giới hạn tần suất.
- Vai trò `ADMIN`, `SCANNER`; quyền chi tiết (`scan:create`, `cabinet:write`, `device:command`, `users:manage`…)
  kiểm tra ở FastAPI bằng dependency. Tài khoản đăng ký mới luôn là `SCANNER`.
- ESP32 tự kết nối **ra ngoài** tới `wss://<tên-miền>/api/v1/device/ws` bằng token riêng của thiết bị.
  Lệnh có `command_id`, `action`, `payload`, hạn dùng và trạng thái
  `pending → sent → acknowledged → applied | failed | timed_out`. Chỉ báo thành công khi ESP32 gửi `applied`.
  Mất Internet: ESP32 vẫn tự cảnh báo bằng còi theo ngưỡng đã lưu trong bộ nhớ flash.

## 6. Việc cần chủ máy thực hiện (cần quyền quản trị hoặc tài khoản bên ngoài)

| Việc | Vì sao không tự làm được |
|---|---|
| Chạy `deploy\postgres\setup-postgres.ps1` (nhập mật khẩu `postgres`) | Cần mật khẩu superuser đã đặt lúc cài PostgreSQL và quyền Administrator để giới hạn `listen_addresses` |
| Tạo tài khoản Admin đầu tiên | Email/mật khẩu là thông tin của nhóm |
| Cài Tailscale, đăng nhập tailnet trên Mini PC và máy Admin | Cần tài khoản Tailscale |
| Kênh công khai: duyệt Tailscale Funnel một lần (hoặc Cloudflare Tunnel + tên miền) | Cần đăng nhập tài khoản Tailscale / Cloudflare của nhóm |
| Cài dịch vụ Windows cho server, tắt chế độ ngủ | Cần quyền Administrator |

## 7. Tiến độ

| Giai đoạn | Trạng thái |
|---|---|
| 1. Kiểm tra workspace, `mobile/`, backend, dữ liệu | Xong (18/11/2026) |
| 2. Phân tích thiết kế mobile → `mobile/DESIGN.md` | Xong |
| 3. PostgreSQL: lược đồ 25 bảng (Alembic), vai trò `smc_app` không superuser, chỉ nghe localhost | Xong — chủ máy đã chạy `setup-postgres.ps1` trên dịch vụ thật (19/11/2026) |
| 4. Chuyển SQLite → PostgreSQL có sao lưu trước + kiểm tra toàn vẹn | Xong — đã chuyển dữ liệu bản 1.0 vào CSDL thật (19/11/2026), đối chiếu khớp 5/5 bảng |
| 5. Danh mục 55.005 thuốc: FTS có trọng số + `pg_trgm` + `unaccent` + RapidFuzz, không tải toàn bộ về Python | Xong |
| 6. Xác thực JWT (aud theo kênh) + refresh xoay vòng + RBAC + giới hạn tần suất + nhật ký kiểm toán | Xong — kiểm thử leo thang quyền bằng HTTP thủ công |
| 7. API công khai (Scanner) và API quản trị tách cổng, tách router | Xong |
| 8. ESP32 qua Internet (WSS) + lệnh có ACK + firmware v2 | Máy chủ + trình mô phỏng: xong. **Firmware chưa biên dịch thử, chưa nạp mạch thật** |
| 9. Ứng dụng di động Expo (QUÉT — LỊCH SỬ — HỒ SƠ) theo thiết kế | Xong — kiểm tra bằng ảnh chụp thật ở 5 kích thước (bản web); **chưa chạy trên điện thoại/emulator** |
| 10. Ứng dụng Windows ADMIN kết nối máy chủ (Tailscale), trang Quản trị | Xong — smoke test Electron 11/11 |
| 11. Vận hành 24/7: dịch vụ Windows, chống ngủ, `pg_dump` hằng ngày, khôi phục, giám sát | Xong — dịch vụ `SmartMedicineServer` đã cài, chống ngủ đã bật; Tailscale (Unattended) phục vụ kênh quản trị; kênh công khai: Tailscale Funnel :8443 |
| 12. Tài liệu triển khai | Xong — `docs/DEPLOYMENT.md` |
| 15. Tài khoản tự đăng ký (SCANNER) xem tủ thuốc + sửa ngày hết hạn (migration 0004, quyền `cabinet:update_expiry`) — theo yêu cầu chủ dự án 25/11/2026, nới đúng một điểm của ràng buộc “mobile không sửa thuốc” | Xong — kiểm thử backend/mobile + chạy thử đầu cuối (đăng ký → Hồ sơ → Hạn dùng → sửa); **cần khởi động lại dịch vụ để áp migration 0004** |
| 14. AI tìm trên mạng (Gemini + Google Search, migration 0003) cho mã vạch/QR chưa có dữ liệu và kết quả quét “không có thuốc đúng”; bảng màu chung Windows + điện thoại | Xong — kiểm thử bằng Gemini giả lập + gọi Gemini thật (khóa hiện tại: tìm kiếm 429 hết hạn mức, các mô hình 503 quá tải → cần bật thanh toán); **cần khởi động lại dịch vụ để áp migration 0002–0003 và khóa trong server.env** |
| 13. Mã vạch (migration 0002): nhập file nhà thuốc → GTIN gắn với thuốc có sẵn trong danh mục; quét EAN-13/DataMatrix trên điện thoại | Xong — kiểm thử backend/Windows/mobile + chạy thử đầu cuối trên bản web; **cần chủ máy khởi động lại dịch vụ để áp migration 0002**; chưa có file mã vạch thật của nhà thuốc |
