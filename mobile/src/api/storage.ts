/**
 * Lưu trữ an toàn cho refresh token + cấu hình máy chủ.
 * - Android/iOS: expo-secure-store (Keystore / Keychain).
 * - Web (chỉ dùng để kiểm tra giao diện): chỉ giữ trong bộ nhớ, KHÔNG ghi token vào localStorage.
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

export const KEYS = {
  refreshToken: "smc.refresh_token",
  serverUrl: "smc.server_url",
  lastEmail: "smc.last_email",
} as const;
