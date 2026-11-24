import { ApiError, PUBLIC_PATH, ScannerApi, assertPublicPath } from "./client";
import { KEYS, memoryStore } from "./storage";

// File của expo-file-system (mô-đun native) — babel-jest tự đưa jest.mock lên trước các import.
jest.mock("expo-file-system", () => ({
  File: class MockFile {
    uri: string;
    constructor(uri: string) {
      this.uri = uri;
    }
    async bytes() {
      return new TextEncoder().encode(`bytes-of:${this.uri}`);
    }
  },
}));

const BASE = "https://api.tuthuoc.example";

type Reply = { status: number; body?: unknown };
function fakeFetch(handler: (url: string, init: RequestInit) => Reply | Promise<Reply> | "network") {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init: init ?? {} });
    const reply = await handler(url, init ?? {});
    if (reply === "network") throw new TypeError("Network request failed");
    return new Response(reply.body === undefined ? null : JSON.stringify(reply.body), { status: reply.status, headers: { "Content-Type": "application/json" } });
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

const tokens = (n: number) => ({
  access_token: `access-${n}`, token_type: "bearer", expires_in: 900, refresh_token: `refresh-token-number-${n}-xxxxxxxx`,
  user: { id: "u1", email: "scanner@example.com", full_name: "Scanner", role: "SCANNER" },
});
const auth = (init: RequestInit) => (init.headers as Record<string, string>).Authorization;

describe("Chỉ gọi API công khai của Scanner", () => {
  it.each([
    "/health", "/app/config", "/auth/login", "/auth/register", "/auth/refresh", "/auth/logout", "/auth/password/forgot", "/auth/password/reset",
    "/me", "/me/password", "/catalog/search", "/catalog/34382", "/scans", "/scans/0b8f2f7e-1f0c-4f0e-9a51-2a4b8c6d7e8f",
    "/scans/0b8f2f7e-1f0c-4f0e-9a51-2a4b8c6d7e8f/thumbnail", "/history", "/history/0b8f2f7e-1f0c-4f0e-9a51-2a4b8c6d7e8f/select",
  ])("cho phép %s", (path) => expect(PUBLIC_PATH.test(path)).toBe(true));

  it.each([
    "/admin/users", "/admin/audit", "/devices", "/devices/x/commands", "/commands/x", "/cabinet/medicines/1", "/cabinet/summary", "/settings", "/backup",
    "/device/status", "/api/devices", "/../api/admin/users", "/catalog/1/../../admin", "/scans/1; DROP", "/auth/me",
  ])("chặn %s", (path) => {
    expect(PUBLIC_PATH.test(path)).toBe(false);
    expect(() => assertPublicPath(path)).toThrow(/không thuộc API công khai/);
  });

  it("mọi URL đều nằm dưới /api/v1 của máy chủ đã cấu hình", () => {
    const api = new ScannerApi(memoryStore());
    api.setBaseUrl(BASE + "/");
    expect(api.url("/history", { q: "augmentin 625", status: "found", before: undefined })).toBe(`${BASE}/api/v1/history?q=augmentin%20625&status=found`);
    expect(() => api.url("/admin/users")).toThrow();
  });
});

