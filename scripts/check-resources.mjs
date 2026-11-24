#!/usr/bin/env node
/**
 * Kiểm tra trước khi electron-builder tạo bản cài ứng dụng QUẢN TRỊ cho Windows.
 *
 * Từ v2.0, bản cài Windows chỉ gồm giao diện + Electron. Máy chủ (FastAPI, PostgreSQL, PaddleOCR, danh mục thuốc)
 * chạy trên Mini PC và được cài bằng deploy\windows\install-server-service.ps1 — KHÔNG đóng gói vào đây.
 * Script cũng chặn việc vô tình đóng gói backend/CSDL/mô hình hay file cấu hình chứa mật khẩu vào bản cài.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const problems = [];

function need(relative, hint) {
  if (!fs.existsSync(path.join(root, relative))) problems.push(`Thiếu ${relative} — ${hint}`);
}
need("frontend/dist/index.html", "chạy: npm run build:frontend");
need("assets/icon.ico", "chạy: python scripts/make_icons.py");
need("assets/icon.png", "chạy: python scripts/make_icons.py");

const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const packed = JSON.stringify([pkg.build?.files ?? [], pkg.build?.extraResources ?? []]);
for (const forbidden of ["backend", "ocr_models", "data", ".env", "deploy"]) {
  if (packed.includes(`"${forbidden}`) || packed.includes(`/${forbidden}`)) {
    problems.push(`package.json → build không được đóng gói "${forbidden}" vào ứng dụng Windows (máy chủ chạy trên Mini PC).`);
  }
}

// Không có chuỗi kết nối / mật khẩu CSDL nào trong mã giao diện hay tiến trình chính.
const scan = [path.join(root, "desktop")];
const distAssets = path.join(root, "frontend", "dist", "assets");
if (fs.existsSync(distAssets)) scan.push(distAssets);
for (const dir of scan) {
  for (const file of fs.readdirSync(dir)) {
    const full = path.join(dir, file);
    if (!fs.statSync(full).isFile()) continue;
    const text = fs.readFileSync(full, "utf8");
    if (/postgres(ql)?(\+psycopg)?:\/\/[^\s"'`]*:[^\s"'`@]+@/i.test(text) || /SMC_DATABASE_URL\s*=/.test(text)) {
      problems.push(`${path.relative(root, full)} chứa chuỗi kết nối cơ sở dữ liệu — không được đưa vào ứng dụng Windows.`);
    }
  }
}

if (problems.length) {
  for (const problem of problems) console.error(`[thiếu] ${problem}`);
  process.exit(1);
}
console.log("[kiểm tra] Đủ thành phần để đóng gói ứng dụng quản trị: giao diện + biểu tượng; không kèm backend, CSDL hay mật khẩu.");
