#!/usr/bin/env node
/**
 * Chạy sau `npm install` ở thư mục gốc:
 *   1. cài thư viện của giao diện (frontend/);
 *   2. tải sẵn bộ chạy Electron. Từ Electron 45, gói `electron` không còn tự tải khi cài mà tải ở lần chạy đầu;
 *      tải luôn ở đây để lần mở ứng dụng đầu tiên không phải chờ và không cần mạng.
 * Bước 2 chỉ cảnh báo nếu lỗi (Electron sẽ tự thử tải lại khi chạy `npm run dev`).
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

const frontend = spawnSync(npm, ["install", "--no-audit", "--no-fund"], {
  cwd: path.join(root, "frontend"),
  stdio: "inherit",
  shell: process.platform === "win32", // npm.cmd cần shell trên Windows
});
if (frontend.status !== 0) {
  console.error("[postinstall] Không cài được thư viện của frontend.");
  process.exit(frontend.status ?? 1);
}

const installer = path.join(root, "node_modules", "electron", "install.js");
if (fs.existsSync(installer)) {
  const electron = spawnSync(process.execPath, [installer], { cwd: root, stdio: "inherit" });
  if (electron.status !== 0) {
    console.warn("[postinstall] Chưa tải được bộ chạy Electron — sẽ tự tải ở lần chạy đầu (cần Internet).");
  }
}
