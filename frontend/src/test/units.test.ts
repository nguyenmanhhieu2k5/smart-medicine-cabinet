import { describe, expect, it } from "vitest";
import { frameSharpness } from "@/hooks/useCamera";
import { translate } from "@/i18n";
import { en } from "@/i18n/en";
import { addDays, formatBytes, formatDate, formatQuantity, relativeDay, startOfWeek, toIsoDate, weekdayDate } from "@/services/format";
import { buildSpeech, spokenDate } from "@/services/tts";

describe("định dạng", () => {
  it("ngày không lệch múi giờ", () => {
    expect(formatDate("2027-06-15")).toBe("15/06/2027");
    expect(formatDate("2026-11-10T14:32:00")).toBe("10/11/2026");
    expect(formatDate(null)).toBe("—");
    expect(toIsoDate(new Date(2026, 10, 10))).toBe("2026-11-10");
  });
  it("tuần bắt đầu từ Thứ Hai", () => {
    expect(toIsoDate(startOfWeek(new Date(2026, 10, 10)))).toBe("2026-11-09"); // Thứ Ba → Thứ Hai 09/11
    expect(toIsoDate(startOfWeek(new Date(2026, 10, 15)))).toBe("2026-11-09"); // Chủ nhật
    expect(toIsoDate(addDays(new Date(2026, 10, 30), 2))).toBe("2026-12-02");
  });
  it("nhãn ngày và số", () => {
    expect(weekdayDate(new Date(2026, 10, 10), "vi")).toBe("Thứ Ba, 10/11/2026");
    expect(relativeDay("2026-11-10T08:00:00", new Date(2026, 10, 10, 14))).toBe("Hôm nay");
    expect(relativeDay("2026-11-09T23:00:00", new Date(2026, 10, 10, 14))).toBe("Hôm qua");
    expect(formatQuantity(24)).toBe("24");
    expect(formatQuantity(2.5)).toBe("2.5");
    expect(formatBytes(2048)).toBe("2.0 KB");
  });
});

describe("giọng đọc", () => {
  it("chỉ đọc các trường có dữ liệu", () => {
    expect(buildSpeech([["Tên thuốc", "Paracetamol"], ["Đường dùng", null], ["Hàm lượng", "500 mg"]])).toBe("Tên thuốc: Paracetamol. Hàm lượng: 500 mg.");
    expect(spokenDate("2027-06-05")).toBe("ngày 5 tháng 6 năm 2027");
    expect(spokenDate(null)).toBeNull();
  });
});

describe("độ nét khung hình", () => {
  it("ảnh có cạnh sắc nét hơn ảnh phẳng", () => {
    const size = 16;
    const flat = new Uint8ClampedArray(size * size * 4).fill(128);
    const edges = new Uint8ClampedArray(size * size * 4);
    for (let i = 0; i < size * size; i++) edges.fill((i % 2) * 255, i * 4, i * 4 + 4);
    expect(frameSharpness(flat, size, size)).toBe(0);
    expect(frameSharpness(edges, size, size)).toBeGreaterThan(1000);
  });
});

describe("i18n", () => {
  it("thiếu bản dịch thì giữ tiếng Việt, có biến thì thay vào", () => {
    expect(translate("vi", "Xin chào, {name}", { name: "Test" })).toBe("Xin chào, Test");
    expect(translate("en", "Một câu chưa được dịch")).toBe("Một câu chưa được dịch");
  });
  it("các mục điều hướng có bản dịch tiếng Anh", () => {
    for (const label of ["Trang chủ", "Quét thuốc", "Thuốc trong tủ", "Hạn dùng", "Nhắc uống thuốc", "Cảnh báo", "Lịch sử", "Hồ sơ", "Cài đặt"]) {
      expect(en[label], label).toBeTruthy();
    }
  });
});
