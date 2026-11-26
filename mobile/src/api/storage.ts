/**
 * Lưu trữ an toàn cho refresh token + cấu hình máy chủ.
 * - Android/iOS: expo-secure-store (Keystore / Keychain).
 * - Trang web: KHÔNG ghi token vào localStorage — phiên đăng nhập nằm trong cookie HttpOnly do máy chủ đặt
 *   (JavaScript không đọc được). localStorage chỉ giữ thứ không bí mật: mã khách quét thử (browserStore).
 */
import { Platform } from "react-native";
import * as SecureStore from "expo-secure-store";

export interface KeyValueStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

export function memoryStore(initial: Record<string, string> = {}): KeyValueStore {
  const data = new Map(Object.entries(initial));
  return {
    get: async (key) => data.get(key) ?? null,
    set: async (key, value) => void data.set(key, value),
    remove: async (key) => void data.delete(key),
  };
}

const secureStore: KeyValueStore = {
  get: (key) => SecureStore.getItemAsync(key),
  set: (key, value) => SecureStore.setItemAsync(key, value, { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY }),
  remove: (key) => SecureStore.deleteItemAsync(key),
};

export const deviceStore: KeyValueStore = Platform.OS === "web" ? memoryStore() : secureStore;

/** Trang web: giá trị KHÔNG bí mật (mã khách quét thử, email gần nhất) trong localStorage; trình duyệt chặn thì bỏ qua. */
export const browserStore: KeyValueStore = {
  get: async (key) => {
    try {
      return globalThis.localStorage?.getItem(key) ?? null;
    } catch {
      return null;
    }
  },
  set: async (key, value) => {
    try {
      globalThis.localStorage?.setItem(key, value);
    } catch {
      /* chế độ riêng tư / bị chặn: chỉ mất mã khách khi tải lại trang */
    }
  },
  remove: async (key) => {
    try {
      globalThis.localStorage?.removeItem(key);
    } catch {
      /* bỏ qua */
    }
  },
};

export const KEYS = {
  refreshToken: "smc.refresh_token",
  serverUrl: "smc.server_url",
  lastEmail: "smc.last_email",
  guestId: "smc.guest_id",
} as const;
