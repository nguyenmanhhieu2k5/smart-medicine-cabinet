/**
 * Tủ thuốc thông minh — ứng dụng QUẢN TRỊ (ADMIN) cho Windows, tiến trình chính của Electron.
 *
 * Từ phiên bản 2.0, máy Windows KHÔNG chạy backend hay cơ sở dữ liệu. Mọi dữ liệu nằm trên máy chủ Mini PC
 * (PostgreSQL + FastAPI + PaddleOCR). Ứng dụng kết nối tới API quản trị qua Tailscale
 * (https://<mini-pc>.<tailnet>.ts.net), hoặc http://127.0.0.1:8001 khi chạy ngay trên Mini PC.
 *
 * Bảo mật:
 *  - đăng nhập / làm mới phiên do tiến trình chính thực hiện (net.fetch). Refresh token được mã hóa bằng
 *    safeStorage (DPAPI của Windows) và KHÔNG BAO GIỜ được đưa sang giao diện; giao diện chỉ nhận access token
 *    ngắn hạn (15 phút);
 *  - ứng dụng không chứa mật khẩu hay chuỗi kết nối cơ sở dữ liệu nào;
 *  - renderer chạy sandbox + contextIsolation, không nodeIntegration; IPC chỉ nhận từ trang của chính ứng dụng.
 */
const { app, BrowserWindow, Menu, Notification, Tray, ipcMain, nativeImage, net, safeStorage, session, shell } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const APP_TITLE = "Tủ thuốc thông minh";
const CLIENT_ID = "desktop-admin";
const devServerUrl = process.env.SMC_DEV_SERVER_URL || null;
const repoRoot = path.resolve(__dirname, "..");
const REQUEST_TIMEOUT_MS = 15_000;
const PROBE_TIMEOUT_MS = 6_000; // thử địa chỉ máy chủ lúc mở ứng dụng: nhanh, không bắt người dùng chờ lâu
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

app.setName("SmartMedicineCabinet"); // %APPDATA%\SmartMedicineCabinet (không dấu)
app.commandLine.appendSwitch("lang", "vi"); // ô chọn ngày hiển thị dd/mm/yyyy

/** @type {BrowserWindow | null} */
let mainWindow = null;
/** @type {Tray | null} */
let tray = null;
let quitting = false;
let trayEnabled = false;
let trayHintShown = false;

/**
 * Trạng thái kết nối — chỉ tồn tại trong tiến trình chính.
 * refreshToken KHÔNG bao giờ rời khỏi đây (không gửi qua IPC).
 */
const conn = {
  serverUrl: "",
  email: "",
  refreshToken: "",
  accessToken: "",
  accessExpiresAt: "",
  user: null,
  lastError: null,
};
/** @type {Promise<object> | null} */
let refreshing = null;
/** Hoàn tất khi lần khôi phục phiên đầu tiên (lúc mở ứng dụng) đã xong. */
let restored = Promise.resolve();

class UserError extends Error {}

// ----------------------------------------------------------------------------- //
// Lưu cấu hình kết nối (userData\connection.json)
// ----------------------------------------------------------------------------- //
function connectionFile() {
  return path.join(app.getPath("userData"), "connection.json");
}

function iconPath() {
  const candidates = [path.join(process.resourcesPath || "", "icon.png"), path.join(repoRoot, "assets", "icon.png")];
  return candidates.find((p) => fs.existsSync(p)) || null;
}

