import Constants from "expo-constants";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Platform } from "react-native";
import appJson from "../../app.json";
import { api, ApiError, ScannerApi, type AppConfig, type GuestQuota, type User } from "@/api";
import { normalizeServerUrl, pickReachableServer, safeNormalize } from "@/api/server";
import { browserStore, deviceStore, KEYS, memoryStore } from "@/api/storage";

/**
 * loading  : đang khôi phục phiên (màn hình khởi động)
 * offline  : có phiên đã lưu nhưng không tới được máy chủ → màn hình “Không thể kết nối đến máy chủ”
 * signedOut: chưa đăng nhập / phiên đã hết hạn
 * signedIn : đã đăng nhập (luôn với quyền SCANNER)
 * guest    : CHỈ trang web — chưa đăng nhập nhưng được quét thử vài lần (máy chủ đếm lượt), hết lượt thì phải đăng nhập
 */
export type AuthStatus = "loading" | "offline" | "signedOut" | "signedIn" | "guest";

interface AuthContextValue {
  status: AuthStatus;
  user: User | null;
  config: AppConfig | null;
  serverUrl: string;
  lastEmail: string;
  /** Thông báo hiển thị ở màn hình đăng nhập (ví dụ phiên đã hết hạn). */
  notice: string | null;
  error: ApiError | null;
  /** Trang web, chưa đăng nhập: số lượt quét thử còn lại (null = không ở chế độ khách). */
  guest: GuestQuota | null;
  login(email: string, password: string): Promise<void>;
  register(fullName: string, email: string, password: string): Promise<void>;
  logout(): Promise<void>;
  retry(): Promise<void>;
  setUser(user: User): void;
  reloadUser(): Promise<void>;
  /** Kiểm tra (GET /health) rồi lưu địa chỉ máy chủ mới. Đổi máy chủ thì đăng xuất phiên cũ. */
  setServer(input: string): Promise<{ version: string }>;
  clearNotice(): void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

/** Địa chỉ cấu hình lúc chạy/build (app.config.ts: SMC_API_URL hoặc app.json). */
function configuredDefault(): string {
  return safeNormalize((Constants.expoConfig?.extra as { apiUrl?: string } | undefined)?.apiUrl);
}

/** Địa chỉ gài sẵn, đọc thẳng từ app.json lúc đóng gói mã — không phụ thuộc biến môi trường hay bộ nhớ đệm. */
const BUILTIN_SERVER = safeNormalize((appJson.expo as { extra?: { apiUrl?: string } }).extra?.apiUrl);

const IS_WEB = Platform.OS === "web";

/**
 * Trang web luôn dùng máy chủ ở CÙNG địa chỉ với trang (máy chủ Mini PC phục vụ cả trang web lẫn API, ví dụ
 * https://tuthuoc.id.vn). Riêng khi chạy thử `npm run web` (Expo, cổng 8081) thì đặt SMC_WEB_API_URL.
 */
export function webServerUrl(): string {
  const override = safeNormalize((Constants.expoConfig?.extra as { webApiUrl?: string } | undefined)?.webApiUrl);
  if (override) return override;
  return typeof window !== "undefined" && window.location?.origin ? safeNormalize(window.location.origin) : "";
}

/** UUID v4 ngẫu nhiên (crypto.randomUUID chỉ có trên HTTPS/localhost — trang mở qua HTTP thường dùng getRandomValues). */
export function randomUuid(): string {
  const crypto = globalThis.crypto;
  if (crypto?.randomUUID) return crypto.randomUUID();
  const bytes = new Uint8Array(16);
  if (crypto?.getRandomValues) crypto.getRandomValues(bytes);
  else for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Mã khách của trình duyệt (UUID ngẫu nhiên, không chứa thông tin cá nhân) — để máy chủ đếm lượt quét thử. */
async function guestId(): Promise<string> {
  const saved = await browserStore.get(KEYS.guestId);
  if (saved && /^[0-9a-f-]{36}$/i.test(saved)) return saved;
  const random = randomUuid();
  await browserStore.set(KEYS.guestId, random);
  return random;
}

async function isServerUp(url: string): Promise<boolean> {
  const probe = new ScannerApi(memoryStore()); // không đụng phiên đăng nhập hiện tại
  probe.setBaseUrl(url);
  try {
    await probe.health();
    return true;
  } catch {
    return false;
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>("loading");
  const [user, setUserState] = useState<User | null>(null);
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [serverUrl, setServerUrl] = useState("");
  const [lastEmail, setLastEmail] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [guest, setGuest] = useState<GuestQuota | null>(null);
  const configRef = useRef<AppConfig | null>(null);
  const booted = useRef(false);

  const loadConfig = useCallback(async () => {
    try {
      const loaded = await api.config();
      configRef.current = loaded;
      setConfig(loaded);
    } catch {
      configRef.current = null;
      setConfig(null);
    }
  }, []);

  /** Chưa đăng nhập: trang web có chế độ quét thử → "guest"; còn lại (ứng dụng điện thoại) → "signedOut". */
  const signedOutState = useCallback(async () => {
    const guestEnabled = IS_WEB && configRef.current?.guest?.enabled === true;
    if (!guestEnabled) {
      api.setGuestId(null);
      setGuest(null);
      setStatus("signedOut");
      return;
    }
    api.setGuestId(await guestId());
    const limit = configRef.current?.guest?.scans ?? 5;
    // Số lượt thật do máy chủ đếm — chờ trả lời để không hiện tạm "còn đủ lượt" rồi mới giảm.
    const quota = await api.guestStatus().catch(() => null);
    setGuest(quota ?? { limit, remaining: limit });
    setStatus("guest");
  }, []);

  const boot = useCallback(async () => {
    setStatus("loading");
    setError(null);
    let url: string;
    if (IS_WEB) {
      url = webServerUrl();
    } else {
      const stored = safeNormalize(await deviceStore.get(KEYS.serverUrl));
      // Tự chọn máy chủ: ưu tiên địa chỉ đã lưu → cấu hình lúc build → gài sẵn; địa chỉ chết/cũ bị bỏ qua tự động.
      const candidates = [...new Set([stored, configuredDefault(), BUILTIN_SERVER].filter(Boolean))];
      url = candidates[0] ?? "";
      if (candidates.length > 1) url = (await pickReachableServer(candidates, isServerUp)) ?? url;
    }
    setServerUrl(url);
    setLastEmail((await (IS_WEB ? browserStore : deviceStore).get(KEYS.lastEmail)) ?? "");
    if (!url) {
      setStatus("signedOut");
      return;
    }
    api.setBaseUrl(url);
    if (IS_WEB) await loadConfig(); // cần biết có cho quét thử không trước khi chọn màn hình đầu
    else void loadConfig();
    try {
      if (await api.restore()) {
        setUserState(await api.me());
        setGuest(null);
        setStatus("signedIn");
      } else {
        await signedOutState();
      }
    } catch (e) {
      if (e instanceof ApiError && (e.kind === "network" || e.kind === "timeout" || e.status >= 500)) {
        setError(e);
        setStatus("offline");
      } else {
        await signedOutState();
      }
    }
  }, [loadConfig, signedOutState]);

  // Ổn định (không đổi giữa các lần render) để màn hình gọi trong useFocusEffect không lặp vô hạn.
  const reloadUser = useCallback(async () => {
    setUserState(await api.me());
  }, []);

  useEffect(() => {
    if (booted.current) return;
    booted.current = true;
    void boot();
  }, [boot]);

  useEffect(
    () =>
      api.onSessionEnd((reason) => {
        setUserState(null);
        void signedOutState();
        if (reason === "expired") setNotice("Phiên đăng nhập đã hết hạn hoặc bị thu hồi. Vui lòng đăng nhập lại.");
      }),
    [signedOutState],
  );

  useEffect(() => api.onGuestQuota((quota) => setGuest((current) => ({ ...current, ...quota }))), []);

  const value = useMemo<AuthContextValue>(() => ({
    status, user, config, serverUrl, lastEmail, notice, error, guest,
    async login(email, password) {
      setNotice(null);
      await api.login(email, password);
      setLastEmail(email.trim());
      if (IS_WEB) void browserStore.set(KEYS.lastEmail, email.trim());
      setUserState(await api.me()); // vai trò hiển thị lấy từ /me: luôn SCANNER trên di động
      setGuest(null);
      setStatus("signedIn");
    },
    async register(fullName, email, password) {
      setNotice(null);
      await api.register(fullName, email, password);
      setLastEmail(email.trim());
      if (IS_WEB) void browserStore.set(KEYS.lastEmail, email.trim());
      setUserState(await api.me());
      setGuest(null);
      setStatus("signedIn");
    },
    async logout() {
      await api.logout(); // listener onSessionEnd đưa về màn hình khách (trang web) hoặc đăng nhập
      setUserState(null);
      await signedOutState();
    },
    retry: boot,
    setUser: setUserState,
    reloadUser,
    async setServer(input) {
      const url = normalizeServerUrl(input);
      const probe = new ScannerApi(memoryStore()); // chỉ để kiểm tra địa chỉ, không đụng phiên hiện tại
      probe.setBaseUrl(url);
      const health = await probe.health();
      if (url !== serverUrl && api.isSignedIn()) await api.logout();
      api.setBaseUrl(url);
      await deviceStore.set(KEYS.serverUrl, url);
      setServerUrl(url);
      await loadConfig();
      setError(null);
      if (status === "offline") await signedOutState();
      return { version: health.version };
    },
    clearNotice: () => setNotice(null),
  }), [status, user, config, serverUrl, lastEmail, notice, error, guest, boot, loadConfig, reloadUser, signedOutState]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error("useAuth phải nằm trong AuthProvider");
  return value;
}
