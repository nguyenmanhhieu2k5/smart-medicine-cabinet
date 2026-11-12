import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import type { AlertItem, MatchCandidate, OcrJob } from "@/types/api";
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
