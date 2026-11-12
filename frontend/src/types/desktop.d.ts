// Cầu nối an toàn do Electron preload cung cấp (desktop/preload.cjs).
export interface BackendInfo {
  baseUrl: string;
  token: string;
  state: "starting" | "ready" | "error";
  error?: string | null;
  /** Đường dẫn file nhật ký của dịch vụ nền (để hướng dẫn người dùng khi có lỗi). */
  logFile?: string;
}

export interface DesktopBridge {
  isDesktop: true;
  appVersion: string;
  platform: string;
  getBackend(): Promise<BackendInfo>;
  pickExcelFile(): Promise<string | null>;
  notify(payload: { title: string; body: string; route?: string }): Promise<boolean>;
  onNavigate(callback: (route: string) => void): () => void;
  openDataFolder(): Promise<void>;
  openLogFolder(): Promise<void>;
  setTrayEnabled(enabled: boolean): Promise<void>;
  relaunch(): Promise<void>;
}

declare global {
  interface Window {
    smc?: DesktopBridge;
  }
}
