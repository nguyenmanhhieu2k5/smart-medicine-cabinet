/**
 * Kiểm thử TRANG WEB quét thuốc trên trình duyệt thật (Microsoft Edge) + máy chủ tạm + camera giả lập.
 *
 *   npm --prefix mobile run export:web
 *   node tests/desktop/web-guest.mjs
 *
 * Máy chủ tạm phục vụ trang web ở cổng Public (SMC_WEB_DIR = mobile/dist-web), đúng như trên Mini PC sau tên miền .id.vn.
 *  1. Khách: camera chiếu mã vạch EAN-13 → trang tự đọc mã (zxing-wasm tải từ CHÍNH máy chủ) → tốn 1 lượt.
 *  2. Khách: chụp hộp thuốc 5 lần → kết quả Augmentin; lần 6 → màn Đăng nhập “đã dùng hết 5 lượt”.
 *  3. Đăng ký tài khoản → dùng như ứng dụng điện thoại (quét, Lịch sử, Hồ sơ); tải lại trang vẫn đăng nhập (cookie);
 *     đăng xuất → về chế độ khách, vẫn hết lượt.
 */
import { chromium } from "playwright-core";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { findPython } from "../../scripts/run-python.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const webDir = path.join(root, "mobile", "dist-web");
if (!fs.existsSync(path.join(webDir, "index.html"))) {
  console.error("Chưa có mobile/dist-web. Chạy: npm --prefix mobile run export:web");
  process.exit(2);
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "smc-web-"));

// ---- Camera giả: hộp thuốc Augmentin (ảnh kiểm thử OCR) và mã vạch EAN-13 -------------------------------- //
fs.copyFileSync(path.join(root, "tests", "fixtures", "ocr", "01_ro_net_augmentin_625.jpg"), path.join(tmp, "box.mjpeg"));
const make = spawnSync(findPython(), ["-I", "-c", `
import sys, cv2, numpy as np, zxingcpp
img = np.array(zxingcpp.create_barcode("8935206010121", zxingcpp.BarcodeFormat.EAN13).to_image(scale=4))
frame = np.full((720, 1280), 235, np.uint8)
y, x = (720 - img.shape[0]) // 2, (1280 - img.shape[1]) // 2
frame[y:y + img.shape[0], x:x + img.shape[1]] = img
ok, jpeg = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 92])
open(sys.argv[1], "wb").write(jpeg.tobytes())
`, path.join(tmp, "ean.mjpeg")], { encoding: "utf8" });
if (make.status !== 0) throw new Error(make.stderr);

console.log("Đang dựng máy chủ tạm (PostgreSQL + app.server, phục vụ trang web ở cổng Public)…");
const devServer = spawn(findPython(), [path.join(root, "scripts", "dev_server.py"), "--catalog", "sample", "--no-simulator"], {
  cwd: root, stdio: ["pipe", "pipe", "inherit"], windowsHide: true,
  env: { ...process.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8", SMC_TAVILY_API_KEY: "", SMC_GEMINI_API_KEY: "", SMC_WEB_DIR: webDir },
});
const server = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("Máy chủ tạm không sẵn sàng sau 240 giây")), 240_000);
  readline.createInterface({ input: devServer.stdout }).on("line", (line) => {
    if (line.startsWith("SMC_READY ")) { clearTimeout(timer); resolve(JSON.parse(line.slice(10))); }
  });
  devServer.once("exit", (code) => reject(new Error(`dev_server.py thoát sớm (mã ${code})`)));
});
const site = server.public_url;

