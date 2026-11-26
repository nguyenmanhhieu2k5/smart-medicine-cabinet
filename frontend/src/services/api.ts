import type {
  ActionSpec, AdminScan, AdminUser, AiLookupResult, AiStatus, TtsStatus, AlertList, AppSettings, AuditEntry, BackupInfo, BackupList, BarcodeImportReport, BarcodeLookup,
  BarcodeStatus, CabinetInput, CabinetItem,
  CabinetList, CatalogStatus, DeviceCommand, DeviceConnection, DeviceInfo, DeviceList, DeviceStatus, DeviceTokenResult, Health,
  HistoryEvent, HistoryList, MedicineDetail, OcrJob, OcrStatus, PendingNotifications, Profile, Reminder, ReminderInput, Schedule,
  SearchResult, SensorPoint, SettingsPatch, SettingsResponse, SystemStatus, UserCreateInput, UserList, UserPatchInput,
  UserSessionInfo,
} from "@/types/api";
import type { AccountInfo, BackendInfo } from "@/types/desktop";

/** Lỗi API kèm thông báo tiếng Việt từ máy chủ. */
export class ApiError extends Error {
  status: number;
  code?: string;
  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

// --------------------------------------------------------------------------- //
// Kết nối + phiên đăng nhập Admin
//
// Bản Windows (Electron): tiến trình chính đăng nhập và giữ refresh token (mã hóa DPAPI); giao diện chỉ nhận
// access token ngắn hạn qua window.smc. Bản chạy trong trình duyệt (chỉ để phát triển): đăng nhập trực tiếp,
// refresh token chỉ nằm trong bộ nhớ của trang.
// --------------------------------------------------------------------------- //
const DEV_BASE = ((import.meta.env.VITE_API_URL as string | undefined) ?? "http://127.0.0.1:8001").replace(/\/+$/, "");
const DEV_CLIENT = "web-admin-dev";
const REFRESH_MARGIN_MS = 60_000;

let current: BackendInfo = { state: "signed-out", baseUrl: DEV_BASE, token: "" };
let devRefreshToken = "";
let initPromise: Promise<BackendInfo> | null = null;
let refreshPromise: Promise<BackendInfo> | null = null;
const listeners = new Set<(info: BackendInfo) => void>();

function publish(info: BackendInfo): BackendInfo {
  current = info;
  for (const listener of listeners) listener(info);
  return info;
}

/** Theo dõi thay đổi kết nối/phiên (đăng xuất, phiên hết hạn…). */
export function onConnectionChange(listener: (info: BackendInfo) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function connectionInfo(): BackendInfo {
  return current;
}

export function currentUser(): AccountInfo | null {
  return current.user ?? null;
}

function signedOut(error?: string | null): BackendInfo {
  return { state: "signed-out", baseUrl: current.baseUrl, token: "", user: null, email: current.email ?? null, error: error ?? null };
}

async function devAuth(path: "/auth/login" | "/auth/refresh", body: Record<string, string>): Promise<BackendInfo> {
  let response: Response;
  try {
    response = await fetch(`${current.baseUrl}/api${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-SMC-Client": DEV_CLIENT },
      body: JSON.stringify(body),
    });
  } catch {
    const error = `Không kết nối được máy chủ ${current.baseUrl}.`;
    return devRefreshToken ? { ...current, state: "error", token: "", error } : signedOut(error);
  }
  const data = (await response.json().catch(() => null)) as { access_token?: string; refresh_token?: string; expires_in?: number; user?: AccountInfo; detail?: string } | null;
  if (response.ok && data?.access_token) {
    devRefreshToken = data.refresh_token ?? "";
    return {
      state: "ready", baseUrl: current.baseUrl, token: data.access_token, user: data.user ?? null, email: data.user?.email ?? null,
      expiresAt: new Date(Date.now() + (data.expires_in ?? 900) * 1000).toISOString(), error: null,
    };
  }
  if (response.status === 401 || response.status === 403) devRefreshToken = "";
  return signedOut(typeof data?.detail === "string" ? data.detail : `Lỗi ${response.status}`);
}

export const connection = {
  /** Lấy trạng thái ban đầu (Electron tự khôi phục phiên đã lưu). Gọi nhiều lần vẫn chỉ chạy một lần. */
  init(): Promise<BackendInfo> {
    if (!initPromise) initPromise = (async () => publish(window.smc ? await window.smc.getBackend() : current))();
    return initPromise;
  },
  /** Thử kết nối lại (sau lỗi mạng). */
  retry(): Promise<BackendInfo> {
    initPromise = null;
    return connection.init();
  },
  async setServer(url: string): Promise<BackendInfo> {
    if (!window.smc) return current;
    return publish(await window.smc.setServer(url));
  },
  async forgetServer(): Promise<BackendInfo> {
    if (!window.smc) return current;
    return publish(await window.smc.forgetServer());
  },
  async login(email: string, password: string): Promise<BackendInfo> {
    const info = window.smc ? await window.smc.login(email, password) : await devAuth("/auth/login", { email, password });
    return publish(info);
  },
  /** Làm mới access token (gộp các lời gọi đồng thời thành một). */
  refresh(): Promise<BackendInfo> {
    if (!refreshPromise) {
      refreshPromise = (async () => {
        let info: BackendInfo;
        if (window.smc) info = await window.smc.refreshSession();
        else if (devRefreshToken) info = await devAuth("/auth/refresh", { refresh_token: devRefreshToken });
        else info = signedOut("Phiên đăng nhập đã hết hạn. Hãy đăng nhập lại.");
        return publish(info);
      })().finally(() => {
        refreshPromise = null;
      });
    }
    return refreshPromise;
  },
  async logout(): Promise<BackendInfo> {
    if (window.smc) return publish(await window.smc.logout());
    const token = devRefreshToken;
    devRefreshToken = "";
    if (token) {
      await fetch(`${current.baseUrl}/api/auth/logout`, {
        method: "POST", headers: { "Content-Type": "application/json", "X-SMC-Client": DEV_CLIENT }, body: JSON.stringify({ refresh_token: token }),
      }).catch(() => undefined);
    }
    return publish(signedOut());
  },
};

export function apiUrl(path: string, params?: Record<string, string | number | boolean | null | undefined>): string {
  const url = new URL(current.baseUrl + "/api" + path);
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
  }
  return url.toString();
}

/** URL cho thẻ <img>: thẻ ảnh không gửi được header nên access token (ngắn hạn, chỉ GET) đi qua tham số. */
export function assetUrl(path: string, cacheKey?: string | number): string {
  return apiUrl(path, { access_token: current.token || undefined, v: cacheKey });
}

type RequestOptions = {
  params?: Record<string, string | number | boolean | null | undefined>;
  body?: unknown;
  form?: FormData;
  signal?: AbortSignal;
};

async function send(method: string, path: string, options: RequestOptions, retried = false): Promise<Response> {
  if (current.state === "ready" && current.expiresAt && Date.parse(current.expiresAt) - Date.now() < REFRESH_MARGIN_MS) {
    await connection.refresh(); // access token sắp hết hạn → lấy token mới trước khi gọi
  }
  const headers: Record<string, string> = {};
  if (current.token) headers.Authorization = `Bearer ${current.token}`;
  let body: BodyInit | undefined;
  if (options.form) body = options.form;
  else if (options.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(options.body);
  }
  let response: Response;
  try {
    response = await fetch(apiUrl(path, options.params), { method, headers, body, signal: options.signal });
  } catch (error) {
    if ((error as Error).name === "AbortError") throw error;
    throw new ApiError("Không kết nối được máy chủ Mini PC. Kiểm tra Tailscale và kết nối mạng.", 0);
  }
  if (response.status === 401 && current.token && !retried) {
    const info = await connection.refresh(); // token hết hạn/bị thu hồi → thử làm mới đúng một lần
    if (info.state === "ready") return send(method, path, options, true);
  }
  return response;
}

async function request<T>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
  const response = await send(method, path, options);
  if (!response.ok) {
    let message = `Lỗi ${response.status}`;
    let code: string | undefined;
    try {
      const data = await response.json();
      if (typeof data.detail === "string") message = data.detail;
      if (typeof data.code === "string") code = data.code;
    } catch {
      /* giữ thông báo mặc định */
    }
    throw new ApiError(message, response.status, code);
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

/** Giọng đọc tự nhiên của máy chủ: trả file WAV để phát. */
async function speechAudio(text: string, speed: number): Promise<Blob> {
  const response = await send("POST", "/tts", { body: { text, speed } });
  if (!response.ok) {
    let message = "Máy chủ không đọc được đoạn này.";
    try {
      const data = await response.json();
      if (typeof data.detail === "string") message = data.detail;
    } catch {
      /* giữ thông báo mặc định */
    }
    throw new ApiError(message, response.status);
  }
  return response.blob();
}

async function download(path: string, params?: Record<string, string>): Promise<{ blob: Blob; filename: string }> {
  const response = await send("GET", path, { params });
  if (!response.ok) throw new ApiError("Không tải được file.", response.status);
  const disposition = response.headers.get("Content-Disposition") ?? "";
  const match = /filename="?([^";]+)"?/.exec(disposition);
  return { blob: await response.blob(), filename: match?.[1] ?? "download" };
}

export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

type Page = { limit?: number; offset?: number };

export const api = {
  health: () => request<Health>("GET", "/health"),

  // Danh mục
  searchMedicines: (q: string, limit = 20, offset = 0, signal?: AbortSignal) =>
    request<SearchResult>("GET", "/medicines/search", { params: { q, limit, offset }, signal }),
  medicine: (id: number) => request<MedicineDetail>("GET", `/medicines/${id}`),
  catalogStatus: () => request<CatalogStatus>("GET", "/catalog/status"),
  /** Nhập lại từ file nguồn đã cấu hình TRÊN MÁY CHỦ (đường dẫn trên Mini PC). */
  catalogImport: (path?: string | null, force = false) => request<CatalogStatus>("POST", "/catalog/import", { body: { path: path ?? null, force } }),
  /** Tải file Excel từ máy Windows lên máy chủ rồi nhập. */
  catalogUpload: (file: File) => {
    const form = new FormData();
    form.append("file", file);
    return request<CatalogStatus>("POST", "/catalog/upload", { form });
  },
  // Mã vạch → thuốc có sẵn trong danh mục (file Excel/CSV của nhà thuốc)
  barcodeStatus: () => request<BarcodeStatus>("GET", "/catalog/barcodes/status"),
  /** dryRun = true: chỉ kiểm tra và báo cáo, máy chủ không ghi gì. */
  barcodeImport: (file: File, dryRun: boolean) => {
    const form = new FormData();
    form.append("file", file);
    form.append("dry_run", String(dryRun));
    return request<BarcodeImportReport>("POST", "/catalog/barcodes/import", { form });
  },
  barcodeLookup: (code: string) => request<BarcodeLookup>("GET", "/catalog/barcodes/lookup", { params: { code } }),
  barcodeDelete: (gtin: string) => request<{ deleted: boolean; gtin: string }>("DELETE", `/catalog/barcodes/${encodeURIComponent(gtin)}`),
  // AI tra cứu trên mạng (máy chủ gọi Gemini; ứng dụng Windows không giữ khóa AI)
  aiStatus: () => request<AiStatus>("GET", "/ai/status"),
  ttsStatus: () => request<TtsStatus>("GET", "/tts/status"),
  ttsAudio: (text: string, speed = 1) => speechAudio(text, speed),
  aiScan: (jobId: string) => request<AiLookupResult>("POST", `/ai/scans/${jobId}`),
  aiLookup: (kind: "barcode" | "qr", code: string) => request<AiLookupResult>("POST", "/ai/lookup", { body: { kind, code } }),

  // OCR
  ocrSubmit: (image: Blob, source: "camera" | "upload", crop?: number[] | null) => {
    const form = new FormData();
    form.append("file", image, source === "camera" ? "camera.jpg" : ((image as File).name ?? "upload.jpg"));
    form.append("source", source);
    if (crop) form.append("crop", JSON.stringify(crop));
    return request<OcrJob>("POST", "/ocr", { form });
  },
  ocrJob: (id: string) => request<OcrJob>("GET", `/ocr/jobs/${id}`),
  ocrStatus: () => request<OcrStatus>("GET", "/ocr/status"),
  ocrWarmup: () => request<OcrStatus>("POST", "/ocr/warmup"),

  // Tủ thuốc
  cabinetList: (params: { q?: string; status?: string; sort?: string; page?: number; page_size?: number }) =>
    request<CabinetList>("GET", "/cabinet/medicines", { params }),
  cabinetSummary: () => request<{ counts: CabinetList["counts"]; expiry_warning_days: number }>("GET", "/cabinet/summary"),
  cabinetItem: (id: number) => request<CabinetItem>("GET", `/cabinet/medicines/${id}`),
  cabinetCreate: (body: CabinetInput) => request<CabinetItem>("POST", "/cabinet/medicines", { body }),
  cabinetUpdate: (id: number, body: CabinetInput) => request<CabinetItem>("PATCH", `/cabinet/medicines/${id}`, { body }),
  cabinetAdjust: (id: number, delta: number, reason?: string) => request<CabinetItem>("POST", `/cabinet/medicines/${id}/adjust`, { body: { delta, reason } }),
  cabinetDelete: (id: number) => request<{ deleted: boolean }>("DELETE", `/cabinet/medicines/${id}`),
  cabinetExport: (format: "xlsx" | "csv", status = "all") => download("/cabinet/export", { format, status }),

  // Lời nhắc
  reminders: () => request<{ items: Reminder[] }>("GET", "/reminders"),
  schedule: (from: string, to: string) => request<Schedule>("GET", "/reminders/schedule", { params: { from, to } }),
  reminderCreate: (body: ReminderInput) => request<Reminder>("POST", "/reminders", { body }),
  reminderUpdate: (id: number, body: ReminderInput) => request<Reminder>("PATCH", `/reminders/${id}`, { body }),
  reminderDelete: (id: number) => request<{ deleted: boolean }>("DELETE", `/reminders/${id}`),
  reminderLog: (id: number, scheduled_for: string, status: "taken" | "skipped" | "pending") =>
    request<unknown>("POST", `/reminders/${id}/log`, { body: { scheduled_for, status } }),

  // Cảnh báo
  alerts: (params: { scope?: string; category?: string; severity?: string } = {}) => request<AlertList>("GET", "/alerts", { params }),
  alertCount: () => request<{ unhandled: number }>("GET", "/alerts/count"),
  alertUpdate: (id: number, status: "seen" | "acknowledged") => request<unknown>("PATCH", `/alerts/${id}`, { body: { status } }),
  alertMarkAll: (status: "seen" | "acknowledged") => request<{ updated: number }>("POST", "/alerts/mark-all", { body: { status } }),
  alertReport: (type: "camera_error", message: string, resolved = false) => request<unknown>("POST", "/alerts/report", { body: { type, message, resolved } }),

  // Lịch sử
  history: (params: { q?: string; group?: string; from?: string; to?: string; page?: number; page_size?: number }) =>
    request<HistoryList>("GET", "/history", { params }),
  historyEvent: (id: number) => request<HistoryEvent>("GET", `/history/${id}`),
  historyDelete: (id: number) => request<unknown>("DELETE", `/history/${id}`),
  historyClear: () => request<{ deleted: number; removed_images: number }>("DELETE", "/history"),

  // Tủ chính (thiết bị ESP32 chính) — tương thích Trang chủ / Cảnh báo
  device: () => request<DeviceStatus>("GET", "/device/status"),
  deviceRefresh: () => request<unknown>("POST", "/device/refresh"),
  deviceReadings: (hours = 24, deviceId?: string) => request<{ hours: number; items: SensorPoint[] }>("GET", "/device/readings", { params: { hours, device_id: deviceId } }),

  // Thiết bị ESP32 + lệnh qua Internet (chỉ kênh Admin)
  devices: () => request<DeviceList>("GET", "/devices"),
  deviceDetail: (id: string) => request<{ device: DeviceInfo; snapshot: DeviceStatus; connection: DeviceConnection }>("GET", `/devices/${id}`),
  deviceCreate: (body: { name: string; note?: string | null }) => request<DeviceTokenResult>("POST", "/devices", { body }),
  deviceUpdate: (id: string, body: { name?: string; note?: string | null; is_active?: boolean; is_primary?: boolean }) =>
    request<{ device: DeviceInfo }>("PATCH", `/devices/${id}`, { body }),
  deviceRotateToken: (id: string) => request<DeviceTokenResult>("POST", `/devices/${id}/token`),
  deviceDelete: (id: string) => request<{ deleted: boolean }>("DELETE", `/devices/${id}`),
  deviceTelemetry: (id: string, hours = 24) => request<{ hours: number; items: SensorPoint[] }>("GET", `/devices/${id}/telemetry`, { params: { hours } }),
  deviceActions: () => request<{ items: ActionSpec[] }>("GET", "/device/actions"),
  deviceCommands: (id: string, limit = 30) => request<{ items: DeviceCommand[] }>("GET", `/devices/${id}/commands`, { params: { limit } }),
  deviceCommandSend: (id: string, action: string, payload: Record<string, unknown>, ttlSeconds?: number) =>
    request<DeviceCommand>("POST", `/devices/${id}/commands`, { body: { action, payload, ttl_seconds: ttlSeconds ?? null } }),
  command: (id: string) => request<DeviceCommand>("GET", `/commands/${id}`),
  commandCancel: (id: string) => request<DeviceCommand>("POST", `/commands/${id}/cancel`),

  // Cài đặt, hồ sơ, tài khoản đang đăng nhập
  settings: () => request<SettingsResponse>("GET", "/settings"),
  settingsUpdate: (body: SettingsPatch) => request<{ settings: AppSettings }>("PATCH", "/settings", { body }),
  profile: () => request<Profile>("GET", "/profile"),
  profileUpdate: (body: { name?: string; phone?: string | null }) => request<Profile>("PATCH", "/profile", { body }),
  avatarUpload: (file: File) => {
    const form = new FormData();
    form.append("file", file);
    return request<Profile>("POST", "/profile/avatar", { form });
  },
  avatarDelete: () => request<Profile>("DELETE", "/profile/avatar"),
  me: () => request<{ user: AccountInfo; channel: string }>("GET", "/auth/me"),
  changePassword: (current_password: string, new_password: string) =>
    request<{ ok: boolean }>("POST", "/auth/password", { body: { current_password, new_password } }),

  // Quản lý tài khoản (ADMIN / SCANNER)
  users: (params: { q?: string; role?: string } & Page = {}) => request<UserList>("GET", "/admin/users", { params }),
  user: (id: string) => request<{ user: AdminUser; sessions: UserSessionInfo[] }>("GET", `/admin/users/${id}`),
  userCreate: (body: UserCreateInput) => request<{ user: AdminUser }>("POST", "/admin/users", { body }),
  userUpdate: (id: string, body: UserPatchInput) => request<{ user: AdminUser }>("PATCH", `/admin/users/${id}`, { body }),
  userSetPassword: (id: string, new_password: string) => request<{ ok: boolean }>("POST", `/admin/users/${id}/password`, { body: { new_password } }),
  userRevokeSessions: (id: string) => request<{ ok: boolean }>("POST", `/admin/users/${id}/sessions/revoke`),
  userDelete: (id: string) => request<{ deleted: boolean }>("DELETE", `/admin/users/${id}`),

  // Nhật ký kiểm toán, lượt quét của mọi tài khoản, trạng thái máy chủ
  audit: (params: { q?: string; action?: string; success?: boolean } & Page = {}) => request<{ total: number; items: AuditEntry[] }>("GET", "/admin/audit", { params }),
  adminScans: (params: { q?: string; user_id?: string } & Page = {}) => request<{ total: number; items: AdminScan[] }>("GET", "/admin/scans", { params }),
  system: () => request<SystemStatus>("GET", "/admin/system"),

  // Sao lưu PostgreSQL (khôi phục chỉ làm trên Mini PC bằng dòng lệnh)
  backups: () => request<BackupList>("GET", "/backup"),
  backupCreate: () => request<BackupInfo>("POST", "/backup"),
  backupDownload: (name: string) => download(`/backup/${encodeURIComponent(name)}/download`),
  backupDelete: (name: string) => request<unknown>("DELETE", `/backup/${encodeURIComponent(name)}`),

  notificationsPending: () => request<PendingNotifications>("POST", "/notifications/pending"),
};
