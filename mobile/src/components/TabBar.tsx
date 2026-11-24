import { router, type Href } from "expo-router";
import type { BottomTabBarProps } from "expo-router/js-tabs";
import { Clock, ScanLine, User, type LucideIcon } from "lucide-react-native";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { colors, font } from "@/theme";
import { useTabBarHidden } from "./tabBarVisibility";

const ITEMS: Record<string, { label: string; icon: LucideIcon }> = {
  scan: { label: "QUÉT", icon: ScanLine },
  history: { label: "LỊCH SỬ", icon: Clock },
  profile: { label: "HỒ SƠ", icon: User },
};

/** Thanh điều hướng dưới: QUÉT — LỊCH SỬ — HỒ SƠ, mục đang chọn màu xanh + gạch chân (thiết kế 05, 09). */
export function TabBar({ state, emitter, navigateToTab }: BottomTabBarProps) {
  const insets = useSafeAreaInsets();
  const hidden = useTabBarHidden();
  if (hidden) return null;
  return (
    <View style={[styles.bar, { paddingBottom: Math.max(insets.bottom, 10) }]} accessibilityRole="tablist">
      {state.routes.map((route, index) => {
        const item = ITEMS[route.name];
        if (!item) return null;
        const focused = state.index === index;
        const color = focused ? colors.primary : "#7A8499";
        const onPress = () => {
          const event = emitter.emit({ type: "tabPress", target: route.key, canPreventDefault: true });
          if (event.defaultPrevented) return;
          if (!focused) navigateToTab(route.key);
          else router.navigate(`/${route.name}` as Href); // bấm lại tab đang mở → về màn hình gốc của tab
        };
        return (
          <Pressable key={route.key} onPress={onPress} accessibilityRole="tab" accessibilityState={{ selected: focused }} accessibilityLabel={item.label}
            style={styles.item} testID={`tab-${route.name}`}>
            <item.icon size={26} color={color} strokeWidth={focused ? 2.3 : 1.8} />
            <Text style={[styles.label, { color }, focused && { fontFamily: font.bold }]}>{item.label}</Text>
            <View style={[styles.underline, focused && { backgroundColor: colors.primary }]} />
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: "row", backgroundColor: colors.surface, borderTopWidth: 1, borderTopColor: colors.border, paddingTop: 10,
  },
  item: { flex: 1, alignItems: "center", gap: 4 },
  label: { fontFamily: font.semibold, fontSize: 13, letterSpacing: 0.4 },
  underline: { marginTop: 2, width: 52, height: 3, borderRadius: 2, backgroundColor: "transparent" },
});
