#!/usr/bin/env node
/**
 * Kiểm tra đủ thành phần trước khi electron-builder tạo bản cài đặt — để không phát hành một bản thiếu
 * backend, thiếu danh mục thuốc hay thiếu mô hình OCR.
 *
 * Mô hình OCR: mặc định BẮT BUỘC có sẵn (ứng dụng ưu tiên chạy offline). Nếu chủ động muốn bản cài nhẹ và để
 * ứng dụng tự tải mô hình ở lần quét đầu tiên (cần Internet), đặt SMC_ALLOW_MISSING_MODELS=1.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const exeName = process.platform === "win32" ? "smc-backend.exe" : "smc-backend";
const problems = [];
const warnings = [];

function need(relative, hint) {
  if (!fs.existsSync(path.join(root, relative))) problems.push(`Thiếu ${relative} — ${hint}`);
}
need("frontend/dist/index.html", "chạy: npm run build:frontend");
need(`backend/dist/smc-backend/${exeName}`, "chạy: npm run build:backend");
need("data/DAV_unique.xlsx", "chép file Excel danh mục thuốc vào thư mục data/");
need("assets/icon.ico", "chạy: python scripts/make_icons.py");
need("assets/icon.png", "chạy: python scripts/make_icons.py");

function hasModel(name) {
  return [name, `${name}_onnx`].some((dir) => ["inference.onnx", "inference.yml"].every((file) => fs.existsSync(path.join(root, "ocr_models", dir, file))));
}
const missingModels = ["PP-OCRv6_small_det", "PP-OCRv6_small_rec"].filter((name) => !hasModel(name));
if (missingModels.length) {
  const message = `Thiếu mô hình OCR trong ocr_models/: ${missingModels.join(", ")} — chạy: python scripts/download_ocr_models.py`;
  if (process.env.SMC_ALLOW_MISSING_MODELS === "1") warnings.push(`${message} (bản cài sẽ tải mô hình ở lần quét đầu, cần Internet)`);
  else problems.push(message);
}
// Backend có kèm PaddlePaddle → bản cài mặc định dùng engine Paddle + PP-OCRv6 medium (định dạng Paddle).
const paddleBundled = fs.existsSync(path.join(root, "backend", "dist", "smc-backend", "_internal", "paddle"));
if (paddleBundled) {
  const hasPaddleModel = (name) => ["inference.pdiparams", "inference.yml"].every((file) => fs.existsSync(path.join(root, "ocr_models", name, file)));
  const missingPaddle = ["PP-OCRv6_medium_det", "PP-OCRv6_medium_rec"].filter((name) => !hasPaddleModel(name));
  if (missingPaddle.length) {
    problems.push(
      `Backend có kèm PaddlePaddle nhưng thiếu mô hình định dạng Paddle trong ocr_models/: ${missingPaddle.join(", ")} — chạy: ` +
        "python scripts/download_ocr_models.py --profile v6_medium --format paddle (hoặc build lại với SMC_BUNDLE_PADDLE=0)",
    );
  }
  const cuda = path.join(root, "backend", "dist", "smc-backend", "_internal", "nvidia");
  console.log(`[kiểm tra] Backend kèm PaddlePaddle ${fs.existsSync(cuda) ? "GPU (có DLL CUDA)" : "CPU"}; mô hình mặc định PP-OCRv6 medium.`);
}
if (!fs.existsSync(path.join(root, "ocr_models"))) fs.mkdirSync(path.join(root, "ocr_models"), { recursive: true }); // electron-builder cần thư mục tồn tại

for (const warning of warnings) console.warn(`[cảnh báo] ${warning}`);
if (problems.length) {
  for (const problem of problems) console.error(`[thiếu] ${problem}`);
  process.exit(1);
}
console.log("[kiểm tra] Đủ thành phần để đóng gói: giao diện, backend, danh mục thuốc, mô hình OCR, biểu tượng.");
