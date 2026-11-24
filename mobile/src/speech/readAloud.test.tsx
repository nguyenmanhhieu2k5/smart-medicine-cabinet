import { act, fireEvent, render, screen } from "@testing-library/react-native";
import * as Speech from "expo-speech";
import { api } from "@/api";
import type { MedicineDetail } from "@/api/types";
import MedicineDetailScreen from "../../app/(app)/medicine/[id]";
import { SPEECH_LANGUAGE, SPEECH_RATE } from "./useSpeech";

jest.mock("react-native-safe-area-context", () => {
  const { View } = jest.requireActual("react-native");
  return { SafeAreaView: View, useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) };
});
jest.mock("expo-speech", () => ({
  speak: jest.fn(),
  stop: jest.fn(async () => undefined),
  getAvailableVoicesAsync: jest.fn(async () => []),
  VoiceQuality: { Default: "Default", Enhanced: "Enhanced" },
}));

const speak = Speech.speak as jest.Mock;
const voices = Speech.getAvailableVoicesAsync as jest.Mock;
const medicine: MedicineDetail = {
  id: 7, ten_thuoc: "Paracetamol 500", hoat_chat_chinh: "Paracetamol", ham_luong: "500mg", dang_bao_che: "Viên nén",
  so_dang_ky: "893110103026", dong_goi: "Hộp 10 vỉ x 10 viên", ten_cong_ty_san_xuat: "Công ty Dược Hậu Giang",
  nuoc_san_xuat: "Việt Nam", registration_status: { code: "valid", label: "Số đăng ký còn hiệu lực" }, source: "DAV_unique", read_only: true,
};
const voice = (identifier: string, language: string, quality = "Default") => ({ identifier, name: identifier, language, quality });

async function openDetail() {
  jest.spyOn(api, "medicine").mockResolvedValue(medicine);
  await render(<MedicineDetailScreen />);
  return screen.findByLabelText("Đọc thông tin thuốc");
}

describe("Giọng đọc tiếng Việt ở màn Chi tiết thuốc", () => {
  beforeEach(() => jest.clearAllMocks());

  it("đọc bằng giọng tiếng Việt cài sẵn trên máy; bấm lần nữa để dừng", async () => {
    voices.mockResolvedValue([
      voice("en-us-x-sfg-local", "en-US"), voice("vi-vn-x-gft-network", "vi-VN", "Enhanced"), voice("vi-vn-x-gft-local", "vi-VN"),
    ]);
    await fireEvent.press(await openDetail());
    expect(speak).toHaveBeenCalledTimes(1);
    const [text, options] = speak.mock.calls[0];
    expect(text).toMatch(/^Tên thuốc: Paracetamol 500\. Hàm lượng: 500 mi li gam\./);
    expect(options).toMatchObject({ language: SPEECH_LANGUAGE, voice: "vi-vn-x-gft-local", rate: SPEECH_RATE });

    const stopButton = await screen.findByLabelText("Dừng đọc");
    await fireEvent.press(stopButton);
    expect(Speech.stop).toHaveBeenCalled();
    expect(await screen.findByLabelText("Đọc thông tin thuốc")).toBeTruthy();
  });

  it("đọc xong thì nút trở lại trạng thái Đọc", async () => {
    voices.mockResolvedValue([voice("vi-VN-default", "vi-VN")]);
    await fireEvent.press(await openDetail());
    expect(await screen.findByLabelText("Dừng đọc")).toBeTruthy();
    await act(async () => speak.mock.calls[0][1].onDone());
    expect(await screen.findByLabelText("Đọc thông tin thuốc")).toBeTruthy();
  });

  it("máy không có giọng tiếng Việt → không đọc bằng giọng khác, hướng dẫn cài đặt", async () => {
    voices.mockResolvedValue([voice("en-us-x-sfg-local", "en-US")]);
    await fireEvent.press(await openDetail());
    expect(speak).not.toHaveBeenCalled();
    expect(await screen.findByText(/chưa có giọng đọc tiếng Việt/)).toBeTruthy();
  });

  it("bộ đọc chưa trả danh sách giọng (lần đầu trên Android) → vẫn đọc theo mã ngôn ngữ tiếng Việt", async () => {
    voices.mockResolvedValue([]);
    await fireEvent.press(await openDetail());
    expect(speak).toHaveBeenCalledWith(expect.stringContaining("Tên thuốc"), expect.objectContaining({ language: SPEECH_LANGUAGE, voice: undefined }));
  });

  it("mở từ quét mã vạch 2D: hiện mã, hạn dùng, số lô của hộp và đọc kèm", async () => {
    const routerMock = jest.requireMock<{ useLocalSearchParams: () => Record<string, string> }>("expo-router");
    const original = routerMock.useLocalSearchParams;
    routerMock.useLocalSearchParams = () => ({ id: "7", barcode: "8935206010120", expiry: "2027-01-31", lot: "LOT42" });
    try {
      voices.mockResolvedValue([voice("vi-VN-default", "vi-VN")]);
      const button = await openDetail();
      expect(screen.getByTestId("box-info")).toBeTruthy();
      expect(screen.getByText("Mã vạch 8935206010120")).toBeTruthy();
      expect(screen.getByText("HSD 31/01/2027")).toBeTruthy();
      expect(screen.getByText("Lô LOT42")).toBeTruthy();
      await fireEvent.press(button);
      expect(speak.mock.calls[0][0]).toContain("Hạn dùng của hộp này: ngày 31 tháng 1 năm 2027. Số lô: L O T 4 2.");
    } finally {
      routerMock.useLocalSearchParams = original;
    }
  });

  it("trên Android phải truyền mã 'vi' (expo-speech coi 'vi-VN' là sai và chuyển sang giọng mặc định)", () => {
    jest.isolateModules(() => {
      const { Platform } = jest.requireActual<typeof import("react-native")>("react-native");
      const original = Platform.OS;
      Object.defineProperty(Platform, "OS", { value: "android", configurable: true });
      try {
        expect(jest.requireActual<typeof import("./useSpeech")>("./useSpeech").SPEECH_LANGUAGE).toBe("vi");
      } finally {
        Object.defineProperty(Platform, "OS", { value: original, configurable: true });
      }
    });
  });
});
