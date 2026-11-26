import {
  Inter_400Regular, Inter_500Medium, Inter_600SemiBold, Inter_700Bold, Inter_800ExtraBold, useFonts,
} from "@expo-google-fonts/inter";
import { Stack } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { StatusBar } from "expo-status-bar";
import { useEffect, useState } from "react";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { AuthProvider, useAuth } from "@/auth/AuthProvider";
import { ConnectionErrorView } from "@/components/states";
import { SplashView } from "@/screens/SplashView";
import { ServerScreen } from "@/screens/ServerScreen";
import { colors, gutter } from "@/theme";
import { useWindowDimensions } from "react-native";
import { setupWeb } from "@/web/setup";

void SplashScreen.preventAutoHideAsync().catch(() => undefined);
setupWeb(); // chỉ trang web: bộ đọc mã vạch tải .wasm từ chính máy chủ, camera không lật ảnh xem trước

export default function RootLayout() {
  const [fontsLoaded, fontError] = useFonts({ Inter_400Regular, Inter_500Medium, Inter_600SemiBold, Inter_700Bold, Inter_800ExtraBold });
  const ready = fontsLoaded || Boolean(fontError);
  useEffect(() => {
    if (ready) void SplashScreen.hideAsync().catch(() => undefined);
  }, [ready]);
  if (!ready) return null;
  return (
    <SafeAreaProvider>
      <AuthProvider>
        <StatusBar style="dark" />
        <RootNavigator />
      </AuthProvider>
    </SafeAreaProvider>
  );
}

function OfflineView() {
  const { error, retry } = useAuth();
  const { width } = useWindowDimensions();
  const [editServer, setEditServer] = useState(false);
  const [retrying, setRetrying] = useState(false);
  if (editServer) return <ServerScreen onDone={() => { setEditServer(false); void retry(); }} onBack={() => setEditServer(false)} />;
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg, paddingHorizontal: gutter(width) }}>
      <ConnectionErrorView
        message={error?.message}
        retrying={retrying}
        onRetry={() => { setRetrying(true); void retry().finally(() => setRetrying(false)); }}
        onServer={() => setEditServer(true)}
      />
    </SafeAreaView>
  );
}

function RootNavigator() {
  const { status } = useAuth();
  if (status === "loading") return <SplashView />;
  if (status === "offline") return <OfflineView />;
  const signedIn = status === "signedIn";
  // Trang web: khách chưa đăng nhập vẫn vào được màn hình Quét (máy chủ đếm lượt quét thử), và mở được Đăng nhập/Đăng ký.
  const inApp = signedIn || status === "guest";
  return (
    <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.bg }, animation: "slide_from_right" }}>
      <Stack.Screen name="index" />
      <Stack.Protected guard={inApp}>
        <Stack.Screen name="(app)" />
      </Stack.Protected>
      <Stack.Protected guard={!signedIn}>
        <Stack.Screen name="(auth)" />
      </Stack.Protected>
      <Stack.Screen name="server" />
    </Stack>
  );
}
