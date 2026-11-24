import { ImageManipulator, SaveFormat } from "expo-image-manipulator";
import * as ImagePicker from "expo-image-picker";
import type { PickedImage } from "@/api";

/** Chất lượng ảnh gửi lên máy chủ (Cài đặt ứng dụng → Chất lượng ảnh quét). */
export const QUALITY = {
  high: { maxSide: 2000, compress: 0.9 },
  standard: { maxSide: 1600, compress: 0.82 },
} as const;
export type ImageQuality = keyof typeof QUALITY;

/**
 * Thu nhỏ ảnh (cạnh dài ≤ 1600/2000 px) và nén JPEG trước khi gửi: đủ nét cho OCR, tải lên nhanh qua 4G.
 * Không đổi tỉ lệ, không cắt ảnh.
 */
export async function prepareImage(uri: string, width: number, height: number, quality: ImageQuality = "standard"): Promise<PickedImage> {
  const { maxSide, compress } = QUALITY[quality];
  const context = ImageManipulator.manipulate(uri);
  if (Math.max(width, height) > maxSide) {
    context.resize(width >= height ? { width: maxSide } : { height: maxSide });
  }
  const rendered = await context.renderAsync();
  const saved = await rendered.saveAsync({ compress, format: SaveFormat.JPEG });
  return { uri: saved.uri, mimeType: "image/jpeg", fileName: "scan.jpg" };
}

/** Chọn ảnh có sẵn trong thư viện (nút “Chọn ảnh”). Trả về null khi người dùng hủy. */
export async function pickFromLibrary(quality: ImageQuality = "standard"): Promise<PickedImage | null> {
  const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images"], quality: 1, allowsEditing: false, exif: false });
  if (result.canceled || result.assets.length === 0) return null;
  const asset = result.assets[0];
  return prepareImage(asset.uri, asset.width, asset.height, quality);
}
