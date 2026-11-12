# Kiến trúc — Tủ thuốc thông minh

Tài liệu này mô tả hệ thống **như đã được lập trình** (không phải kế hoạch). Mỗi mục ghi tệp nguồn tương ứng.

## 1. Tổng quan ba tầng

```
Electron (desktop/)            cửa sổ, vòng đời backend, thông báo, khay hệ thống
   │  preload: window.smc      cầu nối IPC cố định, renderer không có quyền Node
   ▼
React + TypeScript (frontend/) 11 trang trong một AppShell (Sidebar + Topbar dùng chung)
   │  HTTP 127.0.0.1:<cổng> + X-SMC-Token
   ▼
FastAPI (backend/app/)         REST API · SQLite · OCR · so khớp · ESP32 · cảnh báo · lời nhắc
```

Ba tầng tách rời: giao diện chỉ biết REST API; backend chạy độc lập được (`python -m app.run`) để kiểm thử;
Electron chỉ lo vòng đời tiến trình và các chức năng của hệ điều hành.

## 2. Electron (`desktop/`)

| Tệp | Nhiệm vụ |
|---|---|
| `main.cjs` | Chọn cổng trống trên `127.0.0.1`, sinh token ngẫu nhiên 48 ký tự hex, chạy backend (bản đóng gói: `resources/backend/smc-backend.exe`; phát triển: `backend/.venv` → `python -m app.run`), chờ `/api/health` tối đa 90 giây, ghi `logs/backend.log`, dừng backend khi thoát (`taskkill /T /F` trên Windows). |
| `preload.cjs` | `contextBridge.exposeInMainWorld("smc", …)` với đúng 8 hàm — `getBackend`, `pickExcelFile`, `notify`, `onNavigate`, `openDataFolder`, `openLogFolder`, `setTrayEnabled`, `relaunch` — và ba giá trị `isDesktop`, `appVersion`, `platform`. |

Biện pháp an toàn trong `main.cjs`:

- `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, `webSecurity: true`.
- `setWindowOpenHandler` từ chối mọi cửa sổ mới; `will-navigate` chặn điều hướng ra khỏi trang của ứng dụng.
- Chỉ cấp quyền `media` (camera) và `notifications`, và chỉ cho trang của ứng dụng.
- Mỗi kênh IPC kiểm tra URL của khung gửi (`guard`) trước khi xử lý.
- Một phiên bản duy nhất (`requestSingleInstanceLock`).
- Backend nhận `SMC_PARENT_PID`; nếu Electron bị tắt đột ngột, backend tự thoát sau ≤ 2 giây
  (`backend/app/core/parent_watch.py`).

Khi backend chưa sẵn sàng, giao diện hiện màn hình "Đang khởi động dịch vụ nền…"; nếu backend lỗi, hiện rõ lỗi,
đường dẫn nhật ký và nút khởi động lại (`frontend/src/components/BackendGate.tsx`) — không giả vờ là đã chạy.

## 3. Giao diện (`frontend/src/`)

| Thư mục | Nội dung |
|---|---|
| `layouts/AppShell.tsx` | Khung duy nhất: `Sidebar` + `Topbar` + vùng nội dung. Các trang là route con nên Sidebar/Topbar **không bị dựng lại** khi chuyển trang (có kiểm thử so sánh nút DOM). |
| `components/` | Hệ thống thiết kế dùng chung: `Card`, `PrimaryButton`, `IconButton`, `StatusIndicator`, `Modal`, `ConfirmDialog`, `DataTable`, `EmptyState`, `LoadingState`, `ErrorState`, `Toast`, `PageHeader`, các ô nhập trong `Form.tsx`. |
| `pages/` | `HomePage`, `ScanPage`, `ScanResultPage`, `CabinetPage`, `MedicineDetailPage`, `ExpiryPage`, `RemindersPage`, `AlertsPage`, `HistoryPage`, `ProfilePage`, `SettingsPage`. |
| `services/api.ts` | Lớp gọi REST duy nhất (gắn token, đổi lỗi thành thông báo tiếng Việt). |
| `services/queries.ts` | Hook React Query cho từng tài nguyên (tự làm mới: thiết bị 5 giây, cảnh báo, lịch nhắc…). |
| `hooks/useCamera.ts` | Liệt kê/chọn camera, chụp 4 khung và giữ khung nét nhất; gửi nguyên khung hình (không cắt). |
| `hooks/useAppEffects.ts` | Giao diện sáng/tối, ngôn ngữ, bơm thông báo (hỏi backend 30 giây/lần → toast + thông báo Windows). |
| `styles/index.css` | Token thiết kế (Tailwind v4 `@theme`): nền `#F7F7F5`, bề mặt `#FFFFFF`, chính `#0878F9`, navy `#111B39`, chữ phụ `#687287`, viền `#E8EBF0`, thành công `#10A477`, cảnh báo `#F59E0B`, nguy hiểm `#E5484D`; bo góc thẻ 28 px; biến thể `short` cho màn hình thấp (1366×768). |
| `i18n/` | `t("câu tiếng Việt")`; tiếng Anh tra từ điển `en.ts`, thiếu thì giữ tiếng Việt. |

