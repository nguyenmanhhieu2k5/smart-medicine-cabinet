import { StyleSheet, Text, View } from "react-native";
import Svg, { Defs, Line, LinearGradient, Rect, Stop, G } from "react-native-svg";
import { colors, font } from "@/theme";

/** Biểu tượng ứng dụng (giống ứng dụng Windows): ô vuông bo góc gradient xanh + viên thuốc trắng. */
export function LogoMark({ size = 48 }: { size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 256 256" accessibilityLabel="Tủ thuốc thông minh">
      <Defs>
        <LinearGradient id="smcLogo" x1="0" y1="0" x2="1" y2="1">
          <Stop offset="0" stopColor="#3D8BFF" />
          <Stop offset="1" stopColor={colors.primary} />
        </LinearGradient>
      </Defs>
      <Rect width="256" height="256" rx="62" fill="url(#smcLogo)" />
      <G transform="rotate(45 128 128)" fill="none" stroke="#fff" strokeWidth={14} strokeLinecap="round">
        <Rect x="96" y="56" width="64" height="144" rx="32" />
        <Line x1="96" y1="128" x2="160" y2="128" />
      </G>
    </Svg>
  );
}

/** Viên thuốc viền xanh (đầu màn hình Quét / Lịch sử). */
export function PillOutline({ size = 30 }: { size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 32 32">
      <G transform="rotate(-45 16 16)" fill="none" stroke={colors.primary} strokeWidth={2.6} strokeLinecap="round">
        <Rect x="4" y="11" width="24" height="10" rx="5" />
        <Line x1="16" y1="11" x2="16" y2="21" />
      </G>
    </Svg>
  );
}

/** Dòng thương hiệu ở màn hình Đăng nhập/Đăng ký (thiết kế 01, 02). */
export function BrandRow() {
  return (
    <View style={styles.row}>
      <View style={styles.shadow}><LogoMark size={44} /></View>
      <View>
        <Text style={styles.title}>Tủ thuốc thông minh</Text>
        <Text style={styles.subtitle}>SMART MEDICINE CABINET</Text>
      </View>
    </View>
  );
}

/** Đầu màn hình chính: viên thuốc + “Smart Medicine Cabinet” (thiết kế 05, 09). */
export function AppHeaderBrand() {
  return (
    <View style={[styles.row, { gap: 10 }]}>
      <PillOutline size={30} />
      <Text style={styles.appName}>Smart Medicine Cabinet</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: 14 },
  shadow: { borderRadius: 12, shadowColor: colors.primary, shadowOpacity: 0.25, shadowRadius: 10, shadowOffset: { width: 0, height: 6 }, elevation: 3 },
  title: { fontFamily: font.semibold, fontSize: 16, color: colors.navy },
  subtitle: { fontFamily: font.regular, fontSize: 12.5, letterSpacing: 0.6, color: colors.muted, marginTop: 2 },
  appName: { fontFamily: font.medium, fontSize: 16, color: colors.navy },
});
