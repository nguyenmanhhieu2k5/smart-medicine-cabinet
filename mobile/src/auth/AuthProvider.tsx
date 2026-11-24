import Constants from "expo-constants";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import appJson from "../../app.json";
import { api, ApiError, ScannerApi, type AppConfig, type User } from "@/api";
import { normalizeServerUrl, pickReachableServer, safeNormalize } from "@/api/server";
import { deviceStore, KEYS, memoryStore } from "@/api/storage";

/**
 * loading  : đang khôi phục phiên (màn hình khởi động)
 * offline  : có phiên đã lưu nhưng không tới được máy chủ → màn hình “Không thể kết nối đến máy chủ”
 * signedOut: chưa đăng nhập / phiên đã hết hạn
 * signedIn : đã đăng nhập (luôn với quyền SCANNER)
 */
export type AuthStatus = "loading" | "offline" | "signedOut" | "signedIn";

interface AuthContextValue {
  status: AuthStatus;
  user: User | null;
  config: AppConfig | null;
  serverUrl: string;
  lastEmail: string;
  /** Thông báo hiển thị ở màn hình đăng nhập (ví dụ phiên đã hết hạn). */
  notice: string | null;
  error: ApiError | null;
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
  const booted = useRef(false);

  const loadConfig = useCallback(async () => {
    try {
      setConfig(await api.config());
    } catch {
      setConfig(null);
    }
  }, []);

  const boot = useCallback(async () => {
    setStatus("loading");
    setError(null);
    const stored = safeNormalize(await deviceStore.get(KEYS.serverUrl));
    // Tự chọn máy chủ: ưu tiên địa chỉ đã lưu → cấu hình lúc build → gài sẵn; địa chỉ chết/cũ bị bỏ qua tự động.
    const candidates = [...new Set([stored, configuredDefault(), BUILTIN_SERVER].filter(Boolean))];
    let url = candidates[0] ?? "";
    if (candidates.length > 1) url = (await pickReachableServer(candidates, isServerUp)) ?? url;
    setServerUrl(url);
    setLastEmail((await deviceStore.get(KEYS.lastEmail)) ?? "");
    if (!url) {
      setStatus("signedOut");
      return;
    }
    api.setBaseUrl(url);
    void loadConfig();
    try {
      if (await api.restore()) {
        setUserState(await api.me());
        setStatus("signedIn");
      } else {
        setStatus("signedOut");
      }
    } catch (e) {
      if (e instanceof ApiError && (e.kind === "network" || e.kind === "timeout" || e.status >= 500)) {
        setError(e);
        setStatus("offline");
      } else {
        setStatus("signedOut");
      }
    }
  }, [loadConfig]);

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
        setStatus("signedOut");
        if (reason === "expired") setNotice("Phiên đăng nhập đã hết hạn hoặc bị thu hồi. Vui lòng đăng nhập lại.");
      }),
    [],
  );

  const value = useMemo<AuthContextValue>(() => ({
    status, user, config, serverUrl, lastEmail, notice, error,
    async login(email, password) {
      setNotice(null);
      await api.login(email, password);
      setLastEmail(email.trim());
      setUserState(await api.me()); // vai trò hiển thị lấy từ /me: luôn SCANNER trên di động
      setStatus("signedIn");
    },
    async register(fullName, email, password) {
      setNotice(null);
      await api.register(fullName, email, password);
      setLastEmail(email.trim());
      setUserState(await api.me());
      setStatus("signedIn");
    },
    async logout() {
      await api.logout();
      setUserState(null);
      setStatus("signedOut");
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
      if (status === "offline") setStatus("signedOut");
      return { version: health.version };
    },
    clearNotice: () => setNotice(null),
  }), [status, user, config, serverUrl, lastEmail, notice, error, boot, loadConfig, reloadUser]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error("useAuth phải nằm trong AuthProvider");
  return value;
}
