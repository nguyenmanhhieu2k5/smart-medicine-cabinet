import * as Haptics from "expo-haptics";
import { router } from "expo-router";
import { Platform } from "react-native";
import { api, ApiError, type PickedImage } from "@/api";

/**
 * Gửi ảnh lên máy chủ rồi chuyển sang màn “Đang xử lý ảnh”. Kết quả KHÔNG tự thêm vào tủ thuốc —
 * ứng dụng di động chỉ xem kết quả tra cứu (máy chủ cũng không có đường nào cho Scanner ghi vào tủ).
 */
export async function startScan(image: PickedImage, source: "camera" | "upload", options: { vibrate?: boolean } = {}): Promise<void> {
  if (options.vibrate !== false && Platform.OS !== "web") void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => undefined);
  const job = await api.submitScan(image, source);
  router.push({ pathname: "/scan/processing/[jobId]", params: { jobId: job.id } });
}

export function scanErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 413) return "Ảnh quá lớn. Vui lòng chụp lại hoặc chọn ảnh nhỏ hơn.";
    if (error.status === 429) return error.message || "Bạn quét quá nhanh. Vui lòng đợi một chút rồi thử lại.";
    if (error.status === 503) return error.message || "Máy chủ đang bận. Vui lòng thử lại sau ít phút.";
    return error.message;
  }
  return error instanceof Error ? error.message : "Không gửi được ảnh. Vui lòng thử lại.";
}

/** Lỗi mở camera (thông điệp tiếng Anh của hệ điều hành/trình duyệt) → câu tiếng Việt dễ hiểu. */
export function cameraErrorMessage(raw: string | undefined): string {
  const text = (raw ?? "").toLowerCase();
  if (/not ?found|requested device|no camera|devicesnotfound/.test(text)) return "Không tìm thấy camera trên thiết bị này.";
  if (/notallowed|permission|denied/.test(text)) return "Chưa được phép dùng camera. Hãy cho phép camera trong cài đặt.";
  if (/notreadable|could not start|in use|busy/.test(text)) return "Camera đang được ứng dụng khác sử dụng. Hãy đóng ứng dụng đó rồi thử lại.";
  return "Không mở được camera.";
}
