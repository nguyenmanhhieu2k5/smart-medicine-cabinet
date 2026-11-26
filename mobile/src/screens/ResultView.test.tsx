import { fireEvent, render, screen } from "@testing-library/react-native";
import { router } from "expo-router";
import { api } from "@/api";
import type { Candidate, ScanBarcode, ScanJob } from "@/api/types";
import { codeToLookUp, ResultView } from "./ResultView";

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

describe("Ảnh bị lóa sáng (giấy bạc vỉ thuốc, hộp bóng, đèn flash)", () => {
  const withGlare = (j: ScanJob, glare: number | null): ScanJob => ({ ...j, result: j.result && { ...j.result, glare } });

  it("lóa mà chưa chắc chắn → nhắc tắt đèn flash, nghiêng vỉ/hộp rồi chụp lại", async () => {
    await render(<ResultView job={withGlare(job("uncertain", [candidate(20839, "Desloderma 5", "medium")]), 6.5)} />);
    expect(screen.getByTestId("glare-tip")).toBeTruthy();
    expect(screen.getByText(/Tắt đèn flash, nghiêng nhẹ hộp\/vỉ thuốc/)).toBeTruthy();
  });

  it("không đọc được chữ vì lóa → lời giải thích nói rõ là do lóa", async () => {
    await render(<ResultView job={withGlare(job("no_text", []), 12)} />);
    expect(screen.getByText(/Ảnh bị lóa sáng ở vùng giữa/)).toBeTruthy();
  });

  it("ít lóa, đã chắc chắn, hoặc máy chủ cũ không báo lóa → không nhắc", async () => {
    for (const j of [withGlare(job("uncertain", [candidate(1, "A", "medium")]), 1.2), withGlare(job("confident", [candidate(1, "A", "high")]), 20), job("uncertain", [candidate(1, "A", "medium")])]) {
      const view = await render(<ResultView job={j} />);
      expect(screen.queryByTestId("glare-tip")).toBeNull();
      await view.unmount();
    }
  });
});

describe("Không có thuốc đúng → tìm trên mạng (máy chủ mặc định dùng Tavily, không AI)", () => {
  beforeEach(() => jest.clearAllMocks());

  it("có ứng viên nhưng người dùng xác nhận không có thuốc đúng → tìm trên mạng theo đúng lượt quét", async () => {
    await render(<ResultView job={job("uncertain", [candidate(1, "Augmentin 625mg", "medium")])} historyId={null} />);
    expect(screen.getByText("Tìm tên thuốc trên hộp vừa chụp trên mạng")).toBeTruthy();
    expect(screen.queryByText(/bằng AI/)).toBeNull();
    await fireEvent.press(screen.getByTestId("ai-not-listed"));
    expect(router.push).toHaveBeenCalledWith({ pathname: "/ai-lookup", params: { kind: "scan", jobId: "0b8f2f7e-1f0c-4f0e-9a51-2a4b8c6d7e8f" } });
  });

  it("không nhận diện được → có nút “Tìm trên mạng”", async () => {
    await render(<ResultView job={job("no_text", [])} />);
    expect(screen.getByText("Tìm trên mạng")).toBeTruthy();
    await fireEvent.press(screen.getByTestId("ai-search"));
    expect(router.push).toHaveBeenCalledWith({ pathname: "/ai-lookup", params: { kind: "scan", jobId: "0b8f2f7e-1f0c-4f0e-9a51-2a4b8c6d7e8f" } });
  });
});

describe("Ảnh có mã vạch / mã QR (máy chủ đọc mã trên ảnh, kể cả ảnh chọn từ thư viện)", () => {
  beforeEach(() => jest.clearAllMocks());
  const code = (status: ScanBarcode["status"], extra: Partial<ScanBarcode> = {}): ScanBarcode => ({
    format: "EAN-13", text: "8935206010121", kind: "gtin", display: "8935206010121", status,
    medicine_id: status === "found" ? 1 : null, match_by: status === "found" ? "barcode" : null, expiry: null, lot: null, ...extra,
  });
  const withCodes = (base: ScanJob, codes: ScanBarcode[]): ScanJob => ({ ...base, result: { ...base.result!, barcodes: codes } });

  it("mã khớp dữ liệu: hiện mã, nút “Không có thuốc đúng?” vẫn tìm theo chữ trên hộp", async () => {
    await render(<ResultView job={withCodes(job("confident", [candidate(1, "Augmentin 625mg", "high")]), [code("found")])} historyId={null} />);
    expect(screen.getByTestId("scan-barcodes")).toBeTruthy();
    expect(screen.getByText("Khớp dữ liệu")).toBeTruthy();
    await fireEvent.press(screen.getByTestId("ai-not-listed"));
    expect(router.push).toHaveBeenCalledWith({ pathname: "/ai-lookup", params: { kind: "scan", jobId: "0b8f2f7e-1f0c-4f0e-9a51-2a4b8c6d7e8f" } });
  });

  it("mã chưa có dữ liệu: tìm trên mạng theo đúng mã đó", async () => {
    await render(<ResultView job={withCodes(job("uncertain", [candidate(2, "Augmentin 1g", "medium")]), [code("not_found")])} historyId={null} />);
    expect(screen.getByText("Chưa có dữ liệu")).toBeTruthy();
    expect(screen.getByText("Tìm mã vạch 8935206010121 trên mạng")).toBeTruthy();
    await fireEvent.press(screen.getByTestId("ai-not-listed"));
    expect(router.push).toHaveBeenCalledWith({ pathname: "/ai-lookup", params: { kind: "barcode", code: "8935206010121" } });
  });

  it("chỉ có mã (không đọc được chữ) và chưa có dữ liệu → báo rõ, nút Tìm trên mạng tra mã", async () => {
    await render(<ResultView job={withCodes(job("no_text", []), [code("not_found")])} />);
    expect(screen.getByText("Đã đọc được mã nhưng chưa có dữ liệu")).toBeTruthy();
    await fireEvent.press(screen.getByTestId("ai-search"));
    expect(router.push).toHaveBeenCalledWith({ pathname: "/ai-lookup", params: { kind: "barcode", code: "8935206010121" } });
  });

  it("mã QR có nội dung lạ → tra nội dung QR; mã nội bộ cửa hàng thì không tra", () => {
    expect(codeToLookUp([code("text", { format: "QR Code", kind: "invalid", text: "https://hang.example/sp/1", display: "https://hang.example/sp/1" })]))
      .toEqual({ kind: "qr", code: "https://hang.example/sp/1", label: "Mã QR" });
    expect(codeToLookUp([code("internal", { kind: "internal" })])).toBeNull();
    expect(codeToLookUp([])).toBeNull();
  });
});
