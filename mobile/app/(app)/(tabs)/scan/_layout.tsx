import { Stack } from "expo-router";
import { colors } from "@/theme";

export default function ScanStack() {
  return (
    <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.bg }, animation: "slide_from_right" }}>
      <Stack.Screen name="index" />
      <Stack.Screen name="processing/[jobId]" options={{ gestureEnabled: false, animation: "fade" }} />
      <Stack.Screen name="result/[jobId]" />
    </Stack>
  );
}
