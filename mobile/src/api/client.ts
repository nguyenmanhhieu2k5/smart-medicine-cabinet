/**
 * Ứng dụng di động chỉ nói chuyện với API CÔNG KHAI /api/v1 của máy chủ Mini PC (qua Cloudflare Tunnel).
 *
 * - Mọi đường dẫn phải nằm trong danh sách endpoint của Scanner (PUBLIC_PATH) — mã nguồn mobile không có cách nào gọi
 *   API quản trị, kể cả khi đăng nhập bằng tài khoản Admin (máy chủ cũng chặn: token kênh công khai chỉ mang quyền SCANNER).
 * - Access token chỉ giữ trong bộ nhớ; refresh token nằm trong Keystore/Keychain (expo-secure-store), xoay vòng mỗi lần làm mới.
 * - Trang web: refresh token nằm trong cookie HttpOnly do máy chủ đặt (JavaScript không đọc được); khách chưa đăng nhập
 *   quét thử qua /guest/... kèm header X-Guest-Id (mã ngẫu nhiên của trình duyệt), hết lượt → lỗi code "guest_limit".
 */
import { File as FsFile } from "expo-file-system";
import { Platform } from "react-native";
import { KEYS, type KeyValueStore } from "./storage";
import type {
  AiLookupResult, AppConfig, BarcodeResult, CabinetList, CabinetMedicine, GuestQuota, HistoryFilter, HistoryItem, HistoryPage, MedicineDetail, ScanJob,
  TokenResponse, User, UserPreferences,
} from "./types";

export type ApiErrorKind = "network" | "timeout" | "http" | "auth";

export class ApiError extends Error {
  kind: ApiErrorKind;
  status: number;
  code?: string;
  constructor(message: string, kind: ApiErrorKind, status = 0, code?: string) {
    super(message);
    this.name = "ApiError";
    this.kind = kind;
    this.status = status;
    this.code = code;
  }
}

/** Các endpoint mà ứng dụng Scanner được phép gọi (tương ứng backend/app/api/public.py). */
export const PUBLIC_PATH =
  /^\/(health|app\/config|auth\/(login|register|refresh|logout|password\/(forgot|reset))|me(\/password)?|catalog\/(search|\d+)|barcodes\/lookup|ai\/(lookup|scans\/[0-9a-f-]{36})|cabinet\/medicines(\/\d+\/expiry)?|scans(\/[0-9a-f-]{36}(\/thumbnail)?)?|history(\/[0-9a-f-]{36}(\/select)?)?|guest\/(status|scans(\/[0-9a-f-]{36}(\/thumbnail)?)?|barcodes\/lookup|catalog\/\d+|ai\/(lookup|scans\/[0-9a-f-]{36})))$/;

/** Lỗi do khách dùng hết lượt quét thử → trang web chuyển sang đăng nhập. */
export function isGuestLimit(error: unknown): boolean {
  return error instanceof ApiError && error.code === "guest_limit";
}

export function assertPublicPath(path: string): void {
  if (!PUBLIC_PATH.test(path)) throw new Error(`Đường dẫn không thuộc API công khai của Scanner: ${path}`);
}

type Query = Record<string, string | number | boolean | null | undefined>;
interface RequestOptions {
  query?: Query;
  json?: unknown;
  form?: FormData;
  auth?: boolean;
  headers?: Record<string, string>;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** Trang web: refresh token nằm trong cookie HttpOnly — giá trị giữ chỗ cho biết "đang có phiên". */
const WEB_SESSION = "cookie";

/** Trang web có phiên đăng nhập không (cookie "smc_web" không chứa bí mật, đi kèm cookie phiên HttpOnly). */
function webSessionCookie(): boolean {
  return typeof document !== "undefined" && /(?:^|;\s*)smc_web=1(?:;|$)/.test(document.cookie ?? "");
}

export type SessionEndReason = "expired" | "logout";
export interface PickedImage {
  uri: string;
  mimeType?: string | null;
  fileName?: string | null;
}

const DEFAULT_TIMEOUT = 20_000;
const CLIENT = Platform.OS === "web" ? "mobile-web" : `mobile-${Platform.OS}`;

export class ScannerApi {
  private baseUrl = "";
  private accessToken = "";
  private accessExpiresAt = 0;
  private refreshToken = "";
  private refreshing: Promise<boolean> | null = null;
  private listeners = new Set<(reason: SessionEndReason) => void>();
  private guestId = "";
  private guestListeners = new Set<(quota: GuestQuota) => void>();
  private readonly web: boolean;
  private readonly hasWebSession: () => boolean;

