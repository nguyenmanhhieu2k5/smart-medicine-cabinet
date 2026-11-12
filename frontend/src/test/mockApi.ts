import { vi } from "vitest";
import type { AlertItem, CabinetItem, OcrJob } from "@/types/api";

/** Dữ liệu trả về mặc định cho từng endpoint — CHỈ dùng trong kiểm thử giao diện. */
export const fixtures = {
  settings: {
    camera_device_id: null, temp_min: 15, temp_max: 30, humidity_min: 30, humidity_max: 75, expiry_warning_days: 30, low_stock_threshold: 5,
    esp32_enabled: false, esp32_mode: "http", esp32_host: "", esp32_port: 80, esp32_path: "/api/status", esp32_poll_seconds: 5,
    esp32_timeout_seconds: 3, esp32_stale_seconds: 30, esp32_token_set: false, ocr_engine: "onnxruntime", ocr_profile: "v6_small", ocr_device: "auto",
    ocr_det_limit_side_len: 960, ocr_auto_enhance: true, ocr_use_textline_orientation: false, ocr_cpu_threads: 0, ocr_save_scan_images: false,
    notify_environment: true, notify_reminders: true, notify_windows: true, sound_enabled: false, minimize_to_tray: true, tts_enabled: true,
    tts_voice: null, tts_rate: 1, theme: "light", language: "vi", catalog_source_path: null, profile_name: "Test", profile_email: "",
    profile_role: "Người dùng", profile_avatar: null,
  },
  device: {
    enabled: false, configured: false, mode: "http", state: "disabled", temperature: null, humidity: null, last_update: null, last_attempt: null,
    last_error: null, simulated: false, capabilities: [], device: {}, ever_connected: false, address: null,
    environment: { code: "not_configured", label: "Chưa kết nối", temperature: null, humidity: null },
    thresholds: { temp_min: 15, temp_max: 30, humidity_min: 30, humidity_max: 75 }, unhandled_alerts: 0,
  },
};

export function cabinetItem(overrides: Partial<CabinetItem> = {}): CabinetItem {
  return {
    id: 1, catalog_id: 34382, name: "Augmentin 625mg tablets", ingredient: "Amoxicillin; Acid clavulanic", strength: "500mg/125mg",
    dosage_form: "Viên nén bao phim", registration_no: "VN-20169-16", manufacturer: "SmithKline Beecham", quantity: 14, quantity_text: "14 viên",
    unit: "viên", expiry_date: "2027-06-15", expiry_source: "manual", expiry_status: "ok", expiry_status_label: "Còn hạn", days_left: 200,
    lot_number: null, low_stock_threshold: null, low_stock: false, location: null, note: null, has_image: false, source: "manual",
    created_at: "2026-11-10T09:00:00", updated_at: "2026-11-10T09:00:00", ...overrides,
  };
}

export interface MockState {
  alerts: AlertItem[];
  cabinet: CabinetItem[];
  job: OcrJob | null;
  calls: { method: string; path: string; body: unknown }[];
}

/** Thay `fetch` bằng backend giả tối thiểu; trả về state để từng test chỉnh dữ liệu. */
export function installMockApi(): MockState {
  const state: MockState = { alerts: [], cabinet: [], job: null, calls: [] };
  const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });

  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const path = url.pathname.replace(/^\/api/, "");
    const method = init?.method ?? "GET";
    let body: unknown = null;
    if (typeof init?.body === "string") body = JSON.parse(init.body);
    state.calls.push({ method, path, body });
    const unhandled = state.alerts.filter((a) => a.status === "active" || a.status === "seen").length;
    const counts = { all: state.cabinet.length, ok: 0, expiring: 0, expired: 0, unknown: 0, low_stock: 0 };
    for (const item of state.cabinet) counts[item.expiry_status] += 1;

    if (path === "/health") return json({ status: "ok", version: "1.0.0", time: "2026-11-10T14:32:00", database: "ok", catalog_count: 55005, ocr: "ready", import_running: false });
    if (path === "/settings") return json({ settings: fixtures.settings, options: { ocr_profiles: [{ value: "v6_small", label: "PP-OCRv6 small", detection: "PP-OCRv6_small_det", recognition: "PP-OCRv6_small_rec" }], ocr_dependencies: { paddleocr: true, onnxruntime: true, paddle: false } }, paths: { data_dir: "/data", database: "/data/cabinet.db", backups: "/data/backups" } });
    if (path === "/profile") return json({ name: "Test", email: "", role: "Người dùng", has_avatar: false, auth: { provider: "local", configured: false, signed_in: false, email: null, user_id: null } });
    if (path === "/device/status") return json({ ...fixtures.device, unhandled_alerts: unhandled });
    if (path === "/device/readings") return json({ hours: 24, items: [] });
    if (path === "/alerts/count") return json({ unhandled });
    if (path === "/alerts") return json({ items: state.alerts, unhandled, open: state.alerts.filter((a) => a.status !== "resolved").length, by_category: { environment: 0, medicine: state.alerts.length, system: 0 } });
    if (path === "/catalog/status") return json({ count: 55005, source_path: "DAV_unique.xlsx", default_source: null, last_import: null, progress: { running: false, stage: "idle", rows_read: 0, rows_total: null, percent: null, message: "", file: null, last_result: null } });
    if (path === "/ocr/status") return json({ state: "ready", error: null, dependencies: { paddleocr: true, onnxruntime: true, paddle: false }, engine: { library: "PaddleOCR", version: "3.7.0", recognition_model: "PP-OCRv6_small_rec" }, queue_size: 0 });
    if (path.startsWith("/ocr/jobs/")) return state.job ? json(state.job) : json({ detail: "Không tìm thấy lần quét này (có thể đã hết hạn)." }, 404);
    if (path === "/cabinet/medicines" && method === "GET") return json({ items: state.cabinet, total: state.cabinet.length, page: 1, page_size: 20, pages: 1, counts });
    if (path === "/cabinet/medicines" && method === "POST") return json(cabinetItem({ id: 99 }), 201);
    if (path === "/cabinet/summary") return json({ counts, expiry_warning_days: 30 });
    if (path.startsWith("/cabinet/medicines/")) return state.cabinet[0] ? json({ ...state.cabinet[0], catalog: null }) : json({ detail: "Không tìm thấy thuốc này trong tủ." }, 404);
    if (path === "/reminders") return json({ items: [] });
    if (path === "/reminders/schedule") return json({ from: "2026-11-09", to: "2026-11-15", today: "2026-11-10", items: [] });
    if (path === "/history") return json({ items: [], total: 0, page: 1, page_size: 8, pages: 1 });
    if (path === "/backup") return json({ items: [], directory: "/data/backups" });
    if (path === "/notifications/pending") return json({ items: [], windows_notifications: false, sound: false, unhandled_alerts: unhandled });
    if (path.startsWith("/medicines/search")) return json({ items: [], total: 0, query: "", mode: "text", catalog_count: 55005 });
    return json({ detail: `Chưa giả lập ${method} ${path}` }, 404);
  }));
  return state;
}
