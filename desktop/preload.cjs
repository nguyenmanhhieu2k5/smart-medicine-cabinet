/**
 * Preload — cầu nối hẹp giữa giao diện (renderer đã sandbox) và tiến trình chính.
 *
 * Renderer KHÔNG có quyền Node.js. Chỉ những hàm liệt kê dưới đây được đưa ra `window.smc`;
 * mỗi hàm ánh xạ tới đúng một kênh IPC cố định, không nhận tên kênh từ trang web.
 * Kiểu TypeScript tương ứng: frontend/src/types/desktop.d.ts
 */
const { contextBridge, ipcRenderer } = require("electron");

function readVersion() {
  const prefix = "--smc-version=";
  const argument = process.argv.find((value) => typeof value === "string" && value.startsWith(prefix));
  return argument ? argument.slice(prefix.length) : "";
}

contextBridge.exposeInMainWorld("smc", {
  isDesktop: true,
  appVersion: readVersion(),
  platform: process.platform,

  /** Địa chỉ + token của backend cục bộ. Chờ tới khi backend sẵn sàng hoặc báo lỗi. */
  getBackend: () => ipcRenderer.invoke("smc:backend"),

  /** Mở hộp thoại chọn file Excel; trả về đường dẫn hoặc null. */
  pickExcelFile: () => ipcRenderer.invoke("smc:pick-excel"),

  /** Hiện thông báo Windows. */
  notify: (payload) =>
    ipcRenderer.invoke("smc:notify", {
      title: String(payload && payload.title ? payload.title : ""),
      body: String(payload && payload.body ? payload.body : ""),
      route: payload && typeof payload.route === "string" ? payload.route : undefined,
    }),

  /** Tiến trình chính yêu cầu chuyển trang (bấm vào thông báo / khay hệ thống). */
  onNavigate: (callback) => {
    if (typeof callback !== "function") return () => undefined;
    const listener = (_event, route) => {
      if (typeof route === "string") callback(route);
    };
    ipcRenderer.on("smc:navigate", listener);
    return () => ipcRenderer.removeListener("smc:navigate", listener);
  },

  openDataFolder: () => ipcRenderer.invoke("smc:open-data"),
  openLogFolder: () => ipcRenderer.invoke("smc:open-logs"),
  setTrayEnabled: (enabled) => ipcRenderer.invoke("smc:tray", Boolean(enabled)),

  /** Khởi động lại toàn bộ ứng dụng (dùng khi dịch vụ nền lỗi). */
  relaunch: () => ipcRenderer.invoke("smc:relaunch"),
});