  constructor(
    private store: KeyValueStore,
    private fetchImpl: typeof fetch = (...args) => fetch(...args),
    options: { web?: boolean; webSession?: () => boolean } = {},
  ) {
    this.web = options.web ?? Platform.OS === "web";
    this.hasWebSession = options.webSession ?? webSessionCookie;
  }

  // ---- cấu hình --------------------------------------------------------------------------- //
  setBaseUrl(url: string): void {
    this.baseUrl = url.replace(/\/+$/, "");
  }

  getBaseUrl(): string {
    return this.baseUrl;
  }

  isSignedIn(): boolean {
    return Boolean(this.refreshToken);
  }

  /** Trang web: mã khách (UUID của trình duyệt) để quét thử khi chưa đăng nhập; null = tắt chế độ khách. */
  setGuestId(id: string | null): void {
    this.guestId = id ?? "";
  }

  /** Đang quét thử (chưa đăng nhập, có mã khách): mọi thao tác quét đi qua /guest/... */
  isGuest(): boolean {
    return !this.refreshToken && Boolean(this.guestId);
  }

  /** Báo số lượt quét thử còn lại sau mỗi lần quét của khách (kể cả khi hết lượt). */
  onGuestQuota(listener: (quota: GuestQuota) => void): () => void {
    this.guestListeners.add(listener);
    return () => {
      this.guestListeners.delete(listener);
    };
  }

  private emitGuest(quota: GuestQuota | undefined | null): void {
    if (quota && typeof quota.remaining === "number") for (const listener of this.guestListeners) listener(quota);
  }

  /** Đường dẫn + cách xác thực cho thao tác quét: tài khoản → /scans…; khách → /guest/scans… kèm X-Guest-Id. */
  private scanRoute(path: string): { path: string; auth: boolean; headers?: Record<string, string> } {
    if (this.isGuest()) return { path: `/guest${path}`, auth: false, headers: { "X-Guest-Id": this.guestId } };
    return { path, auth: true };
  }

