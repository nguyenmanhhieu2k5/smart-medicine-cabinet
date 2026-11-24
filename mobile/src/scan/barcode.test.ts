import { router } from "expo-router";
import { PUBLIC_PATH } from "@/api/client";
import type { BarcodeResult } from "@/api/types";
import { BARCODE_TYPES, openBarcodeResult, REPEAT_MS, shouldHandle } from "./barcode";

jest.mock("expo-haptics", () => ({ notificationAsync: jest.fn(async () => undefined), NotificationFeedbackType: { Success: "success" } }));
jest.mock("expo-file-system", () => ({ File: class {} }));

describe("Quét mã vạch trong khung camera", () => {
  it("camera báo cùng một mã liên tục → chỉ hỏi máy chủ một lần trong 10 giây", () => {
    const seen = new Map<string, number>();
    expect(shouldHandle("8935206010120", 1_000, seen)).toBe(true);
    expect(shouldHandle("8935206010120", 1_200, seen)).toBe(false);
    expect(shouldHandle("8935206010120", 1_000 + REPEAT_MS - 1, seen)).toBe(false);
    expect(shouldHandle("8936000000016", 1_300, seen)).toBe(true); // mã khác thì xử lý ngay
    expect(shouldHandle("8935206010120", 1_000 + REPEAT_MS, seen)).toBe(true);
    expect(shouldHandle("   ", 9_999_999, seen)).toBe(false);
  });

  it("nhận cả EAN-13 trên vỏ hộp lẫn mã 2D DataMatrix (hạn dùng, số lô)", () => {
    expect(BARCODE_TYPES).toEqual(expect.arrayContaining(["ean13", "ean8", "upc_a", "datamatrix", "qr"]));
  });

  it("tìm thấy → mở Chi tiết thuốc kèm mã, hạn dùng và số lô của hộp", () => {
    const result: BarcodeResult = {
      status: "found", code: "8935206010120", gtin: "08935206010120", history_id: "h1", message: "",
      gs1: { expiry: "2027-01-31", lot: "LOT42", serial: null },
      medicine: { id: 34382, ten_thuoc: "Augmentin 625mg tablets", hoat_chat_chinh: null, ham_luong: null, dang_bao_che: null, so_dang_ky: "VN-20169-16" },
    };
    openBarcodeResult(result);
    expect(router.push).toHaveBeenCalledWith({
      pathname: "/medicine/[id]", params: { id: "34382", barcode: "8935206010120", expiry: "2027-01-31", lot: "LOT42" },
    });
  });

  it("chỉ được gọi API tra mã, không có đường nào ghi dữ liệu mã vạch từ điện thoại", () => {
    expect(PUBLIC_PATH.test("/barcodes/lookup")).toBe(true);
    for (const path of ["/barcodes/import", "/barcodes/8935206010120", "/catalog/barcodes/import", "/catalog/barcodes/status"]) {
      expect(PUBLIC_PATH.test(path)).toBe(false);
    }
  });
});
