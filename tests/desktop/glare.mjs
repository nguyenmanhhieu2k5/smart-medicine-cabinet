/**
 * Kiểm thử NHẮC LÓA SÁNG của ứng dụng Windows: Electron thật + máy chủ tạm + camera giả lập.
 *
 *   npm run build:frontend
 *   node tests/desktop/glare.mjs
 *
 * 1. Camera chiếu vỉ giấy bạc có điểm lóa trắng đè lên chữ → khung camera hiện “Bị lóa sáng — nghiêng nhẹ…”;
 *    bấm chụp → trang kết quả nhắc chụp lại (máy chủ đo % lóa trong ảnh).
 * 2. Cùng vỉ thuốc nhưng không lóa → không nhắc.
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
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "smc-glare-"));

// ---- Ảnh camera giả: vỉ giấy bạc xám, chữ đỏ; bản "glare" có điểm lóa trắng lớn giữa khung ------------- //
const make = spawnSync(findPython(), ["-I", "-c", `
import sys, cv2, numpy as np
out = sys.argv[1]
rng = np.random.default_rng(7)
H, W = 720, 1280
base = np.full((H, W, 3), 70, np.float32)
x0, y0, x1, y1 = 280, 170, 1000, 550
yy, xx = np.mgrid[0:H, 0:W]
foil = 120 + 60 * np.sin(xx / 37.0) * np.cos(yy / 23.0) + rng.normal(0, 6, (H, W))
base[y0:y1, x0:x1] = foil[y0:y1, x0:x1, None]
for i, y in enumerate((260, 380, 500)):
    cv2.putText(base, "CEDIPECT", (x0 + 40 + (i % 2) * 120, y), cv2.FONT_HERSHEY_DUPLEX, 2.2, (40, 30, 190), 5)
for name, amp in (("clean", 0), ("glare", 330)):
    spot = np.exp(-(((xx - 620) / 170.0) ** 2 + ((yy - 330) / 95.0) ** 2)) * amp
    img = np.clip(base + spot[..., None], 0, 255).astype(np.uint8)
    ok, jpeg = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, 92])
    open(f"{out}/{name}.mjpeg", "wb").write(jpeg.tobytes())
`, tmp], { encoding: "utf8" });
if (make.status !== 0) throw new Error(make.stderr);

console.log("Đang dựng máy chủ tạm (PostgreSQL + app.server)…");
const devServer = spawn(findPython(), [path.join(root, "scripts", "dev_server.py"), "--catalog", "sample", "--no-simulator"], {
  cwd: root, stdio: ["pipe", "pipe", "inherit"], windowsHide: true,
  env: { ...process.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8", SMC_TAVILY_API_KEY: "", SMC_GEMINI_API_KEY: "" },
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
  const app = await electron.launch({
    args: [".", `--user-data-dir=${path.join(tmp, `profile-${path.basename(cameraFile)}`)}`, "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding", "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream",
      `--use-file-for-fake-video-capture=${cameraFile}`],
    cwd: root, env: { ...process.env, SMC_SERVER_URL: server.admin_url }, timeout: 60_000,
  });
  const page = await app.firstWindow();
  try {
    await page.waitForSelector('input[type="password"]', { timeout: 60_000 });
    await page.getByLabel("Email").fill(server.email);
    await page.getByLabel("Mật khẩu").fill(server.password);
    await page.getByRole("button", { name: "Đăng nhập" }).click();
    await page.waitForSelector('[data-testid="sidebar"]', { timeout: 30_000 });
    await page.evaluate(() => { window.location.hash = "#/scan"; });
    await page.getByTestId("scan-main-button").and(page.getByRole("button", { name: "Chụp và nhận diện" })).waitFor({ timeout: 30_000 });
    console.log(`  ✓ ${name} — ${await check(page)}`);
  } catch (error) {
    failed = true;
    console.log(`  ✗ ${name}: ${error.message.split("\n")[0]}`);
    await page.screenshot({ path: path.join(tmp, `${path.basename(cameraFile)}.png`) }).catch(() => undefined);
  } finally {
    await app.close().catch(() => undefined);
  }
}

try {
  console.log("Nhắc lóa sáng trên ứng dụng Windows:");
  await scenario("Vỉ giấy bạc bị lóa", path.join(tmp, "glare.mjpeg"), async (page) => {
    const hint = page.getByTestId("glare-hint");
    await hint.waitFor({ timeout: 10_000 });
    const text = (await hint.textContent()).trim();
    await page.getByTestId("scan-main-button").click();
    await page.waitForFunction(() => window.location.hash.startsWith("#/scan/result/"), null, { timeout: 30_000 });
    await page.getByTestId("glare-tip").waitFor({ timeout: 120_000 });
    return `khung camera nhắc “${text}”; chụp xong trang kết quả nhắc chụp lại`;
  });
  await scenario("Cùng vỉ, không lóa", path.join(tmp, "clean.mjpeg"), async (page) => {
    await page.getByTestId("live-code-hint").waitFor({ timeout: 10_000 });
    await page.waitForTimeout(3_000); // 4 lần đo
    if (await page.getByTestId("glare-hint").count()) throw new Error("nhắc lóa nhầm khi ảnh không lóa");
    return "không nhắc lóa sau 3 giây";
  });
} finally {
  devServer.stdin.end();
  await new Promise((resolve) => { devServer.once("exit", resolve); setTimeout(resolve, 60_000); });
}
console.log(failed ? `THẤT BẠI — ảnh chụp màn hình trong ${tmp}` : "ĐẠT");
process.exit(failed ? 1 : 0);