  /** Báo khi phiên kết thúc ngoài ý muốn (bị thu hồi, hết hạn) để giao diện quay về màn hình đăng nhập. */
  onSessionEnd(listener: (reason: SessionEndReason) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  url(path: string, query?: Query): string {
    assertPublicPath(path);
    if (!this.baseUrl) throw new ApiError("Chưa cấu hình địa chỉ máy chủ.", "network");
    const qs = Object.entries(query ?? {})
      .filter(([, v]) => v !== undefined && v !== null && v !== "")
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
      .join("&");
    return `${this.baseUrl}/api/v1${path}${qs ? `?${qs}` : ""}`;
  }

  /** Header cho ảnh cần xác thực (ảnh thu nhỏ của lượt quét). */
  async authHeaders(): Promise<Record<string, string>> {
    if (this.isGuest()) return { "X-Guest-Id": this.guestId };
    await this.ensureFreshToken();
    return this.accessToken ? { Authorization: `Bearer ${this.accessToken}` } : {};
  }

  // ---- phiên đăng nhập -------------------------------------------------------------------- //
  private async applyTokens(data: TokenResponse): Promise<void> {
    this.accessToken = data.access_token;
    this.accessExpiresAt = Date.now() + Math.max(60, data.expires_in) * 1000;
    // Trang web: máy chủ giữ refresh token trong cookie HttpOnly (không trả trong JSON).
    this.refreshToken = data.refresh_token || (this.web ? WEB_SESSION : "");
    if (data.refresh_token) await this.store.set(KEYS.refreshToken, data.refresh_token);
    if (data.user?.email) await this.store.set(KEYS.lastEmail, data.user.email);
  }

  private async clearSession(): Promise<void> {
    this.accessToken = "";
    this.accessExpiresAt = 0;
    this.refreshToken = "";
    await this.store.remove(KEYS.refreshToken);
  }

  /** Khôi phục phiên đã lưu. Trả về false nếu không có phiên; ném ApiError(network) nếu không tới được máy chủ. */
  async restore(): Promise<boolean> {
    if (this.web) {
      // Trang web: phiên nằm trong cookie HttpOnly; không có cookie đánh dấu thì khỏi gọi máy chủ.
      if (!this.hasWebSession()) return false;
      this.refreshToken = WEB_SESSION;
      return this.refresh({ throwOnNetwork: true, silent: true });
    }
    this.refreshToken = (await this.store.get(KEYS.refreshToken)) ?? "";
    if (!this.refreshToken) return false;
    return this.refresh({ throwOnNetwork: true });
  }

  async login(email: string, password: string): Promise<TokenResponse> {
    const data = await this.request<TokenResponse>("POST", "/auth/login", { json: { email: email.trim(), password }, auth: false });
    await this.applyTokens(data);
    return data;
  }

  async register(fullName: string, email: string, password: string): Promise<TokenResponse> {
    const data = await this.request<TokenResponse>("POST", "/auth/register", {
      json: { full_name: fullName.trim(), email: email.trim(), password }, auth: false,
    });
    await this.applyTokens(data);
    return data;
  }

  async logout(): Promise<void> {
    const token = this.refreshToken;
    await this.clearSession();
    if (token) {
      // Thu hồi phiên trên máy chủ (trang web: máy chủ đọc và xóa cookie); mất mạng thì phiên vẫn bị xóa khỏi máy và tự hết hạn.
      const json = token === WEB_SESSION ? {} : { refresh_token: token };
      await this.request("POST", "/auth/logout", { json, auth: false, timeoutMs: 8000 }).catch(() => undefined);
    }
    for (const listener of this.listeners) listener("logout");
  }

  /** Làm mới access token (gộp các lời gọi đồng thời). silent: phiên cũ không còn thì chỉ đăng xuất, không báo "hết hạn". */
  refresh(options: { throwOnNetwork?: boolean; silent?: boolean } = {}): Promise<boolean> {
    if (!this.refreshing) {
      this.refreshing = (async () => {
        if (!this.refreshToken) return false;
        try {
          const json = this.refreshToken === WEB_SESSION ? {} : { refresh_token: this.refreshToken };
          const data = await this.request<TokenResponse>("POST", "/auth/refresh", { json, auth: false });
          await this.applyTokens(data);
          return true;
        } catch (error) {
          if (error instanceof ApiError && (error.kind === "network" || error.kind === "timeout" || error.status >= 500)) {
            if (options.throwOnNetwork) throw error;
            return false; // giữ refresh token để thử lại khi có mạng
          }
          await this.clearSession();
          if (!options.silent) for (const listener of this.listeners) listener("expired");
          return false;
        }
      })().finally(() => {
        this.refreshing = null;
      });
    }
    return this.refreshing;
  }

  private async ensureFreshToken(): Promise<void> {
    if (this.refreshToken && (!this.accessToken || this.accessExpiresAt - Date.now() < 60_000)) await this.refresh();
  }

  // ---- HTTP ------------------------------------------------------------------------------- //
  async request<T>(method: string, path: string, options: RequestOptions = {}, retried = false): Promise<T> {
    const auth = options.auth ?? true;
    if (auth) await this.ensureFreshToken();
    const url = this.url(path, options.query);
    const headers: Record<string, string> = { Accept: "application/json", "X-SMC-Client": CLIENT, ...options.headers };
    if (auth && this.accessToken) headers.Authorization = `Bearer ${this.accessToken}`;
    let body: BodyInit | undefined;
    if (options.form) body = options.form;
    else if (options.json !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(options.json);
    }

    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, options.timeoutMs ?? DEFAULT_TIMEOUT);
    const onAbort = () => controller.abort();
    options.signal?.addEventListener("abort", onAbort);

    let response: Response;
    try {
      response = await this.fetchImpl(url, { method, headers, body, signal: controller.signal });
    } catch (error) {
      if (options.signal?.aborted) throw error;
      if (timedOut) throw new ApiError("Máy chủ phản hồi quá lâu. Vui lòng thử lại.", "timeout");
      // Lỗi thật (vd. thư viện không gửi được dữ liệu) vẫn hiện trong nhật ký Expo để chẩn đoán.
      if (__DEV__) console.warn(`[api] ${method} ${path} thất bại:`, error);
      throw new ApiError("Không thể kết nối đến máy chủ. Vui lòng kiểm tra kết nối Internet và thử lại.", "network");
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
    }

    if (response.status === 401 && auth && !retried && this.refreshToken) {
      if (await this.refresh()) return this.request<T>(method, path, options, true);
    }
    if (!response.ok) {
      let message = `Lỗi máy chủ (${response.status}).`;
      let code: string | undefined;
      try {
        const data = await response.json();
        if (typeof data?.detail === "string") message = data.detail;
        else if (Array.isArray(data?.detail) && data.detail[0]?.msg) message = String(data.detail[0].msg);
        if (typeof data?.code === "string") code = data.code;
        if (code === "guest_limit") this.emitGuest(data?.guest);
      } catch {
        /* giữ thông báo mặc định */
      }
      if (response.status === 429) message = message || "Thao tác quá nhanh. Vui lòng thử lại sau ít phút.";
      throw new ApiError(message, response.status === 401 ? "auth" : "http", response.status, code);
    }
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }

