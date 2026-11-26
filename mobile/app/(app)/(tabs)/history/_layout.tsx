import { Redirect, Stack } from "expo-router";
import { useAuth } from "@/auth/AuthProvider";
import { colors } from "@/theme";

export default function HistoryStack() {
  // Trang web, khách chưa đăng nhập: lịch sử quét cần tài khoản.
  if (useAuth().status === "guest") return <Redirect href="/login" />;
  return <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.bg }, animation: "slide_from_right" }} />;
}
