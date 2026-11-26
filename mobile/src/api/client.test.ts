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

describe("Trang web: khách quét thử không cần đăng nhập (máy chủ đếm lượt)", () => {
  const JOB = "0b8f2f7e-1f0c-4f0e-9a51-2a4b8c6d7e8f";
  const GUEST = "5f0c1d2e-3a4b-4c5d-8e6f-7a8b9c0d1e2f";
  const header = (init: RequestInit, name: string) => (init.headers as Record<string, string>)[name];

  it("chưa đăng nhập + có mã khách → mọi thao tác quét đi qua /guest kèm X-Guest-Id, không gửi token", async () => {
    const { impl, calls } = fakeFetch((url) => {
      if (url.endsWith("/guest/barcodes/lookup")) return { status: 200, body: { status: "not_found", code: "893", guest: { limit: 5, remaining: 3 } } };
      return { status: 200, body: { id: JOB, status: "queued" } };
    });
    const api = new ScannerApi(memoryStore(), impl, { web: true, webSession: () => false });
    api.setBaseUrl(BASE);
    api.setGuestId(GUEST);
    const seen: number[] = [];
    api.onGuestQuota((q) => seen.push(q.remaining));
    expect(api.isGuest()).toBe(true);

    await api.scan(JOB);
    await api.lookupBarcode("8935206010121");
    await api.medicine(34382);
    await api.aiScan(JOB);
    await api.aiLookup("qr", "SDK VN-20169-16");
    await api.cancelScan(JOB);
    expect(calls.map((c) => `${c.init.method} ${c.url.replace(BASE, "")}`)).toEqual([
      `GET /api/v1/guest/scans/${JOB}`, "POST /api/v1/guest/barcodes/lookup", "GET /api/v1/guest/catalog/34382",
      `POST /api/v1/guest/ai/scans/${JOB}`, "POST /api/v1/guest/ai/lookup", `DELETE /api/v1/guest/scans/${JOB}`,
    ]);
    expect(calls.every((c) => header(c.init, "X-Guest-Id") === GUEST && !auth(c.init))).toBe(true);
    expect(seen).toEqual([3]); // số lượt còn lại cập nhật ngay sau lần quét mã
    expect(api.thumbnailUrl(JOB)).toBe(`${BASE}/api/v1/guest/scans/${JOB}/thumbnail`);
    expect(await api.authHeaders()).toEqual({ "X-Guest-Id": GUEST });
  });

  it("hết lượt quét thử → lỗi code guest_limit (trang web chuyển sang đăng nhập) và báo còn 0 lượt", async () => {
    const { impl } = fakeFetch(() => ({ status: 401, body: { detail: "Bạn đã dùng hết 5 lượt quét miễn phí.", code: "guest_limit", guest: { limit: 5, remaining: 0 } } }));
    const api = new ScannerApi(memoryStore(), impl, { web: true, webSession: () => false });
    api.setBaseUrl(BASE);
    api.setGuestId(GUEST);
    const seen: number[] = [];
    api.onGuestQuota((q) => seen.push(q.remaining));
    const error = await api.lookupBarcode("8935206010121").catch((e) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe("guest_limit");
    expect(seen).toEqual([0]);
  });

  it("đăng nhập trên trang web: phiên nằm trong cookie HttpOnly — không giữ refresh token, quét đi đường thường", async () => {
    const { impl, calls } = fakeFetch((url) => {
      if (url.endsWith("/auth/login") || url.endsWith("/auth/refresh")) return { status: 200, body: { ...tokens(1), refresh_token: null } };
      return { status: 200, body: { id: JOB, status: "queued" } };
    });
    const store = memoryStore();
    const api = new ScannerApi(store, impl, { web: true, webSession: () => true });
    api.setBaseUrl(BASE);
    api.setGuestId(GUEST);
    await api.login("scanner@example.com", "Scanner2026");
    expect(api.isSignedIn()).toBe(true);
    expect(api.isGuest()).toBe(false);
    expect(await store.get(KEYS.refreshToken)).toBeNull();
    await api.scan(JOB);
    expect(calls.at(-1)?.url).toBe(`${BASE}/api/v1/scans/${JOB}`);
    expect(auth(calls.at(-1)!.init)).toBe("Bearer access-1");

    // Tải lại trang: khôi phục phiên chỉ bằng cookie (thân yêu cầu rỗng).
    const reloaded = new ScannerApi(memoryStore(), impl, { web: true, webSession: () => true });
    reloaded.setBaseUrl(BASE);
    expect(await reloaded.restore()).toBe(true);
    const refresh = calls.at(-1)!;
    expect(refresh.url).toBe(`${BASE}/api/v1/auth/refresh`);
    expect(JSON.parse(String(refresh.init.body))).toEqual({});

    await reloaded.logout();
    expect(JSON.parse(String(calls.at(-1)!.init.body))).toEqual({}); // máy chủ đọc và xóa cookie
  });

  it("trang web chưa từng đăng nhập: không gọi làm mới vô ích, không báo “phiên hết hạn”", async () => {
    const { impl, calls } = fakeFetch(() => ({ status: 401, body: { detail: "Chưa đăng nhập.", code: "no_session" } }));
    const ended: string[] = [];
    const api = new ScannerApi(memoryStore(), impl, { web: true, webSession: () => false });
    api.setBaseUrl(BASE);
    api.onSessionEnd((reason) => ended.push(reason));
    expect(await api.restore()).toBe(false);
    expect(calls).toHaveLength(0);

    const stale = new ScannerApi(memoryStore(), impl, { web: true, webSession: () => true }); // cookie đánh dấu còn, phiên đã bị thu hồi
    stale.setBaseUrl(BASE);
    stale.onSessionEnd((reason) => ended.push(reason));
    expect(await stale.restore()).toBe(false);
    expect(ended).toEqual([]);
  });

  it("đường dẫn /guest nằm trong danh sách cho phép, đường lạ thì không", () => {
    for (const path of ["/guest/status", "/guest/scans", `/guest/scans/${JOB}`, `/guest/scans/${JOB}/thumbnail`, "/guest/barcodes/lookup",
      "/guest/catalog/34382", "/guest/ai/lookup", `/guest/ai/scans/${JOB}`]) expect(PUBLIC_PATH.test(path)).toBe(true);
    for (const path of ["/guest/history", "/guest/cabinet/medicines", "/guest/me", "/guest/../admin/users"]) expect(PUBLIC_PATH.test(path)).toBe(false);
  });
});