## 4. Backend (`backend/app/`)

```
api/        một router cho mỗi nhóm endpoint (xem README mục 5 và /docs của FastAPI khi chạy dev)
core/       config (đường dẫn, biến môi trường) · security (TokenMiddleware) · clock · context · parent_watch
database/   session.py — SQLite WAL, tạo bảng + bảng ảo FTS5
models/     SQLAlchemy 2: catalog, cabinet, reminder, alert, history, misc (settings, sensor_readings)
schemas/    Pydantic: settings, cabinet, reminder
services/   excel_import · medicine_matcher · ocr · alerts · reminders · esp32 · cabinet · history ·
            settings_store · backup · auth
main.py     create_app(): middleware, lifespan (kiểm tra CSDL, tự nhập Excel lần đầu, theo dõi ESP32,
            đánh giá cảnh báo thuốc mỗi 15 phút)
run.py      điểm vào: uvicorn trên 127.0.0.1
```

### 4.1 Cơ sở dữ liệu SQLite (`cabinet.db` trong thư mục dữ liệu người dùng)

| Bảng | Ý nghĩa |
|---|---|
| `catalog_medicines` | **Danh mục tra cứu** từ Excel: giữ nguyên 29 cột gốc + cột suy ra (`name_norm`, `name_core`, `ingredient_norm`, `strength_norm`, `form_norm`, `shelf_life_months`, `row_hash`, `in_source`). |
| `catalog_regs` | Số đăng ký đã chuẩn hoá (hiện tại / cũ) → thuốc. |
| `catalog_fts`, `catalog_trgm` | Bảng ảo FTS5 trên văn bản đã chuẩn hoá (bỏ dấu): tìm theo từ (`unicode61`) và trigram cho chữ sai/thiếu. |
| `catalog_imports` | Nhật ký mỗi lần nhập (số dòng mới/cập nhật/không đổi/bỏ qua). |
| `cabinet_items` | **Thuốc trong tủ** — tách hẳn khỏi danh mục: số lượng, vị trí, `expiry_date` + `expiry_source` (`manual` \| `ocr_confirmed`), ngưỡng sắp hết, ảnh. |
| `reminders`, `reminder_logs` | Lời nhắc do người dùng đặt; nhật ký đã uống / bỏ qua / đã thông báo. |
| `alerts` | Cảnh báo môi trường / thuốc / hệ thống, 4 mức, có khoá chống trùng. |
| `history_events` | Lịch sử thao tác (quét, thêm/sửa/xoá, nhập dữ liệu, cảnh báo…). |
| `sensor_readings` | Số đo ESP32 hợp lệ (≤ 1 bản ghi/phút, giữ 30 ngày). |
| `settings` | Cài đặt dạng khoá–giá trị. |

### 4.2 Nhập Excel (`services/excel_import/`)

`openpyxl` đọc luồng → `pandas` làm sạch theo lô → chuẩn hoá → *upsert* theo `id` bằng `row_hash`
(nhập lại không tạo trùng; dòng không đổi được bỏ qua) → dựng lại FTS và bảng số đăng ký. Chạy ở luồng nền,
báo tiến độ qua `/api/catalog/status`. Sau khi nhập, mọi lần quét/tìm kiếm chỉ truy vấn SQLite.

### 4.3 OCR (`services/ocr/`)

- `engine.py` — bao bọc **PaddleOCR 3.7** theo đúng API của bản đã cài: `PaddleOCR(...).predict(ndarray)` trả
  `rec_texts`, `rec_scores`, `rec_polys`; `engine="onnxruntime"` chạy gói mô hình ONNX mà không cần PaddlePaddle.
  Mô hình được tìm ở `ocr_models/` đi kèm → bộ nhớ đệm trong thư mục dữ liệu → (cuối cùng) tải lần đầu.
- `preprocess.py` — OpenCV: giải mã, giới hạn kích thước, đo độ nét/độ sáng, tăng tương phản (CLAHE), khử nhiễu,
  xoay, ước lượng và nắn góc nghiêng.
- `service.py` — hàng đợi một luồng. `recognize_best` chạy ảnh gốc trước; chỉ khi kết quả kém mới thử biến thể
  và **chỉ thay thế khi điểm chất lượng tăng ≥ 8 %** — tiền xử lý không được làm xấu kết quả.
