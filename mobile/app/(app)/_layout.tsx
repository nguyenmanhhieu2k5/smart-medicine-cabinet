import { Stack } from "expo-router";
import { colors } from "@/theme";

/** Khu vực đã đăng nhập (quyền SCANNER). Chi tiết thuốc nằm ngoài thanh tab (thiết kế 08). */
export default function SignedInLayout() {
  return (
    <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.bg }, animation: "slide_from_right" }}>
      <Stack.Screen name="(tabs)" />
      <Stack.Screen name="medicine/[id]" />
      <Stack.Screen name="ai-lookup" />
    </Stack>
  );
}
