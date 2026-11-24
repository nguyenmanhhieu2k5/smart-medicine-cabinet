import { act, fireEvent, render, renderHook, screen } from "@testing-library/react-native";
import { router } from "expo-router";
import { api, PUBLIC_PATH } from "@/api";
import type { AiLookupResult, BarcodeResult } from "@/api/types";
import { isQr, useBarcodeScanner } from "@/scan/barcode";
import AiLookupScreen from "../../app/(app)/ai-lookup";

jest.mock("react-native-safe-area-context", () => {
  const { View } = jest.requireActual("react-native");
  return { SafeAreaView: View, useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) };
});
jest.mock("expo-haptics", () => ({ notificationAsync: jest.fn(async () => undefined), NotificationFeedbackType: { Success: "success" } }));
jest.mock("expo-file-system", () => ({ File: class {} }));

const routerMock = jest.requireMock<{ useLocalSearchParams: () => Record<string, string> }>("expo-router");
const original = routerMock.useLocalSearchParams;

const found: AiLookupResult = {
  status: "found", kind: "barcode", mode: "web", model: "gemini-3.8-flash", cached: false, elapsed_ms: 4200,
  result: {
    found: true, ten_thuoc: "Augmentin 625mg", hoat_chat: "Amoxicillin; Acid clavulanic", ham_luong: "500mg/125mg", dang_bao_che: "Viên nén",
    quy_cach: "Hộp 2 vỉ x 7 viên", so_dang_ky: "VN-20169-16", nha_san_xuat: "GSK", nuoc_san_xuat: "Anh", do_tin_cay: "cao", ghi_chu: null,
  },
  sources: [{ title: "nhathuoc.example", url: "https://example.com/augmentin" }],
  catalog_matches: [{ id: 34382, ten_thuoc: "Augmentin 625mg tablets", hoat_chat_chinh: null, ham_luong: null, dang_bao_che: null, so_dang_ky: "VN-20169-16", match_by: "registration" }],
  message: "AI đã tìm thấy thông tin trên mạng.", reason: null, notice: "Thông tin do AI tổng hợp từ Internet, có thể chưa chính xác. Hãy hỏi dược sĩ.",
};

afterEach(() => {
  routerMock.useLocalSearchParams = original;
  jest.restoreAllMocks();
  jest.clearAllMocks();
});

describe("Điện thoại chỉ gọi được API AI dành cho Scanner", () => {
  it("cho phép tra mã/ảnh, chặn trạng thái AI (chỉ ở kênh quản trị)", () => {
    expect(PUBLIC_PATH.test("/ai/lookup")).toBe(true);
    expect(PUBLIC_PATH.test("/ai/scans/0b8f2f7e-1f0c-4f0e-9a51-2a4b8c6d7e8f")).toBe(true);
    for (const path of ["/ai/status", "/ai/scans/abc", "/ai", "/ai/lookup/x"]) expect(PUBLIC_PATH.test(path)).toBe(false);
  });
});

describe("Mã chưa có trong dữ liệu → AI tự tìm trên mạng", () => {
  const scan = async (reply: Partial<BarcodeResult>, input: { data: string; type: string }) => {
    jest.spyOn(api, "lookupBarcode").mockResolvedValue({ code: input.data, gtin: null, gs1: null, medicine: null, history_id: null, message: "", status: "not_found", ...reply });
    const { result } = await renderHook(() => useBarcodeScanner({ enabled: true, vibrate: false }));
    await act(async () => result.current.onScanned(input));
  };

  it("mã vạch hợp lệ nhưng chưa có → mở màn AI với mã đó", async () => {
    await scan({ status: "not_found", code: "8935206010121" }, { data: "8935206010121", type: "ean13" });
    expect(router.push).toHaveBeenCalledWith({ pathname: "/ai-lookup", params: { kind: "barcode", code: "8935206010121" } });
  });

  it("mã QR không theo chuẩn GS1 → AI đọc nội dung; mã nội bộ cửa hàng thì bỏ qua", async () => {
    await scan({ status: "invalid" }, { data: "https://hang-thuoc.example/sp/123", type: "qr" });
    expect(router.push).toHaveBeenCalledWith({ pathname: "/ai-lookup", params: { kind: "qr", code: "https://hang-thuoc.example/sp/123" } });
    jest.clearAllMocks();
    await scan({ status: "internal" }, { data: "2000000000015", type: "ean13" });
    expect(router.push).not.toHaveBeenCalled();
    expect(isQr("org.iso.QRCode")).toBe(true);
    expect(isQr("ean13")).toBe(false);
  });
});

