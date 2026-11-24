import type { ConfigContext, ExpoConfig } from "expo/config";

/**
 * Địa chỉ API CÔNG KHAI của máy chủ Mini PC mà ứng dụng TỰ DÙNG — người dùng không phải nhập gì.
 *  - Mặc định: app.json → expo.extra.apiUrl (địa chỉ Tailscale Funnel cố định của Mini PC).
 *  - Ghi đè khi chạy/build: biến môi trường SMC_API_URL (để trống = dùng mặc định), ví dụ khi chuyển sang Cloudflare.
 *  - Nếu máy chủ đổi địa chỉ, người dùng vẫn đổi được trong ứng dụng: Hồ sơ → Cài đặt ứng dụng → Máy chủ.
 * KHÔNG có địa chỉ quản trị nào ở đây.
 */
export function resolveApiUrl(extra: unknown, env: string | undefined): string {
  const fromEnv = (env ?? "").trim();
  const fromAppJson = String((extra as { apiUrl?: unknown } | undefined)?.apiUrl ?? "").trim();
  return fromEnv || fromAppJson;
}

export default ({ config }: ConfigContext): ExpoConfig => ({
  ...(config as ExpoConfig),
  extra: {
    ...(config.extra ?? {}),
    apiUrl: resolveApiUrl(config.extra, process.env.SMC_API_URL),
  },
});
