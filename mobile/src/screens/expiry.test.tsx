import { fireEvent, render, screen } from "@testing-library/react-native";
import { api, PUBLIC_PATH } from "@/api";
import type { CabinetList, CabinetMedicine } from "@/api/types";
import { isoToVnDate, maskDateInput, vnDateToIso } from "@/utils/format";
import ExpiryScreen from "../../app/(app)/(tabs)/profile/expiry";

jest.mock("react-native-safe-area-context", () => {
  const { View } = jest.requireActual("react-native");
  return { SafeAreaView: View, useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) };
});
jest.mock("expo-file-system", () => ({ File: class {} }));
// useFocusEffect chạy ngay như useEffect để màn hình tải dữ liệu trong kiểm thử.
jest.mock("expo-router", () => {
  const { useEffect } = jest.requireActual("react");
  return { router: { push: jest.fn(), back: jest.fn(), canGoBack: () => true, replace: jest.fn() }, useFocusEffect: (cb: () => void) => useEffect(cb, [cb]) };
});

const med = (id: number, name: string, expiry: string | null, status: CabinetMedicine["expiry_status"], label: string): CabinetMedicine => ({
  id, catalog_id: null, name, ingredient: null, strength: "500mg", dosage_form: null, registration_no: null, manufacturer: null,
  quantity_text: "20 viên", expiry_date: expiry, expiry_source: expiry ? "manual" : null, expiry_status: status, expiry_status_label: label,
  days_left: null, lot_number: null, updated_at: "2026-11-25T00:00:00",
});
const list: CabinetList = {
  items: [med(1, "Paracetamol 500mg", "2026-01-01", "expired", "Đã hết hạn"), med(2, "Augmentin 625mg", "2027-06-15", "ok", "Còn hạn")],
  total: 2, counts: { all: 2, expired: 1, expiring: 0, ok: 1, unknown: 0, low_stock: 0 },
};

afterEach(() => jest.restoreAllMocks());

describe("Ngày kiểu Việt Nam", () => {
  it("đổi qua lại và kiểm tra ngày có thật", () => {
    expect(isoToVnDate("2027-06-15")).toBe("15/06/2027");
    expect(vnDateToIso("15/6/2027")).toBe("2027-06-15");
    expect(vnDateToIso("31/02/2027")).toBeNull();
    expect(vnDateToIso("2027-06-15")).toBeNull();
    expect(maskDateInput("15062027")).toBe("15/06/2027");
    expect(maskDateInput("15/0")).toBe("15/0");
  });
});

describe("Điện thoại chỉ gọi được: xem tủ thuốc + sửa ngày hết hạn", () => {
  it("chặn mọi đường thêm/xóa/sửa khác", () => {
    expect(PUBLIC_PATH.test("/cabinet/medicines")).toBe(true);
    expect(PUBLIC_PATH.test("/cabinet/medicines/12/expiry")).toBe(true);
    for (const path of ["/cabinet/medicines/12", "/cabinet/medicines/12/adjust", "/cabinet/summary", "/cabinet/medicines/abc/expiry"]) {
      expect(PUBLIC_PATH.test(path)).toBe(false);
    }
  });
});

describe("Màn Hạn dùng thuốc", () => {
  it("liệt kê thuốc, sửa ngày hết hạn (chỉ gửi đúng ngày), không có nút thêm/xóa thuốc", async () => {
    jest.spyOn(api, "cabinet").mockResolvedValue(list);
    const update = jest.spyOn(api, "updateExpiry").mockResolvedValue(med(1, "Paracetamol 500mg", "2028-01-31", "ok", "Còn hạn"));
    await render(<ExpiryScreen />);
    expect(await screen.findByText("Paracetamol 500mg")).toBeTruthy();
    expect(screen.getByText("HSD: 01/01/2026")).toBeTruthy();
    expect(screen.getByText("Đã hết hạn")).toBeTruthy();
    expect(screen.queryByText(/Thêm thuốc|Xóa thuốc/)).toBeNull();

    await fireEvent.press(screen.getByTestId("expiry-row-1"));
    const input = screen.getByTestId("expiry-input");
    await fireEvent.changeText(input, "31/02/2028");
    await fireEvent.press(screen.getByTestId("expiry-save"));
    expect(update).not.toHaveBeenCalled();
    expect(screen.getByText(/Nhập ngày theo dạng/)).toBeTruthy();

    await fireEvent.changeText(input, "31012028");
    await fireEvent.press(screen.getByTestId("expiry-save"));
    expect(update).toHaveBeenCalledWith(1, "2028-01-31");
    expect(await screen.findByText(/hạn dùng 31\/01\/2028/)).toBeTruthy();
  });

  it("lọc theo trạng thái gọi máy chủ; tìm theo tên lọc ngay trên máy (không dấu)", async () => {
    const cabinet = jest.spyOn(api, "cabinet").mockResolvedValue(list);
    await render(<ExpiryScreen />);
    await screen.findByText("Augmentin 625mg");
    await fireEvent.changeText(screen.getByLabelText("Tìm thuốc trong tủ"), "PARACETAMOL");
    expect(screen.queryByText("Augmentin 625mg")).toBeNull();
    expect(screen.getByText("Paracetamol 500mg")).toBeTruthy();
    await fireEvent.press(screen.getByText("Hết hạn 1"));
    expect(cabinet).toHaveBeenLastCalledWith({ status: "expired" });
  });
});