let failed = false;
async function withBrowser(name, cameraFile, run) {
  const browser = await chromium.launch({
    channel: "msedge", headless: true,
    args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-video-capture=${cameraFile}`],
  });
  const context = await browser.newContext({ viewport: { width: 420, height: 900 }, locale: "vi-VN" });
  const page = await context.newPage();
  const problems = [];
  const thirdParty = [];
  page.on("pageerror", (e) => problems.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error" && /Content Security Policy|Refused to/.test(m.text())) problems.push(m.text()); });
  page.on("request", (r) => { if (!r.url().startsWith(site) && !r.url().startsWith("data:") && !r.url().startsWith("blob:")) thirdParty.push(r.url()); });
  const started = Date.now();
  try {
    const detail = await run(page);
    if (thirdParty.length) throw new Error(`trang gọi ra ngoài máy chủ: ${thirdParty.slice(0, 3).join(", ")}`);
    if (problems.length) throw new Error(`lỗi trong trang: ${problems.slice(0, 2).join(" | ")}`);
    console.log(`  ✓ ${name} — ${detail} (${((Date.now() - started) / 1000).toFixed(0)} giây)`);
  } catch (error) {
    failed = true;
    console.log(`  ✗ ${name}: ${error.message.split("\n")[0]}`);
    await page.screenshot({ path: path.join(tmp, `${name.slice(0, 24).replace(/\W+/g, "-")}.png`) }).catch(() => undefined);
  } finally {
    await browser.close();
  }
}

const remaining = (page) => page.getByTestId("guest-remaining").filter({ visible: true });

/** Chờ camera thật sự có hình (người dùng cũng phải chờ camera bật mới bấm chụp). */
async function cameraReady(page) {
  await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="camera-frame"] video')]
    .some((video) => video.offsetParent !== null && video.readyState >= 2 && video.videoWidth > 0), null, { timeout: 30_000 });
}

/** Phần tử đang hiển thị (Expo Router giữ các màn hình trước trong ngăn xếp, ẩn đi chứ không gỡ). */
const shown = (page, testId) => page.getByTestId(testId).filter({ visible: true });

async function shootAndSeeResult(page) {
  await cameraReady(page);
  await shown(page, "shutter").click();
  await shown(page, "result-screen").waitFor({ timeout: 60_000 });
  await page.getByText("Augmentin 625mg tablets").first().waitFor({ timeout: 10_000 });
}

try {
  console.log(`Trang web quét thuốc tại ${site}:`);

  await withBrowser("Khách quét mã vạch bằng camera", path.join(tmp, "ean.mjpeg"), async (page) => {
    const wasm = [];
    page.on("response", (r) => { if (r.url().endsWith(".wasm")) wasm.push(`${r.status()} ${r.headers()["content-type"]}`); });
    await page.goto(site);
    await remaining(page).waitFor({ timeout: 30_000 });
    // Mã chưa có trong dữ liệu mẫu → tự mở "Tìm trên mạng" theo đúng mã (giống ứng dụng điện thoại).
    await page.waitForURL(/\/ai-lookup\?.*code=8935206010121/, { timeout: 30_000 });
    await page.goto(`${site}/scan`);
    const left = (await remaining(page).textContent()).trim();
    if (left !== "Còn 4/5 lượt") throw new Error(`sau 1 lần quét mã còn “${left}”`);
    return `tự đọc mã 8935206010121 (bộ đọc .wasm từ máy chủ: ${wasm[0] ?? "trình duyệt có sẵn BarcodeDetector"}), còn 4/5 lượt`;
  });

  await withBrowser("Khách quét 5 lần → lần 6 phải đăng nhập → đăng ký dùng như app", path.join(tmp, "box.mjpeg"), async (page) => {
    await page.goto(site);
    await remaining(page).waitFor({ timeout: 30_000 });
    if ((await remaining(page).textContent()).trim() !== "Còn 5/5 lượt") throw new Error("khách mới không có đủ 5 lượt");
    for (let n = 1; n <= 5; n++) {
      await shootAndSeeResult(page);
      await page.goto(`${site}/scan`);
      await remaining(page).waitFor({ timeout: 30_000 });
      await page.waitForFunction((want) => [...document.querySelectorAll('[data-testid="guest-remaining"]')]
        .some((el) => el.offsetParent !== null && el.textContent?.trim() === want), n < 5 ? `Còn ${5 - n}/5 lượt` : "Đã hết lượt quét thử", { timeout: 10_000 });
    }
    const mirrored = await page.evaluate(() => [...document.querySelectorAll('[data-testid="camera-frame"] video')]
      .filter((video) => video.offsetParent !== null).map((video) => getComputedStyle(video).transform).find((t) => t && t !== "none"));
    if (mirrored && mirrored !== "none") throw new Error(`ảnh xem trước camera bị lật: ${mirrored}`);
    await cameraReady(page);
    await shown(page, "shutter").click(); // lần thứ 6
    await page.waitForURL(/\/login/, { timeout: 15_000 });
    await shown(page, "guest-limit-notice").waitFor({ timeout: 10_000 });

    await page.getByRole("link", { name: "Đăng ký" }).click();
    const form = shown(page, "register-screen"); // màn Đăng nhập vẫn nằm bên dưới trong ngăn xếp
    await form.getByLabel("Họ và tên", { exact: true }).fill("Người dùng web");
    await form.getByLabel("Email", { exact: true }).fill("web.user@example.com");
    await form.getByLabel("Mật khẩu", { exact: true }).fill("WebUser2026");
    await form.getByRole("button", { name: "Tạo tài khoản" }).click();
    await shown(page, "tab-history").waitFor({ timeout: 30_000 }); // như ứng dụng: Quét — Lịch sử — Hồ sơ
    if (await shown(page, "guest-banner").count()) throw new Error("đăng nhập rồi vẫn hiện chế độ khách");
    await shootAndSeeResult(page); // lượt thứ 7: không còn giới hạn
    await page.goto(`${site}/history`);
    await shown(page, "history-screen").getByText("Augmentin 625mg tablets").first().waitFor({ timeout: 20_000 });

    await page.reload(); // tải lại trang: phiên nằm trong cookie HttpOnly
    await shown(page, "history-screen").waitFor({ timeout: 30_000 });
    const jsCookies = await page.evaluate(() => document.cookie);
    if (/smc_refresh/.test(jsCookies)) throw new Error("JavaScript đọc được cookie phiên");

    await page.goto(`${site}/profile`);
    await page.getByRole("button", { name: "Đăng xuất" }).filter({ visible: true }).click();
    // Đăng xuất: về màn Đăng nhập; trình duyệt này đã hết lượt quét thử nên có lời nhắc, quét tiếp vẫn phải đăng nhập.
    await shown(page, "guest-limit-notice").waitFor({ timeout: 30_000 });
    await page.goto(`${site}/scan`);
    await remaining(page).waitFor({ timeout: 30_000 });
    const after = (await remaining(page).textContent()).trim();
    if (after !== "Đã hết lượt quét thử") throw new Error(`đăng xuất xong còn “${after}”`);
    const session = await page.evaluate(async () => (await fetch("/api/v1/auth/refresh", { method: "POST", headers: { "Content-Type": "application/json", "X-SMC-Client": "mobile-web" }, body: "{}" })).status);
    if (session !== 401) throw new Error(`đăng xuất rồi cookie phiên vẫn dùng được (HTTP ${session})`);
    return "5 lượt khách ra Augmentin; lần 6 → đăng nhập; đăng ký xong quét tiếp, có Lịch sử; tải lại trang vẫn đăng nhập; đăng xuất thu hồi phiên, về khách (hết lượt)";
  });
} finally {
  devServer.stdin.end();
  await new Promise((resolve) => { devServer.once("exit", resolve); setTimeout(resolve, 60_000); });
}
console.log(failed ? `THẤT BẠI — ảnh chụp màn hình trong ${tmp}` : "ĐẠT");
process.exit(failed ? 1 : 0);
