/*
 * Tủ thuốc thông minh — firmware ESP32 + DHT22 + còi (phiên bản 2.0.0)
 * ------------------------------------------------------------------------------------------------
 * ESP32 tự kết nối RA NGOÀI tới máy chủ Mini PC qua WSS (Cloudflare Tunnel) — không cần chung Wi-Fi,
 * không cần mở cổng router. Giao thức: docs/ESP32_PROTOCOL.md.
 *
 *   thiết bị → máy chủ : hello, telemetry, ack (received → applied | failed), pong
 *   máy chủ → thiết bị : welcome, command, ping
 *
 * Lệnh hỗ trợ (đúng với phần cứng mạch mẫu): buzzer, read_now, set_thresholds, set_alarm, set_interval.
 * Mất Internet: thiết bị vẫn tự đo và tự kêu còi khi vượt ngưỡng đã lưu trong bộ nhớ flash (NVS).
 *
 * Thư viện (Arduino Library Manager):
 *   - "WebSockets" (Markus Sattler / Links2004) ≥ 2.4
 *   - "ArduinoJson" (Benoit Blanchon) v7
 *   - "DHT sensor library" (Adafruit) + "Adafruit Unified Sensor"
 * Board: "ESP32 Dev Module" (Arduino core for ESP32 3.x).
 *
 * Trạng thái: CHƯA biên dịch thử và CHƯA nạp lên mạch thật (giao thức đã được kiểm thử phía máy chủ bằng
 * scripts/esp32_simulator.py). Biên dịch bằng Arduino IDE, kiểm tra chân GPIO cho mạch của bạn trước khi nạp.
 */
#include <WiFi.h>
#include <WebSocketsClient.h>
#include <ArduinoJson.h>
#include <DHT.h>
#include <Preferences.h>
#include <time.h>

#if __has_include("config.h")
#include "config.h"
#else
#warning "Chưa có config.h — đang dùng config.example.h (chép thành config.h và điền thông tin thật)"
#include "config.example.h"
#endif
#include "root_ca.h"

static const char* FIRMWARE_VERSION = "2.0.0";
static const char* CAPABILITIES[] = {"buzzer", "read_now", "set_thresholds", "set_alarm", "set_interval"};
static const uint32_t MAX_BUZZER_MS = 300000;  // còi bật tay tự tắt sau tối đa 5 phút (an toàn khi mất mạng)

WebSocketsClient ws;
DHT dht(DHT_PIN, DHT_TYPE);
Preferences prefs;

struct Thresholds { float tempMin, tempMax, humMin, humMax; } th = {15, 30, 30, 75};
bool alarmEnabled = true;
uint32_t intervalS = 10;
bool manualBuzzer = false;
uint32_t manualBuzzerUntil = 0;
bool buzzerOn = false;
bool localAlarm = false;
float lastTemp = NAN, lastHum = NAN;
uint32_t lastRead = 0, lastTelemetry = 0;
bool connected = false;
String recentIds[16];
uint8_t recentPos = 0;

// --------------------------------------------------------------------------------------------- //
void loadSettings() {
  prefs.begin("cabinet", true);
  th.tempMin = prefs.getFloat("tmin", th.tempMin);
  th.tempMax = prefs.getFloat("tmax", th.tempMax);
  th.humMin = prefs.getFloat("hmin", th.humMin);
  th.humMax = prefs.getFloat("hmax", th.humMax);
  alarmEnabled = prefs.getBool("alarm", alarmEnabled);
  intervalS = prefs.getUInt("interval", intervalS);
  prefs.end();
}

void saveSettings() {
  prefs.begin("cabinet", false);
  prefs.putFloat("tmin", th.tempMin);
  prefs.putFloat("tmax", th.tempMax);
  prefs.putFloat("hmin", th.humMin);
  prefs.putFloat("hmax", th.humMax);
  prefs.putBool("alarm", alarmEnabled);
  prefs.putUInt("interval", intervalS);
  prefs.end();
}

bool validThresholds(float a, float b, float c, float d) {
  return a >= -20 && b <= 60 && a < b && c >= 0 && d <= 100 && c < d;
}

void readSensor(bool force = false) {
  if (!force && lastRead != 0 && millis() - lastRead < 2000) return;  // DHT22: tối đa 0,5 Hz
  lastRead = millis();
  lastTemp = dht.readTemperature();
  lastHum = dht.readHumidity();
}

