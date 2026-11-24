/** Địa chỉ máy chủ: API CÔNG KHAI của Mini PC (Cloudflare Tunnel). Ứng dụng di động không biết địa chỉ quản trị. */

const PRIVATE_HOST = /^(localhost|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)$/;

export class ServerUrlError extends Error {}

/**
 * Chuẩn hóa địa chỉ người dùng nhập: thêm https:// nếu thiếu, bỏ đường dẫn (/api/v1…) và dấu / cuối.
 * Qua Internet bắt buộc https; http chỉ chấp nhận cho máy trong mạng nội bộ (chạy thử).
 */
export function normalizeServerUrl(input: string): string {
  let text = input.trim();
  if (!text) throw new ServerUrlError("Hãy nhập địa chỉ máy chủ.");
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
    const host = text.split(/[/:]/)[0].toLowerCase();
    text = (PRIVATE_HOST.test(host) ? "http://" : "https://") + text;
  }
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new ServerUrlError("Địa chỉ máy chủ không hợp lệ.");
  }
  if (url.username || url.password) throw new ServerUrlError("Địa chỉ không được chứa tên đăng nhập hoặc mật khẩu.");
  if (url.protocol === "http:" && !PRIVATE_HOST.test(url.hostname)) {
    throw new ServerUrlError("Qua Internet phải dùng https:// (tên miền Cloudflare của Mini PC).");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new ServerUrlError("Địa chỉ phải bắt đầu bằng https://");
  return `${url.protocol}//${url.host}`;
}

/** Chuẩn hóa nhưng không ném lỗi (giá trị cấu hình hỏng → ""). */
export function safeNormalize(input: string | null | undefined): string {
  try {
    return input ? normalizeServerUrl(input) : "";
  } catch {
    return "";
  }
}

/**
 * Chọn địa chỉ máy chủ còn hoạt động, theo thứ tự ưu tiên (địa chỉ người dùng đã lưu → cấu hình lúc build → gài sẵn).
 * Kiểm tra song song nhưng trả về ngay khi địa chỉ ưu tiên cao nhất trả lời — không phải chờ địa chỉ đã chết.
 * Trả về null nếu không địa chỉ nào trả lời (mất mạng) để giữ nguyên lựa chọn đầu tiên.
 */
export async function pickReachableServer(candidates: string[], isUp: (url: string) => Promise<boolean>): Promise<string | null> {
  const unique = [...new Set(candidates.filter(Boolean))];
  const probes = unique.map((url) => isUp(url).catch(() => false));
  for (let i = 0; i < unique.length; i++) {
    if (await probes[i]) return unique[i];
  }
  return null;
}

export function displayHost(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}
