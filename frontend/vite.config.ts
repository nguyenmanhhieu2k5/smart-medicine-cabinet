/// <reference types="vitest/config" />
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath, URL } from "node:url";
import { defineConfig, type Plugin } from "vite";

const SCRIPT_SRC = "script-src 'self' 'wasm-unsafe-eval';";

/**
 * Chỉ khi chạy `vite dev`: React Fast Refresh chèn một đoạn script nội tuyến, nên nới CSP cho script.
 * Bản build (dùng trong ứng dụng đóng gói) giữ nguyên CSP chặt trong index.html (chỉ thêm 'wasm-unsafe-eval' cho bộ đọc mã).
 */
function devCsp(): Plugin {
  return {
    name: "smc-dev-csp",
    apply: "serve",
    transformIndexHtml: (html) => html.replace(SCRIPT_SRC, SCRIPT_SRC.replace(";", " 'unsafe-inline';")),
  };
}

/**
 * Bộ đọc mã vạch/QR (zxing-wasm): nhúng file .wasm vào bản build dưới dạng base64 (module ảo).
 * Ứng dụng đóng gói nạp trang bằng file:// trong sandbox nên không `fetch` được file .wasm rời; hậu tố `?inline`
 * của Vite lại lỗi với file .wasm trên Windows (rolldown, os error 123).
 */
function zxingReaderWasm(): Plugin {
  const id = "virtual:zxing-reader-wasm";
  return {
    name: "smc-zxing-reader-wasm",
    resolveId: (source) => (source === id ? `\0${id}` : null),
    load(resolved) {
      if (resolved !== `\0${id}`) return null;
      const file = createRequire(import.meta.url).resolve("zxing-wasm/reader/zxing_reader.wasm");
      return `export default ${JSON.stringify(readFileSync(file).toString("base64"))};`;
    },
  };
}

// base "./" để Electron nạp được bằng file:// sau khi đóng gói.
export default defineConfig({
  base: "./",
  plugins: [react(), tailwindcss(), devCsp(), zxingReaderWasm()],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  server: { port: 5173, strictPort: true, host: "127.0.0.1" },
  build: { outDir: "dist", sourcemap: false, chunkSizeWarningLimit: 900 },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    css: false,
  },
});
