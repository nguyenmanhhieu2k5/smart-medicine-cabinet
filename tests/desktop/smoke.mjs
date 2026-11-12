/**
 * Kiểm thử khói (smoke test) cho bản desktop: chạy Electron thật + backend Python thật.
 *
 *   npm run build:frontend
 *   npm run test:desktop
 *
 * Kiểm tra:
 *   1. Electron tự khởi động backend, giao diện vượt qua màn hình "Đang khởi động…"
 *   2. Renderer không có quyền Node (không require/process), chỉ có cầu nối window.smc
 *   3. Backend chỉ nghe trên 127.0.0.1 và từ chối yêu cầu không có token
 *   4. SQLite nằm trong thư mục dữ liệu người dùng (SMC_DATA_DIR), không nằm trong mã nguồn
 *   5. Sidebar/Topbar giữ nguyên khi chuyển trang
 *   6. (nếu có mô hình OCR) camera giả lập → chụp → PaddleOCR → xác nhận → lưu vào tủ thuốc
 *   7. Thoát ứng dụng thì backend cũng dừng
 *
 * DỮ LIỆU KIỂM THỬ: dùng danh mục mẫu tests/fixtures/catalog_sample.xlsx (trích từ file thật) và thư mục
 * dữ liệu tạm — không đụng tới dữ liệu thật của người dùng.
 *
 * Chế độ `--packed` (npm run test:desktop:packed): chạy BẢN ĐÃ ĐÓNG GÓI trong release/*-unpacked
 * (tạo bằng `npm run pack`). Khi đó không ghi đè gì: ứng dụng dùng backend đã đóng băng, file Excel thật và
 * mô hình OCR nằm trong thư mục resources — đúng như trên máy người dùng, chỉ khác là hồ sơ dữ liệu để ở thư mục tạm.
 *
 * Biến môi trường tuỳ chọn:
 *   SMC_TEST_OCR_MODELS   thư mục mô hình OCR (mặc định: ./ocr_models nếu có)
 *   SMC_SMOKE_EXECUTABLE  đường dẫn file chạy đã đóng gói (thay cho tự dò trong release/)
 *   SMC_SMOKE_KEEP=1      giữ lại thư mục tạm để xem nhật ký
 */
import { _electron as electron } from "playwright-core";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const results = [];
let failed = false;

function record(name, ok, detail = "") {
  results.push({ name, ok, detail });
  if (ok === false) failed = true;
  const mark = ok === true ? "PASS" : ok === false ? "FAIL" : "SKIP";
  console.log(`[${mark}] ${name}${detail ? " — " + detail : ""}`);
}
async function step(name, fn) {
  try {
    const detail = await fn();
    record(name, true, typeof detail === "string" ? detail : "");
  } catch (error) {
    record(name, false, error && error.message ? error.message.split("\n")[0] : String(error));
  }
}
function assert(condition, message) {
  if (!condition) throw new Error(message);
}
function findOcrModels() {
  const candidates = [process.env.SMC_TEST_OCR_MODELS, path.join(root, "ocr_models")].filter(Boolean);
  return candidates.find((dir) => fs.existsSync(dir) && fs.readdirSync(dir).some((name) => fs.existsSync(path.join(dir, name, "inference.yml")))) || null;
}
function tryConnect(host, port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port, timeout: 1500 });
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("error", () => resolve(false));
    socket.once("timeout", () => { socket.destroy(); resolve(false); });
  });
}

function findPackedExecutable() {
  if (process.env.SMC_SMOKE_EXECUTABLE) return process.env.SMC_SMOKE_EXECUTABLE;
  const candidates = [
    path.join(root, "release", "win-unpacked", "SmartMedicineCabinet.exe"),
    path.join(root, "release", "linux-unpacked", "smart-medicine-cabinet"),
    path.join(root, "release", "mac", "SmartMedicineCabinet.app", "Contents", "MacOS", "SmartMedicineCabinet"),
  ];
  return candidates.find((file) => fs.existsSync(file)) || null;
}