function canEncrypt() {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

function loadConnection() {
  try {
    const data = JSON.parse(fs.readFileSync(connectionFile(), "utf8"));
    conn.serverUrl = typeof data.serverUrl === "string" ? data.serverUrl : "";
    conn.email = typeof data.email === "string" ? data.email : "";
    conn.refreshToken = "";
    if (typeof data.session === "string" && data.session && canEncrypt()) {
      try {
        conn.refreshToken = safeStorage.decryptString(Buffer.from(data.session, "base64"));
      } catch {
        conn.refreshToken = ""; // hồ sơ Windows khác / dữ liệu hỏng → đăng nhập lại
      }
    }
  } catch {
    /* chưa cấu hình */
  }
}

/**
 * Địa chỉ API quản trị gài sẵn (desktop/servers.json), theo thứ tự ưu tiên; SMC_SERVER_URL (kiểm thử/triển khai) đứng đầu.
 * Mọi địa chỉ gài sẵn đều trỏ về CÙNG máy chủ Mini PC (qua Tailscale, hoặc 127.0.0.1 khi chạy ngay trên Mini PC).
 */
function builtinServers() {
  const list = [];
  if (process.env.SMC_SERVER_URL) list.push(process.env.SMC_SERVER_URL);
  try {
    const data = JSON.parse(fs.readFileSync(path.join(__dirname, "servers.json"), "utf8"));
    if (Array.isArray(data.servers)) list.push(...data.servers);
  } catch {
    /* không có tệp → chỉ dùng địa chỉ đã lưu */
  }
  const out = [];
  for (const item of list) {
    try {
      const origin = normalizeServerUrl(item);
      if (!out.includes(origin)) out.push(origin);
    } catch {
      /* bỏ qua giá trị sai */
    }
  }
  return out;
}

/** Địa chỉ này có phải API QUẢN TRỊ của Tủ thuốc thông minh đang chạy không. */
async function probeAdmin(origin) {
  const result = await callServer(origin, "GET", "/api/health", undefined, undefined, PROBE_TIMEOUT_MS);
  return Boolean(result.ok && result.data && typeof result.data.version === "string" && (!result.data.channel || result.data.channel === "admin"));
}

/**
 * Như ứng dụng điện thoại: tự chọn máy chủ, người dùng không phải nhập địa chỉ.
 * Thử song song địa chỉ đã lưu + các địa chỉ gài sẵn → lấy địa chỉ đầu tiên (theo thứ tự ưu tiên) trả lời đúng là kênh quản trị.
 */
async function autoSelectServer() {
  const builtins = builtinServers();
  const candidates = [...new Set([conn.serverUrl, ...builtins].filter(Boolean))];
  if (candidates.length === 0) return;
  const reachable = await Promise.all(candidates.map((origin) => probeAdmin(origin).catch(() => false)));
  const index = reachable.findIndex(Boolean);
  if (index < 0) {
    if (!conn.serverUrl) conn.serverUrl = candidates[0];
    conn.accessToken = "";
    conn.lastError = "Không kết nối được máy chủ Mini PC. Hãy kiểm tra Tailscale đã bật và đăng nhập cùng tài khoản với Mini PC, rồi bấm Thử lại.";
    return;
  }
  const chosen = candidates[index];
  if (chosen !== conn.serverUrl) {
    // Đổi giữa các địa chỉ gài sẵn = vẫn cùng một Mini PC → giữ phiên; máy chủ khác hẳn → bỏ phiên cũ.
    if (conn.serverUrl && !builtins.includes(conn.serverUrl)) clearSession();
    conn.serverUrl = chosen;
  }
  conn.lastError = null;
  saveConnection();
}

function saveConnection() {
  const data = { serverUrl: conn.serverUrl, email: conn.email, session: null };
  // Không lưu refresh token dạng rõ: nếu hệ điều hành không hỗ trợ mã hóa thì chỉ giữ trong bộ nhớ.
  if (conn.refreshToken && canEncrypt()) data.session = safeStorage.encryptString(conn.refreshToken).toString("base64");
  const file = connectionFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(data, null, 2), { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temp, file);
}

// ----------------------------------------------------------------------------- //
// Gọi API quản trị từ tiến trình chính
// ----------------------------------------------------------------------------- //
function normalizeServerUrl(input) {
  let text = String(input || "").trim();
  if (!text) throw new UserError("Hãy nhập địa chỉ máy chủ.");
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
    const host = text.split(/[/:]/)[0].toLowerCase();
    text = (LOOPBACK_HOSTS.has(host) ? "http://" : "https://") + text;
  }
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new UserError("Địa chỉ máy chủ không hợp lệ.");
  }
  if (url.username || url.password) throw new UserError("Địa chỉ máy chủ không được chứa tên đăng nhập/mật khẩu.");
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new UserError("Địa chỉ máy chủ phải bắt đầu bằng https://");
  if (url.protocol === "http:" && !LOOPBACK_HOSTS.has(url.hostname)) {
    throw new UserError("Qua mạng phải dùng https:// (Tailscale). http:// chỉ dùng cho 127.0.0.1 khi chạy ngay trên Mini PC.");
  }
  return url.origin;
}