// Điều khiển cục bộ: chạy cả khi mất Internet.
void updateOutputs() {
  bool valid = !isnan(lastTemp) && !isnan(lastHum);
  localAlarm = alarmEnabled && valid &&
               (lastTemp < th.tempMin || lastTemp > th.tempMax || lastHum < th.humMin || lastHum > th.humMax);
  if (manualBuzzer && (int32_t)(millis() - manualBuzzerUntil) >= 0) manualBuzzer = false;
  bool want = manualBuzzer || localAlarm;
  if (want != buzzerOn) {
    buzzerOn = want;
    digitalWrite(BUZZER_PIN, buzzerOn ? HIGH : LOW);
  }
}

// --------------------------------------------------------------------------------------------- //
void sendJson(JsonDocument& doc) {
  if (!connected) return;
  String body;
  serializeJson(doc, body);
  ws.sendTXT(body);
}

void sendTelemetry() {
  JsonDocument doc;
  doc["type"] = "telemetry";
  // Cảm biến lỗi → gửi null; máy chủ báo "Mất dữ liệu cảm biến" thay vì hiện số sai.
  if (isnan(lastTemp)) doc["temperature"] = nullptr; else doc["temperature"] = roundf(lastTemp * 10) / 10.0;
  if (isnan(lastHum)) doc["humidity"] = nullptr; else doc["humidity"] = roundf(lastHum * 10) / 10.0;
  doc["sensor_ok"] = !(isnan(lastTemp) || isnan(lastHum));
  doc["buzzer_on"] = buzzerOn;
  doc["alarm_enabled"] = alarmEnabled;
  doc["local_alarm"] = localAlarm;
  doc["interval_s"] = intervalS;
  doc["uptime_ms"] = millis();
  doc["rssi"] = WiFi.RSSI();
  sendJson(doc);
  lastTelemetry = millis();
}

void sendHello() {
  JsonDocument doc;
  doc["type"] = "hello";
  doc["firmware"] = FIRMWARE_VERSION;
  JsonArray caps = doc["capabilities"].to<JsonArray>();
  for (const char* c : CAPABILITIES) caps.add(c);
  JsonObject state = doc["state"].to<JsonObject>();
  state["temp_min"] = th.tempMin;
  state["temp_max"] = th.tempMax;
  state["humidity_min"] = th.humMin;
  state["humidity_max"] = th.humMax;
  state["alarm_enabled"] = alarmEnabled;
  state["interval_s"] = intervalS;
  sendJson(doc);
}

void sendAck(const char* id, const char* status, const char* message = nullptr, JsonDocument* result = nullptr) {
  JsonDocument doc;
  doc["type"] = "ack";
  doc["command_id"] = id;
  doc["status"] = status;
  if (message) doc["message"] = message;
  if (result) doc["result"] = result->as<JsonObject>();
  sendJson(doc);
}

bool seenRecently(const String& id) {
  for (const String& s : recentIds) if (s == id) return true;
  recentIds[recentPos] = id;
  recentPos = (recentPos + 1) % 16;
  return false;
}

void handleCommand(JsonDocument& msg) {
  const char* id = msg["command_id"] | "";
  const char* action = msg["action"] | "";
  JsonObject payload = msg["payload"].as<JsonObject>();
  if (strlen(id) == 0) return;
  sendAck(id, "received");
  if (seenRecently(String(id))) {  // máy chủ gửi lại lệnh đã làm → không thực hiện lần hai
    sendAck(id, "applied", "duplicate");
    return;
  }
  JsonDocument result;
  if (strcmp(action, "buzzer") == 0) {
    bool on = payload["on"] | false;
    uint32_t duration = payload["duration_s"] | 0;
    manualBuzzer = on;
    manualBuzzerUntil = millis() + (on ? std::min<uint32_t>(duration ? duration * 1000UL : MAX_BUZZER_MS, MAX_BUZZER_MS) : 0);
    updateOutputs();
    result["buzzer_on"] = buzzerOn;
  } else if (strcmp(action, "read_now") == 0) {
    readSensor(true);
    updateOutputs();
    if (isnan(lastTemp) || isnan(lastHum)) { sendAck(id, "failed", "Cảm biến DHT22 không phản hồi"); return; }
  } else if (strcmp(action, "set_thresholds") == 0) {
    float a = payload["temp_min"] | NAN, b = payload["temp_max"] | NAN, c = payload["humidity_min"] | NAN, d = payload["humidity_max"] | NAN;
    if (!validThresholds(a, b, c, d)) { sendAck(id, "failed", "Ngưỡng không hợp lệ"); return; }
    th = {a, b, c, d};
    saveSettings();
    updateOutputs();
    result["saved"] = true;
  } else if (strcmp(action, "set_alarm") == 0) {
    alarmEnabled = payload["enabled"] | true;
    saveSettings();
    updateOutputs();
    result["alarm_enabled"] = alarmEnabled;
  } else if (strcmp(action, "set_interval") == 0) {
    uint32_t s = payload["seconds"] | 0;
    if (s < 5 || s > 3600) { sendAck(id, "failed", "Chu kỳ phải từ 5 đến 3600 giây"); return; }
    intervalS = s;
    saveSettings();
    result["interval_s"] = intervalS;
  } else {
    sendAck(id, "failed", "Lệnh không được firmware hỗ trợ");
    return;
  }
  sendAck(id, "applied", nullptr, &result);
  sendTelemetry();
}

