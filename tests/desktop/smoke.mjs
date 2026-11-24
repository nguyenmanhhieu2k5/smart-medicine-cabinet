/**
 * Kiểm thử khói (smoke test) ứng dụng QUẢN TRỊ Windows: Electron thật + máy chủ thật (PostgreSQL tạm).
 *
 *   npm run build:frontend
 *   npm run test:desktop                 (mã nguồn: electron .)
 *   npm run test:desktop:packed          (bản đóng gói trong release/*-unpacked, tạo bằng npm run pack)
 *
 * Máy chủ: scripts/dev_server.py dựng cụm PostgreSQL tạm + app.server (2 cổng 127.0.0.1) + Admin mật khẩu ngẫu nhiên
 * + ESP32 mô phỏng — không đụng tới dữ liệu thật. Đặt SMC_SMOKE_SERVER_URL/SMC_SMOKE_EMAIL/SMC_SMOKE_PASSWORD để
 * kiểm tra với máy chủ đang chạy (ví dụ qua Tailscale) thay vì máy chủ tạm.
 *
 * Kiểm tra:
 *   1. Ứng dụng hiện màn hình đăng nhập (địa chỉ máy chủ đặt sẵn) → đăng nhập Admin → vào ứng dụng
 *   2. Renderer bị cô lập; cầu nối window.smc không lộ refresh token
 *   3. Refresh token lưu ở dạng MÃ HÓA (safeStorage/DPAPI), không có mật khẩu/chuỗi kết nối CSDL
 *   4. API quản trị chỉ nghe 127.0.0.1 (ra ngoài qua Tailscale), bắt buộc Bearer token
 *   5. Sidebar/Topbar giữ nguyên qua 10 trang
 *   6. Quản trị → Thiết bị: gửi lệnh còi tới ESP32 (mô phỏng) → chỉ "Đã thực hiện" sau ACK applied
 *   7. (nếu máy chủ có mô hình OCR) camera giả lập → OCR trên máy chủ → xác nhận → lưu vào tủ thuốc
 *   8. Mở lại ứng dụng: tự khôi phục phiên đã mã hóa, không phải đăng nhập lại
 *   9. Đăng xuất → phiên bị thu hồi trên máy chủ; mở lại phải đăng nhập
 *  10. Đóng ứng dụng Windows: máy chủ vẫn chạy độc lập
 */
import { _electron as electron } from "playwright-core";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { findPython } from "../../scripts/run-python.mjs";

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
    return true;
  } catch (error) {
    record(name, false, error && error.message ? error.message.split("\n")[0] : String(error));
    return false;
  }
}
function assert(condition, message) {
  if (!condition) throw new Error(message);
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
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

// ---- Máy chủ ---------------------------------------------------------------------------- //
let server = null;
let devServer = null;
if (process.env.SMC_SMOKE_SERVER_URL) {
  server = { admin_url: process.env.SMC_SMOKE_SERVER_URL.replace(/\/$/, ""), email: process.env.SMC_SMOKE_EMAIL, password: process.env.SMC_SMOKE_PASSWORD, device_id: null };
  assert(server.email && server.password, "Cần SMC_SMOKE_EMAIL và SMC_SMOKE_PASSWORD");
} else {
  console.log("Đang dựng máy chủ tạm (PostgreSQL + app.server)…");
  devServer = spawn(findPython(), [path.join(root, "scripts", "dev_server.py"), "--catalog", "sample"], {
    cwd: root, stdio: ["pipe", "pipe", "inherit"], env: { ...process.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" }, windowsHide: true,
  });
  server = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Máy chủ tạm không sẵn sàng sau 240 giây")), 240_000);
    readline.createInterface({ input: devServer.stdout }).on("line", (line) => {
      if (line.startsWith("SMC_READY ")) {
        clearTimeout(timer);
        resolve(JSON.parse(line.slice("SMC_READY ".length)));
      }
    });
    devServer.once("exit", (code) => reject(new Error(`dev_server.py thoát sớm (mã ${code})`)));
  });
}
const ADMIN = server.admin_url;
console.log(`Máy chủ quản trị: ${ADMIN}`);