  // ---- endpoint ---------------------------------------------------------------------------- //
  health = () => this.request<{ status: string; version: string }>("GET", "/health", { auth: false, timeoutMs: 8000 });
  config = () => this.request<AppConfig>("GET", "/app/config", { auth: false, timeoutMs: 8000 });
  me = () => this.request<{ user: User }>("GET", "/me").then((r) => r.user);
  updateMe = (body: { full_name?: string; phone?: string | null; preferences?: UserPreferences }) =>
    this.request<{ user: User }>("PATCH", "/me", { json: body }).then((r) => r.user);
  changePassword = (current: string, next: string) =>
    this.request<{ ok: boolean }>("POST", "/me/password", { json: { current_password: current, new_password: next } });
  forgotPassword = (email: string) => this.request<unknown>("POST", "/auth/password/forgot", { json: { email: email.trim() }, auth: false });
  resetPassword = (email: string, code: string, newPassword: string) =>
    this.request<unknown>("POST", "/auth/password/reset", { json: { email: email.trim(), code, new_password: newPassword }, auth: false });

  medicine = (id: number) => {
    const route = this.scanRoute(`/catalog/${id}`);
    return this.request<MedicineDetail>("GET", route.path, { auth: route.auth, headers: route.headers });
  };
  /** Số lượt quét thử còn lại của trình duyệt khách. */
  guestStatus = () => this.request<GuestQuota>("GET", "/guest/status", { auth: false, headers: { "X-Guest-Id": this.guestId }, timeoutMs: 8000 })
    .then((quota) => {
      this.emitGuest(quota);
      return quota;
    });

