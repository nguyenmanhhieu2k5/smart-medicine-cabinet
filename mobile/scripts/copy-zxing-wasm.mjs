/**
 * Chép bộ đọc mã vạch WebAssembly (zxing_reader.wasm) của gói barcode-detector vào public/ trước khi build trang web,
 * để trang web tải .wasm từ CHÍNH máy chủ (src/scan/barcodeWasm.web.ts) thay vì CDN jsDelivr.
 * Lấy đúng phiên bản zxing-wasm mà barcode-detector dùng (phần JS và file .wasm phải cùng phiên bản).
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Thư mục gốc của một gói (các gói này không cho require "pkg/package.json" vì trường exports). */
function packageRoot(fromDir, name) {
  const entry = createRequire(path.join(fromDir, "package.json")).resolve(name);
  for (let dir = path.dirname(entry); dir !== path.dirname(dir); dir = path.dirname(dir)) {
    const manifest = path.join(dir, "package.json");
    if (existsSync(manifest) && JSON.parse(readFileSync(manifest, "utf8")).name === name) return dir;
  }
  throw new Error(`Không tìm thấy gói ${name}`);
}

const detectorDir = packageRoot(root, "barcode-detector");
const zxingDir = packageRoot(detectorDir, "zxing-wasm");
const source = path.join(zxingDir, "dist", "reader", "zxing_reader.wasm");
const target = path.join(root, "public", "zxing_reader.wasm");
mkdirSync(path.dirname(target), { recursive: true });
copyFileSync(source, target);
const { version } = JSON.parse(readFileSync(path.join(zxingDir, "package.json"), "utf8"));
console.log(`zxing-wasm ${version}: ${path.relative(root, target)} (${Math.round(statSync(target).size / 1024)} KB)`);