const packed = process.argv.includes("--packed") || Boolean(process.env.SMC_SMOKE_EXECUTABLE);
const executable = packed ? findPackedExecutable() : null;
if (packed && !executable) {
  console.error("Chưa có bản đóng gói trong release/. Chạy: npm run pack");
  process.exit(2);
}
if (!packed && !fs.existsSync(path.join(root, "frontend", "dist", "index.html"))) {
  console.error("Chưa có frontend/dist. Chạy: npm run build:frontend");
  process.exit(2);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "smc-smoke-"));
const profileDir = path.join(tmp, "profile");
// Bản đóng gói: để ứng dụng tự chọn nơi lưu (userData/data). Bản phát triển: chỉ định thư mục tạm.
const dataDir = packed ? path.join(profileDir, "data") : path.join(tmp, "data");
const resourcesDir = packed ? path.join(path.dirname(executable), "resources") : null;
const ocrModels = packed ? (fs.existsSync(path.join(resourcesDir, "ocr_models")) && fs.readdirSync(path.join(resourcesDir, "ocr_models")).some((name) => fs.existsSync(path.join(resourcesDir, "ocr_models", name, "inference.yml"))) ? path.join(resourcesDir, "ocr_models") : null) : findOcrModels();
const fakeCamera = path.join(tmp, "camera.mjpeg");
fs.copyFileSync(path.join(root, "tests", "fixtures", "ocr", "01_ro_net_augmentin_625.jpg"), fakeCamera);

const args = [
  ...(packed ? [] : ["."]),
  `--user-data-dir=${profileDir}`,
  "--use-fake-ui-for-media-stream",
  "--use-fake-device-for-media-stream",
  `--use-file-for-fake-video-capture=${fakeCamera}`,
];
// Chromium không chạy sandbox dưới quyền root (máy CI/Linux). Trên Windows không cần cờ này.
if (process.platform === "linux" && process.getuid && process.getuid() === 0) args.unshift("--no-sandbox");

const env = { ...process.env };
for (const name of ["SMC_DEV_SERVER_URL", "SMC_EXTERNAL_BACKEND", "SMC_DATA_DIR", "SMC_RESOURCE_DIR", "SMC_CATALOG_XLSX", "SMC_OCR_MODEL_DIR", "SMC_PYTHON"]) delete env[name];
if (!packed) {
  env.SMC_DATA_DIR = dataDir;
  env.SMC_CATALOG_XLSX = path.join(root, "tests", "fixtures", "catalog_sample.xlsx");
  if (ocrModels) env.SMC_OCR_MODEL_DIR = ocrModels;
}

console.log(`Chế độ: ${packed ? "BẢN ĐÓNG GÓI " + executable : "mã nguồn (electron .)"}`);
console.log(`Thư mục tạm: ${tmp}`);
console.log(`Mô hình OCR: ${ocrModels || "(không có — bỏ qua bước quét)"}`);