async function callServer(base, method, pathName, body, accessToken, timeoutMs = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const headers = { Accept: "application/json", "X-SMC-Client": CLIENT_ID };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
  try {
    const response = await net.fetch(base + pathName, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
      redirect: "error", // không đi theo chuyển hướng: tránh gửi mật khẩu tới nơi khác
    });
    let data = null;
    try {
      data = await response.json();
    } catch {
      data = null;
    }
    return { status: response.status, ok: response.ok, data };
  } catch (error) {
    const reason = error && error.name === "AbortError" ? "hết thời gian chờ" : (error && error.message) || String(error);
    return { status: 0, ok: false, data: null, networkError: reason };
  } finally {
    clearTimeout(timer);
  }
}

function serverMessage(result, fallback) {
  if (result.networkError) {
    return `Không kết nối được máy chủ ${conn.serverUrl || ""} (${result.networkError}). Kiểm tra Tailscale đã bật và Mini PC đang chạy.`;
  }
  if (result.data && typeof result.data.detail === "string") return result.data.detail;
  if (result.status === 404) return "Địa chỉ này không phải API quản trị của Tủ thuốc thông minh.";
  if (result.status === 400 || result.status === 403) return `Máy chủ từ chối kết nối (mã ${result.status}). API quản trị chỉ mở qua Tailscale.`;
  return fallback || `Lỗi máy chủ (mã ${result.status}).`;
}

function applyTokens(data) {
  conn.accessToken = data.access_token;
  // Tính theo đồng hồ của máy này (expires_in giây) — không phụ thuộc múi giờ của máy chủ.
  const seconds = Number(data.expires_in) > 0 ? Number(data.expires_in) : 900;
  conn.accessExpiresAt = new Date(Date.now() + seconds * 1000).toISOString();
  conn.refreshToken = data.refresh_token;
  conn.user = data.user || null;
  conn.lastError = null;
  if (conn.user && conn.user.email) conn.email = conn.user.email;
  saveConnection();
}

function clearSession() {
  conn.accessToken = "";
  conn.accessExpiresAt = "";
  conn.refreshToken = "";
  conn.user = null;
}

/** Thông tin gửi sang giao diện — KHÔNG có refresh token. */
function snapshot(extra = {}) {
  let state = "ready";
  if (!conn.serverUrl) state = "unconfigured";
  else if (!conn.accessToken) state = conn.lastError ? "error" : "signed-out";
  return {
    state,
    baseUrl: conn.serverUrl,
    token: conn.accessToken,
    expiresAt: conn.accessExpiresAt || null,
    user: conn.user,
    email: conn.email || null,
    error: conn.lastError,
    secureStorage: canEncrypt(),
    hasSession: Boolean(conn.refreshToken),
    ...extra,
  };
}

async function refreshSession() {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    if (!conn.serverUrl || !conn.refreshToken) {
      conn.accessToken = "";
      return snapshot();
    }
    const result = await callServer(conn.serverUrl, "POST", "/api/auth/refresh", { refresh_token: conn.refreshToken });
    if (result.ok && result.data && result.data.access_token) {
      applyTokens(result.data);
      return snapshot();
    }
    if (result.status === 401 || result.status === 403) {
      // Phiên bị thu hồi / hết hạn / token đã dùng lại → phải đăng nhập lại.
      clearSession();
      conn.lastError = null;
      saveConnection();
      return snapshot({ error: serverMessage(result, "Phiên đăng nhập đã hết hạn. Hãy đăng nhập lại.") });
    }
    // Lỗi mạng / máy chủ tạm lỗi: giữ refresh token để thử lại.
    conn.accessToken = "";
    conn.lastError = serverMessage(result);
    return snapshot();
  })().finally(() => {
    refreshing = null;
  });
  return refreshing;
}

