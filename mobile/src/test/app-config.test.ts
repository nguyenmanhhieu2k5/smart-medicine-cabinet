/** Ứng dụng tự biết địa chỉ máy chủ: mặc định trong app.json, ghi đè được bằng SMC_API_URL khi chạy/build. */
import appJson from "../../app.json";
import { resolveApiUrl } from "../../app.config";
import { normalizeServerUrl } from "@/api/server";

describe("Địa chỉ máy chủ gài sẵn", () => {
  const extra = appJson.expo.extra;

  it("app.json có sẵn địa chỉ công khai hợp lệ (https) — người dùng không phải nhập", () => {
    expect(extra.apiUrl).toMatch(/^https:\/\//);
    expect(normalizeServerUrl(extra.apiUrl)).toBe(extra.apiUrl);
  });

  it("không đặt SMC_API_URL (hoặc để trống như eas.json) → dùng địa chỉ trong app.json", () => {
    expect(resolveApiUrl(extra, undefined)).toBe(extra.apiUrl);
    expect(resolveApiUrl(extra, "")).toBe(extra.apiUrl);
    expect(resolveApiUrl(extra, "   ")).toBe(extra.apiUrl);
  });

  it("SMC_API_URL ghi đè khi cần (máy chủ thử, chuyển sang Cloudflare)", () => {
    expect(resolveApiUrl(extra, "https://api.tuthuoc.example")).toBe("https://api.tuthuoc.example");
  });
});
