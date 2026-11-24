import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentType, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BackendInfo, DesktopBridge } from "@/types/desktop";

const SERVER = "https://mini-pc.tailnet-test.ts.net";
const ADMIN = {
  id: "u1", email: "admin@example.com", full_name: "Admin", phone: null, role: "ADMIN", role_name: "Quản trị viên", permissions: [],
  is_active: true, created_at: null, last_login_at: null, locked_until: null,
};

function info(overrides: Partial<BackendInfo>): BackendInfo {
  return { state: "signed-out", baseUrl: SERVER, token: "", user: null, email: null, error: null, secureStorage: true, ...overrides };
}

function bridge(overrides: Partial<DesktopBridge> = {}): DesktopBridge {
  return {
    isDesktop: true, appVersion: "2.0.0", platform: "win32",
    getBackend: vi.fn(async () => info({ state: "unconfigured", baseUrl: "" })),
    setServer: vi.fn(async (url: string) => info({ baseUrl: url })),
    forgetServer: vi.fn(async () => info({ state: "unconfigured", baseUrl: "" })),
    login: vi.fn(async () => info({ state: "ready", token: "access-1", user: ADMIN, expiresAt: new Date(Date.now() + 900_000).toISOString() })),
    refreshSession: vi.fn(async () => info({ state: "signed-out", error: "Phiên đăng nhập đã hết hạn. Hãy đăng nhập lại." })),
    logout: vi.fn(async () => info({})),
    notify: vi.fn(), onNavigate: vi.fn(() => () => undefined), setTrayEnabled: vi.fn(), relaunch: vi.fn(),
    ...overrides,
  } as DesktopBridge;
}

/** Nạp lại module để trạng thái phiên trong services/api không dính giữa các test. */
async function loadGate(): Promise<{ Gate: ComponentType<{ children: ReactNode }>; api: typeof import("@/services/api") }> {
  vi.resetModules();
  const api = await import("@/services/api");
  const { BackendGate } = await import("@/components/BackendGate");
  return { Gate: BackendGate, api };
}

function renderGate(Gate: ComponentType<{ children: ReactNode }>) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <Gate><p>nội dung quản trị</p></Gate>
    </QueryClientProvider>,
  );
}

