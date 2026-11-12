# Giao thức kết nối ESP32 ↔ Tủ thuốc thông minh

Phần mềm trên máy tính là **client**; ESP32 là **server** trong cùng mạng LAN.
Backend của ứng dụng chỉ lắng nghe trên `127.0.0.1` nên ESP32 không (và không cần) gọi
ngược về máy tính.

> Trạng thái: lớp adapter đã được kiểm thử tự động với thiết bị giả lập
> (`tests/backend/test_06_environment_esp32.py`, `scripts/esp32_simulator.py`).
> **Chưa kiểm thử với phần cứng ESP32 thật.** Firmware mẫu trong
> `firmware/esp32_cabinet/` là điểm khởi đầu, cần nạp và hiệu chỉnh trên mạch của bạn.

## 1. HTTP polling (mặc định)

Ứng dụng gọi định kỳ (mặc định 5 giây, chỉnh trong Cài đặt → Thiết bị ESP32):

```
GET http://<địa-chỉ-esp32>:<cổng>/api/status
X-Device-Token: <token>        (chỉ gửi khi người dùng nhập token)
```

Phản hồi `200 OK`, `Content-Type: application/json`:

```json
{
  "temperature": 26.4,
  "humidity": 58.0,
  "sensor_ok": true,
  "uptime_ms": 123456,
  "firmware": "1.0.0",
  "capabilities": ["buzzer"]
}
```

| Trường | Kiểu | Bắt buộc | Ý nghĩa |
|---|---|---|---|
| `temperature` | số hoặc `null` | có (một trong hai) | °C. Tên thay thế: `temperature_c`, `temp`, `temp_c`, `t` |
| `humidity` | số hoặc `null` | có (một trong hai) | %RH. Tên thay thế: `humidity_percent`, `hum`, `rh`, `h` |
| `sensor_ok`, `uptime_ms`, `firmware`, `name`, `door_open`, `fan_on` | tùy | không | Hiển thị ở mục trạng thái thiết bị |
| `capabilities` | mảng chuỗi | không | Các lệnh thiết bị hỗ trợ (xem mục 3) |
| `simulated` | boolean | không | `true` nếu là trình mô phỏng — giao diện gắn nhãn “Mô phỏng” |

Có thể lồng số đo trong `sensors`, `data` hoặc `reading`:
`{"sensors": {"temp": 26.4, "hum": 58}}`.

Quy tắc xử lý phía ứng dụng:

- Giá trị `null`, `NaN`, không phải số hoặc ngoài khoảng vật lý (−40…85 °C, 0…100 %)
  → coi là **không có số đo** (cảnh báo “Mất dữ liệu cảm biến”), không hiển thị số.
- Lỗi mạng, quá thời gian chờ, mã HTTP ≠ 200, nội dung không phải JSON → một lần lỗi.
  Sau **2 lần lỗi liên tiếp** (hoặc ngay lần đầu nếu chưa từng kết nối) trạng thái thành
  “Mất kết nối”, số đo cũ bị xóa khỏi màn hình và có cảnh báo “Mất kết nối ESP32”.
- Số đo hợp lệ được lưu vào SQLite tối đa 1 lần/phút, giữ 30 ngày.

## 2. WebSocket (tùy chọn)

Chọn chế độ `websocket` trong Cài đặt. Ứng dụng mở `ws://<esp32>:<cổng><đường-dẫn>`
(ví dụ `/ws`) và ESP32 **đẩy** JSON cùng định dạng mục 1 mỗi khi có số đo mới.
Nếu quá `esp32_stale_seconds` (mặc định 30 giây) không có bản tin, trạng thái là
“Mất dữ liệu cảm biến”.

## 3. Lệnh điều khiển (chỉ khi firmware khai báo)

Ứng dụng **không giả định** thiết bị có endpoint điều khiển. Lệnh chỉ được gửi khi tên
lệnh nằm trong `capabilities` của phản hồi trạng thái gần nhất:

```
POST http://<esp32>/api/command
{"command": "buzzer", "value": true}
```

Phản hồi 2xx (JSON tùy ý, ví dụ `{"ok": true}`). Mã ≥ 400 được báo là thiết bị từ chối.
API phía ứng dụng: `POST /api/device/command`.

## 4. API phía ứng dụng

| Endpoint | Mô tả |
|---|---|
| `GET /api/device/status` | Trạng thái, số đo hiện tại, ngưỡng, đánh giá môi trường |
| `POST /api/device/refresh` | Đọc thiết bị ngay |
| `POST /api/device/test` | Thử một cấu hình mà không lưu |
| `GET /api/device/readings?hours=24` | Lịch sử số đo thật |
| `POST /api/device/command` | Gửi lệnh (chỉ với capability đã khai báo) |

## 5. Chạy thử không cần phần cứng

```
python scripts/esp32_simulator.py --port 8080
```

Sau đó vào Cài đặt → Thiết bị ESP32: bật kết nối, địa chỉ `127.0.0.1`, cổng `8080`.
Trình mô phỏng luôn trả `"simulated": true` nên giao diện hiển thị nhãn **Mô phỏng**
cạnh số đo — không thể nhầm với dữ liệu cảm biến thật.