async function setServer(input) {
  let origin;
  try {
    origin = normalizeServerUrl(input);
  } catch (error) {
    return snapshot({ error: error.message });
  }
  const result = await callServer(origin, "GET", "/api/health");
  if (!result.ok || !result.data || typeof result.data.version !== "string") {
    const previous = conn.serverUrl;
    conn.serverUrl = origin; // để thông báo lỗi nêu đúng địa chỉ vừa thử
    const message = serverMessage(result, "Máy chủ không trả lời đúng định dạng.");
    conn.serverUrl = previous;
    return snapshot({ error: message });
  }
  if (result.data.channel && result.data.channel !== "admin") {
    return snapshot({ error: "Đây là API công khai (dành cho ứng dụng điện thoại). Ứng dụng Windows cần địa chỉ API quản trị qua Tailscale." });
  }
  if (origin !== conn.serverUrl) {
    await logout(); // đổi máy chủ → bỏ phiên cũ
    conn.serverUrl = origin;
  }
  conn.lastError = null;
  saveConnection();
  return snapshot({ health: result.data });
}

async function login(email, password) {
  if (!conn.serverUrl) return snapshot({ error: "Chưa cấu hình địa chỉ máy chủ." });
  const result = await callServer(conn.serverUrl, "POST", "/api/auth/login", {
    email: String(email || "").trim().slice(0, 254),
    password: String(password || "").slice(0, 200),
  });
  if (result.ok && result.data && result.data.access_token) {
    applyTokens(result.data);
    return snapshot();
  }
  return snapshot({ error: serverMessage(result, "Đăng nhập thất bại.") });
}

async function logout() {
  const token = conn.refreshToken;
  const base = conn.serverUrl;
  clearSession();
  conn.lastError = null;
  saveConnection();
  if (token && base) await callServer(base, "POST", "/api/auth/logout", { refresh_token: token }); // thu hồi phiên trên máy chủ
  return snapshot();
}

async function forgetServer() {
  await logout();
  conn.serverUrl = "";
  saveConnection();
  return snapshot();
}

// ----------------------------------------------------------------------------- //
// Cửa sổ
// ----------------------------------------------------------------------------- //
function isTrustedUrl(url) {
  if (devServerUrl) return url.startsWith(devServerUrl);
  return url.startsWith("file://");
}

function createWindow() {
  const icon = iconPath();
  mainWindow = new BrowserWindow({
    width: 1600,
    height: 1000,
    minWidth: 1180,
    minHeight: 700,
    show: false,
    title: APP_TITLE,
    backgroundColor: "#F7F7F5",
    autoHideMenuBar: true,
    icon: icon || undefined,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
      backgroundThrottling: false, // vẫn kiểm tra lời nhắc khi cửa sổ bị ẩn
      additionalArguments: [`--smc-version=${app.getVersion()}`],
    },
  });
  mainWindow.setMenuBarVisibility(false);
  mainWindow.once("ready-to-show", () => {
    mainWindow.maximize();
    mainWindow.show();
  });

  // Không mở cửa sổ mới trong ứng dụng; liên kết https bên ngoài mở bằng trình duyệt.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (!isTrustedUrl(url)) event.preventDefault();
  });

  mainWindow.on("close", (event) => {
    if (!quitting && trayEnabled && tray) {
      event.preventDefault();
      mainWindow.hide();
      if (!trayHintShown && Notification.isSupported()) {
        trayHintShown = true;
        new Notification({ title: APP_TITLE, body: "Ứng dụng vẫn chạy ở khay hệ thống để nhắc uống thuốc. Nhấp chuột phải vào biểu tượng để thoát." }).show();
      }
    }
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  if (devServerUrl) void mainWindow.loadURL(devServerUrl);
  else void mainWindow.loadFile(path.join(__dirname, "..", "frontend", "dist", "index.html"));
}

function showWindow(route) {
  if (!mainWindow) createWindow();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
  if (route) mainWindow.webContents.send("smc:navigate", route);
}

function ensureTray() {
  if (tray) return;
  const icon = iconPath();
  if (!icon) return;
  tray = new Tray(nativeImage.createFromPath(icon).resize({ width: 16, height: 16 }));
  tray.setToolTip(APP_TITLE);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: `Mở ${APP_TITLE}`, click: () => showWindow() },
      { label: "Nhắc uống thuốc", click: () => showWindow("/reminders") },
      { type: "separator" },
      { label: "Thoát", click: () => { quitting = true; app.quit(); } },
    ]),
  );
  tray.on("click", () => showWindow());
}

