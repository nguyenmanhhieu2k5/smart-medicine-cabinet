#!/usr/bin/env node
/**
 * Chạy Python của backend (backend/.venv) với các tham số truyền vào — dùng chung cho Windows/Linux/macOS.
 *
 *   node scripts/run-python.mjs -m pytest tests/backend -q
 *   node scripts/run-python.mjs scripts/download_ocr_models.py
 *
 * Thứ tự tìm Python: biến SMC_PYTHON → backend/.venv → python trên PATH.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function findPython() {
  if (process.env.SMC_PYTHON) return process.env.SMC_PYTHON;
  const venv = path.join(root, "backend", ".venv");
  const candidate = process.platform === "win32" ? path.join(venv, "Scripts", "python.exe") : path.join(venv, "bin", "python");
  if (fs.existsSync(candidate)) return candidate;
  return process.platform === "win32" ? "python" : "python3";
}

export function runPython(args, options = {}) {
  const python = findPython();
  const result = spawnSync(python, args, { cwd: root, stdio: "inherit", ...options });
  if (result.error) {
    console.error(`Không chạy được Python (${python}): ${result.error.message}`);
    console.error("Hãy tạo môi trường: python -m venv backend/.venv  rồi cài backend/requirements-dev.txt");
    return 127;
  }
  return result.status ?? 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(runPython(process.argv.slice(2)));
}