const app = await electron.launch({ args, cwd: packed ? path.dirname(executable) : root, env, timeout: 60_000, ...(packed ? { executablePath: executable } : {}) });
let backend = null;
try {
  const page = await app.firstWindow();
  const consoleErrors = [];
  page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
  page.on("pageerror", (error) => consoleErrors.push(String(error)));

  await step("1. Giao diện khởi động và backend sẵn sàng", async () => {
    await page.waitForSelector('[data-testid="sidebar"]', { timeout: 120_000 });
    backend = await page.evaluate(() => window.smc.getBackend());
    assert(backend.state === "ready", `trạng thái backend: ${backend.state} (${backend.error})`);
    return backend.baseUrl;
  });

  await step("2. Renderer bị cô lập: không có require/process, chỉ có window.smc", async () => {
    const info = await page.evaluate(() => ({
      require: typeof window.require, process: typeof window.process, module: typeof window.module,
      bridge: Object.keys(window.smc).sort(), version: window.smc.appVersion,
    }));
    assert(info.require === "undefined" && info.process === "undefined" && info.module === "undefined", `renderer có API Node: ${JSON.stringify(info)}`);
    assert(info.bridge.includes("getBackend") && info.bridge.includes("notify"), "thiếu hàm cầu nối");
    assert(/^\d+\.\d+\.\d+/.test(info.version), `phiên bản không hợp lệ: ${info.version}`);
    const prefs = await app.evaluate(({ BrowserWindow }) => {
      const p = BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences();
      return { contextIsolation: p.contextIsolation, nodeIntegration: p.nodeIntegration, sandbox: p.sandbox, webSecurity: p.webSecurity };
    });
    assert(prefs.contextIsolation === true && prefs.nodeIntegration === false && prefs.sandbox === true && prefs.webSecurity === true, JSON.stringify(prefs));
    return `cầu nối: ${info.bridge.join(", ")}`;
  });

  await step("3. API cục bộ: chỉ 127.0.0.1, bắt buộc token", async () => {
    const url = new URL(backend.baseUrl);
    assert(url.hostname === "127.0.0.1", `backend nghe trên ${url.hostname}`);
    assert(backend.token.length >= 32, "token quá ngắn");
    const noToken = await fetch(`${backend.baseUrl}/api/cabinet/medicines`);
    assert(noToken.status === 401, `không token mà nhận mã ${noToken.status}`);
    const wrongToken = await fetch(`${backend.baseUrl}/api/cabinet/medicines`, { headers: { "X-SMC-Token": "sai" } });
    assert(wrongToken.status === 401, `token sai mà nhận mã ${wrongToken.status}`);
    const ok = await fetch(`${backend.baseUrl}/api/health`, { headers: { "X-SMC-Token": backend.token } });
    assert(ok.status === 200, `health trả mã ${ok.status}`);
    const external = Object.values(os.networkInterfaces()).flat().filter((item) => item && item.family === "IPv4" && !item.internal).map((item) => item.address);
    for (const address of external) assert(!(await tryConnect(address, Number(url.port))), `cổng ${url.port} mở trên ${address}`);
    return external.length ? `đã thử từ ${external.join(", ")}: bị từ chối` : "máy không có card mạng ngoài để thử";
  });

  await step("4. SQLite nằm trong thư mục dữ liệu người dùng", async () => {
    assert(fs.existsSync(path.join(dataDir, "cabinet.db")), `không thấy ${path.join(dataDir, "cabinet.db")}`);
    assert(!fs.existsSync(path.join(root, "cabinet.db")) && !fs.existsSync(path.join(root, "backend", "cabinet.db")), "có file DB trong thư mục mã nguồn");
    if (packed) {
      const inInstall = fs.readdirSync(resourcesDir, { recursive: true }).filter((name) => String(name).endsWith(".db"));
      assert(inInstall.length === 0, `có file DB trong thư mục cài đặt: ${inInstall.join(", ")}`);
    }
    return path.join(dataDir, "cabinet.db");
  });

  await step("5. Sidebar/Topbar giữ nguyên khi chuyển trang", async () => {
    await page.evaluate(() => {
      window.__sidebar = document.querySelector('[data-testid="sidebar"]');
      window.__topbar = document.querySelector('[data-testid="topbar"]');
    });
    for (const route of ["/cabinet", "/expiry", "/reminders", "/alerts", "/history", "/profile", "/settings", "/scan", "/"]) {
      await page.evaluate((target) => { window.location.hash = "#" + target; }, route);
      await page.waitForFunction((target) => window.location.hash === "#" + target, route);
      await page.waitForTimeout(350);
      const same = await page.evaluate(() => window.__sidebar === document.querySelector('[data-testid="sidebar"]') && window.__topbar === document.querySelector('[data-testid="topbar"]'));
      assert(same, `Sidebar/Topbar bị dựng lại ở ${route}`);
    }
    return "9 trang";
  });

  await step(`5b. Danh mục ${packed ? "thật (kèm bản cài)" : "mẫu"} đã được nhập tự động vào SQLite`, async () => {
    const deadline = Date.now() + 240_000;
    let status = null;
    while (Date.now() < deadline) {
      status = await (await fetch(`${backend.baseUrl}/api/catalog/status`, { headers: { "X-SMC-Token": backend.token } })).json();
      if (status.count > 0 && !(status.progress && status.progress.running)) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    assert(status && status.count > 0 && !(status.progress && status.progress.running), "danh mục chưa nhập xong sau 240 giây");
    if (packed) assert(status.count > 50_000, `bản đóng gói phải nhập danh mục thật, hiện có ${status.count}`);
    return `${status.count} thuốc ${packed ? "(file Excel thật trong resources/data)" : "(dữ liệu mẫu kiểm thử)"}`;
  });

  if (!ocrModels) {
    record("6. Camera → OCR → xác nhận → lưu", null, "không có mô hình OCR (đặt SMC_TEST_OCR_MODELS hoặc chạy scripts/download_ocr_models.py)");
  } else {
    await step("6. Camera (giả lập) → PaddleOCR → xác nhận → lưu vào tủ thuốc", async () => {
      await page.evaluate(() => { window.location.hash = "#/scan"; });
      await page.waitForFunction(() => { const video = document.querySelector("video"); return video && video.videoWidth > 0; }, null, { timeout: 20_000 });
      await page.waitForTimeout(600);
      await page.click('[data-testid="scan-main-button"]');
      await page.waitForURL(/scan\/result\//, { timeout: 20_000 });
      await page.waitForSelector('[data-testid="confirm-save"]', { timeout: 180_000 });
      const jobId = page.url().split("/").pop();
      const job = await (await fetch(`${backend.baseUrl}/api/ocr/jobs/${jobId}`, { headers: { "X-SMC-Token": backend.token } })).json();
      const match = job.result.match;
      assert(match.candidates.length >= 1 && match.candidates.length <= 3, `số ứng viên: ${match.candidates.length}`);
      if (await page.isDisabled('[data-testid="confirm-save"]')) await page.getByRole("radio").first().click(); // chưa chắc chắn → phải tự chọn
      await page.click('[data-testid="confirm-save"]');
      const dialog = page.getByRole("dialog");
      await dialog.waitFor({ timeout: 5000 });
      await dialog.locator('input[type="date"]').fill("2027-06-15");
      await dialog.getByRole("button", { name: "Xác nhận và lưu", exact: true }).click();
      await page.waitForURL(/#\/cabinet\/\d+/, { timeout: 15_000 });
      const cabinet = await (await fetch(`${backend.baseUrl}/api/cabinet/medicines`, { headers: { "X-SMC-Token": backend.token } })).json();
      assert(cabinet.total === 1, `tủ thuốc có ${cabinet.total} mục`);
      assert(cabinet.items[0].expiry_date === "2027-06-15", `hạn dùng lưu: ${cabinet.items[0].expiry_date}`);
      return `"${match.candidates[0].medicine.ten_thuoc}" — ${match.status}, ${match.candidates[0].score}/100, ${job.result.elapsed_ms} ms, ${job.result.ocr.engine.library} ${job.result.ocr.engine.version} (${job.result.ocr.engine.engine})`;
    });
  }

  await step("6b. Không có lỗi JavaScript trong cửa sổ", async () => {
    const serious = consoleErrors.filter((text) => !/favicon|ResizeObserver loop/.test(text));
    assert(serious.length === 0, serious.slice(0, 3).join(" | "));
  });
} finally {
  await app.close().catch(() => undefined);
}

await step("7. Thoát ứng dụng thì backend dừng", async () => {
  assert(backend, "không có thông tin backend");
  const url = new URL(backend.baseUrl);
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (!(await tryConnect("127.0.0.1", Number(url.port)))) return `cổng ${url.port} đã đóng`;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`backend vẫn nghe trên cổng ${url.port} sau 15 giây`);
});

if (!process.env.SMC_SMOKE_KEEP) fs.rmSync(tmp, { recursive: true, force: true });
const passed = results.filter((item) => item.ok === true).length;
const skipped = results.filter((item) => item.ok === null).length;
console.log(`\nKết quả: ${passed} đạt, ${results.length - passed - skipped} lỗi, ${skipped} bỏ qua`);
process.exit(failed ? 1 : 0);