// ----------------------------------------------------------------------------- //
// IPC (chỉ nhận từ trang của chính ứng dụng)
// ----------------------------------------------------------------------------- //
function guard(event) {
  const url = event.senderFrame ? event.senderFrame.url : "";
  if (!isTrustedUrl(url)) throw new Error("Nguồn gọi IPC không hợp lệ");
}

function registerIpc() {
  ipcMain.handle("smc:backend", async (event) => {
    guard(event);
    await restored;
    // Chưa có máy chủ / lần trước không kết nối được (bấm "Thử lại") → tự chọn lại địa chỉ như lúc mở ứng dụng.
    if (!conn.accessToken && (!conn.serverUrl || conn.lastError)) await autoSelectServer();
    if (conn.serverUrl && !conn.accessToken && conn.refreshToken && !conn.lastError) return refreshSession();
    return snapshot();
  });
  ipcMain.handle("smc:server-set", (event, url) => {
    guard(event);
    return setServer(typeof url === "string" ? url.slice(0, 300) : "");
  });
  ipcMain.handle("smc:server-forget", (event) => {
    guard(event);
    return forgetServer();
  });
  ipcMain.handle("smc:login", (event, payload) => {
    guard(event);
    return login(payload && payload.email, payload && payload.password);
  });
  ipcMain.handle("smc:refresh", (event) => {
    guard(event);
    return refreshSession();
  });
  ipcMain.handle("smc:logout", (event) => {
    guard(event);
    return logout();
  });

  ipcMain.handle("smc:relaunch", (event) => {
    guard(event);
    quitting = true;
    app.relaunch();
    app.quit();
  });

  ipcMain.handle("smc:notify", (event, payload) => {
    guard(event);
    if (!Notification.isSupported() || !payload || typeof payload.title !== "string") return false;
    const notification = new Notification({ title: payload.title.slice(0, 120), body: String(payload.body || "").slice(0, 300), icon: iconPath() || undefined });
    const route = typeof payload.route === "string" && payload.route.startsWith("/") ? payload.route : null;
    notification.on("click", () => showWindow(route));
    notification.show();
    return true;
  });

  ipcMain.handle("smc:tray", (event, enabled) => {
    guard(event);
    trayEnabled = Boolean(enabled);
    if (trayEnabled) ensureTray();
    else if (tray) {
      tray.destroy();
      tray = null;
    }
  });
}

// ----------------------------------------------------------------------------- //
// Khởi động
// ----------------------------------------------------------------------------- //
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => showWindow());

  app.whenReady().then(() => {
    if (process.platform === "win32") app.setAppUserModelId("vn.smartmedicinecabinet.app"); // cần cho thông báo Windows

    // Chỉ cấp quyền camera (quét thuốc), thông báo và ghi clipboard (sao chép token thiết bị) cho trang của ứng dụng.
    const ALLOWED = new Set(["media", "notifications", "clipboard-sanitized-write"]);
    session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
      callback(isTrustedUrl(webContents.getURL()) && ALLOWED.has(permission));
    });
    session.defaultSession.setPermissionCheckHandler((webContents, permission) => {
      const url = webContents ? webContents.getURL() : "";
      return isTrustedUrl(url) && ALLOWED.has(permission);
    });

    loadConnection();
    registerIpc();
    // Như ứng dụng điện thoại: tự chọn máy chủ (đã lưu → gài sẵn) rồi khôi phục phiên đã mã hóa.
    restored = autoSelectServer()
      .catch(() => undefined)
      .then(() => (conn.serverUrl && conn.refreshToken && !conn.lastError ? refreshSession() : undefined))
      .then(() => undefined);
    createWindow();
  });

  app.on("activate", () => showWindow());
  app.on("window-all-closed", () => {
    if (!trayEnabled || quitting) {
      quitting = true;
      app.quit();
    }
  });
  app.on("before-quit", () => {
    quitting = true;
  });
}
