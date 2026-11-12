#!/usr/bin/env node
/**
 * Đóng gói backend Python thành backend/dist/smc-backend (PyInstaller, chế độ thư mục).
 * PyInstaller không biên dịch chéo: muốn có smc-backend.exe phải chạy lệnh này TRÊN WINDOWS.
 */
import fs from "node:fs";
import path from "node:path";
import { root, runPython } from "./run-python.mjs";

const backendDir = path.join(root, "backend");
for (const name of ["build", "dist"]) fs.rmSync(path.join(backendDir, name), { recursive: true, force: true });

// Kèm engine PaddlePaddle khi backend/.venv có cài (paddlepaddle hoặc paddlepaddle-gpu).
// Ép bật/tắt bằng SMC_BUNDLE_PADDLE=1 / SMC_BUNDLE_PADDLE=0.
const env = { ...process.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" }; // spec in tiếng Việt ra console cp1252
if (env.SMC_BUNDLE_PADDLE !== "0" && env.SMC_BUNDLE_PADDLE !== "1") {
  const hasPaddle = runPython(["-c", "import importlib.util, sys; sys.exit(0 if importlib.util.find_spec('paddle') else 1)"], { stdio: "ignore" }) === 0;
  env.SMC_BUNDLE_PADDLE = hasPaddle ? "1" : "0";
}
console.log(env.SMC_BUNDLE_PADDLE === "1"
  ? "[backend] Kèm engine PaddlePaddle (GPU nếu là bản paddlepaddle-gpu). Tắt bằng SMC_BUNDLE_PADDLE=0."
  : "[backend] Không kèm PaddlePaddle — bản cài chỉ có ONNX Runtime (CPU).");

console.log("[backend] PyInstaller đang đóng gói (vài phút)…");
const status = runPython(["-m", "PyInstaller", "smc_backend.spec", "--noconfirm", "--clean", "--log-level", "WARN"], { cwd: backendDir, env });
if (status !== 0) {
  console.error("[backend] PyInstaller lỗi. Kiểm tra đã cài backend/requirements-dev.txt trong backend/.venv chưa.");
  process.exit(status);
}
const exe = path.join(backendDir, "dist", "smc-backend", process.platform === "win32" ? "smc-backend.exe" : "smc-backend");
if (!fs.existsSync(exe)) {
  console.error(`[backend] Không thấy file kết quả: ${exe}`);
  process.exit(1);
}
console.log(`[backend] Xong: ${exe}`);
