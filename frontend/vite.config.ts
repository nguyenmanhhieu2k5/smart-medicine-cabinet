/// <reference types="vitest/config" />
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";
import { defineConfig, type Plugin } from "vite";

/**
 * Chỉ khi chạy `vite dev`: React Fast Refresh chèn một đoạn script nội tuyến, nên nới CSP cho script.
 * Bản build (dùng trong ứng dụng đóng gói) giữ nguyên CSP chặt `script-src 'self'` trong index.html.
 */
function devCsp(): Plugin {
  return {
    name: "smc-dev-csp",
    apply: "serve",
    transformIndexHtml: (html) => html.replace("script-src 'self';", "script-src 'self' 'unsafe-inline';"),
  };
}

// base "./" để Electron nạp được bằng file:// sau khi đóng gói.
export default defineConfig({
  base: "./",
  plugins: [react(), tailwindcss(), devCsp()],
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
