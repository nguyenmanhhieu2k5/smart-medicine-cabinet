/**
 * Kiểm tra giao diện ứng dụng di động bằng ảnh chụp thật (không chỉ đọc JSX):
 *   1. dựng máy chủ thật dùng một lần (scripts/dev_server.py: PostgreSQL tạm + app.server, danh mục mẫu);
 *   2. phục vụ bản web của ứng dụng (npx expo export --platform web) — cùng mã nguồn React Native;
 *   3. Chrome giả lập điện thoại (cảm ứng, DPR 2) với camera giả phát ảnh hộp thuốc thật;
 *   4. chụp từng màn hình ở 5 kích thước 360×800, 375×812, 390×844, 393×852, 412×915 (dp) vào visual-check/output/.
 *
 *   cd mobile && SMC_API_URL=http://127.0.0.1:18000 npx expo export --platform web --output-dir dist-web
 *   node visual-check/run.mjs
 *
 * Can thiệp mạng DUY NHẤT để chụp đúng trạng thái trung gian của thiết kế: (a) giữ màn “Đang xử lý” ở 62% vài giây,
 * (b) bật cờ password_reset_enabled để chụp biểu mẫu Quên mật khẩu (máy chủ thử không có SMTP), (c) cắt mạng để chụp
 * màn “Không thể kết nối”. Mọi bước khác (đăng ký, quét OCR, kết quả, lịch sử) chạy thật với máy chủ.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const mobile = path.resolve(here, "..");
const root = path.resolve(mobile, "..");
const require = createRequire(path.join(root, "package.json"));
const { chromium } = require("playwright-core");
const { findPython } = await import(new URL("../../scripts/run-python.mjs", import.meta.url));

const WEB_PORT = 19006;
const API_PORT = 18000;
const dist = path.join(mobile, "dist-web");
const out = path.join(here, "output");
const fixtures = path.join(root, "tests", "fixtures", "ocr");
const SIZES = [[360, 800], [375, 812], [390, 844], [393, 852], [412, 915]];
const ACCOUNT = { name: "Nguyễn Văn An", email: "an.nguyen@example.com", password: "TraCuu2026" };

if (!fs.existsSync(path.join(dist, "index.html"))) {
  console.error("Chưa có mobile/dist-web. Chạy: SMC_API_URL=http://127.0.0.1:18000 npx expo export --platform web --output-dir dist-web");
  process.exit(2);
}
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
const log = (...args) => console.log("[visual]", ...args);

// ---- 1. Máy chủ thật dùng một lần --------------------------------------------------------- //
const server = spawn(findPython(), [path.join(root, "scripts", "dev_server.py"), "--catalog", "sample", "--no-simulator",
  "--public-port", String(API_PORT), "--cors", `http://127.0.0.1:${WEB_PORT}`], {
  cwd: root, stdio: ["pipe", "pipe", "inherit"], env: { ...process.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" }, windowsHide: true,
});
await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("Máy chủ thử không sẵn sàng sau 240 giây")), 240_000);
  readline.createInterface({ input: server.stdout }).on("line", (line) => {
    if (line.startsWith("SMC_READY ")) {
      clearTimeout(timer);
      resolve();
    }
  });
  server.once("exit", (code) => reject(new Error(`dev_server.py thoát (mã ${code})`)));
});
const API = `http://127.0.0.1:${API_PORT}/api/v1`;
log("máy chủ:", API);
// Chờ danh mục mẫu nhập xong (OCR cần danh mục để so khớp).
for (let i = 0; i < 120; i++) {
  const reg = await fetch(`${API}/app/config`).then((r) => r.ok).catch(() => false);
  if (reg) break;
  await new Promise((r) => setTimeout(r, 500));
}

// ---- 2. Phục vụ bản web (SPA: đường dẫn lạ → index.html) ---------------------------------- //
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".ico": "image/x-icon", ".ttf": "font/ttf", ".json": "application/json" };
const web = http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  let file = path.join(dist, decodeURIComponent(url.pathname));
  if (!file.startsWith(dist) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(dist, "index.html");
  res.writeHead(200, { "Content-Type": types[path.extname(file)] ?? "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
}).listen(WEB_PORT, "127.0.0.1");
const BASE = `http://127.0.0.1:${WEB_PORT}`;

// ---- 3. Tài khoản + vài lượt quét thật để màn Lịch sử có dữ liệu --------------------------- //
async function apiJson(method, p, body, token) {
  const res = await fetch(API + p, { method, headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json().catch(() => null) };
}
async function seedHistory() {
  const login = await apiJson("POST", "/auth/login", { email: ACCOUNT.email, password: ACCOUNT.password });
  const token = login.data.access_token;
  for (const name of ["05_mo_paracetamol_500.jpg", "04_cung_ten_augmentin_1g.jpg", "08_toi_panadol_extra.jpg", "06_nghieng_hapacol_250.jpg"]) {
    const form = new FormData();
    form.append("file", new Blob([fs.readFileSync(path.join(fixtures, name))], { type: "image/jpeg" }), name);
    form.append("source", "upload");
    const job = await (await fetch(`${API}/scans`, { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: form })).json();
    for (let i = 0; i < 120; i++) {
      const j = (await apiJson("GET", `/scans/${job.id}`, null, token)).data;
      if (j.status === "done" || j.status === "error") break;
      await new Promise((r) => setTimeout(r, 400));
    }
  }
  await apiJson("POST", "/auth/logout", { refresh_token: login.data.refresh_token });
}

// ---- 4. Chrome giả lập điện thoại ----------------------------------------------------------- //
const camera = path.join(out, "camera.mjpeg");
fs.copyFileSync(path.join(fixtures, "01_ro_net_augmentin_625.jpg"), camera);
const browser = await chromium.launch({
  channel: process.env.SMC_VISUAL_CHANNEL ?? "chrome",
  args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-video-capture=${camera}`],
});

async function shot(page, size, name) {
  await page.waitForTimeout(450); // chờ hiệu ứng chuyển màn hình
  const file = path.join(out, `${size[0]}x${size[1]}`, `${name}.png`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  await page.screenshot({ path: file });
  log(`${size[0]}x${size[1]}`, name);
}
async function newPage(size) {
  const context = await browser.newContext({
    viewport: { width: size[0], height: size[1] }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: "vi-VN",
    timezoneId: "Asia/Ho_Chi_Minh", permissions: ["camera"],
  });
  await context.grantPermissions(["camera"], { origin: BASE });
  const page = await context.newPage();
  page.on("pageerror", (e) => console.error("[pageerror]", e.message));
  return { context, page };
}
const byTest = (page, id) => page.locator(`[data-testid="${id}"]`);

async function login(page) {
  await page.goto(BASE + "/");
  await byTest(page, "login-screen").waitFor();
  await page.getByLabel("Email", { exact: true }).fill(ACCOUNT.email);
  await page.getByLabel("Mật khẩu", { exact: true }).fill(ACCOUNT.password);
  await byTest(page, "login-submit").click();
  await byTest(page, "scan-screen").waitFor({ timeout: 20_000 });
}
async function waitCamera(page) {
  await page.waitForFunction(() => { const v = document.querySelector("video"); return v && v.videoWidth > 0; }, null, { timeout: 20_000 });
}

try {
  // ===== Kích thước chuẩn của thiết kế: 393×852, đi đủ luồng =====
  const main = [393, 852];
  {
    const { context, page } = await newPage(main);
    await page.route("**/api/v1/app/config", async (route) => {
      const res = await route.fetch();
      await route.fulfill({ response: res, json: { ...(await res.json()), password_reset_enabled: true } });
    });
    await page.goto(BASE + "/");
    await byTest(page, "login-screen").waitFor();
    await shot(page, main, "01_dang_nhap");
    await page.getByText("Quên mật khẩu?").click();
    await page.getByRole("button", { name: "Gửi mã khôi phục" }).waitFor();
    await shot(page, main, "03_quen_mat_khau");
    await page.goto(BASE + "/reset-password?email=" + encodeURIComponent(ACCOUNT.email));
    await byTest(page, "reset-code").waitFor();
    await page.keyboard.type("4825");
    await shot(page, main, "04_nhap_ma");
    await page.goto(BASE + "/register");
    await byTest(page, "register-screen").waitFor();
    await shot(page, main, "02_dang_ky");

    // Đăng ký thật → vào thẳng màn Quét (tài khoản mới là SCANNER).
    await page.getByLabel("Họ và tên", { exact: true }).fill(ACCOUNT.name);
    await page.getByLabel("Email", { exact: true }).fill(ACCOUNT.email);
    await page.getByLabel("Mật khẩu", { exact: true }).fill(ACCOUNT.password);
    await page.getByLabel("Tạo tài khoản", { exact: true }).click();
    await byTest(page, "scan-screen").waitFor({ timeout: 20_000 });
    await waitCamera(page);
    await shot(page, main, "05_quet_thuoc");

    // Quét thật bằng camera giả; giữ màn “Đang xử lý” ở 62% để chụp đúng trạng thái thiết kế 06.
    let hold = true;
    await page.route(/\/api\/v1\/scans\/[0-9a-f-]{36}$/, async (route) => {
      if (!hold || route.request().method() !== "GET") return route.continue();
      const res = await route.fetch();
      const job = await res.json();
      await route.fulfill({ response: res, json: { ...job, status: "recognizing", progress: 62, finished_at: null, result: null,
        stages: [{ key: "image", label: "Xử lý hình ảnh", state: "done" }, { key: "ocr", label: "Nhận dạng văn bản (OCR)", state: "active" },
          { key: "lookup", label: "Tra cứu trong cơ sở dữ liệu", state: "pending" }, { key: "summary", label: "Tổng hợp kết quả", state: "pending" }] } });
    });
    await byTest(page, "shutter").click();
    await byTest(page, "processing-screen").waitFor({ timeout: 20_000 });
    await page.getByText("62%").waitFor();
    await shot(page, main, "06_dang_xu_ly_ocr");
    hold = false;
    await byTest(page, "result-screen").waitFor({ timeout: 60_000 });
    await shot(page, main, "07_ket_qua_ocr");
    await byTest(page, "open-detail").click();
    await byTest(page, "medicine-screen").waitFor({ timeout: 20_000 });
    await page.waitForTimeout(600);
    await shot(page, main, "08_chi_tiet_thuoc");

    await seedHistory();
    await page.goBack();
    await byTest(page, "tab-history").click();
    await byTest(page, "history-screen").waitFor();
    await page.getByText("Hôm nay").waitFor();
    await page.waitForTimeout(900); // ảnh thu nhỏ
    await shot(page, main, "09_lich_su_quet");
    await byTest(page, "tab-profile").click();
    await byTest(page, "profile-screen").waitFor();
    await shot(page, main, "10_ho_so");

    // Ảnh không có thuốc → “Không nhận diện được”.
    await byTest(page, "tab-scan").click();
    await byTest(page, "tab-scan").click(); // bấm lại tab đang mở → về màn Quét gốc
    await byTest(page, "scan-screen").waitFor();
    const chooser = page.waitForEvent("filechooser");
    await byTest(page, "pick-image").click();
    await (await chooser).setFiles(path.join(fixtures, "11_khong_phai_thuoc.jpg"));
    await page.locator('[data-testid="unrecognized"], [data-testid="result-screen"]').first().waitFor({ timeout: 60_000 });
    await shot(page, main, "11_khong_nhan_dien");

    // Mất kết nối khi mở chi tiết thuốc từ lịch sử.
    await byTest(page, "tab-history").click();
    await byTest(page, "history-screen").waitFor();
    await page.locator('[aria-label*="Đã tra cứu"]').first().click();
    await byTest(page, "result-screen").waitFor({ timeout: 20_000 });
    await page.route("**/api/v1/catalog/**", (route) => route.abort("internetdisconnected"));
    await byTest(page, "open-detail").click();
    await byTest(page, "retry-connection").waitFor({ timeout: 30_000 });
    await shot(page, main, "12_mat_ket_noi");
    await page.unroute("**/api/v1/catalog/**");
    await context.close();
  }

  // ===== Các kích thước khác: các màn chính =====
  for (const size of SIZES.filter((s) => s !== main && !(s[0] === main[0] && s[1] === main[1]))) {
    const { context, page } = await newPage(size);
    await page.goto(BASE + "/");
    await byTest(page, "login-screen").waitFor();
    await shot(page, size, "01_dang_nhap");
    await login(page);
    await waitCamera(page);
    await shot(page, size, "05_quet_thuoc");
    await byTest(page, "tab-history").click();
    await page.getByText("Hôm nay").waitFor();
    await page.waitForTimeout(900);
    await shot(page, size, "09_lich_su_quet");
    await page.locator('[aria-label*="Đã tra cứu"]').first().click();
    await byTest(page, "result-screen").waitFor({ timeout: 20_000 });
    await shot(page, size, "07_ket_qua_ocr");
    await byTest(page, "open-detail").click();
    await byTest(page, "medicine-screen").waitFor();
    await page.waitForTimeout(600);
    await shot(page, size, "08_chi_tiet_thuoc");
    await page.goBack();
    await byTest(page, "tab-profile").click();
    await byTest(page, "profile-screen").waitFor();
    await shot(page, size, "10_ho_so");
    await context.close();
  }
  log("Xong:", out);
} finally {
  await browser.close().catch(() => undefined);
  web.close();
  server.stdin.end();
  await new Promise((resolve) => { server.once("exit", resolve); setTimeout(resolve, 60_000); });
}