describe("Màn Tìm trên mạng (AI)", () => {
  it("hiện thông tin, độ tin cậy, nguồn, lưu ý an toàn; thuốc khớp danh mục mở Chi tiết thuốc", async () => {
    routerMock.useLocalSearchParams = () => ({ kind: "barcode", code: "8935206010121" });
    const lookup = jest.spyOn(api, "aiLookup").mockResolvedValue(found);
    await render(<AiLookupScreen />);
    expect(await screen.findByTestId("ai-result")).toBeTruthy();
    expect(lookup).toHaveBeenCalledWith("barcode", "8935206010121");
    expect(screen.getByText("Augmentin 625mg")).toBeTruthy();
    expect(screen.getByText("AI · đã tra trên mạng")).toBeTruthy();
    expect(screen.getByText("Độ tin cậy: Cao")).toBeTruthy();
    expect(screen.getByText("nhathuoc.example")).toBeTruthy();
    expect(screen.getByText(/hỏi dược sĩ/)).toBeTruthy();
    await fireEvent.press(screen.getByTestId("ai-match-34382"));
    expect(router.push).toHaveBeenCalledWith({ pathname: "/medicine/[id]", params: { id: "34382" } });
  });

  it("ảnh quét: gọi AI theo đúng lượt quét", async () => {
    routerMock.useLocalSearchParams = () => ({ kind: "scan", jobId: "0b8f2f7e-1f0c-4f0e-9a51-2a4b8c6d7e8f" });
    const aiScan = jest.spyOn(api, "aiScan").mockResolvedValue({ ...found, kind: "scan", mode: "offline" });
    await render(<AiLookupScreen />);
    expect(await screen.findByText("AI · chỉ đọc ảnh/mã")).toBeTruthy();
    expect(aiScan).toHaveBeenCalledWith("0b8f2f7e-1f0c-4f0e-9a51-2a4b8c6d7e8f");
  });

  it("Gemini chưa cho tìm kiếm → báo rõ lý do, có nút thử lại", async () => {
    routerMock.useLocalSearchParams = () => ({ kind: "barcode", code: "8935206010121" });
    const lookup = jest.spyOn(api, "aiLookup").mockResolvedValue({
      ...found, status: "unavailable", result: null, catalog_matches: [], sources: [], reason: "search_quota",
      message: "Gemini chưa cho phép tìm kiếm trên mạng: hết hạn mức Google Search của khóa API.",
    });
    await render(<AiLookupScreen />);
    expect(await screen.findByTestId("ai-unavailable")).toBeTruthy();
    expect(screen.getByText(/hết hạn mức Google Search/)).toBeTruthy();
    await fireEvent.press(screen.getByText("Thử lại"));
    expect(lookup).toHaveBeenCalledTimes(2);
  });
});

describe("Tra trên mạng không dùng AI (Tavily)", () => {
  it("ghi rõ “không dùng AI”, không gắn nhãn AI", async () => {
    routerMock.useLocalSearchParams = () => ({ kind: "barcode", code: "8935206010121" });
    jest.spyOn(api, "aiLookup").mockResolvedValue({ ...found, mode: "search", model: "tavily", notice: "Kết quả tìm kiếm trên Internet (không dùng AI)." });
    await render(<AiLookupScreen />);
    expect(await screen.findByText("Tra trên mạng · không dùng AI")).toBeTruthy();
    expect(screen.queryByText("AI · đã tra trên mạng")).toBeNull();
    expect(screen.getByText("Tìm trên mạng")).toBeTruthy();
  });
});
