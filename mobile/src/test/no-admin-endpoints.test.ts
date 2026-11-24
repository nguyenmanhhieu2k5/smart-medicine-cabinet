/**
 * Kiểm tra tĩnh toàn bộ mã nguồn mobile: không có lời gọi nào tới API quản trị (/api/... ngoài /api/v1),
 * không có chức năng thêm/sửa/xóa thuốc hay điều khiển ESP32.
 */
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "..", "..");
function sources(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "test" || entry.name === "node_modules" ? [] : sources(full);
    return /\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [full] : [];
  });
}
const files = [...sources(path.join(ROOT, "app")), ...sources(path.join(ROOT, "src"))];

describe("Mã nguồn ứng dụng di động", () => {
  it("có đủ các màn hình", () => {
    expect(files.length).toBeGreaterThan(20);
  });

  it.each(files.map((f) => [path.relative(ROOT, f), f]))("%s không gọi API quản trị", (_name, file) => {
    const text = fs.readFileSync(file, "utf8");
    // Bỏ qua "@/api/..." (đường dẫn module) và "backend/app/api/..." (tên file trong chú thích).
    expect(text).not.toMatch(/(?<![@\w])\/api\/(?!v1\b)/);
    expect(text).not.toMatch(/["'`]\/(admin|devices|commands|settings|backup|device\/status)\b/);
    // Tủ thuốc: chỉ /cabinet/medicines (xem + sửa ngày hết hạn); PUBLIC_PATH chặn mọi đường khác (thêm/xóa/sửa).
    expect(text).not.toMatch(/["'`]\/cabinet(?!\/medicines)/);
    expect(text).not.toMatch(/X-SMC-Token|access_token=/);
  });
});
