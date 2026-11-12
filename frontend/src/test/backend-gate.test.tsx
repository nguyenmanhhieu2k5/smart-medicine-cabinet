import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BackendInfo, DesktopBridge } from "@/types/desktop";

const initBackend = vi.fn<() => Promise<BackendInfo | null>>();
vi.mock("@/services/api", () => ({ initBackend: () => initBackend() }));

import { BackendGate } from "@/components/BackendGate";

function bridge(overrides: Partial<DesktopBridge> = {}): DesktopBridge {
  return {
    isDesktop: true, appVersion: "1.0.0", platform: "win32",
    getBackend: vi.fn(), pickExcelFile: vi.fn(), notify: vi.fn(), onNavigate: vi.fn(() => () => undefined),
    openDataFolder: vi.fn(), openLogFolder: vi.fn(), setTrayEnabled: vi.fn(), relaunch: vi.fn(),
    ...overrides,
  } as DesktopBridge;
}

describe("BackendGate — khởi động dịch vụ nền trong bản desktop", () => {
  beforeEach(() => initBackend.mockReset());
  afterEach(() => {
    delete window.smc;
  });

  it("trình duyệt (không có Electron): hiển thị ứng dụng ngay", () => {
    render(<BackendGate><p>nội dung</p></BackendGate>);
    expect(screen.getByText("nội dung")).toBeInTheDocument();
    expect(initBackend).not.toHaveBeenCalled();
  });

  it("đang chờ backend: hiện màn hình khởi động, xong thì hiện ứng dụng", async () => {
    window.smc = bridge();
    let resolve!: (info: BackendInfo) => void;
    initBackend.mockReturnValue(new Promise((done) => (resolve = done)));
    render(<BackendGate><p>nội dung</p></BackendGate>);
    expect(screen.getByText("Đang khởi động dịch vụ nền…")).toBeInTheDocument();
    expect(screen.queryByText("nội dung")).not.toBeInTheDocument();
    resolve({ baseUrl: "http://127.0.0.1:50001", token: "t", state: "ready" });
    expect(await screen.findByText("nội dung")).toBeInTheDocument();
  });

  it("backend lỗi: nêu rõ lỗi, đường dẫn nhật ký và cho khởi động lại — không hiển thị ứng dụng", async () => {
    const relaunch = vi.fn();
    const openLogFolder = vi.fn();
    window.smc = bridge({ relaunch, openLogFolder });
    initBackend.mockResolvedValue({
      baseUrl: "http://127.0.0.1:50001", token: "t", state: "error",
      error: "Dịch vụ nền đã dừng (mã 1).", logFile: "C:\\Users\\test\\AppData\\Roaming\\SmartMedicineCabinet\\logs\\backend.log",
    });
    render(<BackendGate><p>nội dung</p></BackendGate>);
    expect(await screen.findByText("Không khởi động được dịch vụ nền")).toBeInTheDocument();
    expect(screen.getByText("Dịch vụ nền đã dừng (mã 1).")).toBeInTheDocument();
    expect(screen.getByText(/backend\.log$/)).toBeInTheDocument();
    expect(screen.queryByText("nội dung")).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Khởi động lại ứng dụng" }));
    await userEvent.click(screen.getByRole("button", { name: "Mở thư mục nhật ký" }));
    await waitFor(() => expect(relaunch).toHaveBeenCalledTimes(1));
    expect(openLogFolder).toHaveBeenCalledTimes(1);
  });
});
