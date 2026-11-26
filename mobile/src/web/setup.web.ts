import { setZXingModuleOverrides } from "barcode-detector";

/**
 * Chỉ cho TRANG WEB (bản web của ứng dụng điện thoại):
 *
 * 1. Bộ đọc mã vạch: trình duyệt không có BarcodeDetector (Chrome/Edge trên Windows, Safari…) thì expo-camera dùng
 *    bộ đọc dự phòng zxing-wasm (gói barcode-detector). Mặc định nó tải file .wasm từ CDN jsDelivr — ở đây đổi sang
 *    /zxing_reader.wasm do CHÍNH máy chủ phục vụ (scripts/copy-zxing-wasm.mjs chép vào public/ lúc build): không phụ
 *    thuốc bên thứ ba, chạy được với Content-Security-Policy chỉ cho phép 'self'.
 * 2. Camera: webcam máy tính (và camera trước điện thoại) báo là "camera trước" nên expo-camera LẬT NGANG ảnh xem trước
 *    như gương — chữ trên hộp thuốc bị ngược. Ảnh chụp gửi đi vốn không lật, nên bỏ lật ở ảnh xem trước cho giống ảnh chụp.
 */
const CSS = '[data-testid="camera-frame"] video { transform: none !important; }';

export function setupWeb(): void {
  setZXingModuleOverrides({
    locateFile: (path: string, prefix: string) => (path.endsWith(".wasm") ? "/zxing_reader.wasm" : prefix + path),
  });
  if (typeof document !== "undefined" && !document.getElementById("smc-web-fixes")) {
    const style = document.createElement("style");
    style.id = "smc-web-fixes";
    style.textContent = CSS;
    document.head.appendChild(style);
  }
}
