/**
 * Kiểm thử QUÉT MÃ TRỰC TIẾP của ứng dụng Windows: Electron thật + máy chủ tạm + camera giả lập.
 *
 *   npm run build:frontend
 *   node tests/desktop/live-code.mjs
 *
 * Camera giả lập (Chromium --use-file-for-fake-video-capture) chiếu một ảnh có mã; KHÔNG bấm nút chụp nào:
 *   1. Mã QR ghi số đăng ký → ứng dụng tự mở “Kết quả quét mã” → tự tra (nội dung QR) → Augmentin 625mg.
 *   2. Mã vạch EAN-13 chưa có dữ liệu → tự mở “Kết quả quét mã” → báo chưa có dữ liệu → tự tìm trên mạng theo mã đó.
 * Ảnh mã tạo ngay lúc chạy bằng zxing-cpp của máy chủ (không cần file mẫu).
 */
import { _electron as electron } from "playwright-core";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { findPython } from "../../scripts/run-python.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
if (!fs.existsSync(path.join(root, "frontend", "dist", "index.html"))) {
  console.error("Chưa có frontend/dist. Chạy: npm run build:frontend");
  process.exit(2);
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "smc-live-code-"));
const QR_TEXT = "AUGMENTIN 625MG - SDK VN-20169-16";

// ---- Ảnh camera giả: mã đặt giữa khung 1280×720 như khi đưa hộp thuốc trước webcam ---------------------- //
const make = spawnSync(findPython(), ["-I", "-c", `
import sys, cv2, numpy as np, zxingcpp
sys.path.insert(0, ${JSON.stringify(path.join(root, "backend"))})
from app.services.barcode.gs1 import check_digit
out = sys.argv[1]
body = "893520601012"
codes = {"qr": (${JSON.stringify(QR_TEXT)}, zxingcpp.BarcodeFormat.QRCode, 8), "ean": (body + str(check_digit(body)), zxingcpp.BarcodeFormat.EAN13, 4)}
for name, (text, fmt, scale) in codes.items():
    img = np.array(zxingcpp.create_barcode(text, fmt).to_image(scale=scale))
    frame = np.full((720, 1280), 235, np.uint8)
    y, x = (720 - img.shape[0]) // 2, (1280 - img.shape[1]) // 2
    frame[y:y + img.shape[0], x:x + img.shape[1]] = img
    ok, jpeg = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 92])
    open(f"{out}/{name}.mjpeg", "wb").write(jpeg.tobytes())
    print(name, text)
`, tmp], { encoding: "utf8" });
if (make.status !== 0) throw new Error(make.stderr);
const EAN = make.stdout.split("\n").find((l) => l.startsWith("ean ")).slice(4).trim();

// ---- Máy chủ tạm ------------------------------------------------------------------------------------- //
console.log("Đang dựng máy chủ tạm (PostgreSQL + app.server)…");
const devServer = spawn(findPython(), [path.join(root, "scripts", "dev_server.py"), "--catalog", "sample", "--no-simulator"], {
  cwd: root, stdio: ["pipe", "pipe", "inherit"], env: { ...process.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8", SMC_TAVILY_API_KEY: "", SMC_GEMINI_API_KEY: "" }, windowsHide: true,
});
const server = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("Máy chủ tạm không sẵn sàng sau 240 giây")), 240_000);
  readline.createInterface({ input: devServer.stdout }).on("line", (line) => {
    if (line.startsWith("SMC_READY ")) { clearTimeout(timer); resolve(JSON.parse(line.slice(10))); }
  });
  devServer.once("exit", (code) => reject(new Error(`dev_server.py thoát sớm (mã ${code})`)));
});

