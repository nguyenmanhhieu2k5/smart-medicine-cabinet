/**
 * Hệ màu + chữ của ứng dụng di động — dùng CHUNG bảng màu với ứng dụng Windows (frontend/src/styles/index.css),
 * đánh số theo ảnh bảng màu của dự án; bố cục giữ đúng thiết kế trong mobile/01-auth, 02-main-screens (DESIGN.md).
 */
import { Platform, type ViewStyle } from "react-native";

export const colors = {
  bg: "#F0F7FF", // (1) nền trang, chuyển sắc xuống bgEnd
  bgEnd: "#E2EEFF",
  surface: "#FFFFFF", // (2)(9) thẻ, thanh tab dưới
  primary: "#0066FF", // (3)(5) mục đang chọn, nút chính, liên kết/chữ nhấn
  primaryPressed: "#0052CC",
  primarySoft: "#E6F2FF", // (4) vùng camera/quét thuốc
  primaryTint: "#F0F7FF", // (6) nút phụ tròn
  metric: "#F0F6FF", // (7) thẻ thông số
  navy: "#111B39",
  muted: "#667085",
  placeholder: "#98A2B3",
  border: "#E3EBF7",
  success: "#10B981", // trạng thái thành công
  successSoft: "#E7F8F1",
  warning: "#F59E0B",
  warningSoft: "#FFF3D6", // (8) nền biểu tượng cảnh báo
  warningLabel: "#FFECB3", // (8) nền nhãn cảnh báo
  warningInk: "#B4610B",
  danger: "#EF4444", // số lượng thông báo, lỗi
  dangerSoft: "#FDECEC",
  overlay: "rgba(17, 27, 57, 0.45)",
} as const;

export const font = {
  regular: "Inter_400Regular",
  medium: "Inter_500Medium",
  semibold: "Inter_600SemiBold",
  bold: "Inter_700Bold",
  extrabold: "Inter_800ExtraBold",
} as const;

export const radius = { card: 20, control: 16, button: 18, pill: 999 } as const;

/** Lề hai bên màn hình (thiết kế: 24 dp ở 393 dp; tự co ở máy 360 dp). */
export function gutter(width: number): number {
  return width < 375 ? 18 : width < 400 ? 22 : 24;
}

export const shadow: ViewStyle = Platform.select<ViewStyle>({
  ios: { shadowColor: "#1B2A4E", shadowOpacity: 0.06, shadowRadius: 14, shadowOffset: { width: 0, height: 6 } },
  android: { elevation: 2 },
  default: { boxShadow: "0 6px 18px rgba(27, 42, 78, 0.06)" } as ViewStyle,
}) as ViewStyle;

export const buttonShadow: ViewStyle = Platform.select<ViewStyle>({
  ios: { shadowColor: colors.primary, shadowOpacity: 0.22, shadowRadius: 14, shadowOffset: { width: 0, height: 8 } },
  android: { elevation: 3 },
  default: { boxShadow: "0 10px 24px rgba(0, 102, 255, 0.22)" } as ViewStyle,
}) as ViewStyle;
