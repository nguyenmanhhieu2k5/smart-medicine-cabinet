import type { Candidate, HistoryItem } from "@/api/types";
import { candidateBadge, groupHistory, initials, maskEmail } from "./format";

const item = (id: string, created_at: string): HistoryItem => ({
  id, job_id: null, status: "confident", title: id, subtitle: null, candidate_count: 1, top_medicine_id: 1, selected_medicine_id: null,
  created_at, has_thumbnail: false,
});

describe("Lịch sử quét", () => {
  it("nhóm Hôm nay / Hôm qua / Trước đó theo giờ của điện thoại, giữ thứ tự", () => {
    const now = new Date(2026, 10, 19, 10, 0);
    const iso = (d: number, h: number) => new Date(2026, 10, d, h, 30).toISOString();
    const sections = groupHistory([item("a", iso(19, 9)), item("b", iso(19, 0)), item("c", iso(18, 23)), item("d", iso(12, 8))], now);
    expect(sections.map((s) => [s.title, s.data.map((i) => i.id)])).toEqual([
      ["Hôm nay", ["a", "b"]], ["Hôm qua", ["c"]], ["Trước đó", ["d"]],
    ]);
  });

  it("bỏ nhóm trống", () => {
    expect(groupHistory([], new Date())).toEqual([]);
  });
});

describe("Nhãn mức độ phù hợp", () => {
  const c = (level: Candidate["level"]): Candidate => ({ rank: 1, medicine: { id: 1, ten_thuoc: "x", hoat_chat_chinh: null, ham_luong: null, dang_bao_che: null, so_dang_ky: null }, score: 90, level, level_label: "" });
  it("ứng viên đầu mức cao là “Phù hợp nhất”, còn lại theo mức", () => {
    expect(candidateBadge(c("high"), 0)).toMatchObject({ label: "Phù hợp nhất", tone: "success" });
    expect(candidateBadge(c("high"), 1)).toMatchObject({ label: "Mức độ phù hợp: Cao", tone: "primary" });
    expect(candidateBadge(c("medium"), 0)).toMatchObject({ label: "Mức độ phù hợp: Trung bình", tone: "warning" });
    expect(candidateBadge(c("low"), 2)).toMatchObject({ label: "Mức độ phù hợp: Thấp" });
  });
});

describe("Định dạng", () => {
  it("chữ viết tắt và che email", () => {
    expect(initials("Nguyễn Văn An")).toBe("VA");
    expect(initials("Scanner")).toBe("S");
    expect(maskEmail("annguyen@gmail.com")).toBe("an••••@gmail.com");
  });
});
