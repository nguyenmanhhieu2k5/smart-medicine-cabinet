import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { pickCode, shouldHandle } from "@/scan/codeReader";
import { beforeEach, describe, expect, it } from "vitest";
import { installMockApi, type MockState } from "./mockApi";
import { renderApp } from "./renderApp";

let api: MockState;
beforeEach(() => {
  api = installMockApi();
});

describe("Quét mã trực tiếp bằng webcam — chọn mã và chống lặp", () => {
  it("ưu tiên mã sản phẩm (mã vạch / DataMatrix) khi khung hình có cả mã QR", () => {
    expect(pickCode([{ format: "QRCode", text: "http://vacopharm.com" }, { format: "EAN13", text: "8936144803219" }]))
      .toEqual({ format: "EAN13", text: "8936144803219" });
    expect(pickCode([{ format: "QRCode", text: "SDK VN-20169-16" }])?.format).toBe("QRCode");
    expect(pickCode([])).toBeNull();
  });

  it("cùng một mã chỉ xử lý lại sau 10 giây (camera thấy mã liên tục)", () => {
    const seen = new Map<string, number>();
    expect(shouldHandle("8936144803219", 1_000, seen)).toBe(true);
    expect(shouldHandle("8936144803219", 5_000, seen)).toBe(false);
    expect(shouldHandle("8935206010121", 5_000, seen)).toBe(true);
    expect(shouldHandle("8936144803219", 11_500, seen)).toBe(true);
    expect(shouldHandle("  ", 20_000, seen)).toBe(false);
  });
});

describe("Kết quả quét mã (camera tự đọc mã, không bấm chụp)", () => {
  it("mã có trong dữ liệu → hiện thuốc ngay, có nút Thêm vào tủ, không tìm trên mạng", async () => {
    api.barcodes = 1;
    renderApp(`/scan/code?code=8935206010121&format=EAN13`);
    const medicine = await screen.findByTestId("code-medicine");
    expect(medicine).toHaveTextContent("Augmentin 625mg tablets");
    expect(screen.getByText("Khớp dữ liệu mã vạch")).toBeInTheDocument();
    expect(within(medicine).getByRole("button", { name: "Thêm vào tủ" })).toBeInTheDocument();
    expect(screen.getByTestId("code-card")).toHaveTextContent("EAN-13");
    expect(screen.queryByTestId("ai-panel")).toBeNull();
    expect(api.calls.some((call) => call.path === "/ai/lookup")).toBe(false);
  });

  it("mã vạch chưa có dữ liệu → TỰ tìm trên mạng theo đúng mã đó", async () => {
    renderApp(`/scan/code?code=8935206010121&format=EAN13`);
    expect(await screen.findByText("Chưa có dữ liệu mã vạch")).toBeInTheDocument();
    await screen.findByTestId("ai-result");
    expect(api.calls).toContainEqual({ method: "POST", path: "/ai/lookup", body: { kind: "barcode", code: "8935206010121" } });
  });

  it("mã QR → TỰ tìm thuốc trên mạng theo nội dung QR (không cần bấm)", async () => {
    const text = "https://hang-thuoc.example/sp/123";
    renderApp(`/scan/code?${new URLSearchParams({ code: text, format: "QRCode" })}`);
    const panel = await screen.findByTestId("ai-panel");
    expect(panel).toHaveTextContent("Mã QR — Tìm thuốc trên mạng");
    await within(panel).findByTestId("ai-result");
    expect(api.calls).toContainEqual({ method: "POST", path: "/ai/lookup", body: { kind: "qr", code: text } });
    expect(screen.getByTestId("code-card")).toHaveTextContent("QR Code");
  });

  it("mã 1D không phải mã sản phẩm → báo rõ, không tìm trên mạng", async () => {
    renderApp(`/scan/code?code=ABC-123&format=Code128`);
    expect(await screen.findByRole("alert")).toHaveTextContent("không phải mã vạch sản phẩm");
    expect(screen.queryByTestId("ai-panel")).toBeNull();
  });

  it("nút “Quét mã khác” quay lại trang Quét", async () => {
    const user = userEvent.setup();
    renderApp(`/scan/code?code=8935206010121&format=EAN13`);
    await user.click(await screen.findByRole("button", { name: "Quét mã khác" }));
    await waitFor(() => expect(screen.queryByTestId("code-card")).toBeNull());
  });
});
