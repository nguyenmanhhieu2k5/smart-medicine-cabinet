/**
 * Đọc mã vạch / mã QR từ khung hình webcam NGAY TRONG ứng dụng Windows — không cần bấm chụp, không gửi hình lên máy chủ.
 *
 * Dùng zxing-wasm (chính thư viện zxing-cpp mà máy chủ dùng, biên dịch WebAssembly; chạy offline). Chromium trên Windows
 * không có BarcodeDetector nên phải tự đọc. Ứng dụng nạp trang bằng file:// (sandbox) nên không `fetch` được file .wasm →
 * nhúng .wasm vào bản build (module ảo base64, xem vite.config.ts) rồi đưa thẳng cho zxing.
 */
import { useEffect, useRef, type RefObject } from "react";

export interface DetectedCode {
  /** Tên loại mã theo zxing: "EAN13", "QRCode", "DataMatrix"… */
  format: string;
  text: string;
}

const FORMATS = ["EAN13", "EAN8", "UPCA", "UPCE", "ITF", "ITF14", "Code128", "QRCode", "MicroQRCode", "DataMatrix"] as const;
/** Quét luân phiên hai tỉ lệ: ảnh webcam thật có mã QR nhỏ cạnh mã vạch — ở tỉ lệ gốc chỉ thấy mã vạch. */
export const SCALES = [1, 0.5] as const;
export const MAX_SIDE = 1280;
export const INTERVAL_MS = 300;
/** Cùng một mã chỉ xử lý lại sau khoảng này (camera thấy mã liên tục nhiều lần mỗi giây). */
export const REPEAT_MS = 10_000;

type Reader = typeof import("zxing-wasm/reader");
let loading: Promise<Reader> | null = null;

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function loadReader(): Promise<Reader> {
  loading ??= (async () => {
    const [zxing, wasm] = await Promise.all([import("zxing-wasm/reader"), import("virtual:zxing-reader-wasm")]);
    const bytes = base64ToBytes(wasm.default);
    await zxing.prepareZXingModule({ overrides: { wasmBinary: bytes.buffer as ArrayBuffer }, fireImmediately: true });
    return zxing;
  })();
  try {
    return await loading;
  } catch (error) {
    loading = null; // lần sau thử nạp lại
    throw error;
  }
}

export async function readCodes(image: ImageData): Promise<DetectedCode[]> {
  const zxing = await loadReader();
  const results = await zxing.readBarcodes(image, { formats: [...FORMATS], tryHarder: true, maxNumberOfSymbols: 4 });
  return results.filter((r) => r.isValid && r.text.trim()).map((r) => ({ format: r.format, text: r.text.trim() }));
}

export function isQrFormat(format: string): boolean {
  return /qr/i.test(format);
}

/** Có nên xử lý mã này bây giờ không — tránh mở đi mở lại khi camera vẫn nhìn thấy cùng một mã. */
export function shouldHandle(code: string, now: number, seen: Map<string, number>, repeatMs = REPEAT_MS): boolean {
  if (!code.trim()) return false;
  const last = seen.get(code);
  if (last !== undefined && now - last < repeatMs) return false;
  seen.set(code, now);
  for (const [key, at] of seen) if (now - at > repeatMs * 6) seen.delete(key);
  return true;
}

/** Ưu tiên mã sản phẩm (mã vạch, DataMatrix) trước mã QR khi khung hình có nhiều mã. */
export function pickCode(codes: DetectedCode[]): DetectedCode | null {
  return codes.find((c) => !isQrFormat(c.format)) ?? codes[0] ?? null;
}

/**
 * Khi `enabled`: cứ INTERVAL_MS lấy một khung hình từ <video>, đọc mã; thấy mã → gọi onCodes.
 * Mỗi lần chỉ đọc một khung (không dồn việc); lỗi một khung thì bỏ qua.
 */
export function useLiveCodeScan(videoRef: RefObject<HTMLVideoElement | null>, enabled: boolean, onCodes: (codes: DetectedCode[]) => void): void {
  const callback = useRef(onCodes);
  callback.current = onCodes;

  useEffect(() => {
    if (!enabled) return;
    let stopped = false;
    let timer: number | undefined;
    let tick = 0;
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) return;

    const step = async () => {
      const video = videoRef.current;
      if (video && video.readyState >= 2 && video.videoWidth > 0) {
        const fit = Math.min(1, MAX_SIDE / Math.max(video.videoWidth, video.videoHeight));
        const scale = fit * SCALES[tick % SCALES.length];
        tick += 1;
        canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
        canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
        try {
          context.drawImage(video, 0, 0, canvas.width, canvas.height);
          const codes = await readCodes(context.getImageData(0, 0, canvas.width, canvas.height));
          if (!stopped && codes.length > 0) callback.current(codes);
        } catch {
          // khung hình lỗi / chưa nạp xong bộ đọc mã: thử lại ở khung sau
        }
      }
      if (!stopped) timer = window.setTimeout(() => void step(), INTERVAL_MS);
    };
    void step();
    return () => {
      stopped = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [enabled, videoRef]);
}
