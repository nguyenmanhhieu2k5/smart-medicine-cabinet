import { useEffect, useState, type RefObject } from "react";

/**
 * Chất lượng khung hình webcam trước khi gửi đi nhận dạng chữ.
 *
 * “Lóa sáng” = điểm ảnh cháy sáng (kênh lớn nhất ≥ 250) và gần như không màu: phản chiếu của đèn trên giấy bạc
 * của vỉ thuốc, màng bóng của hộp, hoặc màn hình điện thoại quá sáng. Chữ nằm dưới chỗ lóa bị mất hẳn —
 * không bộ lọc nào khôi phục được — nên cách hiệu quả nhất là chọn khung ít lóa nhất và nhắc người dùng nghiêng vỉ/hộp.
 */

/** Vùng giữa khung hình (nơi đặt hộp/vỉ thuốc, trùng khung quét trên màn hình), theo tỉ lệ 0–1. */
export const CENTER_REGION = { x0: 0.15, x1: 0.85, y0: 0.1, y1: 0.9 };
/** Từ tỉ lệ lóa này (3% vùng giữa) trở lên thì nhắc người dùng. Đo trên ảnh quét thật: vỉ giấy bạc lóa 2–9%, hộp giấy thường < 1%. */
export const GLARE_HINT_RATIO = 0.03;

/** Tỉ lệ điểm ảnh bị lóa trong một vùng (dữ liệu RGBA của canvas). */
export function glareRatio(data: Uint8ClampedArray, width: number, height: number, region = CENTER_REGION): number {
  const x0 = Math.floor(width * region.x0);
  const x1 = Math.ceil(width * region.x1);
  const y0 = Math.floor(height * region.y0);
  const y1 = Math.ceil(height * region.y1);
  let clipped = 0;
  let total = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * width + x) * 4;
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const max = Math.max(r, g, b);
      if (max >= 250 && max - Math.min(r, g, b) <= 40) clipped++;
      total++;
    }
  }
  return total ? clipped / total : 0;
}

/**
 * Điểm để chọn khung gửi đi: nét nhất nhưng bị trừ mạnh khi lóa (lóa 4% ≈ mất nửa điểm).
 * Chỗ lóa có viền rất gắt nên làm độ nét Laplacian tăng giả — phải trừ thì mới không chọn nhầm khung lóa.
 */
export function frameScore(sharpness: number, glare: number): number {
  return sharpness / (1 + 25 * glare);
}

/** Nhắc “bị lóa sáng” khi khung hình trực tiếp bị lóa liên tục (bật sau 2 lần đo, tắt sau 2 lần đo không lóa). */
export function useGlareHint(videoRef: RefObject<HTMLVideoElement | null>, enabled: boolean, intervalMs = 700): boolean {
  const [glare, setGlare] = useState(false);
  useEffect(() => {
    if (!enabled) {
      setGlare(false);
      return;
    }
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) return;
    let streak = 0;
    let showing = false;
    const timer = window.setInterval(() => {
      const video = videoRef.current;
      if (!video || video.readyState < 2 || !video.videoWidth) return;
      canvas.width = 240;
      canvas.height = Math.max(8, Math.round((240 * video.videoHeight) / video.videoWidth));
      try {
        context.drawImage(video, 0, 0, canvas.width, canvas.height);
        const ratio = glareRatio(context.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height);
        const over = showing ? ratio >= GLARE_HINT_RATIO * 0.6 : ratio >= GLARE_HINT_RATIO;
        streak = over === showing ? 0 : streak + 1;
        if (streak >= 2) {
          showing = !showing;
          streak = 0;
          setGlare(showing);
        }
      } catch {
        // khung hình chưa sẵn sàng: đo lại lần sau
      }
    }, intervalMs);
    return () => window.clearInterval(timer);
  }, [enabled, intervalMs, videoRef]);
  return glare;
}
