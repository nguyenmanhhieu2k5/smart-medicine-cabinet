/**
 * Kiểm thử GIỌNG ĐỌC TIẾNG VIỆT TỰ NHIÊN của ứng dụng Windows: Electron thật + máy chủ tạm + mô hình Piper thật.
 *
 *   python scripts/download_tts_model.py      (một lần — tải mô hình vào thư mục dữ liệu máy chủ)
 *   npm run build:frontend
 *   node tests/desktop/tts-voice.mjs [thư-mục-mô-hình]
 *
 * 1. Cài đặt → Giọng đọc: mặc định là “Giọng tự nhiên tiếng Việt — máy chủ”, bấm “Đọc thử” → máy chủ tạo WAV, ứng dụng phát.
 * 2. Trang thông tin thuốc → “Đọc thông tin” → đọc tên, hoạt chất, hàm lượng… bằng giọng máy chủ (không dùng giọng Windows).
 */
import { _electron as electron } from "playwright-core";
import { spawn } from "node:child_process";
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
const programData = process.env.ProgramData ?? "C:\\ProgramData";
const modelDir = process.argv[2] ?? path.join(programData, "SmartMedicineCabinet", "server", "tts", "vits-piper-vi_VN-vais1000-medium");
if (!fs.existsSync(path.join(modelDir, "vi_VN-vais1000-medium.onnx"))) {
  console.error(`Không thấy mô hình giọng đọc trong ${modelDir}. Chạy: python scripts/download_tts_model.py`);
  process.exit(2);
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "smc-tts-"));

console.log("Đang dựng máy chủ tạm (PostgreSQL + app.server)…");
const devServer = spawn(findPython(), [path.join(root, "scripts", "dev_server.py"), "--catalog", "sample", "--no-simulator"], {
  cwd: root, stdio: ["pipe", "pipe", "inherit"], windowsHide: true,
  env: { ...process.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8", SMC_TAVILY_API_KEY: "", SMC_GEMINI_API_KEY: "", SMC_TTS_MODEL_DIR: modelDir },
});
const server = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("Máy chủ tạm không sẵn sàng sau 240 giây")), 240_000);
  readline.createInterface({ input: devServer.stdout }).on("line", (line) => {
    if (line.startsWith("SMC_READY ")) { clearTimeout(timer); resolve(JSON.parse(line.slice(10))); }
  });
  devServer.once("exit", (code) => reject(new Error(`dev_server.py thoát sớm (mã ${code})`)));
});

// Một thuốc trong danh mục mẫu để mở trang thông tin thuốc.
const login = await fetch(`${server.admin_url}/api/auth/login`, {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: server.email, password: server.password }),
}).then((r) => r.json());
const search = await fetch(`${server.admin_url}/api/medicines/search?q=Augmentin&limit=1`, { headers: { Authorization: `Bearer ${login.access_token}` } }).then((r) => r.json());
const medicine = search.items?.[0];
if (!medicine) throw new Error("Danh mục mẫu không có Augmentin");

/** Ghi lại mọi lần phát âm thanh trong trang (nguồn, thời lượng, đã phát được không) và mọi lần gọi giọng Windows. */
function recordPlayback() {
  window.__plays = [];
  window.__windowsSpeech = [];
  const play = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function patchedPlay() {
    const rec = { src: this.src, duration: null, played: 0, error: null };
    window.__plays.push(rec);
    this.addEventListener("loadedmetadata", () => { rec.duration = this.duration; });
    this.addEventListener("timeupdate", () => { rec.played = Math.max(rec.played, this.currentTime); });
    return play.call(this).catch((error) => { rec.error = String(error); throw error; });
  };
  const speak = window.speechSynthesis.speak.bind(window.speechSynthesis);
  window.speechSynthesis.speak = (utterance) => { window.__windowsSpeech.push(utterance.text); speak(utterance); };
}

let failed = false;
const app = await electron.launch({
  args: [".", `--user-data-dir=${path.join(tmp, "profile")}`, "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding",
    "--autoplay-policy=no-user-gesture-required"],
  cwd: root, env: { ...process.env, SMC_SERVER_URL: server.admin_url }, timeout: 60_000,
});
const page = await app.firstWindow();
const errors = [];
page.on("pageerror", (error) => errors.push(String(error)));
page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
const ttsResponses = [];
page.on("response", async (r) => {
  if (r.url().endsWith("/api/tts") && r.request().method() === "POST") ttsResponses.push({ status: r.status(), type: r.headers()["content-type"], ms: Date.now() });
});

