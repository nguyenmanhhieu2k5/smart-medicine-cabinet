import { router } from "expo-router";
import { ArrowLeft } from "lucide-react-native";
import type { ReactNode } from "react";
import {
  KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, View, useWindowDimensions, type RefreshControlProps,
  type StyleProp, type ViewStyle,
} from "react-native";
import { SafeAreaView, type Edge } from "react-native-safe-area-context";
import Svg, { Defs, LinearGradient, Rect, Stop } from "react-native-svg";
import { colors, gutter } from "@/theme";
import { CircleButton, type as T } from "./ui";

/** (1) Nền trang chuyển sắc #F0F7FF → #E2EEFF, giống ứng dụng Windows. */
function PageBackground() {
  return (
    <Svg style={StyleSheet.absoluteFill} width="100%" height="100%" pointerEvents="none" preserveAspectRatio="none">
      <Defs>
        <LinearGradient id="smcPageBg" x1="0" y1="0" x2="0" y2="1">
          <Stop offset="0" stopColor={colors.bg} />
          <Stop offset="1" stopColor={colors.bgEnd} />
        </LinearGradient>
      </Defs>
      <Rect x="0" y="0" width="100%" height="100%" fill="url(#smcPageBg)" />
    </Svg>
  );
}

interface ScreenProps {
  children: ReactNode;
  scroll?: boolean;
  keyboard?: boolean;
  edges?: Edge[];
  style?: StyleProp<ViewStyle>;
  contentStyle?: StyleProp<ViewStyle>;
  refreshControl?: React.ReactElement<RefreshControlProps>;
  testID?: string;
}

/** Khung màn hình: nền chuyển sắc #F0F7FF → #E2EEFF, lề hai bên theo bề rộng máy, tránh tai thỏ/thanh điều hướng. */
export function Screen({ children, scroll = false, keyboard = false, edges = ["top"], style, contentStyle, refreshControl, testID }: ScreenProps) {
  const { width } = useWindowDimensions();
  const padding = { paddingHorizontal: gutter(width) };
  const body = scroll ? (
    <ScrollView
      keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false} refreshControl={refreshControl}
      contentContainerStyle={[padding, { paddingBottom: 28, flexGrow: 1 }, contentStyle]}
    >
      {children}
    </ScrollView>
  ) : (
    <View style={[padding, { flex: 1 }, contentStyle]}>{children}</View>
  );
  return (
    <SafeAreaView edges={edges} style={[styles.screen, style]} testID={testID}>
      <PageBackground />
      {keyboard ? <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>{body}</KeyboardAvoidingView> : body}
    </SafeAreaView>
  );
}

/** Đầu màn hình con: nút quay lại tròn + tiêu đề giữa (thiết kế 06, 07, 08). */
export function ScreenHeader({ title, onBack, right, tone = "soft" }: { title: string; onBack?: () => void; right?: ReactNode; tone?: "soft" | "outline" }) {
  const back = onBack ?? (() => (router.canGoBack() ? router.back() : router.replace("/scan")));
  return (
    <View style={styles.header}>
      <CircleButton icon={ArrowLeft} label="Quay lại" onPress={back} tone={tone} size={46} />
      <Text style={[T.screenTitle, styles.headerTitle]} numberOfLines={1} accessibilityRole="header">{title}</Text>
      <View style={{ width: 46, alignItems: "flex-end" }}>{right}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  header: { flexDirection: "row", alignItems: "center", paddingTop: 8, paddingBottom: 16, gap: 8 },
  headerTitle: { flex: 1, textAlign: "center" },
});
