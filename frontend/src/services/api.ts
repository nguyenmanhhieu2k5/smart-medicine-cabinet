import type {
  AlertList, AppSettings, BackupInfo, CabinetInput, CabinetItem, CabinetList, CatalogStatus, DeviceStatus, Health,
  HistoryEvent, HistoryList, MedicineDetail, OcrJob, OcrStatus, PendingNotifications, Profile, Reminder,
  ReminderInput, Schedule, SearchResult, SensorPoint, SettingsPatch, SettingsResponse,
} from "@/types/api";
import type { BackendInfo } from "@/types/desktop";

/** Lỗi API kèm thông báo tiếng Việt từ backend. */
export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

const DEV_BASE = (import.meta.env.VITE_API_URL as string | undefined) ?? "http://127.0.0.1:8756";
let backend: { baseUrl: string; token: string } = { baseUrl: DEV_BASE, token: "" };
let backendPromise: Promise<BackendInfo | null> | null = null;

/**
 * Lấy địa chỉ + token backend từ Electron (nếu có); trình duyệt dev dùng cổng mặc định.
 * Trong Electron, lời gọi này chờ tới khi dịch vụ nền sẵn sàng hoặc báo lỗi khởi động.
 */
export function initBackend(): Promise<BackendInfo | null> {
  if (!backendPromise) {
    backendPromise = (async () => {
      if (!window.smc) return null;
      const info = await window.smc.getBackend();
      if (info.baseUrl) backend = { baseUrl: info.baseUrl, token: info.token };
      return info;
    })();
  }
  return backendPromise;
}

export function apiUrl(path: string, params?: Record<string, string | number | boolean | null | undefined>): string {
  const url = new URL(backend.baseUrl + "/api" + path);
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
  }
  return url.toString();
}

/** URL cho thẻ <img>: token đi qua tham số vì thẻ ảnh không gửi được header. */
export function assetUrl(path: string, cacheKey?: string | number): string {
  return apiUrl(path, { token: backend.token || undefined, v: cacheKey });
}

async function request<T>(
  method: string,
  path: string,
  options: { params?: Record<string, string | number | boolean | null | undefined>; body?: unknown; form?: FormData; signal?: AbortSignal } = {},
): Promise<T> {
  await initBackend();
  const headers: Record<string, string> = {};
  if (backend.token) headers["X-SMC-Token"] = backend.token;
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
    throw new ApiError("Không kết nối được dịch vụ nền của ứng dụng.", 0);
  }
  if (!response.ok) {
    let message = `Lỗi ${response.status}`;
    try {
      const data = await response.json();
      if (typeof data.detail === "string") message = data.detail;
    } catch {
      /* giữ thông báo mặc định */
    }
    throw new ApiError(message, response.status);
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

async function download(path: string, params?: Record<string, string>): Promise<{ blob: Blob; filename: string }> {
  await initBackend();
  const response = await fetch(apiUrl(path, params), { headers: backend.token ? { "X-SMC-Token": backend.token } : {} });
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

export const api = {
  health: () => request<Health>("GET", "/health"),

  // Danh mục
  searchMedicines: (q: string, limit = 20, offset = 0, signal?: AbortSignal) =>
    request<SearchResult>("GET", "/medicines/search", { params: { q, limit, offset }, signal }),
  medicine: (id: number) => request<MedicineDetail>("GET", `/medicines/${id}`),
  catalogStatus: () => request<CatalogStatus>("GET", "/catalog/status"),
  catalogImport: (path?: string | null, force = false) => request<CatalogStatus>("POST", "/catalog/import", { body: { path: path ?? null, force } }),
  catalogUpload: (file: File) => {
    const form = new FormData();
    form.append("file", file);
    return request<CatalogStatus>("POST", "/catalog/upload", { form });
  },

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

  // Thiết bị
  device: () => request<DeviceStatus>("GET", "/device/status"),
  deviceRefresh: () => request<unknown>("POST", "/device/refresh"),
  deviceTest: (body: { mode: string; host: string; port: number; path: string; timeout: number; token?: string | null }) =>
    request<{ ok: boolean; error?: string; temperature?: number | null; humidity?: number | null; simulated?: boolean }>("POST", "/device/test", { body }),
  deviceReadings: (hours = 24) => request<{ hours: number; items: SensorPoint[] }>("GET", "/device/readings", { params: { hours } }),

  // Cài đặt, hồ sơ
  settings: () => request<SettingsResponse>("GET", "/settings"),
  settingsUpdate: (body: SettingsPatch) => request<{ settings: AppSettings }>("PATCH", "/settings", { body }),
  profile: () => request<Profile>("GET", "/profile"),
  profileUpdate: (body: { name?: string; email?: string; role?: string }) => request<Profile>("PATCH", "/profile", { body }),
  avatarUpload: (file: File) => {
    const form = new FormData();
    form.append("file", file);
    return request<Profile>("POST", "/profile/avatar", { form });
  },
  avatarDelete: () => request<Profile>("DELETE", "/profile/avatar"),
  login: (email: string, password: string) => request<Profile>("POST", "/auth/login", { body: { email, password } }),
  logout: () => request<Profile>("POST", "/auth/logout"),

  // Sao lưu
  backups: () => request<{ items: BackupInfo[]; directory: string }>("GET", "/backup"),
  backupCreate: () => request<BackupInfo>("POST", "/backup"),
  backupDownload: (name: string) => download(`/backup/${encodeURIComponent(name)}/download`),
  backupDelete: (name: string) => request<unknown>("DELETE", `/backup/${encodeURIComponent(name)}`),
  backupRestore: (name: string) => request<{ restored: Record<string, number>; safety_backup: string }>("POST", "/backup/restore", { body: { name } }),
  backupRestoreUpload: (file: File) => {
    const form = new FormData();
    form.append("file", file);
    return request<{ restored: Record<string, number>; safety_backup: string }>("POST", "/backup/restore-upload", { form });
  },

  notificationsPending: () => request<PendingNotifications>("POST", "/notifications/pending"),
};
