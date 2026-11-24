import { useEffect, useState } from "react";
import { Animated, Easing, StyleSheet, Text, View } from "react-native";
import Svg, { ClipPath, Defs, G, Rect } from "react-native-svg";
import { colors, font } from "@/theme";

/** Màn hình khởi động (thiết kế tổng quan 14, màn 1): hiện trong lúc khôi phục phiên đăng nhập. */
export function SplashView() {
  const [progress] = useState(() => new Animated.Value(0));
  useEffect(() => {
    const loop = Animated.loop(Animated.timing(progress, { toValue: 1, duration: 1400, easing: Easing.inOut(Easing.ease), useNativeDriver: false }));
    loop.start();
    return () => loop.stop();
  }, [progress]);
  const left = progress.interpolate({ inputRange: [0, 1], outputRange: ["-35%", "100%"] });
  return (
    <View style={styles.wrap} accessibilityLabel="Đang khởi động" testID="splash">
      <View style={styles.circle}>
        <Svg width={150} height={150} viewBox="0 0 120 120">
          <Defs>
            <ClipPath id="cap"><Rect x="34" y="12" width="52" height="96" rx="26" /></ClipPath>
          </Defs>
          <G transform="rotate(42 60 60)">
            <G clipPath="url(#cap)">
              <Rect x="34" y="12" width="52" height="48" fill={colors.primary} />
              <Rect x="34" y="60" width="52" height="48" fill="#FFFFFF" />
            </G>
            <Rect x="34" y="12" width="52" height="96" rx="26" fill="none" stroke={colors.primary} strokeWidth={5} />
          </G>
        </Svg>
      </View>
      <Text style={styles.title}>Smart{"\n"}Medicine Cabinet</Text>
      <Text style={styles.subtitle}>Ứng dụng tra cứu và nhận diện thuốc bằng OCR</Text>
      <View style={styles.track}>
        <Animated.View style={[styles.bar, { left }]} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: colors.bg, alignItems: "center", justifyContent: "center", paddingHorizontal: 32 },
  circle: { width: 220, height: 220, borderRadius: 110, backgroundColor: colors.primarySoft, alignItems: "center", justifyContent: "center", marginBottom: 36 },
  title: { fontFamily: font.extrabold, fontSize: 30, lineHeight: 36, color: colors.navy, textAlign: "center", letterSpacing: -0.6 },
  subtitle: { fontFamily: font.regular, fontSize: 15, lineHeight: 22, color: colors.muted, textAlign: "center", marginTop: 14 },
  track: { position: "absolute", bottom: 72, width: 96, height: 4, borderRadius: 2, backgroundColor: colors.border, overflow: "hidden" },
  bar: { position: "absolute", top: 0, bottom: 0, width: "40%", borderRadius: 2, backgroundColor: colors.primary },
});
