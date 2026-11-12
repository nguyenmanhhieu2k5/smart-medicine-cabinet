/*
 * Tủ thuốc thông minh — firmware mẫu cho ESP32 + DHT22
 * ------------------------------------------------------------------
 * Triển khai giao thức trong docs/ESP32_PROTOCOL.md:
 *   GET  /api/status   → {"temperature": .., "humidity": .., ...}
 *   POST /api/command  → {"command":"buzzer","value":true}
 *
 * CHƯA ĐƯỢC KIỂM THỬ TRÊN PHẦN CỨNG. Đây là mã khởi đầu: hãy chỉnh chân
 * GPIO, loại cảm biến và thông tin Wi-Fi cho mạch của bạn rồi nạp thử.
 *
 * Thư viện (Arduino Library Manager):
 *   - "DHT sensor library" (Adafruit) + "Adafruit Unified Sensor"
 *   - "ArduinoJson" (v7)
 * Board: ESP32 Dev Module (Arduino core for ESP32).
 */
#include <WiFi.h>
#include <WebServer.h>
#include <ArduinoJson.h>
#include <DHT.h>

// ---- Cấu hình: điền thông tin của bạn (không đưa mật khẩu thật lên kho mã) ----
const char* WIFI_SSID     = "TEN_WIFI";
const char* WIFI_PASSWORD = "MAT_KHAU_WIFI";
const char* DEVICE_TOKEN  = "";          // để trống nếu không dùng token

const int DHT_PIN    = 4;                // chân DATA của DHT22
const int BUZZER_PIN = 5;                // còi (tùy chọn)
#define DHT_TYPE DHT22

DHT dht(DHT_PIN, DHT_TYPE);
WebServer server(80);

float lastTemp = NAN, lastHum = NAN;
unsigned long lastRead = 0;
bool buzzerOn = false;

bool authorized() {
  if (strlen(DEVICE_TOKEN) == 0) return true;
  return server.header("X-Device-Token") == DEVICE_TOKEN;
}

void readSensor() {
  if (millis() - lastRead < 2000 && lastRead != 0) return;   // DHT22: tối đa 0,5 Hz
  lastRead = millis();
  lastTemp = dht.readTemperature();
  lastHum  = dht.readHumidity();
}

void handleStatus() {
  if (!authorized()) { server.send(401, "application/json", "{\"error\":\"unauthorized\"}"); return; }
  readSensor();
  JsonDocument doc;
  // Cảm biến lỗi → gửi null; phần mềm sẽ báo "Mất dữ liệu cảm biến" thay vì hiện số sai.
  if (isnan(lastTemp)) doc["temperature"] = nullptr; else doc["temperature"] = roundf(lastTemp * 10) / 10.0;
  if (isnan(lastHum))  doc["humidity"]    = nullptr; else doc["humidity"]    = roundf(lastHum * 10) / 10.0;
  doc["sensor_ok"] = !(isnan(lastTemp) || isnan(lastHum));
  doc["uptime_ms"] = millis();
  doc["firmware"]  = "1.0.0";
  doc["capabilities"].add("buzzer");
  doc["buzzer_on"] = buzzerOn;
  String body;
  serializeJson(doc, body);
  server.send(200, "application/json", body);
}

void handleCommand() {
  if (!authorized()) { server.send(401, "application/json", "{\"error\":\"unauthorized\"}"); return; }
  JsonDocument doc;
  if (deserializeJson(doc, server.arg("plain"))) { server.send(400, "application/json", "{\"error\":\"bad json\"}"); return; }
  const char* command = doc["command"] | "";
  if (strcmp(command, "buzzer") == 0) {
    buzzerOn = doc["value"] | false;
    digitalWrite(BUZZER_PIN, buzzerOn ? HIGH : LOW);
    server.send(200, "application/json", buzzerOn ? "{\"ok\":true,\"buzzer_on\":true}" : "{\"ok\":true,\"buzzer_on\":false}");
  } else {
    server.send(400, "application/json", "{\"error\":\"unsupported command\"}");
  }
}

void setup() {
  Serial.begin(115200);
  pinMode(BUZZER_PIN, OUTPUT);
  digitalWrite(BUZZER_PIN, LOW);
  dht.begin();

  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  Serial.print("Dang ket noi Wi-Fi");
  while (WiFi.status() != WL_CONNECTED) { delay(400); Serial.print("."); }
  Serial.printf("\nDia chi IP: %s  (nhap dia chi nay vao Cai dat > Thiet bi ESP32)\n", WiFi.localIP().toString().c_str());

  const char* headers[] = {"X-Device-Token"};
  server.collectHeaders(headers, 1);
  server.on("/api/status", HTTP_GET, handleStatus);
  server.on("/api/command", HTTP_POST, handleCommand);
  server.onNotFound([]() { server.send(404, "application/json", "{\"error\":\"not found\"}"); });
  server.begin();
}

void loop() {
  server.handleClient();
}