void onMessage(uint8_t* data, size_t length) {
  JsonDocument msg;
  if (deserializeJson(msg, data, length)) return;
  const char* type = msg["type"] | "";
  if (strcmp(type, "command") == 0) {
    handleCommand(msg);
  } else if (strcmp(type, "ping") == 0) {
    JsonDocument pong;
    pong["type"] = "pong";
    sendJson(pong);
  } else if (strcmp(type, "welcome") == 0) {
    // Máy chủ gửi ngưỡng hiện hành → đồng bộ để còi cục bộ dùng đúng ngưỡng khi mất mạng.
    JsonObject t = msg["thresholds"].as<JsonObject>();
    float a = t["temp_min"] | NAN, b = t["temp_max"] | NAN, c = t["humidity_min"] | NAN, d = t["humidity_max"] | NAN;
    if (validThresholds(a, b, c, d)) { th = {a, b, c, d}; saveSettings(); }
  }
}

void onWsEvent(WStype_t type, uint8_t* payload, size_t length) {
  switch (type) {
    case WStype_CONNECTED:
      connected = true;
      Serial.println("[ws] da ket noi may chu");
      sendHello();
      readSensor(true);
      updateOutputs();
      sendTelemetry();
      break;
    case WStype_DISCONNECTED:
      if (connected) Serial.println("[ws] mat ket noi — tiep tuc dieu khien cuc bo");
      connected = false;
      break;
    case WStype_TEXT:
      onMessage(payload, length);
      break;
    default:
      break;
  }
}

// --------------------------------------------------------------------------------------------- //
void connectWifi() {
  if (WiFi.status() == WL_CONNECTED) return;
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  Serial.print("Dang ket noi Wi-Fi");
  uint32_t start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < 20000) { delay(400); Serial.print("."); }
  Serial.println(WiFi.status() == WL_CONNECTED ? "\nWi-Fi OK: " + WiFi.localIP().toString() : String("\nChua co Wi-Fi, se thu lai"));
}

void setup() {
  Serial.begin(115200);
  pinMode(BUZZER_PIN, OUTPUT);
  digitalWrite(BUZZER_PIN, LOW);
  dht.begin();
  loadSettings();
  connectWifi();
  configTime(TZ_OFFSET_SECONDS, 0, "pool.ntp.org", "time.google.com");  // TLS cần đồng hồ đúng

  String header = String("Authorization: Bearer ") + DEVICE_TOKEN;
  ws.setExtraHeaders(header.c_str());
#if USE_TLS
  ws.beginSslWithCA(SERVER_HOST, SERVER_PORT, SERVER_PATH, ROOT_CA_BUNDLE);
#else
  ws.begin(SERVER_HOST, SERVER_PORT, SERVER_PATH);
#endif
  ws.onEvent(onWsEvent);
  ws.setReconnectInterval(5000);
  ws.enableHeartbeat(25000, 5000, 2);  // ping WebSocket, phát hiện kết nối chết
}

void loop() {
  static uint32_t lastWifiCheck = 0;
  if (WiFi.status() != WL_CONNECTED && millis() - lastWifiCheck > 15000) {
    lastWifiCheck = millis();
    connectWifi();
  }
  ws.loop();
  readSensor();
  bool before = buzzerOn;
  updateOutputs();
  if (connected && (millis() - lastTelemetry >= intervalS * 1000UL || before != buzzerOn)) sendTelemetry();
  delay(10);
}