let failed = false;
async function scenario(name, cameraFile, check) {
  const started = Date.now();
  const app = await electron.launch({
    args: [".", `--user-data-dir=${path.join(tmp, `profile-${path.basename(cameraFile)}`)}`, "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding", "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream",
      `--use-file-for-fake-video-capture=${cameraFile}`],
    cwd: root, env: { ...process.env, SMC_SERVER_URL: server.admin_url }, timeout: 60_000,
  });
  const page = await app.firstWindow();
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
  try {
    await page.waitForSelector('input[type="password"]', { timeout: 60_000 });
    await page.getByLabel("Email").fill(server.email);
    await page.getByLabel("Mật khẩu").fill(server.password);
    await page.getByRole("button", { name: "Đăng nhập" }).click();
    await page.waitForSelector('[data-testid="sidebar"]', { timeout: 30_000 });
    const opened = Date.now();
    await page.evaluate(() => { window.location.hash = "#/scan"; }); // trang Quét tự bật camera và tự quét mã
    await page.waitForFunction(() => window.location.hash.startsWith("#/scan/code"), null, { timeout: 30_000 });
    const detail = await check(page);
    console.log(`  ✓ ${name} — tự mở kết quả sau ${((Date.now() - opened) / 1000).toFixed(1)} giây; ${detail}`);
    if (errors.length) console.log(`    (lỗi trong trang: ${errors.slice(0, 3).join(" | ")})`);
  } catch (error) {
    failed = true;
    console.log(`  ✗ ${name}: ${error.message.split("\n")[0]}`);
    await page.screenshot({ path: path.join(tmp, `${path.basename(cameraFile)}.png`) }).catch(() => undefined);
    if (errors.length) console.log(`    lỗi trong trang: ${errors.slice(0, 5).join(" | ")}`);
  } finally {
    await app.close().catch(() => undefined);
    console.log(`    (${((Date.now() - started) / 1000).toFixed(0)} giây)`);
  }
}

try {
  console.log("Quét mã trực tiếp trên ứng dụng Windows (không bấm chụp):");
  await scenario("Mã QR có số đăng ký → tự tra nội dung QR", path.join(tmp, "qr.mjpeg"), async (page) => {
    const card = page.getByTestId("code-card");
    await card.waitFor({ timeout: 15_000 });
    const result = page.getByTestId("ai-result");
    await result.waitFor({ timeout: 30_000 });
    const text = await result.textContent();
    if (!/Augmentin 625mg/i.test(text)) throw new Error(`kết quả không phải Augmentin 625mg: ${text.slice(0, 120)}`);
    if (!(await card.textContent()).includes("QR Code")) throw new Error("không ghi loại mã QR");
    return "tự tra ra Augmentin 625mg (đọc số đăng ký trong mã QR)";
  });
  await scenario("Mã vạch EAN-13 chưa có dữ liệu → tự tìm trên mạng", path.join(tmp, "ean.mjpeg"), async (page) => {
    const card = page.getByTestId("code-card");
    await card.waitFor({ timeout: 15_000 });
    await page.getByText("Chưa có dữ liệu mã vạch").waitFor({ timeout: 15_000 });
    if (!(await card.textContent()).includes(EAN)) throw new Error(`không hiện đúng mã ${EAN}`);
    const panel = page.getByTestId("ai-panel");
    await panel.waitFor({ timeout: 15_000 });
    // Máy chủ tạm không có khóa Tavily → ô tìm trên mạng tự chạy và báo chưa cấu hình (chứng tỏ đã tự gọi).
    await page.waitForFunction(() => /Chưa cấu hình tra cứu trên mạng|không dùng AI|Không tìm thấy/.test(document.querySelector('[data-testid="ai-panel"]')?.textContent ?? ""), null, { timeout: 30_000 });
    return `đọc đúng mã ${EAN}, ô “Tìm trên mạng” tự chạy theo mã đó`;
  });
} finally {
  devServer.stdin.end();
  await new Promise((resolve) => { devServer.once("exit", resolve); setTimeout(resolve, 60_000); });
}
console.log(failed ? `THẤT BẠI — ảnh chụp màn hình trong ${tmp}` : "ĐẠT");
process.exit(failed ? 1 : 0);
