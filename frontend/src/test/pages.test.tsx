import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import type { AlertItem, MatchCandidate, OcrJob, ScanBarcode } from "@/types/api";
import { cabinetItem, installMockApi, type MockState } from "./mockApi";
import { renderApp } from "./renderApp";

let api: MockState;
beforeEach(() => {
  api = installMockApi();
});

function alert(overrides: Partial<AlertItem> = {}): AlertItem {
  return {
    id: 1, category: "medicine", category_label: "Thuốc", type: "expired", severity: "danger", severity_label: "Nguy hiểm",
    title: "Ibuprofen đã hết hạn", message: "Hạn dùng 03/11/2026.", status: "active", status_label: "Mới", data: { cabinet_item_id: 1 },
    created_at: "2026-11-10T14:00:00", updated_at: "2026-11-10T14:00:00", resolved_at: null, ...overrides,
  };
}

function candidate(id: number, name: string, strength: string, score: number): MatchCandidate {
  return {
    medicine: {
      id, ten_thuoc: name, hoat_chat_chinh: "Amoxicillin; Acid clavulanic", ham_luong: strength, ham_luong_source: "hamLuong", dang_bao_che: "Viên nén bao phim",
      so_dang_ky: `VN-${id}`, ten_cong_ty_san_xuat: "SmithKline Beecham", nuoc_san_xuat: "Anh", dong_goi: "Hộp 2 vỉ x 7 viên",
      registration_status: { code: "valid", label: "Số đăng ký còn hiệu lực" }, in_source: true,
    },
    score, level: score >= 80 ? "high" : "medium", level_label: score >= 80 ? "Cao" : "Trung bình",
    components: [{ key: "name", label: "Tên thuốc", status: "match", value: 1, weight: 0.3, detail: "Giống 100/100" }], flags: [],
  };
}

function job(status: "confident" | "uncertain", candidates: MatchCandidate[]): OcrJob {
  return {
    id: "job1", source: "camera", status: "done", progress: 100, message: "Hoàn tất", created_at: "2026-11-10T14:30:00", finished_at: "2026-11-10T14:30:01",
    has_image: false, error: null,
    result: {
      ocr: { lines: [{ text: "Augmentin", score: 0.99, box: [0, 0, 10, 10] }], line_count: 1, mean_score: 0.99, preprocess: "original", preprocess_label: "Ảnh gốc", attempts: [], engine: {} },
      image: { width: 100, height: 100, sharpness: 1, brightness: 1 }, expiry_suggestion: null, elapsed_ms: 900,
      match: {
        status, message: status === "uncertain" ? "Chưa thể xác định chắc chắn. Vui lòng chọn đúng thuốc." : "Tìm thấy ứng viên phù hợp. Vui lòng kiểm tra và xác nhận trước khi lưu.",
        reasons: status === "uncertain" ? ["Chỉ có một loại bằng chứng (ví dụ chỉ đọc được tên)."] : [],
        evidence: { lines: ["Augmentin"], registration_numbers: [], strengths: [], dosage_form: null, name_guess: "Augmentin", ingredients: [], search_hint: "augmentin" },
        candidates,
      },
    },
  };
}