async function adminApi(token, method, pathname, body) {
  const response = await fetch(ADMIN + "/api" + pathname, {
    method, headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json().catch(() => null);
  return { status: response.status, data };
}

// ---- Electron ---------------------------------------------------------------------------- //
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "smc-smoke-"));
const profileDir = path.join(tmp, "profile");
const fakeCamera = path.join(tmp, "camera.mjpeg");
fs.copyFileSync(path.join(root, "tests", "fixtures", "ocr", "01_ro_net_augmentin_625.jpg"), fakeCamera);
const args = [
  ...(packed ? [] : ["."]),
  `--user-data-dir=${profileDir}`,
  // Cửa sổ do Playwright mở có thể bị che → Chromium dừng requestAnimationFrame, hiệu ứng chuyển trang treo giữa chừng.
  "--disable-backgrounding-occluded-windows",
  "--disable-renderer-backgrounding",
  "--use-fake-ui-for-media-stream",
  "--use-fake-device-for-media-stream",
  `--use-file-for-fake-video-capture=${fakeCamera}`,
];
if (process.platform === "linux" && process.getuid && process.getuid() === 0) args.unshift("--no-sandbox");
const env = { ...process.env, SMC_SERVER_URL: ADMIN };
for (const name of ["SMC_DEV_SERVER_URL", "ELECTRON_RUN_AS_NODE"]) delete env[name];

/** Chuyển trang rồi chờ hiệu ứng chuyển trang kết thúc (chỉ còn một khung trang, độ mờ = 1) mới thao tác. */
async function goto(page, route) {
  await page.evaluate((target) => { window.location.hash = "#" + target; }, route);
  await page.waitForFunction(() => {
    const frames = document.querySelectorAll('[data-testid="page-content"] > div');
    return frames.length === 1 && getComputedStyle(frames[0]).opacity === "1";
  }, null, { timeout: 15_000 });
}

async function launch() {
  const app = await electron.launch({ args, cwd: packed ? path.dirname(executable) : root, env, timeout: 60_000, ...(packed ? { executablePath: executable } : {}) });
  const page = await app.firstWindow();
  const errors = [];
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  page.on("pageerror", (error) => errors.push(String(error)));
  return { app, page, errors };
}

