/**
 * Tủ thuốc thông minh — tiến trình chính của Electron.
 *
 * Nhiệm vụ:
 *  - khởi động backend Python (FastAPI) trên 127.0.0.1 với cổng ngẫu nhiên + token ngẫu nhiên,
 *    và dừng nó khi ứng dụng thoát (người dùng không phải mở terminal);
 *  - mở cửa sổ giao diện với contextIsolation, sandbox, không bật nodeIntegration;
 *  - cung cấp một số IPC hẹp qua preload: thông tin backend, chọn file Excel, thông báo Windows,
 *    khay hệ thống, mở thư mục dữ liệu.
 */
const { app, BrowserWindow, Menu, Notification, Tray, dialog, ipcMain, nativeImage, session, shell } = require("electron");
const { spawn, execFile } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const path = require("node:path");

const APP_TITLE = "Tủ thuốc thông minh";
const isDev = !app.isPackaged;
const devServerUrl = process.env.SMC_DEV_SERVER_URL || null;
const repoRoot = path.resolve(__dirname, "..");

app.setName("SmartMedicineCabinet"); // thư mục dữ liệu: %APPDATA%\SmartMedicineCabinet (không dấu)
app.commandLine.appendSwitch("lang", "vi"); // ô chọn ngày hiển thị dd/mm/yyyy

/** @type {BrowserWindow | null} */
let mainWindow = null;
/** @type {Tray | null} */
let tray = null;
/** @type {import("node:child_process").ChildProcess | null} */
let backendProcess = null;
let quitting = false;
let trayEnabled = false;
let trayHintShown = false;

const backend = {
  baseUrl: "",
  token: "",
  state: "starting", // starting | ready | error
  error: null,
};
/** Hoàn tất khi backend đã sẵn sàng hoặc đã báo lỗi — renderer chờ promise này trước khi gọi API. */
let backendSettled = Promise.resolve();

// ----------------------------------------------------------------------------- //
// Đường dẫn
// ----------------------------------------------------------------------------- //
function userDataDir() {
  return path.join(app.getPath("userData"), isDev ? "data-dev" : "data");
}
function logFile() {
  const dir = path.join(app.getPath("userData"), "logs");
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, "backend.log");
}
function iconPath() {
  const candidates = [path.join(process.resourcesPath || "", "icon.png"), path.join(repoRoot, "assets", "icon.png")];
  return candidates.find((p) => fs.existsSync(p)) || null;
}

