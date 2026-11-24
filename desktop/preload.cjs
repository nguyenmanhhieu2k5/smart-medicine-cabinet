/**
 * Preload — cầu nối hẹp giữa giao diện (renderer đã sandbox) và tiến trình chính.
 *
 * Renderer KHÔNG có quyền Node.js. Chỉ những hàm liệt kê dưới đây được đưa ra `window.smc`;
 * mỗi hàm ánh xạ tới đúng một kênh IPC cố định, không nhận tên kênh từ trang web.
 * Refresh token không bao giờ đi qua cầu nối này — giao diện chỉ nhận access token ngắn hạn.
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

  /** Trạng thái kết nối máy chủ + phiên Admin (tự khôi phục phiên đã lưu khi mở ứng dụng). */
  getBackend: () => ipcRenderer.invoke("smc:backend"),
  /** Kiểm tra rồi lưu địa chỉ API quản trị (Tailscale) của Mini PC. */
  setServer: (url) => ipcRenderer.invoke("smc:server-set", String(url || "")),
  /** Quên máy chủ (đăng xuất trước). */
  forgetServer: () => ipcRenderer.invoke("smc:server-forget"),
  /** Đăng nhập Admin — tiến trình chính gọi máy chủ và giữ refresh token. */
  login: (email, password) => ipcRenderer.invoke("smc:login", { email: String(email || ""), password: String(password || "") }),
  /** Lấy access token mới (khi token cũ sắp hết hạn hoặc bị từ chối 401). */
  refreshSession: () => ipcRenderer.invoke("smc:refresh"),
  logout: () => ipcRenderer.invoke("smc:logout"),

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

  setTrayEnabled: (enabled) => ipcRenderer.invoke("smc:tray", Boolean(enabled)),

  /** Khởi động lại toàn bộ ứng dụng. */
  relaunch: () => ipcRenderer.invoke("smc:relaunch"),
});
