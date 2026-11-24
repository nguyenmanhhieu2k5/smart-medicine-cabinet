import { vi } from "vitest";
import type { AdminUser, AlertItem, AuditEntry, CabinetItem, DeviceCommand, DeviceInfo, OcrJob } from "@/types/api";

/** Dữ liệu trả về mặc định cho từng endpoint — CHỈ dùng trong kiểm thử giao diện. */
export const fixtures = {
  settings: {
    camera_device_id: null, temp_min: 15, temp_max: 30, humidity_min: 30, humidity_max: 75, expiry_warning_days: 30, low_stock_threshold: 5,
    ocr_engine: "onnxruntime", ocr_profile: "v6_small", ocr_device: "auto",
    ocr_det_limit_side_len: 960, ocr_auto_enhance: true, ocr_use_textline_orientation: false, ocr_cpu_threads: 0, ocr_save_scan_images: false,
    notify_environment: true, notify_reminders: true, notify_windows: true, sound_enabled: false, minimize_to_tray: true, tts_enabled: true,
    tts_voice: null, tts_rate: 1, theme: "light", language: "vi", catalog_source_path: null, profile_name: "Test", profile_email: "",
    profile_role: "Người dùng", profile_avatar: null,
  },
  device: {
    enabled: false, configured: false, mode: "wss", device_id: null, state: "disabled", temperature: null, humidity: null, last_update: null, last_attempt: null,
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

export const ADMIN_USER: AdminUser = {
  id: "00000000-0000-0000-0000-000000000001", email: "admin@example.com", full_name: "Test", phone: null, role: "ADMIN", role_name: "Quản trị viên",
  permissions: ["users:manage"], is_active: true, created_at: "2026-11-01T08:00:00", last_login_at: "2026-11-10T08:00:00", locked_until: null, active_sessions: 1,
};

export function deviceInfo(overrides: Partial<DeviceInfo> = {}): DeviceInfo {
  return {
    id: "dev-1", name: "Tủ phòng khách", token_hint: "…ab12", firmware: "smc-esp32/2.0.0", capabilities: ["buzzer", "read_now", "set_thresholds", "set_alarm", "set_interval"],
    supported_actions: ["buzzer", "read_now", "set_thresholds", "set_alarm", "set_interval"], is_active: true, is_primary: true, online: true,
    last_seen_at: "2026-11-10T14:30:00", last_ip: "203.0.113.5", last_state: null, note: null, created_at: "2026-11-01T08:00:00", ...overrides,
  };
}

export interface MockState {
  alerts: AlertItem[];
  cabinet: CabinetItem[];
  job: OcrJob | null;
  devices: DeviceInfo[];
  /** Trạng thái lần lượt mà GET /commands/{id} trả về (mô phỏng ACK từ thiết bị). */
  commandStatuses: DeviceCommand["status"][];
  users: AdminUser[];
  audit: AuditEntry[];
  /** Số mã vạch đã gắn (giả lập). */
  barcodes: number;
  /** Trạng thái AI giả lập: tìm kiếm trên mạng có dùng được không. */
  aiSearch: boolean;
  aiProvider: "tavily" | "auto" | "gemini";
  calls: { method: string; path: string; body: unknown }[];
}

/** Thay `fetch` bằng backend giả tối thiểu; trả về state để từng test chỉnh dữ liệu. */
export function installMockApi(): MockState {
  const state: MockState = { alerts: [], cabinet: [], job: null, devices: [], commandStatuses: ["sent", "acknowledged", "applied"], users: [ADMIN_USER], audit: [], barcodes: 0, aiSearch: true, aiProvider: "tavily", calls: [] };
  let commandPolls = 0;
  const command = (status: DeviceCommand["status"]): DeviceCommand => ({
    id: "cmd-1", device_id: "dev-1", action: "buzzer", action_label: "Bật/tắt còi", payload: { on: true, duration_s: 5 }, status,
    created_at: "2026-11-10T14:31:00", expires_at: "2026-11-10T14:32:00", sent_at: status === "pending" ? null : "2026-11-10T14:31:00",
    acknowledged_at: ["acknowledged", "applied"].includes(status) ? "2026-11-10T14:31:01" : null,
    completed_at: ["applied", "failed", "timed_out"].includes(status) ? "2026-11-10T14:31:02" : null, attempts: 1,
    error: status === "failed" ? "Còi không phản hồi" : status === "timed_out" ? "Thiết bị không xác nhận trước khi lệnh hết hạn." : null,
    result: null, final: ["applied", "failed", "timed_out", "cancelled"].includes(status),
    acks: status === "applied" ? [{ status: "received", message: null, payload: null, received_at: "2026-11-10T14:31:01" }, { status: "applied", message: null, payload: null, received_at: "2026-11-10T14:31:02" }] : [],
  });
  const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });

  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const path = url.pathname.replace(/^\/api/, "");
    const method = init?.method ?? "GET";
    let body: unknown = null;
    if (typeof init?.body === "string") body = JSON.parse(init.body);
    // multipart: ghi lại các trường chữ (bỏ nội dung file) để test kiểm tra được, ví dụ dry_run.
    if (init?.body instanceof FormData) body = Object.fromEntries([...init.body.entries()].map(([k, v]) => [k, typeof v === "string" ? v : `<file ${(v as File).name}>`]));
    state.calls.push({ method, path, body });
    const unhandled = state.alerts.filter((a) => a.status === "active" || a.status === "seen").length;
    const counts = { all: state.cabinet.length, ok: 0, expiring: 0, expired: 0, unknown: 0, low_stock: 0 };
    for (const item of state.cabinet) counts[item.expiry_status] += 1;

    if (path === "/health") return json({ status: "ok", version: "1.0.0", time: "2026-11-10T14:32:00", database: "ok", catalog_count: 55005, ocr: "ready", import_running: false });
    if (path === "/settings") return json({ settings: fixtures.settings, options: { ocr_profiles: [{ value: "v6_small", label: "PP-OCRv6 small", detection: "PP-OCRv6_small_det", recognition: "PP-OCRv6_small_rec" }], ocr_dependencies: { paddleocr: true, onnxruntime: true, paddle: false } }, paths: { data_dir: "/data", database: "/data/cabinet.db", backups: "/data/backups" } });
    if (path === "/profile") return json({ name: "Test", email: ADMIN_USER.email, role: "Quản trị viên", phone: null, has_avatar: false, account: ADMIN_USER, auth: { provider: "server", configured: true, signed_in: true, email: ADMIN_USER.email, user_id: ADMIN_USER.id } });
    if (path === "/device/status") return json({ ...fixtures.device, unhandled_alerts: unhandled });
    if (path === "/device/readings") return json({ hours: 24, items: [] });
    if (path === "/alerts/count") return json({ unhandled });
    if (path === "/alerts") return json({ items: state.alerts, unhandled, open: state.alerts.filter((a) => a.status !== "resolved").length, by_category: { environment: 0, medicine: state.alerts.length, system: 0 } });
    if (path === "/catalog/status") return json({ count: 55005, source_path: "DAV_unique.xlsx", default_source: null, last_import: null, progress: { running: false, stage: "idle", rows_read: 0, rows_total: null, percent: null, message: "", file: null, last_result: null } });
    if (path === "/ai/status") return json({ provider: state.aiProvider, configured: true, models: ["gemini-3.5-flash"], search_available: state.aiSearch, last_error: state.aiSearch ? null : "Gemini chưa cho phép tìm kiếm trên mạng", web_search: { provider: "tavily", configured: true, last_error: null } });
    if (path.startsWith("/ai/scans/")) return json({
      status: "found", kind: "scan", mode: state.aiProvider === "tavily" ? "search" : state.aiSearch ? "web" : "offline",
      model: state.aiProvider === "tavily" ? "tavily" : "gemini-3.5-flash", cached: false, elapsed_ms: 4200,
      result: { found: true, ten_thuoc: "Augmentin 625mg", hoat_chat: "Amoxicillin; Acid clavulanic", ham_luong: "500mg/125mg", dang_bao_che: "Viên nén bao phim", quy_cach: "Hộp 2 vỉ x 7 viên", so_dang_ky: "VN-20169-16", nha_san_xuat: "GSK", nuoc_san_xuat: "Anh", do_tin_cay: "cao", ghi_chu: null },
      sources: [{ title: "nhathuoc.example", url: "https://example.com/augmentin" }],
      catalog_matches: [{ id: 34382, ten_thuoc: "Augmentin 625mg tablets", hoat_chat_chinh: null, ham_luong: "500mg/125mg", ham_luong_source: "hamLuong", dang_bao_che: null, so_dang_ky: "VN-20169-16", ten_cong_ty_san_xuat: null, nuoc_san_xuat: null, dong_goi: null, registration_status: { code: "valid", label: "Số đăng ký còn hiệu lực" }, in_source: true, match_by: "registration" }],
      message: "AI đã tìm thấy thông tin trên mạng.", reason: null, notice: "Thông tin do AI tổng hợp từ Internet, có thể chưa chính xác. Hãy đối chiếu với vỏ hộp và hỏi dược sĩ trước khi dùng thuốc.",
    });
    if (path === "/catalog/barcodes/status") return json({ barcodes: state.barcodes, medicines_with_barcode: state.barcodes ? 4 : 0, catalog_total: 55005, last_import: null });
    if (path === "/catalog/barcodes/import") {
      const dry = (body as { dry_run?: string } | null)?.dry_run !== "false";
      if (!dry) state.barcodes += 5;
      return json({
        dry_run: dry, file_name: "nha_thuoc.xlsx", sheet: "Sheet1", columns: { barcode: "Mã vạch", registration: "Số ĐK", name: "Tên hàng hóa" },
        catalog_total: 55005, rows_total: 12, rows_with_barcode: 11, codes_total: 12, matched_rows: 8, by_registration: 7, by_name: 1,
        linked: 5, unchanged: 0, conflicts: 1, ambiguous: 2, unmatched: 1, invalid: 1, internal: 1, import_id: dry ? null : 1,
        issues: [{ row: 7, barcode: "8935206010168", registration: "VN-19068-15", name: "Efferalgan", reason: "ambiguous", message: "Số đăng ký VN-19068-15 ứng với 2 thuốc trong danh mục, tên/hàm lượng không đủ để phân biệt." }],
        samples: [],
      });
    }
    if (path === "/catalog/barcodes/lookup") {
      const code = url.searchParams.get("code") ?? "";
      return json(state.barcodes ? {
        status: "found", code, gtin: `0${code}`, message: "", link: { source: "excel", match_method: "registration", unit: "Hộp", import_id: 1 },
        medicine: { id: 34382, ten_thuoc: "Augmentin 625mg tablets", hoat_chat_chinh: null, ham_luong: "500mg/125mg", ham_luong_source: "hamLuong", dang_bao_che: null, so_dang_ky: "VN-20169-16", ten_cong_ty_san_xuat: null, nuoc_san_xuat: null, dong_goi: null, registration_status: { code: "valid", label: "Số đăng ký còn hiệu lực" }, in_source: true },
      } : { status: "not_found", code, gtin: `0${code}`, message: `Mã vạch ${code} chưa có trong dữ liệu.`, medicine: null, link: null });
    }
    if (path.startsWith("/catalog/barcodes/") && method === "DELETE") {
      state.barcodes = Math.max(0, state.barcodes - 1);
      return json({ deleted: true, gtin: decodeURIComponent(path.split("/").pop() ?? "") });
    }
    if (path === "/ocr/status") return json({ state: "ready", error: null, dependencies: { paddleocr: true, onnxruntime: true, paddle: false }, engine: { library: "PaddleOCR", version: "3.7.0", recognition_model: "PP-OCRv6_small_rec" }, queue_size: 0 });
    if (path.startsWith("/ocr/jobs/")) return state.job ? json(state.job) : json({ detail: "Không tìm thấy lần quét này (có thể đã hết hạn)." }, 404);
    if (path === "/cabinet/medicines" && method === "GET") return json({ items: state.cabinet, total: state.cabinet.length, page: 1, page_size: 20, pages: 1, counts });
    if (path === "/cabinet/medicines" && method === "POST") return json(cabinetItem({ id: 99 }), 201);
    if (path === "/cabinet/summary") return json({ counts, expiry_warning_days: 30 });
    if (path.startsWith("/cabinet/medicines/")) return state.cabinet[0] ? json({ ...state.cabinet[0], catalog: null }) : json({ detail: "Không tìm thấy thuốc này trong tủ." }, 404);
    if (path === "/reminders") return json({ items: [] });
    if (path === "/reminders/schedule") return json({ from: "2026-11-09", to: "2026-11-15", today: "2026-11-10", items: [] });
    if (path === "/history") return json({ items: [], total: 0, page: 1, page_size: 8, pages: 1 });
    if (path === "/backup") return json({ items: [], directory: "D:/smc/backups", copy_directory: null, keep_automatic: 14, last_automatic: null, restore_hint: "python -m app.cli backup restore <tên-file>.dump" });
    // ---- Quản trị ----
    const connection = { websocket_url: "wss://api.example.com/api/v1/device/ws", public_base_url: "https://api.example.com", note: null };
    if (path === "/devices" && method === "GET") return json({ items: state.devices, connection });
    if (path === "/devices" && method === "POST") {
      const created = deviceInfo({ id: "dev-new", name: String((body as { name: string }).name), online: false, last_seen_at: null, is_primary: state.devices.length === 0, capabilities: [], supported_actions: [] });
      state.devices.push(created);
      return json({ device: created, token: "smcdev_TEST_TOKEN_ONLY_SHOWN_ONCE", connection }, 201);
    }
    if (/^\/devices\/[^/]+$/.test(path) && method === "GET") {
      const found = state.devices.find((d) => path.endsWith(d.id));
      return found ? json({ device: found, snapshot: { ...fixtures.device, enabled: true, configured: true, state: "connected", temperature: 25.5, humidity: 61, device_id: found.id }, connection }) : json({ detail: "Không tìm thấy thiết bị." }, 404);
    }
    if (/^\/devices\/[^/]+\/commands$/.test(path) && method === "GET") return json({ items: [] });
    if (/^\/devices\/[^/]+\/commands$/.test(path) && method === "POST") {
      commandPolls = 0;
      return json({ ...command("sent"), delivered: true }, 202);
    }
    if (path === "/commands/cmd-1") {
      const status = state.commandStatuses[Math.min(commandPolls, state.commandStatuses.length - 1)];
      commandPolls += 1;
      return json(command(status));
    }
    if (path === "/device/actions") return json({ items: [] });
    if (path === "/admin/users" && method === "GET") return json({ items: state.users, total: state.users.length, limit: 20, offset: 0 });
    if (path === "/admin/users" && method === "POST") {
      const input = body as { email: string; full_name: string; role: string };
      const created = { ...ADMIN_USER, id: `u-${state.users.length + 1}`, email: input.email, full_name: input.full_name, role: input.role, role_name: input.role === "ADMIN" ? "Quản trị viên" : "Người quét", active_sessions: 0, last_login_at: null };
      state.users.unshift(created);
      return json({ user: created }, 201);
    }
    if (path === "/admin/audit") return json({ total: state.audit.length, items: state.audit });
    if (path === "/admin/scans") return json({ total: 0, items: [] });
    if (path === "/notifications/pending") return json({ items: [], windows_notifications: false, sound: false, unhandled_alerts: unhandled });
    if (path.startsWith("/medicines/search")) return json({ items: [], total: 0, query: "", mode: "text", catalog_count: 55005 });
    return json({ detail: `Chưa giả lập ${method} ${path}` }, 404);
  }));
  return state;
}