/** Lệnh khởi động backend: file .exe đã đóng gói, hoặc Python trong môi trường phát triển. */
function backendCommand() {
  if (!isDev) {
    const exe = path.join(process.resourcesPath, "backend", process.platform === "win32" ? "smc-backend.exe" : "smc-backend");
    return { command: exe, args: [], cwd: path.dirname(exe), resources: process.resourcesPath };
  }
  const backendDir = path.join(repoRoot, "backend");
  const venvPython = process.platform === "win32" ? path.join(backendDir, ".venv", "Scripts", "python.exe") : path.join(backendDir, ".venv", "bin", "python");
  const python = process.env.SMC_PYTHON || (fs.existsSync(venvPython) ? venvPython : process.platform === "win32" ? "python" : "python3");
  return { command: python, args: ["-m", "app.run"], cwd: backendDir, resources: repoRoot };
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function checkHealth() {
  return new Promise((resolve) => {
    const request = http.get(`${backend.baseUrl}/api/health`, { timeout: 2000 }, (response) => {
      response.resume();
      resolve(response.statusCode === 200);
    });
    request.on("error", () => resolve(false));
    request.on("timeout", () => {
      request.destroy();
      resolve(false);
    });
  });
}

// ----------------------------------------------------------------------------- //
// Vòng đời backend
// ----------------------------------------------------------------------------- //
async function startBackend() {
  // Cho phép trỏ tới backend đang chạy sẵn khi phát triển: SMC_EXTERNAL_BACKEND=http://127.0.0.1:8756
  if (process.env.SMC_EXTERNAL_BACKEND) {
    backend.baseUrl = process.env.SMC_EXTERNAL_BACKEND.replace(/\/$/, "");
    backend.token = process.env.SMC_API_TOKEN || "";
  } else {
    const port = await freePort();
    backend.baseUrl = `http://127.0.0.1:${port}`;
    backend.token = crypto.randomBytes(24).toString("hex");
    const { command, args, cwd, resources } = backendCommand();
    if (!isDev && !fs.existsSync(command)) {
      backend.state = "error";
      backend.error = `Không tìm thấy dịch vụ nền: ${command}`;
      return;
    }
    const log = fs.createWriteStream(logFile(), { flags: "w" });
    const env = {
      ...process.env,
      SMC_HOST: "127.0.0.1",
      SMC_PORT: String(port),
      SMC_API_TOKEN: backend.token,
      SMC_DATA_DIR: process.env.SMC_DATA_DIR || userDataDir(),
      SMC_RESOURCE_DIR: process.env.SMC_RESOURCE_DIR || resources,
      SMC_PARENT_PID: String(process.pid), // backend tự thoát nếu ứng dụng bị tắt đột ngột
      PYTHONUNBUFFERED: "1",
      PYTHONIOENCODING: "utf-8",
      PYTHONUTF8: "1",
    };
    backendProcess = spawn(command, args, { cwd, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    backendProcess.stdout.pipe(log);
    backendProcess.stderr.pipe(log);
    backendProcess.on("error", (error) => {
      backend.state = "error";
      backend.error = `Không khởi động được dịch vụ nền: ${error.message}`;
    });
    backendProcess.on("exit", (code) => {
      backendProcess = null;
      if (!quitting) {
        const wasReady = backend.state === "ready";
        backend.state = "error";
        backend.error = `Dịch vụ nền đã dừng (mã ${code}).`;
        // Đang chạy mà dừng đột ngột -> báo ngay; lỗi lúc khởi động đã có màn hình riêng trong giao diện.
        if (wasReady && mainWindow) {
          void dialog
            .showMessageBox(mainWindow, {
              type: "error",
              title: APP_TITLE,
              message: "Dịch vụ nền đã dừng",
              detail: `${backend.error}\nNhật ký: ${logFile()}`,
              buttons: ["Khởi động lại ứng dụng", "Đóng"],
              defaultId: 0,
              cancelId: 1,
            })
            .then(({ response }) => {
              if (response === 0) {
                quitting = true;
                app.relaunch();
                app.quit();
              }
            });
        }
      }
    });
  }

  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline && backend.state === "starting") {
    if (await checkHealth()) {
      backend.state = "ready";
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  if (backend.state === "starting") {
    backend.state = "error";
    backend.error = "Dịch vụ nền không phản hồi sau 90 giây.";
  }
}

function stopBackend() {
  const child = backendProcess;
  if (!child || child.killed) return;
  backendProcess = null;
  if (process.platform === "win32" && child.pid) {
    // Dừng cả cây tiến trình (uvicorn + luồng OCR) trên Windows.
    execFile("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true }, () => undefined);
  } else {
    child.kill("SIGTERM");
  }
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

  // Không mở cửa sổ mới, không điều hướng ra ngoài ứng dụng.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url) && !url.startsWith("http://127.0.0.1") && !url.startsWith("http://localhost")) void shell.openExternal(url);
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
    await backendSettled;
    return { baseUrl: backend.baseUrl, token: backend.token, state: backend.state, error: backend.error, logFile: logFile() };
  });

  ipcMain.handle("smc:open-logs", (event) => {
    guard(event);
    return shell.openPath(path.dirname(logFile()));
  });

  ipcMain.handle("smc:relaunch", (event) => {
    guard(event);
    quitting = true;
    app.relaunch();
    app.quit();
  });

  ipcMain.handle("smc:pick-excel", async (event) => {
    guard(event);
    const result = await dialog.showOpenDialog(mainWindow, {
      title: "Chọn file Excel danh mục thuốc",
      properties: ["openFile"],
      filters: [{ name: "Excel", extensions: ["xlsx", "xlsm"] }],
    });
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0];
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

  ipcMain.handle("smc:open-data", (event) => {
    guard(event);
    return shell.openPath(process.env.SMC_DATA_DIR || userDataDir());
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

  app.whenReady().then(async () => {
    if (process.platform === "win32") app.setAppUserModelId("vn.smartmedicinecabinet.app"); // cần cho thông báo Windows

    // Chỉ cấp quyền camera/thông báo cho trang của ứng dụng.
    session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
      callback(isTrustedUrl(webContents.getURL()) && (permission === "media" || permission === "notifications"));
    });
    session.defaultSession.setPermissionCheckHandler((webContents, permission) => {
      const url = webContents ? webContents.getURL() : "";
      return isTrustedUrl(url) && (permission === "media" || permission === "notifications");
    });

    registerIpc();
    backendSettled = startBackend().catch((error) => {
      backend.state = "error";
      backend.error = `Không khởi động được dịch vụ nền: ${error.message}`;
    });
    createWindow(); // giao diện hiện ngay với màn hình "Đang khởi động…"; lỗi (nếu có) hiển thị trong cửa sổ
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
  app.on("will-quit", stopBackend);
  process.on("exit", stopBackend);
}