describe("Cổng kết nối máy chủ + đăng nhập Admin (ứng dụng Windows)", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });
  afterEach(() => {
    delete window.smc;
  });

  it("máy chủ được tự chọn (gài sẵn, như điện thoại): vào thẳng màn đăng nhập, không phải nhập/không hiện địa chỉ", async () => {
    const smc = bridge({ getBackend: vi.fn(async () => info({ state: "signed-out", baseUrl: SERVER })) });
    window.smc = smc;
    const { Gate } = await loadGate();
    renderGate(Gate);
    expect(await screen.findByText("Đăng nhập quản trị")).toBeInTheDocument();
    expect(screen.queryByLabelText("Địa chỉ API quản trị")).not.toBeInTheDocument();
    expect(screen.queryByText(SERVER)).not.toBeInTheDocument();
    expect(smc.setServer).not.toHaveBeenCalled();
  });

  it("không tới được máy chủ gài sẵn: nhắc bật Tailscale, Thử lại / Đổi máy chủ; chưa có phiên thì không hiện Đăng xuất", async () => {
    const message = "Không kết nối được máy chủ Mini PC. Hãy kiểm tra Tailscale đã bật và đăng nhập cùng tài khoản với Mini PC, rồi bấm Thử lại.";
    const smc = bridge({ getBackend: vi.fn(async () => info({ state: "error", baseUrl: SERVER, error: message, hasSession: false })) });
    window.smc = smc;
    const { Gate } = await loadGate();
    renderGate(Gate);
    expect(await screen.findByText(/Tailscale đã bật/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Thử lại" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Đổi máy chủ" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Đăng xuất" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Thử lại" }));
    expect(smc.getBackend).toHaveBeenCalledTimes(2); // thử lại = tự chọn lại địa chỉ
  });

  it("vẫn nhập tay được khi cần (Đổi máy chủ / chưa có địa chỉ gài sẵn): kiểm tra xong mới sang đăng nhập", async () => {
    const smc = bridge();
    window.smc = smc;
    const { Gate } = await loadGate();
    renderGate(Gate);
    const input = await screen.findByLabelText("Địa chỉ API quản trị");
    expect(screen.queryByText("nội dung quản trị")).not.toBeInTheDocument();
    await userEvent.type(input, SERVER);
    await userEvent.click(screen.getByRole("button", { name: "Kết nối" }));
    expect(smc.setServer).toHaveBeenCalledWith(SERVER);
    expect(await screen.findByText("Đăng nhập quản trị")).toBeInTheDocument();
  });

  it("địa chỉ sai (ví dụ API công khai): báo lỗi của máy chủ, không chuyển bước", async () => {
    const smc = bridge({
      setServer: vi.fn(async () => info({ state: "unconfigured", baseUrl: "", error: "Đây là API công khai (dành cho ứng dụng điện thoại)." })),
    });
    window.smc = smc;
    const { Gate } = await loadGate();
    renderGate(Gate);
    await userEvent.type(await screen.findByLabelText("Địa chỉ API quản trị"), "https://api.example.com");
    await userEvent.click(screen.getByRole("button", { name: "Kết nối" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Đây là API công khai");
    expect(screen.queryByText("Đăng nhập quản trị")).not.toBeInTheDocument();
  });

  it("đăng nhập sai: hiện lỗi, xóa mật khẩu; đăng nhập đúng: hiện ứng dụng", async () => {
    const login = vi.fn()
      .mockResolvedValueOnce(info({ error: "Email hoặc mật khẩu không đúng." }))
      .mockResolvedValueOnce(info({ state: "ready", token: "access-1", user: ADMIN, expiresAt: new Date(Date.now() + 900_000).toISOString() }));
    window.smc = bridge({ getBackend: vi.fn(async () => info({ email: "admin@example.com" })), login });
    const { Gate } = await loadGate();
    renderGate(Gate);
    const password = await screen.findByLabelText("Mật khẩu");
    expect(screen.getByLabelText("Email")).toHaveValue("admin@example.com");
    await userEvent.type(password, "sai-mat-khau1");
    await userEvent.click(screen.getByRole("button", { name: "Đăng nhập" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Email hoặc mật khẩu không đúng.");
    expect(screen.getByLabelText("Mật khẩu")).toHaveValue("");
    expect(screen.queryByText("nội dung quản trị")).not.toBeInTheDocument();

    await userEvent.type(screen.getByLabelText("Mật khẩu"), "dung-mat-khau1");
    await userEvent.click(screen.getByRole("button", { name: "Đăng nhập" }));
    expect(await screen.findByText("nội dung quản trị")).toBeInTheDocument();
    expect(login).toHaveBeenLastCalledWith("admin@example.com", "dung-mat-khau1");
  });

  it("có phiên đã lưu nhưng không tới được máy chủ: nêu rõ lỗi, không giả vờ đã kết nối, thử lại được", async () => {
    const getBackend = vi.fn()
      .mockResolvedValueOnce(info({ state: "error", error: "Không kết nối được máy chủ (hết thời gian chờ). Kiểm tra Tailscale đã bật và Mini PC đang chạy." }))
      .mockResolvedValueOnce(info({ state: "ready", token: "access-2", user: ADMIN, expiresAt: new Date(Date.now() + 900_000).toISOString() }));
    window.smc = bridge({ getBackend });
    const { Gate } = await loadGate();
    renderGate(Gate);
    expect(await screen.findByText("Không kết nối được máy chủ")).toBeInTheDocument();
    expect(screen.getByText(/Kiểm tra Tailscale/)).toBeInTheDocument();
    expect(screen.queryByText("nội dung quản trị")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Thử lại" }));
    expect(await screen.findByText("nội dung quản trị")).toBeInTheDocument();
    expect(getBackend).toHaveBeenCalledTimes(2);
  });

  it("đang dùng mà phiên bị thu hồi (401, làm mới thất bại): quay về màn hình đăng nhập", async () => {
    const smc = bridge({ getBackend: vi.fn(async () => info({ state: "ready", token: "revoked", user: ADMIN, expiresAt: new Date(Date.now() + 900_000).toISOString() })) });
    window.smc = smc;
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ detail: "Phiên đã bị thu hồi." }), { status: 401, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const { Gate, api } = await loadGate();
    renderGate(Gate);
    expect(await screen.findByText("nội dung quản trị")).toBeInTheDocument();

    await expect(api.api.health()).rejects.toMatchObject({ status: 401 });
    // Gửi kèm Bearer token, làm mới đúng một lần, rồi về màn hình đăng nhập với thông báo rõ ràng.
    const firstCall = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(firstCall[0]).toBe(`${SERVER}/api/health`);
    expect((firstCall[1].headers as Record<string, string>).Authorization).toBe("Bearer revoked");
    expect(smc.refreshSession).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await screen.findByText("Đăng nhập quản trị")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("Phiên đăng nhập đã hết hạn");
  });

  it("access token được làm mới thì gọi lại yêu cầu với token mới", async () => {
    const smc = bridge({
      getBackend: vi.fn(async () => info({ state: "ready", token: "old", user: ADMIN, expiresAt: new Date(Date.now() + 900_000).toISOString() })),
      refreshSession: vi.fn(async () => info({ state: "ready", token: "new", user: ADMIN, expiresAt: new Date(Date.now() + 900_000).toISOString() })),
    });
    window.smc = smc;
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const auth = (init?.headers as Record<string, string>).Authorization;
      return auth === "Bearer new"
        ? new Response(JSON.stringify({ status: "ok", version: "2.0.0" }), { status: 200, headers: { "Content-Type": "application/json" } })
        : new Response(JSON.stringify({ detail: "Token hết hạn." }), { status: 401 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const { api } = await loadGate();
    await api.connection.init();
    await expect(api.api.health()).resolves.toMatchObject({ status: "ok" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(smc.refreshSession).toHaveBeenCalledTimes(1);
  });
});