async function step(name, run) {
  try {
    console.log(`  ✓ ${name} — ${await run()}`);
  } catch (error) {
    failed = true;
    console.log(`  ✗ ${name}: ${error.message.split("\n")[0]}`);
    await page.screenshot({ path: path.join(tmp, `${name.slice(0, 20).replace(/\W+/g, "-")}.png`) }).catch(() => undefined);
  }
}

/** Chờ đến khi âm thanh thật sự phát được ≥ 0,5 giây. */
async function waitPlayed(count) {
  await page.waitForFunction((n) => window.__plays.length >= n && window.__plays[n - 1].played >= 0.5, count, { timeout: 30_000 });
  return page.evaluate((n) => window.__plays[n - 1], count);
}

try {
  await page.waitForSelector('input[type="password"]', { timeout: 60_000 });
  await page.getByLabel("Email").fill(server.email);
  await page.getByLabel("Mật khẩu").fill(server.password);
  await page.getByRole("button", { name: "Đăng nhập" }).click();
  await page.waitForSelector('[data-testid="sidebar"]', { timeout: 30_000 });
  await page.evaluate(recordPlayback);
  console.log("Giọng đọc tiếng Việt trên ứng dụng Windows:");

  await step("Cài đặt → Đọc thử bằng giọng tự nhiên của máy chủ", async () => {
    await page.evaluate(() => { window.location.hash = "#/settings"; });
    const select = page.getByRole("combobox", { name: "Giọng đọc" });
    await page.waitForFunction(() => {
      const el = [...document.querySelectorAll("select")].find((s) => s.getAttribute("aria-label") === "Giọng đọc");
      return el?.selectedOptions[0]?.textContent?.includes("Giọng tự nhiên tiếng Việt — máy chủ");
    }, null, { timeout: 30_000 });
    const label = await select.evaluate((el) => el.selectedOptions[0].textContent);
    const clicked = Date.now();
    await page.getByRole("button", { name: "Đọc thử" }).click();
    const rec = await waitPlayed(1);
    const res = ttsResponses[0];
    if (!res || res.status !== 200 || res.type !== "audio/wav") throw new Error(`máy chủ trả ${JSON.stringify(res)}`);
    if (!rec.src.startsWith("blob:")) throw new Error(`nguồn âm thanh lạ: ${rec.src}`);
    await page.getByRole("button", { name: "Dừng" }).click();
    return `mặc định “${label.trim()}”; máy chủ tạo giọng sau ${((res.ms - clicked) / 1000).toFixed(2)} giây, phát ${rec.duration.toFixed(1)} giây âm thanh`;
  });

  await step("Thông tin thuốc → Đọc thông tin", async () => {
    await page.evaluate((id) => { window.location.hash = `#/medicines/${id}`; }, medicine.id);
    await page.getByRole("button", { name: "Đọc thông tin" }).click();
    const rec = await waitPlayed(2);
    await page.getByRole("button", { name: "Dừng đọc" }).waitFor({ timeout: 5_000 });
    const spokenByWindows = await page.evaluate(() => window.__windowsSpeech.length);
    if (spokenByWindows) throw new Error("vẫn đọc bằng giọng Windows");
    await page.getByRole("button", { name: "Dừng đọc" }).click();
    await page.getByRole("button", { name: "Đọc thông tin" }).waitFor({ timeout: 5_000 });
    return `${medicine.ten_thuoc}: phát ${rec.duration.toFixed(1)} giây bằng giọng máy chủ, bấm Dừng đọc thì dừng`;
  });
  if (errors.length) console.log(`    (lỗi trong trang: ${errors.slice(0, 3).join(" | ")})`);
} finally {
  await app.close().catch(() => undefined);
  devServer.stdin.end();
  await new Promise((resolve) => { devServer.once("exit", resolve); setTimeout(resolve, 60_000); });
}
console.log(failed ? `THẤT BẠI — ảnh chụp màn hình trong ${tmp}` : "ĐẠT");
process.exit(failed ? 1 : 0);
