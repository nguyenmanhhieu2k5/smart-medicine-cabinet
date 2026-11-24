/*
 * Cấu hình firmware — CHÉP file này thành config.h rồi điền thông tin thật.
 * config.h đã được .gitignore bỏ qua: KHÔNG đưa mật khẩu Wi-Fi hay token thiết bị lên kho mã.
 */
#pragma once

// ---- Wi-Fi (ESP32 không cần chung mạng với máy tính hay Mini PC) ----
#define WIFI_SSID      "TEN_WIFI"
#define WIFI_PASSWORD  "MAT_KHAU_WIFI"

// ---- Máy chủ (API công khai của Mini PC) — lấy đúng địa chỉ ở ứng dụng Windows → Quản trị → Thiết bị ----
// Tailscale Funnel:   wss://<mini-pc>.<tailnet>.ts.net:8443/api/v1/device/ws → SERVER_HOST "<mini-pc>.<tailnet>.ts.net", SERVER_PORT 8443
// Cloudflare Tunnel:  wss://api.tuthuoc.example/api/v1/device/ws             → SERVER_HOST "api.tuthuoc.example",        SERVER_PORT 443
#define SERVER_HOST    "api.tuthuoc.example"
#define SERVER_PORT    443
#define SERVER_PATH    "/api/v1/device/ws"
#define USE_TLS        1        // 1 = wss (bắt buộc: máy chủ chỉ nhận kết nối qua Funnel/Cloudflare); 0 = ws (chỉ khi tự dựng proxy thử nghiệm)

// ---- Token thiết bị: tạo ở ứng dụng Windows → Quản trị → Thiết bị → Thêm thiết bị (chỉ hiển thị một lần) ----
#define DEVICE_TOKEN   "smcdev_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"

// ---- Phần cứng ----
#define DHT_PIN        4        // chân DATA của DHT22
#define DHT_TYPE       DHT22
#define BUZZER_PIN     5        // còi chủ động (mức HIGH = kêu)

// ---- Múi giờ cho đồng hồ NTP (TLS cần thời gian đúng) ----
#define TZ_OFFSET_SECONDS (7 * 3600)
