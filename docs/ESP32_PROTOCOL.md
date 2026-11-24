# Giao thức ESP32 ↔ máy chủ Mini PC (phiên bản 2)

ESP32 là **client**, tự kết nối **ra ngoài** tới máy chủ bằng WebSocket bảo mật (WSS) qua kênh công khai của Mini PC
(Tailscale Funnel hoặc Cloudflare Tunnel). ESP32, Mini PC và máy Admin **không cần chung mạng Wi-Fi**, không cần mở cổng router.

```
ESP32 ──WSS (TLS, token thiết bị)──► Tailscale Funnel :8443  ─┐
                                   ► hoặc Cloudflare Tunnel ──┴─► 127.0.0.1:8000 /api/v1/device/ws (Mini PC)
```

> Trạng thái: máy chủ + giao thức đã kiểm thử tự động (`tests/backend/test_06_iot_devices.py`) và đầu-cuối với
> trình mô phỏng (`scripts/esp32_simulator.py`, `scripts/e2e_server.py`). Firmware `firmware/esp32_cabinet`
> **chưa biên dịch thử và chưa nạp lên mạch thật**.

## 1. Kết nối và xác thực

- URL: `wss://<mini-pc>.<tailnet>.ts.net:8443/api/v1/device/ws` (Funnel) hoặc `wss://api.<tên-miền>/api/v1/device/ws`
  (Cloudflare) — ứng dụng Windows hiện đúng địa chỉ ở *Quản trị → Thiết bị*. Thử ngay trên Mini PC:
  `ws://127.0.0.1:8000/api/v1/device/ws`; máy chủ chỉ nghe 127.0.0.1 nên mọi thiết bị khác đi qua kênh công khai.
- Header: `Authorization: Bearer <token thiết bị>` (`smcdev_...`). Token tạo ở ứng dụng Windows → *Quản trị → Thiết bị →
  Thêm thiết bị*; máy chủ chỉ lưu SHA-256, token chỉ hiển thị một lần. Đổi token / vô hiệu hóa thiết bị → kết nối
  cũ bị ngắt ngay.
- Token sai → máy chủ từ chối bắt tay (HTTP 403) và ghi nhật ký kiểm toán.
- Mỗi thiết bị một kết nối; kết nối mới thay thế kết nối cũ. Bản tin tối đa 8 KB, tối đa 60 bản tin / 10 giây.
- Máy chủ gửi `{"type":"ping"}` mỗi 20 giây (proxy như Cloudflare cắt WebSocket nhàn rỗi sau 100 giây); thiết bị trả `pong`.
  Không có bản tin nào trong 90 giây → máy chủ đóng kết nối và báo “Mất kết nối ESP32”.

## 2. Bản tin

### Máy chủ → thiết bị

| type | Nội dung |
|---|---|
| `welcome` | `device_id`, `name`, `server_time`, `thresholds` {temp_min, temp_max, humidity_min, humidity_max}, `ping_interval_s` |
| `command` | `command_id` (UUID), `action`, `payload`, `expires_in_s` |
| `ping` | — |

### Thiết bị → máy chủ

| type | Nội dung |
|---|---|
| `hello` | `firmware`, `capabilities` (danh sách lệnh hỗ trợ), `state` (tùy ý) |
| `telemetry` | `temperature`, `humidity` (số hoặc `null`), `sensor_ok`, `buzzer_on`, `alarm_enabled`, `local_alarm`, `interval_s`, `uptime_ms`, `rssi`, `simulated` |
| `ack` | `command_id`, `status` = `received` \| `applied` \| `failed`, `message`, `result` |
| `pong` | — |

Quy tắc số đo: `null`, NaN, ngoài khoảng vật lý (−40…85 °C, 0…100 %) → **không có số đo** (“Mất dữ liệu cảm
biến”), không hiển thị số. Lưu tối đa 1 số đo/phút/thiết bị vào `device_telemetry`, giữ 90 ngày. Bản tin có
`"simulated": true` luôn được gắn nhãn **Mô phỏng**.

## 3. Lệnh điều khiển

Một lệnh chỉ được tạo khi **cả máy chủ** (danh mục trong `backend/app/iot/actions.py`) **và thiết bị**
(`capabilities` trong `hello`) đều hỗ trợ; tham số được kiểm tra chặt (thừa trường → từ chối).

| action | payload | Phần cứng |
|---|---|---|
| `buzzer` | `{"on": true, "duration_s": 1–300}` | Còi (tự tắt tối đa sau 5 phút) |
| `read_now` | `{}` | Đọc DHT22 ngay và gửi telemetry |
| `set_thresholds` | `{"temp_min","temp_max","humidity_min","humidity_max"}` | Lưu vào NVS, dùng cho còi cảnh báo cục bộ |
| `set_alarm` | `{"enabled": true}` | Bật/tắt còi tự động khi vượt ngưỡng |
| `set_interval` | `{"seconds": 5–3600}` | Chu kỳ gửi số đo |

Vòng đời (bảng `device_commands` + `device_command_ack`):

```
pending ──(thiết bị đang kết nối: gửi)──► sent ──ack received──► acknowledged ──ack applied──► applied
   │                                         │                        └──────ack failed───────► failed
   └──────────── quá expires_at (mặc định 60 s) mà chưa applied/failed ─────────────────────► timed_out
```

- **Chỉ `applied` mới là thành công** — máy chủ không bao giờ báo thành công chỉ vì đã gửi lệnh.
- Thiết bị ngoại tuyến: lệnh ở `pending`, được gửi lại khi thiết bị kết nối và chào (`hello`) nếu còn hạn.
- Thiết bị ghi nhớ 16 `command_id` gần nhất để không thực hiện lại lệnh bị gửi lặp.
- Phản hồi đến muộn sau `timed_out` vẫn được ghi nhận trung thực (`result.late = true`).
- Đổi ngưỡng trong *Cài đặt* của ứng dụng Windows → máy chủ tự gửi `set_thresholds` tới mọi thiết bị hỗ trợ.

## 4. Mất Internet

Firmware tiếp tục đọc cảm biến và **tự kêu còi khi vượt ngưỡng** đã lưu trong NVS; tự kết nối lại Wi-Fi/WSS
(5 giây/lần). Còi bật tay luôn có thời hạn (≤ 5 phút) để không kêu mãi khi mất mạng.

## 5. API quản trị liên quan (kênh Admin, Tailscale)

| Endpoint | Mô tả |
|---|---|
| `GET /api/device/status` | Trạng thái tủ chính + đánh giá môi trường (tương thích giao diện cũ) |
| `GET /api/devices` · `POST /api/devices` | Danh sách / thêm thiết bị (trả token một lần) |
| `PATCH /api/devices/{id}` · `POST /api/devices/{id}/token` · `DELETE /api/devices/{id}` | Sửa, đổi token, xóa |
| `POST /api/devices/{id}/commands` · `GET /api/commands/{id}` · `POST /api/commands/{id}/cancel` | Gửi lệnh, theo dõi ACK, hủy |
| `GET /api/devices/{id}/telemetry?hours=24` | Lịch sử số đo thật |

API công khai (`/api/v1`) **không có** endpoint quản lý hay điều khiển thiết bị; ứng dụng mobile không gửi lệnh được.

## 6. Chạy thử không cần phần cứng

```
backend\.venv\Scripts\python scripts\esp32_simulator.py --url ws://127.0.0.1:8000/api/v1/device/ws --token smcdev_...
backend\.venv\Scripts\python scripts\esp32_simulator.py --url wss://api.<tên-miền>/api/v1/device/ws --token smcdev_...
```