  async submitScan(image: PickedImage, source: "camera" | "upload"): Promise<ScanJob> {
    const form = new FormData();
    const name = image.fileName || (source === "camera" ? "camera.jpg" : "upload.jpg");
    if (Platform.OS === "web") {
      const blob = await (await fetch(image.uri)).blob();
      form.append("file", blob, name);
    } else {
      // Từ SDK 58, `fetch` mặc định là expo/fetch: KHÔNG nhận kiểu cũ { uri, name, type } của React Native
      // (ném "Unsupported FormDataPart implementation" trước khi gửi). expo/fetch nhận phần tệp có hàm bytes()
      // (như File của expo-file-system); name/type đặt rõ để máy chủ luôn thấy đây là tệp (có filename).
      const file = new FsFile(image.uri);
      const part = { name, type: image.mimeType || "image/jpeg", bytes: () => file.bytes() };
      form.append("file", part as unknown as Blob);
    }
    form.append("source", source);
    const route = this.scanRoute("/scans");
    const job = await this.request<ScanJob>("POST", route.path, { form, auth: route.auth, headers: route.headers, timeoutMs: 60_000 });
    this.emitGuest(job.guest);
    return job;
  }

  scan = (id: string, signal?: AbortSignal) => {
    const route = this.scanRoute(`/scans/${id}`);
    return this.request<ScanJob>("GET", route.path, { auth: route.auth, headers: route.headers, signal, timeoutMs: 10_000 });
  };
  /** Mã vạch → thuốc trong danh mục (chỉ tra cứu; tìm thấy thì máy chủ ghi vào lịch sử quét của chính mình). */
  lookupBarcode = async (code: string) => {
    const route = this.scanRoute("/barcodes/lookup");
    const result = await this.request<BarcodeResult>("POST", route.path, { json: { code }, auth: route.auth, headers: route.headers, timeoutMs: 10_000 });
    this.emitGuest(result.guest);
    return result;
  };
  /** Thuốc trong tủ (sắp theo hạn dùng gần nhất). Chỉ xem — thêm/xóa thuốc là việc của quản trị viên. */
  cabinet = (params: { q?: string; status?: "all" | "expired" | "expiring" | "ok" | "unknown" } = {}) =>
    this.request<CabinetList>("GET", "/cabinet/medicines", { query: { q: params.q || undefined, status: params.status === "all" ? undefined : params.status } });
  /** Sửa DUY NHẤT ngày hết hạn (YYYY-MM-DD, null = chưa rõ). Máy chủ từ chối mọi trường khác. */
  updateExpiry = (id: number, expiryDate: string | null) =>
    this.request<CabinetMedicine>("PATCH", `/cabinet/medicines/${id}/expiry`, { json: { expiry_date: expiryDate } });
  /** AI tìm thông tin thuốc trên mạng (máy chủ gọi Gemini — điện thoại không giữ khóa AI). Có thể mất 5–30 giây. */
  aiLookup = (kind: "barcode" | "qr", code: string) => {
    const route = this.scanRoute("/ai/lookup");
    return this.request<AiLookupResult>("POST", route.path, { json: { kind, code }, auth: route.auth, headers: route.headers, timeoutMs: 75_000 });
  };
  /** Người dùng xác nhận "không có thuốc đúng" → AI đọc ảnh của lượt quét + tra mạng. */
  aiScan = (jobId: string) => {
    const route = this.scanRoute(`/ai/scans/${jobId}`);
    return this.request<AiLookupResult>("POST", route.path, { auth: route.auth, headers: route.headers, timeoutMs: 75_000 });
  };
  cancelScan = (id: string) => {
    const route = this.scanRoute(`/scans/${id}`);
    return this.request<{ cancelled: boolean }>("DELETE", route.path, { auth: route.auth, headers: route.headers });
  };
  thumbnailUrl = (jobId: string) => this.url(this.scanRoute(`/scans/${jobId}/thumbnail`).path);

  history = (params: { q?: string; status?: HistoryFilter; before?: string | null; limit?: number } = {}) =>
    this.request<HistoryPage>("GET", "/history", {
      query: { q: params.q, status: params.status === "all" ? undefined : params.status, before: params.before, limit: params.limit ?? 30 },
    });
  historyDetail = (id: string) => this.request<{ item: HistoryItem; scan: ScanJob | null }>("GET", `/history/${id}`);
  selectCandidate = (historyId: string, medicineId: number) =>
    this.request<{ item: HistoryItem }>("POST", `/history/${historyId}/select`, { json: { medicine_id: medicineId } });
}