describe("Trang chủ", () => {
  it("chưa kết nối ESP32 thì hiện “Chưa kết nối”, không có số đo giả", async () => {
    renderApp("/");
    expect(await screen.findByText("Trạng thái: Chưa kết nối")).toBeInTheDocument();
    const page = screen.getByTestId("page-content");
    // Chờ số liệu thiết bị tải xong: ô chỉ số hiện ngưỡng nhưng giá trị là "—".
    expect(await within(page).findByText((_, element) => element?.tagName === "P" && element.textContent === "Ngưỡng 15–30°C")).toBeInTheDocument();
    expect(within(page).getAllByText("—")).toHaveLength(2);
    expect(within(page).queryByText(/^\d+(\.\d+)?(°C|%)$/)).not.toBeInTheDocument();
    expect(within(page).getByText("Thiết lập kết nối ESP32")).toBeInTheDocument();
  });

  it("có nút camera tròn làm hành động chính và đúng ba lối tắt", async () => {
    renderApp("/");
    expect(await screen.findByTestId("scan-main-button")).toHaveAccessibleName("Bật camera");
    expect(screen.getByRole("button", { name: "Chọn ảnh" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Nhập thủ công" })).toBeInTheDocument();
    const shortcuts = within(screen.getByTestId("page-content")).getAllByRole("link").filter((link) => ["/cabinet", "/expiry", "/reminders"].includes(link.getAttribute("href") ?? ""));
    expect(shortcuts.map((link) => link.textContent)).toEqual(["Thuốc trong tủ", "Hạn dùng", "Nhắc uống thuốc"]);
    expect(within(screen.getByTestId("page-content")).queryByRole("table")).not.toBeInTheDocument(); // không liệt kê thuốc ở trang chủ
  });
});

describe("Cảnh báo", () => {
  it("không có cảnh báo: hiện khiên và câu thông báo, số 0 không tô đỏ", async () => {
    renderApp("/alerts");
    const empty = await screen.findByTestId("no-alerts");
    expect(within(empty).getByText("Không có cảnh báo – Hệ thống hoạt động bình thường.")).toBeInTheDocument();
    const badge = within(screen.getByTestId("sidebar")).getByLabelText("Không có cảnh báo");
    expect(badge).toHaveTextContent("0");
    expect(badge.className).not.toMatch(/danger/);
    expect(badge.className).toMatch(/success/);
  });

  it("có cảnh báo: liệt kê, tô đỏ số đếm và cho phép xác nhận", async () => {
    api.alerts = [alert()];
    const user = userEvent.setup();
    renderApp("/alerts");
    expect(await screen.findByText("Ibuprofen đã hết hạn")).toBeInTheDocument();
    const badge = within(screen.getByTestId("sidebar")).getByLabelText("1 cảnh báo chưa xử lý");
    expect(badge.className).toMatch(/danger/);
    await user.click(screen.getByRole("button", { name: "Xác nhận" }));
    await waitFor(() => expect(api.calls).toContainEqual({ method: "PATCH", path: "/alerts/1", body: { status: "acknowledged" } }));
  });
});

describe("Kết quả nhận diện", () => {
  it("kết quả chưa chắc chắn: buộc người dùng chọn ứng viên trước khi lưu", async () => {
    api.job = job("uncertain", [candidate(1, "Augmentin 250mg/31,25mg", "250mg/31,25mg", 77.5), candidate(2, "Augmentin 500mg/62,5mg", "500mg/62,5mg", 77.5), candidate(3, "Augmentin 1g", "875mg/125mg", 77.5)]);
    const user = userEvent.setup();
    renderApp("/scan/result/job1");
    expect(await screen.findByRole("alert")).toHaveTextContent("Chưa thể xác định chắc chắn. Vui lòng chọn đúng thuốc.");
    const confirm = screen.getByTestId("confirm-save");
    expect(confirm).toBeDisabled();
    const options = screen.getAllByRole("radio");
    expect(options).toHaveLength(3);
    expect(options.every((option) => option.getAttribute("aria-checked") === "false")).toBe(true);
    expect(api.calls.some((call) => call.method === "POST" && call.path === "/cabinet/medicines")).toBe(false); // chưa hề lưu

    await user.click(options[1]);
    expect(confirm).toBeEnabled();
    expect(screen.getByRole("heading", { level: 3 })).toHaveTextContent("Augmentin 500mg/62,5mg");
  });

  it("kết quả đủ chắc chắn vẫn chỉ lưu sau khi bấm xác nhận trong hộp thoại", async () => {
    api.job = job("confident", [candidate(34382, "Augmentin 625mg tablets", "500mg/125mg", 100), candidate(2, "Augmentin 1g", "875mg/125mg", 48)]);
    const user = userEvent.setup();
    renderApp("/scan/result/job1");
    const confirm = await screen.findByTestId("confirm-save");
    expect(confirm).toBeEnabled();
    expect(screen.getByText(/Mức độ phù hợp: Cao · 100\/100/, { selector: "h3 ~ div span" })).toBeInTheDocument();
    expect(screen.queryByText(/%/)).not.toBeInTheDocument(); // không hiển thị phần trăm như xác suất
    await user.click(confirm);
    const dialog = await screen.findByRole("dialog");
    expect(api.calls.some((call) => call.method === "POST" && call.path === "/cabinet/medicines")).toBe(false);
    await user.click(within(dialog).getByRole("button", { name: "Xác nhận và lưu" }));
    await waitFor(() => {
      const saved = api.calls.find((call) => call.method === "POST" && call.path === "/cabinet/medicines");
      expect(saved?.body).toMatchObject({ catalog_id: 34382, scan_job_id: "job1", quantity: 1 });
    });
  });

  it("ảnh bị lóa sáng mà kết quả chưa chắc chắn: nhắc nghiêng vỉ/hộp rồi chụp lại; ảnh không lóa thì không nhắc", async () => {
    const glared = job("uncertain", [candidate(20839, "Desloderma 5", "5mg", 73)]);
    glared.result!.image.glare = 6.2;
    api.job = glared;
    const { unmount } = renderApp("/scan/result/job1");
    expect(await screen.findByTestId("glare-tip")).toHaveTextContent("Ảnh bị lóa sáng ở vùng giữa");
    expect(screen.getByTestId("glare-tip")).toHaveTextContent("Nghiêng nhẹ vỉ/hộp thuốc");
    unmount();

    for (const [status, glare] of [["uncertain", 1.0], ["confident", 9.0]] as const) {
      const other = job(status, [candidate(20839, "Desloderma 5", "5mg", status === "confident" ? 92 : 73)]);
      other.result!.image.glare = glare;
      api.job = other;
      const view = renderApp("/scan/result/job1");
      await screen.findAllByRole("radio");
      expect(screen.queryByTestId("glare-tip")).toBeNull(); // lóa ít, hoặc đã chắc chắn → không làm phiền
      view.unmount();
    }
  });

  it("lần quét không tồn tại: báo lỗi và cho quét lại", async () => {
    renderApp("/scan/result/khongco");
    expect(await screen.findByText("Không tìm thấy lần quét này")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Quét lại" })).toBeInTheDocument();
  });
});

describe("Thuốc trong tủ", () => {
  it("tủ trống: giải thích danh mục không tự thêm vào tủ", async () => {
    renderApp("/cabinet");
    expect(await screen.findByText("Tủ thuốc đang trống")).toBeInTheDocument();
    expect(screen.getByText(/Danh mục thuốc từ Excel được dùng để tra cứu, không tự thêm vào tủ/)).toBeInTheDocument();
  });

  it("xóa thuốc cần xác nhận", async () => {
    api.cabinet = [cabinetItem()];
    const user = userEvent.setup();
    renderApp("/cabinet");
    await screen.findByText("Augmentin 625mg tablets");
    await user.click(screen.getByRole("button", { name: "Xóa" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("Xóa thuốc khỏi tủ?");
    expect(api.calls.some((call) => call.method === "DELETE")).toBe(false);
    await user.click(within(dialog).getByRole("button", { name: "Hủy" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(api.calls.some((call) => call.method === "DELETE")).toBe(false);
  });
});

describe("Mã vạch thuốc (Cài đặt)", () => {
  it("chọn file → máy chủ chỉ kiểm tra; xem báo cáo rồi mới nhập; gỡ liên kết phải xác nhận", async () => {
    const user = userEvent.setup();
    renderApp("/settings");
    expect(await screen.findByText("Chưa có mã vạch")).toBeInTheDocument();

    await user.upload(screen.getByTestId("barcode-file"), new File(["x"], "nha_thuoc.xlsx", { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
    const report = await screen.findByTestId("barcode-report");
    expect(api.calls).toContainEqual({ method: "POST", path: "/catalog/barcodes/import", body: { file: "<file nha_thuoc.xlsx>", dry_run: "true" } });
    expect(api.calls.some((call) => (call.body as { dry_run?: string } | null)?.dry_run === "false")).toBe(false); // chưa ghi gì
    expect(within(report).getByText("8 / 11")).toBeInTheDocument();
    expect(within(report).getByText(/Efferalgan/)).toBeInTheDocument();
    expect(within(report).getByText("Nhiều thuốc khớp")).toBeInTheDocument();

    await user.click(within(report).getByRole("button", { name: "Nhập 5 mã vạch" }));
    await waitFor(() => expect(api.calls).toContainEqual({ method: "POST", path: "/catalog/barcodes/import", body: { file: "<file nha_thuoc.xlsx>", dry_run: "false" } }));
    expect(await screen.findByText("5 mã · 4 thuốc")).toBeInTheDocument();
    expect(screen.queryByTestId("barcode-report")).not.toBeInTheDocument();

    await user.type(screen.getByLabelText("Mã vạch cần tra"), "8935206010120");
    await user.click(screen.getByRole("button", { name: "Tra" }));
    const found = await screen.findByTestId("barcode-lookup");
    expect(found).toHaveTextContent("Augmentin 625mg tablets");
    await user.click(within(found).getByRole("button", { name: "Gỡ liên kết" }));
    const dialog = await screen.findByRole("dialog");
    expect(api.calls.some((call) => call.method === "DELETE")).toBe(false);
    await user.click(within(dialog).getByRole("button", { name: "Gỡ liên kết" }));
    await waitFor(() => expect(api.calls).toContainEqual({ method: "DELETE", path: "/catalog/barcodes/08935206010120", body: null }));
  });
});

describe("Ảnh quét có mã vạch / mã QR (máy chủ đọc mã cùng lúc với OCR)", () => {
  const barcode = (status: ScanBarcode["status"], extra: Partial<ScanBarcode> = {}): ScanBarcode => ({
    format: "EAN-13", text: "8935206010121", kind: "gtin", display: "8935206010121", status,
    medicine_id: status === "found" ? 1 : null, match_by: status === "found" ? "barcode" : null, expiry: null, lot: null, ...extra,
  });

  it("mã khớp dữ liệu: hiện mã, ngày hết hạn trong mã, thuốc khớp mã đứng đầu và được chọn sẵn", async () => {
    const top = { ...candidate(1, "Augmentin 625mg tablets", "500mg/125mg", 100), components: [
      { key: "barcode" as const, label: "Mã vạch/QR", status: "match" as const, value: 1, weight: 1, detail: "Mã vạch 8935206010121 (EAN-13) đã gắn với thuốc này" }] };
    const withCode = job("confident", [top]);
    withCode.result!.barcodes = [barcode("found", { format: "Data Matrix", expiry: "2027-06-30", lot: "LOT2026A" })];
    api.job = withCode;
    renderApp("/scan/result/job1");
    const strip = await screen.findByTestId("scan-barcodes");
    expect(strip).toHaveTextContent("Data Matrix");
    expect(strip).toHaveTextContent("8935206010121");
    expect(strip).toHaveTextContent("Khớp dữ liệu mã vạch");
    expect(strip).toHaveTextContent("30/06/2027");
    expect(strip).toHaveTextContent("LOT2026A");
    expect(screen.getByTestId("confirm-save")).toBeEnabled();
    expect(within(screen.getByTestId("ai-panel")).getByText("Không có thuốc đúng? Tìm trên mạng")).toBeInTheDocument();
  });

  it("mã chưa có dữ liệu: “Tìm trên mạng” tra đúng mã đó (không tra chữ trên hộp)", async () => {
    const withCode = job("uncertain", [candidate(2, "Augmentin 250mg/31,25mg", "250mg/31,25mg", 77.5)]);
    withCode.result!.barcodes = [barcode("not_found")];
    api.job = withCode;
    const user = userEvent.setup();
    renderApp("/scan/result/job1");
    expect(await screen.findByText("Chưa có dữ liệu mã vạch")).toBeInTheDocument();
    const panel = screen.getByTestId("ai-panel");
    expect(panel).toHaveTextContent("Mã vạch 8935206010121 chưa có dữ liệu — Tìm trên mạng");
    await user.click(within(panel).getByRole("button", { name: "Tìm trên mạng" }));
    await within(panel).findByTestId("ai-result");
    expect(api.calls).toContainEqual({ method: "POST", path: "/ai/lookup", body: { kind: "barcode", code: "8935206010121" } });
    expect(api.calls.some((call) => call.path.startsWith("/ai/scans/"))).toBe(false);
  });
});

describe("Tra cứu trên mạng khi không có thuốc đúng", () => {
  it("chỉ chạy khi người dùng bấm “Tìm trên mạng”; mặc định Tavily, ghi rõ không dùng AI, có nguồn, lưu ý và thuốc khớp danh mục", async () => {
    api.job = job("uncertain", [candidate(1, "Augmentin 250mg/31,25mg", "250mg/31,25mg", 77.5)]);
    const user = userEvent.setup();
    renderApp("/scan/result/job1");
    const panel = await screen.findByTestId("ai-panel");
    expect(panel).not.toHaveTextContent("Gemini");
    expect(api.calls.some((call) => call.path.startsWith("/ai/"))).toBe(false); // không tự tra
    await user.click(within(panel).getByRole("button", { name: "Tìm trên mạng" }));
    const result = await within(panel).findByTestId("ai-result");
    expect(api.calls).toContainEqual({ method: "POST", path: "/ai/scans/job1", body: null });
    expect(result).toHaveTextContent("Augmentin 625mg");
    expect(result).toHaveTextContent("Tra trên mạng · không dùng AI");
    expect(result).not.toHaveTextContent("AI · đã tra trên mạng");
    expect(result).toHaveTextContent("Độ tin cậy: Cao");
    expect(result).toHaveTextContent("Khớp số đăng ký");
    expect(within(result).getByRole("link", { name: /nhathuoc\.example/ })).toHaveAttribute("href", "https://example.com/augmentin");
    expect(result).toHaveTextContent("hỏi dược sĩ");
    expect(api.calls.some((call) => call.method === "POST" && call.path === "/cabinet/medicines")).toBe(false); // không tự vào tủ
  });

  it("chế độ Gemini (SMC_LOOKUP_PROVIDER=auto) vẫn gắn nhãn AI", async () => {
    api.aiProvider = "auto";
    api.job = job("uncertain", [candidate(1, "Augmentin 250mg/31,25mg", "250mg/31,25mg", 77.5)]);
    const user = userEvent.setup();
    renderApp("/scan/result/job1");
    const panel = await screen.findByTestId("ai-panel");
    await user.click(within(panel).getByRole("button", { name: "Tìm trên mạng" }));
    expect(await within(panel).findByText("AI · đã tra trên mạng")).toBeInTheDocument();
  });

  it("Cài đặt: chỉ Tavily → Gemini hiện “Đang tắt”, không hiện khóa hay danh sách mô hình", async () => {
    renderApp("/settings");
    expect(await screen.findByText("Tra cứu thuốc trên mạng")).toBeInTheDocument();
    expect(await screen.findByText("Tavily · không dùng AI")).toBeInTheDocument();
    expect(screen.getByText("Đã cấu hình")).toBeInTheDocument();
    expect(screen.getByText("Đang tắt")).toBeInTheDocument();
    expect(screen.getByText(/SMC_LOOKUP_PROVIDER=auto/)).toBeInTheDocument();
    expect(screen.queryByText("gemini-3.5-flash")).toBeNull();
    expect(document.body.textContent).not.toMatch(/tvly-|AQ\./);
  });

  it("Cài đặt: chế độ auto báo khi Gemini chưa tìm kiếm được trên mạng", async () => {
    api.aiProvider = "auto";
    api.aiSearch = false;
    renderApp("/settings");
    expect(await screen.findByText("Gemini → Tavily")).toBeInTheDocument();
    expect(screen.getByText(/bật thanh toán cho khóa trong Google AI Studio/)).toBeInTheDocument();
    expect(screen.getByText("gemini-3.5-flash")).toBeInTheDocument();
  });
});