describe("Phiên đăng nhập", () => {
  it("đăng nhập lưu refresh token vào kho an toàn và gửi Bearer token", async () => {
    const store = memoryStore();
    const { impl, calls } = fakeFetch((url) => (url.endsWith("/auth/login") ? { status: 200, body: tokens(1) } : { status: 200, body: { user: { id: "u1" } } }));
    const api = new ScannerApi(store, impl);
    api.setBaseUrl(BASE);
    await api.login(" scanner@example.com ", "MatKhau2026");
    expect(await store.get(KEYS.refreshToken)).toBe(tokens(1).refresh_token);
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ email: "scanner@example.com", password: "MatKhau2026" });
    await api.me();
    expect(auth(calls[1].init)).toBe("Bearer access-1");
    expect(calls.every((c) => c.url.startsWith(`${BASE}/api/v1/`))).toBe(true);
  });

  it("access token bị từ chối (401) → làm mới đúng một lần, lưu refresh token mới (xoay vòng) rồi gửi lại", async () => {
    const store = memoryStore();
    let meCalls = 0;
    const { impl, calls } = fakeFetch((url, init) => {
      if (url.endsWith("/auth/login")) return { status: 200, body: tokens(1) };
      if (url.endsWith("/auth/refresh")) return { status: 200, body: tokens(2) };
      meCalls += 1;
      return auth(init) === "Bearer access-2" ? { status: 200, body: { user: { id: "u1" } } } : { status: 401, body: { detail: "Token hết hạn." } };
    });
    const api = new ScannerApi(store, impl);
    api.setBaseUrl(BASE);
    await api.login("scanner@example.com", "MatKhau2026");
    await expect(api.me()).resolves.toEqual({ id: "u1" });
    expect(meCalls).toBe(2);
    expect(calls.filter((c) => c.url.endsWith("/auth/refresh"))).toHaveLength(1);
    expect(await store.get(KEYS.refreshToken)).toBe(tokens(2).refresh_token);
  });

  it("làm mới bị từ chối (phiên bị thu hồi) → xóa phiên và báo về màn hình đăng nhập", async () => {
    const store = memoryStore({ [KEYS.refreshToken]: "revoked-refresh-token-xxxxxxxx" });
    const { impl } = fakeFetch((url) => (url.endsWith("/auth/refresh") ? { status: 401, body: { detail: "Phiên đã bị thu hồi." } } : { status: 200, body: {} }));
    const api = new ScannerApi(store, impl);
    api.setBaseUrl(BASE);
    const ended = jest.fn();
    api.onSessionEnd(ended);
    await expect(api.restore()).resolves.toBe(false);
    expect(ended).toHaveBeenCalledWith("expired");
    expect(await store.get(KEYS.refreshToken)).toBeNull();
    expect(api.isSignedIn()).toBe(false);
  });

  it("mất mạng khi khôi phục phiên → báo lỗi mạng nhưng GIỮ phiên để thử lại", async () => {
    const store = memoryStore({ [KEYS.refreshToken]: "saved-refresh-token-xxxxxxxxxxx" });
    const { impl } = fakeFetch(() => "network");
    const api = new ScannerApi(store, impl);
    api.setBaseUrl(BASE);
    await expect(api.restore()).rejects.toMatchObject({ kind: "network" });
    expect(await store.get(KEYS.refreshToken)).toBe("saved-refresh-token-xxxxxxxxxxx");
  });

  it("đăng xuất thu hồi phiên trên máy chủ và xóa token khỏi điện thoại", async () => {
    const store = memoryStore();
    const { impl, calls } = fakeFetch((url) => (url.endsWith("/auth/login") ? { status: 200, body: tokens(1) } : { status: 200, body: { ok: true } }));
    const api = new ScannerApi(store, impl);
    api.setBaseUrl(BASE);
    await api.login("scanner@example.com", "MatKhau2026");
    await api.logout();
    const logout = calls.find((c) => c.url.endsWith("/auth/logout"));
    expect(JSON.parse(String(logout?.init.body))).toEqual({ refresh_token: tokens(1).refresh_token });
    expect(await store.get(KEYS.refreshToken)).toBeNull();
  });

  it("lỗi từ máy chủ giữ nguyên thông báo tiếng Việt", async () => {
    const { impl } = fakeFetch(() => ({ status: 401, body: { detail: "Email hoặc mật khẩu không đúng.", code: "invalid_credentials" } }));
    const api = new ScannerApi(memoryStore(), impl);
    api.setBaseUrl(BASE);
    const error = await api.login("a@example.com", "sai").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ message: "Email hoặc mật khẩu không đúng.", status: 401, code: "invalid_credentials" });
  });

  it("không có máy chủ phản hồi → thông báo không kết nối được", async () => {
    const { impl } = fakeFetch(() => "network");
    const api = new ScannerApi(memoryStore(), impl);
    api.setBaseUrl(BASE);
    await expect(api.config()).rejects.toMatchObject({ kind: "network", message: expect.stringMatching(/Không thể kết nối đến máy chủ/) });
  });
});

describe("Gửi ảnh quét từ điện thoại", () => {
  it("gửi phần tệp có bytes() + tên/kiểu rõ ràng (expo/fetch không nhận kiểu { uri } cũ)", async () => {
    const { impl, calls } = fakeFetch((url) =>
      url.endsWith("/auth/login") ? { status: 200, body: tokens(1) } : { status: 202, body: { id: "job-1", status: "queued" } });
    const append = jest.spyOn(FormData.prototype, "append");
    const api = new ScannerApi(memoryStore(), impl);
    api.setBaseUrl(BASE);
    await api.login("scanner@example.com", "MatKhau2026");
    const job = await api.submitScan({ uri: "file:///cache/ImageManipulator/abc.jpg", mimeType: "image/jpeg", fileName: "scan.jpg" }, "upload");
    expect(job.id).toBe("job-1");
    expect(calls.find((c) => c.url.endsWith("/scans"))?.init.method).toBe("POST");
    const parts = append.mock.calls as unknown as [string, unknown][];
    append.mockRestore();
    const file = parts.find(([key]) => key === "file")?.[1] as { name: string; type: string; bytes: () => Promise<Uint8Array>; uri?: string };
    expect(file).toMatchObject({ name: "scan.jpg", type: "image/jpeg" });
    expect(file.uri).toBeUndefined();
    expect(new TextDecoder().decode(await file.bytes())).toBe("bytes-of:file:///cache/ImageManipulator/abc.jpg");
    expect(parts.find(([key]) => key === "source")?.[1]).toBe("upload");
  });
});
