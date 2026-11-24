// Cầu nối an toàn do Electron preload cung cấp (desktop/preload.cjs).

/** Tài khoản đang đăng nhập (do máy chủ trả về). */
export interface AccountInfo {
  id: string;
  email: string;
  full_name: string;
  phone: string | null;
  role: "ADMIN" | "SCANNER" | string;
  role_name: string | null;
  permissions: string[];
  is_active: boolean;
  created_at: string | null;
  last_login_at: string | null;
  locked_until: string | null;
}

/**
 * Trạng thái kết nối tới máy chủ Mini PC.
 * - unconfigured: chưa nhập địa chỉ API quản trị
 * - signed-out  : đã có địa chỉ, chưa đăng nhập (hoặc phiên đã hết hạn)
 * - ready       : đã đăng nhập, `token` là access token ngắn hạn
 * - error       : có phiên đã lưu nhưng không kết nối được máy chủ (thử lại được)
 */
export type ConnectionState = "unconfigured" | "signed-out" | "ready" | "error";

export interface BackendInfo {
  state: ConnectionState;
  /** Gốc địa chỉ máy chủ, ví dụ https://mini-pc.tailnet.ts.net (rỗng khi chưa cấu hình). */
  baseUrl: string;
  /** Access token (rỗng khi chưa đăng nhập). Refresh token không bao giờ có ở đây. */
  token: string;
  expiresAt?: string | null;
  user?: AccountInfo | null;
  /** Email đăng nhập gần nhất (điền sẵn ô email). */
  email?: string | null;
  error?: string | null;
  /** false khi Windows không hỗ trợ mã hóa (phiên chỉ giữ tới khi đóng ứng dụng). */
  secureStorage?: boolean;
  /** Có phiên đăng nhập đã lưu (mã hóa) — để biết có nên hiện nút Đăng xuất khi mất kết nối. */
  hasSession?: boolean;
  health?: { version: string; catalog_count: number; database: string; ocr: string; channel?: string };
}

export interface DesktopBridge {
  isDesktop: true;
  appVersion: string;
  platform: string;
  getBackend(): Promise<BackendInfo>;
  setServer(url: string): Promise<BackendInfo>;
  forgetServer(): Promise<BackendInfo>;
  login(email: string, password: string): Promise<BackendInfo>;
  refreshSession(): Promise<BackendInfo>;
  logout(): Promise<BackendInfo>;
  notify(payload: { title: string; body: string; route?: string }): Promise<boolean>;
  onNavigate(callback: (route: string) => void): () => void;
  setTrayEnabled(enabled: boolean): Promise<void>;
  relaunch(): Promise<void>;
}

declare global {
  interface Window {
    smc?: DesktopBridge;
  }
}
