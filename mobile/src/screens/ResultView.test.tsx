import { fireEvent, render, screen } from "@testing-library/react-native";
import { router } from "expo-router";
import { api } from "@/api";
import type { Candidate, ScanJob } from "@/api/types";
import { ResultView } from "./ResultView";

jest.mock("react-native-safe-area-context", () => {
  const { View } = jest.requireActual("react-native");
  return { SafeAreaView: View, useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) };
});

const candidate = (id: number, name: string, level: Candidate["level"]): Candidate => ({
  rank: 1, score: level === "high" ? 92 : 70, level, level_label: level,
  medicine: { id, ten_thuoc: name, hoat_chat_chinh: "Amoxicillin; Acid clavulanic", ham_luong: "500mg/125mg", dang_bao_che: "Viên nén", so_dang_ky: `VN-${id}` },
});

function job(status: "confident" | "uncertain" | "no_text", candidates: Candidate[]): ScanJob {
  return {
    id: "0b8f2f7e-1f0c-4f0e-9a51-2a4b8c6d7e8f", status: "done", progress: 100, message: "", stages: null, created_at: "2026-11-19T10:00:00+07:00",
    finished_at: null, error: null, history_id: "11111111-2222-3333-4444-555555555555",
    result: { match: { status, message: "", reasons: [], candidates }, ocr_text: [], expiry_suggestion: null, elapsed_ms: 800 },
  };
}

describe("Kết quả nhận diện", () => {
  beforeEach(() => jest.clearAllMocks());

  it("hiện tối đa 3 kết quả, chọn sẵn kết quả đầu; Xem chi tiết chỉ ghi lịch sử rồi mở chi tiết (không thêm vào tủ)", async () => {
    const select = jest.spyOn(api, "selectCandidate").mockResolvedValue({ item: {} as never });
    const many = [candidate(1, "Augmentin 625mg", "high"), candidate(2, "Augmentin 1g", "high"), candidate(3, "Klamentin", "medium"), candidate(4, "Thừa", "low")];
    await render(<ResultView job={job("confident", many)} historyId="11111111-2222-3333-4444-555555555555" />);
    expect(screen.getByText("Đã tìm thấy 3 kết quả phù hợp")).toBeTruthy();
    expect(screen.queryByText("Thừa")).toBeNull();
    expect(screen.getByText("Phù hợp nhất")).toBeTruthy();
    expect(screen.getByText("Mức độ phù hợp: Trung bình")).toBeTruthy();

    await fireEvent.press(screen.getByTestId("candidate-2"));
    await fireEvent.press(screen.getByTestId("open-detail"));
    expect(select).toHaveBeenCalledWith("11111111-2222-3333-4444-555555555555", 3);
    expect(router.push).toHaveBeenCalledWith({ pathname: "/medicine/[id]", params: { id: "3", jobId: "0b8f2f7e-1f0c-4f0e-9a51-2a4b8c6d7e8f" } });
  });

  it("kết quả chưa chắc chắn: nêu rõ để người dùng tự chọn", async () => {
    await render(<ResultView job={job("uncertain", [candidate(1, "A", "medium"), candidate(2, "B", "medium")])} />);
    expect(screen.getByText("Chưa chắc chắn · 2 khả năng")).toBeTruthy();
  });

  it("không có ứng viên: màn “Không nhận diện được” với Quét lại / Chọn ảnh khác", async () => {
    await render(<ResultView job={job("no_text", [])} />);
    expect(screen.getByText("Không nhận diện được thông tin thuốc")).toBeTruthy();
    await fireEvent.press(screen.getByLabelText("Quét lại"));
    expect(router.navigate).toHaveBeenCalledWith("/scan");
    expect(screen.getByLabelText("Chọn ảnh khác")).toBeTruthy();
  });
});

describe("Không có thuốc đúng → tìm trên mạng bằng AI", () => {
  beforeEach(() => jest.clearAllMocks());

  it("có ứng viên nhưng người dùng xác nhận không có thuốc đúng → mở AI theo đúng lượt quét", async () => {
    await render(<ResultView job={job("uncertain", [candidate(1, "Augmentin 625mg", "medium")])} historyId={null} />);
    await fireEvent.press(screen.getByTestId("ai-not-listed"));
    expect(router.push).toHaveBeenCalledWith({ pathname: "/ai-lookup", params: { kind: "scan", jobId: "0b8f2f7e-1f0c-4f0e-9a51-2a4b8c6d7e8f" } });
  });

  it("không nhận diện được → có nút tìm bằng AI", async () => {
    await render(<ResultView job={job("no_text", [])} />);
    await fireEvent.press(screen.getByTestId("ai-search"));
    expect(router.push).toHaveBeenCalledWith({ pathname: "/ai-lookup", params: { kind: "scan", jobId: "0b8f2f7e-1f0c-4f0e-9a51-2a4b8c6d7e8f" } });
  });
});
