/** Trang Quản trị: thiết bị + lệnh qua Internet (chỉ báo thành công khi thiết bị ACK applied), tài khoản. */
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { useToastStore } from "@/stores/toast";
import { deviceInfo, installMockApi, type MockState } from "./mockApi";
import { renderApp } from "./renderApp";

let api: MockState;
beforeEach(() => {
  api = installMockApi();
  useToastStore.setState({ toasts: [] });
});

const SLOW = { timeout: 5000 };

describe("Quản trị → Thiết bị", () => {
  it("thêm thiết bị: token chỉ hiển thị một lần cùng địa chỉ WSS và hướng dẫn nạp firmware", async () => {
    const user = userEvent.setup();
    renderApp("/admin/devices");
    expect(await screen.findByText("Chưa có thiết bị")).toBeInTheDocument();
    await user.click(screen.getAllByRole("button", { name: "Thêm thiết bị" })[0]);
    const dialog = await screen.findByRole("dialog", { name: "Thêm thiết bị ESP32" });
    await user.type(within(dialog).getByRole("textbox", { name: /Tên thiết bị/ }), "Tủ bếp");
    await user.click(within(dialog).getByRole("button", { name: "Thêm và tạo token" }));

    const tokenDialog = await screen.findByRole("dialog", { name: "Token của thiết bị “Tủ bếp”" });
    expect(within(tokenDialog).getByLabelText("Token thiết bị")).toHaveValue("smcdev_TEST_TOKEN_ONLY_SHOWN_ONCE");
    expect(within(tokenDialog).getByLabelText("Địa chỉ kết nối WSS")).toHaveValue("wss://api.example.com/api/v1/device/ws");
    expect(within(tokenDialog).getByText(/Token chỉ hiển thị MỘT lần/)).toBeInTheDocument();
    expect(api.calls.some((c) => c.method === "POST" && c.path === "/devices" && (c.body as { name: string }).name === "Tủ bếp")).toBe(true);
  });

  it("gửi lệnh còi: chỉ báo thành công sau khi thiết bị xác nhận đã thực hiện (ACK applied)", async () => {
    api.devices = [deviceInfo()];
    const user = userEvent.setup();
    renderApp("/admin/devices");
    expect(await screen.findByRole("heading", { name: "Tủ phòng khách" })).toBeInTheDocument();
    expect(await screen.findByText("25.5°C")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Gửi lệnh" }));
    const post = api.calls.find((c) => c.method === "POST" && c.path === "/devices/dev-1/commands");
    expect(post?.body).toEqual({ action: "buzzer", payload: { on: true, duration_s: 5 }, ttl_seconds: null });

    const tracker = await screen.findByTestId("command-tracker");
    // Ngay sau khi gửi: chưa có thông báo thành công.
    expect(screen.queryByText("Thiết bị đã thực hiện lệnh")).not.toBeInTheDocument();
    await waitFor(() => expect(within(tracker).getByText("Đã thực hiện")).toBeInTheDocument(), SLOW);
    expect(await screen.findByText("Thiết bị đã thực hiện lệnh")).toBeInTheDocument();
    expect(within(tracker).getByText("Thiết bị đã nhận (ACK)")).toBeInTheDocument();
  }, 10_000);

  it("thiết bị không phản hồi tới khi hết hạn: báo “Hết thời gian”, không báo thành công", async () => {
    api.devices = [deviceInfo()];
    api.commandStatuses = ["sent", "timed_out"];
    const user = userEvent.setup();
    renderApp("/admin/devices");
    await screen.findByRole("heading", { name: "Tủ phòng khách" });
    await user.click(screen.getByRole("button", { name: "Gửi lệnh" }));
    const tracker = await screen.findByTestId("command-tracker");
    await waitFor(() => expect(within(tracker).getByText("Hết thời gian")).toBeInTheDocument(), SLOW);
    expect(await screen.findByText("Lệnh hết thời gian")).toBeInTheDocument();
    expect(screen.queryByText("Thiết bị đã thực hiện lệnh")).not.toBeInTheDocument();
  }, 10_000);

  it("thiết bị chưa khai báo lệnh hỗ trợ: không cho gửi lệnh", async () => {
    api.devices = [deviceInfo({ online: false, capabilities: [], supported_actions: [] })];
    renderApp("/admin/devices");
    expect(await screen.findByText(/Thiết bị chưa khai báo lệnh nào được hỗ trợ/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Gửi lệnh" })).not.toBeInTheDocument();
  });
});

describe("Quản trị → Tài khoản", () => {
  it("tạo tài khoản mặc định là SCANNER (chỉ quét trên điện thoại)", async () => {
    const user = userEvent.setup();
    renderApp("/admin/users");
    expect(await screen.findByText("admin@example.com")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Thêm tài khoản" }));
    const dialog = await screen.findByRole("dialog", { name: "Thêm tài khoản" });
    expect(within(dialog).getByRole("combobox", { name: "Vai trò" })).toHaveValue("SCANNER");
    expect(within(dialog).getByText("Chỉ quét thuốc và xem lịch sử của mình trên ứng dụng điện thoại.")).toBeInTheDocument();
    const [email] = within(dialog).getAllByRole("textbox");
    await user.type(email, "scanner@example.com");
    const passwords = dialog.querySelectorAll<HTMLInputElement>('input[type="password"]');
    await user.type(passwords[0], "matkhau123");
    await user.type(passwords[1], "matkhau123");
    await user.click(within(dialog).getByRole("button", { name: "Tạo tài khoản" }));
    await waitFor(() => expect(api.calls.some((c) => c.method === "POST" && c.path === "/admin/users")).toBe(true));
    const body = api.calls.find((c) => c.method === "POST" && c.path === "/admin/users")?.body as Record<string, unknown>;
    expect(body).toMatchObject({ email: "scanner@example.com", role: "SCANNER", password: "matkhau123" });
    expect(await within(screen.getByRole("table")).findByText("scanner@example.com")).toBeInTheDocument();
  });

  it("mật khẩu nhập lại không khớp thì không cho tạo", async () => {
    const user = userEvent.setup();
    renderApp("/admin/users");
    await user.click(await screen.findByRole("button", { name: "Thêm tài khoản" }));
    const dialog = await screen.findByRole("dialog", { name: "Thêm tài khoản" });
    await user.type(within(dialog).getAllByRole("textbox")[0], "x@example.com");
    const passwords = dialog.querySelectorAll<HTMLInputElement>('input[type="password"]');
    await user.type(passwords[0], "matkhau123");
    await user.type(passwords[1], "matkhau124");
    expect(within(dialog).getByText("Mật khẩu nhập lại không khớp.")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Tạo tài khoản" })).toBeDisabled();
  });
});
