/**
 * Quét mã vạch ngay trong khung camera của màn Quét (không cần chế độ riêng): thấy mã → hỏi máy chủ → có trong dữ liệu
 * thì mở Chi tiết thuốc; chưa có thì nhắc chụp mặt hộp để nhận diện bằng OCR như bình thường.
 */
import type { BarcodeScanningResult, BarcodeType } from "expo-camera";
import * as Haptics from "expo-haptics";
import { router } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { Platform } from "react-native";
import { api, ApiError, type BarcodeResult } from "@/api";

/** EAN-13/8, UPC trên vỏ hộp; DataMatrix (GS1, có hạn dùng + số lô); QR (GS1 Digital Link); Code 128 (GS1-128). */
export const BARCODE_TYPES: BarcodeType[] = ["ean13", "ean8", "upc_a", "upc_e", "datamatrix", "qr", "code128", "itf14"];
/** Cùng một mã chỉ xử lý lại sau khoảng này (camera báo mã liên tục nhiều lần mỗi giây). */
export const REPEAT_MS = 10_000;
const NOTICE_MS = 7_000;

/** Có nên xử lý mã này bây giờ không — tránh gọi máy chủ liên tục khi camera vẫn nhìn thấy cùng một mã. */
export function shouldHandle(code: string, now: number, seen: Map<string, number>, repeatMs = REPEAT_MS): boolean {
  if (!code.trim()) return false;
  const last = seen.get(code);
  if (last !== undefined && now - last < repeatMs) return false;
  seen.set(code, now);
  for (const [key, at] of seen) if (now - at > repeatMs * 6) seen.delete(key);
  return true;
}

/** Mã chưa có trong dữ liệu → AI tìm trên mạng (máy chủ gọi Gemini; điện thoại không giữ khóa AI). */
export function openAiLookup(kind: "barcode" | "qr", code: string): void {
  router.push({ pathname: "/ai-lookup", params: { kind, code } });
}

/** Mở màn Chi tiết thuốc kèm hạn dùng/số lô đọc từ mã 2D (nếu có). */
export function openBarcodeResult(result: BarcodeResult): void {
  if (!result.medicine) return;
  const params: Record<string, string> = { id: String(result.medicine.id), barcode: result.code };
  if (result.gs1?.expiry) params.expiry = result.gs1.expiry;
  if (result.gs1?.lot) params.lot = result.gs1.lot;
  router.push({ pathname: "/medicine/[id]", params: params as { id: string } });
}

/** Android báo "qr", iOS "org.iso.QRCode", web "qr_code" — chấp nhận mọi cách gọi. */
export function isQr(type: string | undefined): boolean {
  return /qr/i.test(type ?? "");
}

export interface BarcodeNotice {
  code: string;
  message: string;
}

export function useBarcodeScanner({ enabled, vibrate }: { enabled: boolean; vibrate: boolean }) {
  const [notice, setNotice] = useState<BarcodeNotice | null>(null);
  const [looking, setLooking] = useState(false);
  const inFlight = useRef(false);
  const seen = useRef(new Map<string, number>());

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), NOTICE_MS);
    return () => clearTimeout(timer);
  }, [notice]);

  const onScanned = useCallback(async ({ data, type }: Pick<BarcodeScanningResult, "data"> & { type?: string }) => {
    if (!enabled || inFlight.current || !shouldHandle(data, Date.now(), seen.current)) return;
    inFlight.current = true;
    setLooking(true);
    try {
      const result = await api.lookupBarcode(data);
      if (result.status === "found" && result.medicine) {
        setNotice(null);
        if (vibrate && Platform.OS !== "web") void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined);
        openBarcodeResult(result);
      } else if (result.status === "not_found") {
        // Mã vạch hợp lệ nhưng chưa có trong dữ liệu → AI tự tìm trên mạng.
        setNotice(null);
        openAiLookup("barcode", result.code);
      } else if (result.status === "invalid" && isQr(type)) {
        // Mã QR không theo chuẩn GS1 (link/mã của hãng) → AI đọc nội dung và tìm trên mạng.
        setNotice(null);
        openAiLookup("qr", data);
      }
      // Mã nội bộ của cửa hàng (dải 2xx) và mã vạch 1D lỗi: bỏ qua, không làm phiền người dùng.
    } catch (e) {
      if (e instanceof ApiError) setNotice({ code: data, message: e.message });
    } finally {
      inFlight.current = false;
      setLooking(false);
    }
  }, [enabled, vibrate]);

  return { notice, looking, onScanned, dismiss: useCallback(() => setNotice(null), []) };
}