- `expiry.py` — gợi ý hạn dùng chỉ khi ngày đứng cạnh từ khoá HSD/EXP; luôn gắn `needs_confirmation`.

### 4.4 So khớp thuốc (`services/medicine_matcher/`)

- `normalize.py` — bỏ dấu, gộp biến thể (`PARACETAMOL 500 MG`, `Paracetamol-500mg`, `paracetamol 500mg` → cùng
  dạng), phân tích hàm lượng thành (giá trị, đơn vị) có quy đổi g/mg/mcg, số đăng ký, dạng bào chế, lõi tên thuốc.
- `catalog.py` — truy xuất ứng viên: số đăng ký (chính xác rồi gần đúng), FTS5, trigram.
- `matcher.py` — chấm điểm có giải thích. Trọng số: số đăng ký 0,35 · tên 0,30 · hàm lượng 0,20 · hoạt chất 0,10
  · dạng bào chế 0,05. Chỉ tính trên bằng chứng thực sự đọc được, nhân hệ số độ phủ; giới hạn điểm khi hàm lượng
  mâu thuẫn (≤ 55), khi tên giống dưới 75 % mà không có số đăng ký (≤ 40)…

| Trạng thái | Điều kiện | Giao diện |
|---|---|---|
| `confident` | điểm ≥ 80, hơn ứng viên thứ hai ≥ 5 điểm và không phải "sản phẩm sinh đôi" | Vẫn phải bấm **Xác nhận và lưu** |
| `uncertain` | còn lại | *"Chưa thể xác định chắc chắn. Vui lòng chọn đúng thuốc."* — nút xác nhận khoá tới khi chọn |
| `no_match` / `no_text` / `no_catalog` | điểm < 45 / không đọc được chữ / chưa có danh mục | Hướng dẫn quét lại hoặc tìm thủ công |

Điểm số là **mức độ phù hợp** giữa chữ đọc được và bản ghi danh mục, không phải xác suất đúng.

### 4.5 ESP32 (`services/esp32/`)

`adapter.py` định nghĩa giao diện chung và hai bộ kết nối (`HttpPollingAdapter`, `WebSocketAdapter`);
`monitor.py` chạy nền: 2 lần lỗi liên tiếp → "Mất kết nối" và **xoá số đo cũ khỏi màn hình**; đánh giá ngưỡng →
cảnh báo; lệnh điều khiển chỉ gửi khi firmware khai báo `capabilities`. Không có đường nào sinh số đo giả;
dữ liệu từ trình mô phỏng mang cờ `simulated` và được gắn nhãn trên giao diện.

### 4.6 Bảo vệ API

`TokenMiddleware` (`core/security.py`) yêu cầu `X-SMC-Token` (hoặc `?token=` cho thẻ `<img>`),
`TrustedHostMiddleware` chỉ nhận `Host` cục bộ, CORS chỉ cho nguồn của ứng dụng, `loopback_host()` ép địa chỉ
nghe về `127.0.0.1`.

## 5. Luồng quét thuốc (đầu-cuối)

```
ScanPage ─ chụp/chọn ảnh ─► POST /api/ocr (202, job_id)
                                 │  hàng đợi 1 luồng: tiền xử lý → PaddleOCR → trích xuất → truy xuất → chấm điểm
ScanResultPage ◄─ GET /api/ocr/jobs/{id} (hỏi định kỳ, có tiến độ)
   │ hiển thị ≤ 3 ứng viên + lý do chấm điểm; người dùng chọn / tìm thủ công
   ▼
Hộp thoại xác nhận: số lượng, vị trí, HẠN DÙNG TRÊN BAO BÌ (người dùng nhập, hoặc xác nhận gợi ý OCR;
                     để trống thì thuốc được xếp vào nhóm "chưa có hạn dùng")
   ▼
POST /api/cabinet/medicines ─► cabinet_items + history_events ─► trang chi tiết thuốc trong tủ
```

## 6. Đóng gói

```
npm run build:frontend     Vite → frontend/dist (base "./", CSP chặt)
npm run build:backend      PyInstaller (backend/smc_backend.spec) → backend/dist/smc-backend/  (onedir)
npm run check:resources    dừng nếu thiếu backend / Excel / mô hình OCR / biểu tượng
electron-builder           app.asar = desktop + frontend/dist
                           extraResources = backend/ · data/DAV_unique.xlsx · ocr_models/ · icon.png
                           NSIS: cài theo người dùng, chọn được thư mục, lối tắt "Tủ thuốc thông minh"
```

Đường dẫn lúc chạy đều suy ra từ `process.resourcesPath` (Electron), `SMC_RESOURCE_DIR`/`SMC_DATA_DIR` (backend) —
không có đường dẫn tuyệt đối của máy phát triển.