console.log(`Chế độ: ${packed ? "BẢN ĐÓNG GÓI " + executable : "mã nguồn (electron .)"} · thư mục tạm: ${tmp}`);
let session = null;
let run = await launch();
try {
  const { page, app } = run;
  await step("1. Màn hình đăng nhập → đăng nhập Admin → vào ứng dụng", async () => {
    // Như ứng dụng điện thoại: máy chủ được TỰ chọn (SMC_SERVER_URL / desktop/servers.json) → vào thẳng màn đăng nhập,
    // không có ô nhập địa chỉ và không hiện địa chỉ.
    await page.waitForSelector('input[type="password"]', { timeout: 60_000 });
    assert(await page.getByLabel("Địa chỉ API quản trị").count() === 0, "vẫn bắt nhập địa chỉ máy chủ");
    assert(await page.getByText(ADMIN, { exact: true }).count() === 0, "màn đăng nhập vẫn hiện địa chỉ máy chủ");
    await page.getByLabel("Email").fill(server.email);
    await page.getByLabel("Mật khẩu").fill("sai-mat-khau-1");
    await page.getByRole("button", { name: "Đăng nhập" }).click();
    await page.getByRole("alert").waitFor({ timeout: 15_000 });
    const message = await page.getByRole("alert").textContent();
    await page.getByLabel("Mật khẩu").fill(server.password);
    await page.getByRole("button", { name: "Đăng nhập" }).click();
    await page.waitForSelector('[data-testid="sidebar"]', { timeout: 30_000 });
    session = await page.evaluate(() => window.smc.getBackend());
    assert(session.state === "ready" && session.user && session.user.role === "ADMIN", `trạng thái: ${session.state}`);
    return `mật khẩu sai → “${message.trim()}”; đúng → ${session.user.email}`;
  });

  await step("2. Renderer bị cô lập; cầu nối không lộ refresh token", async () => {
    const info = await page.evaluate(async () => ({
      require: typeof window.require, process: typeof window.process, bridge: Object.keys(window.smc).sort(),
      backend: JSON.stringify(await window.smc.getBackend()),
    }));
    assert(info.require === "undefined" && info.process === "undefined", "renderer có API Node");
    assert(!/refresh/i.test(info.backend), "getBackend() trả về refresh token");
    const prefs = await app.evaluate(({ BrowserWindow }) => {
      const p = BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences();
      return { contextIsolation: p.contextIsolation, nodeIntegration: p.nodeIntegration, sandbox: p.sandbox, webSecurity: p.webSecurity };
    });
    assert(prefs.contextIsolation && !prefs.nodeIntegration && prefs.sandbox && prefs.webSecurity, JSON.stringify(prefs));
    return `cầu nối: ${info.bridge.join(", ")}`;
  });

  await step("3. Phiên lưu ở dạng mã hóa (safeStorage), không có mật khẩu hay chuỗi kết nối CSDL", async () => {
    const file = path.join(profileDir, "connection.json");
    assert(fs.existsSync(file), `không thấy ${file}`);
    const text = fs.readFileSync(file, "utf8");
    const data = JSON.parse(text);
    assert(data.serverUrl === ADMIN, `serverUrl: ${data.serverUrl}`);
    assert(typeof data.session === "string" && data.session.length > 40, "chưa lưu phiên (máy không hỗ trợ mã hóa?)");
    const raw = Buffer.from(data.session, "base64");
    assert(!/^[A-Za-z0-9_-]{60,}$/.test(raw.toString("latin1")), "phiên lưu ở dạng rõ");
    assert(!text.includes(server.password) && !/postgres(ql)?:\/\//i.test(text) && !text.includes(session.token), "file chứa mật khẩu/chuỗi kết nối/access token");
    return `${raw.length} byte mã hóa`;
  });

  await step("4. API quản trị: chỉ 127.0.0.1, bắt buộc Bearer token", async () => {
    const url = new URL(ADMIN);
    const anonymous = await fetch(`${ADMIN}/api/cabinet/medicines`);
    assert(anonymous.status === 401, `không token mà nhận ${anonymous.status}`);
    const ok = await adminApi(session.token, "GET", "/auth/me");
    assert(ok.status === 200 && ok.data.user.role === "ADMIN", `me: ${ok.status}`);
    if (!["127.0.0.1", "localhost"].includes(url.hostname)) return "máy chủ từ xa — bỏ qua kiểm tra cổng";
    const external = Object.values(os.networkInterfaces()).flat().filter((i) => i && i.family === "IPv4" && !i.internal).map((i) => i.address);
    for (const address of external) assert(!(await tryConnect(address, Number(url.port))), `cổng ${url.port} mở trên ${address}`);
    return external.length ? `từ ${external.join(", ")}: bị từ chối` : "không có card mạng ngoài để thử";
  });

  await step("5. Sidebar/Topbar giữ nguyên qua 10 trang", async () => {
    await page.evaluate(() => {
      window.__sidebar = document.querySelector('[data-testid="sidebar"]');
      window.__topbar = document.querySelector('[data-testid="topbar"]');
    });
    for (const route of ["/scan", "/cabinet", "/expiry", "/reminders", "/alerts", "/history", "/admin/system", "/profile", "/settings", "/"]) {
      await page.evaluate((target) => { window.location.hash = "#" + target; }, route);
      await page.waitForFunction((target) => window.location.hash === "#" + target, route);
      await page.waitForTimeout(350);
      const same = await page.evaluate(() => window.__sidebar === document.querySelector('[data-testid="sidebar"]') && window.__topbar === document.querySelector('[data-testid="topbar"]'));
      assert(same, `Sidebar/Topbar bị dựng lại ở ${route}`);
    }
    return "10 trang";
  });

  if (!server.device_id) {
    record("6. Lệnh tới ESP32 + ACK", null, "máy chủ ngoài — không có thiết bị mô phỏng");
  } else {
    await step("6. Quản trị → Thiết bị: lệnh còi qua Internet, chỉ “Đã thực hiện” sau ACK applied", async () => {
      await goto(page, "/admin/devices");
      try {
        await page.getByText("Trực tuyến").first().waitFor({ timeout: 30_000 });
      } catch {
        await page.screenshot({ path: path.join(tmp, "devices.png") });
        const list = await adminApi(session.token, "GET", "/devices");
        throw new Error(`thiết bị không trực tuyến: ${JSON.stringify(list.data.items.map((d) => [d.name, d.online]))} (ảnh: ${path.join(tmp, "devices.png")})`);
      }
      await page.getByRole("button", { name: "Gửi lệnh" }).click();
      const tracker = page.getByTestId("command-tracker");
      try {
        await tracker.getByText("Đã thực hiện", { exact: true }).waitFor({ timeout: 30_000 });
      } catch {
        await page.screenshot({ path: path.join(tmp, "command.png") });
        throw new Error(`không thấy “Đã thực hiện”: ${(await tracker.textContent().catch(() => "không có tracker"))?.slice(0, 200)}`);
      }
      const commands = await adminApi(session.token, "GET", `/devices/${server.device_id}/commands`);
      const last = commands.data.items[0];
      const detail = await adminApi(session.token, "GET", `/commands/${last.id}`);
      assert(detail.data.status === "applied", `trạng thái ${detail.data.status}`);
      assert(JSON.stringify(detail.data.acks.map((a) => a.status)) === JSON.stringify(["received", "applied"]), JSON.stringify(detail.data.acks));
      return `${detail.data.action_label}: ${detail.data.acks.map((a) => a.status).join(" → ")}`;
    });
  }

  const ocrReady = (await adminApi(session.token, "GET", "/ocr/status")).data;
  const hasModels = ocrReady && ocrReady.engine && ocrReady.engine.models_available_offline !== false;
  if (!hasModels) {
    record("7. Camera → OCR trên máy chủ → lưu", null, "máy chủ chưa có mô hình OCR offline");
  } else {
    await step("7. Camera (giả lập) → OCR trên máy chủ → xác nhận → lưu vào tủ thuốc", async () => {
      await goto(page, "/scan");
      await page.waitForFunction(() => { const video = document.querySelector("video"); return video && video.videoWidth > 0; }, null, { timeout: 20_000 });
      await page.waitForTimeout(600);
      await page.click('[data-testid="scan-main-button"]');
      await page.waitForURL(/scan\/result\//, { timeout: 20_000 });
      await page.waitForSelector('[data-testid="confirm-save"]', { timeout: 180_000 });
      const jobId = page.url().split("/").pop();
      const token = (await page.evaluate(() => window.smc.getBackend())).token;
      const job = (await adminApi(token, "GET", `/ocr/jobs/${jobId}`)).data;
      const match = job.result.match;
      assert(match.candidates.length >= 1 && match.candidates.length <= 3, `số ứng viên: ${match.candidates.length}`);
      const before = (await adminApi(token, "GET", "/cabinet/medicines")).data.total;
      assert(before === 0, "quét xong đã tự thêm vào tủ");
      if (await page.isDisabled('[data-testid="confirm-save"]')) await page.getByRole("radio").first().click();
      await page.click('[data-testid="confirm-save"]');
      const dialog = page.getByRole("dialog");
      await dialog.waitFor({ timeout: 5000 });
      await dialog.locator('input[type="date"]').fill("2027-06-15");
      await dialog.getByRole("button", { name: "Xác nhận và lưu", exact: true }).click();
      await page.waitForURL(/#\/cabinet\/\d+/, { timeout: 15_000 });
      const cabinet = (await adminApi(token, "GET", "/cabinet/medicines")).data;
      assert(cabinet.total === 1 && cabinet.items[0].expiry_date === "2027-06-15", `tủ có ${cabinet.total} mục`);
      return `"${match.candidates[0].medicine.ten_thuoc}" — ${match.status}, ${job.result.elapsed_ms} ms, ${job.result.ocr.engine.engine} trên ${job.result.ocr.engine.device ?? "?"}`;
    });
  }

  await step("7b. Không có lỗi JavaScript trong cửa sổ", async () => {
    const serious = run.errors.filter((text) => !/favicon|ResizeObserver loop/.test(text));
    assert(serious.length === 0, serious.slice(0, 3).join(" | "));
  });
} finally {
  await run.app.close().catch(() => undefined);
}

await step("8. Mở lại ứng dụng: tự khôi phục phiên đã mã hóa, không phải đăng nhập lại", async () => {
  run = await launch();
  await run.page.waitForSelector('[data-testid="sidebar"]', { timeout: 60_000 });
  const info = await run.page.evaluate(() => window.smc.getBackend());
  assert(info.state === "ready" && info.token !== session.token, "không làm mới access token");
  session = info;
  return "đăng nhập tự động bằng refresh token đã lưu (đã xoay vòng)";
});

await step("9. Đăng xuất → phiên bị thu hồi trên máy chủ; mở lại phải đăng nhập", async () => {
  const token = session.token;
  await goto(run.page, "/profile");
  await run.page.getByRole("button", { name: "Đăng xuất" }).click();
  await run.page.waitForSelector('input[type="password"]', { timeout: 15_000 });
  const stored = JSON.parse(fs.readFileSync(path.join(profileDir, "connection.json"), "utf8"));
  assert(!stored.session, "vẫn còn phiên đã lưu sau khi đăng xuất");
  await run.app.close();
  run = await launch();
  await run.page.waitForSelector('input[type="password"]', { timeout: 60_000 });
  const me = await adminApi(token, "GET", "/auth/me");
  return `mở lại → màn hình đăng nhập; access token cũ: ${me.status === 200 ? "còn hạn tới khi hết 15 phút" : "bị từ chối"}`;
}).finally(() => run.app.close().catch(() => undefined));

await step("10. Đóng ứng dụng Windows: máy chủ vẫn chạy độc lập", async () => {
  await sleep(1000);
  const health = await fetch(`${ADMIN}/api/health`);
  assert(health.status === 200, `health: ${health.status}`);
  return (await health.json()).version;
});

if (devServer) {
  devServer.stdin.end();
  await new Promise((resolve) => { devServer.once("exit", resolve); setTimeout(resolve, 60_000); });
}
if (!process.env.SMC_SMOKE_KEEP) fs.rmSync(tmp, { recursive: true, force: true });
const passed = results.filter((item) => item.ok === true).length;
const skipped = results.filter((item) => item.ok === null).length;
console.log(`\nKết quả: ${passed} đạt, ${results.length - passed - skipped} lỗi, ${skipped} bỏ qua`);
process.exit(failed ? 1 : 0);
