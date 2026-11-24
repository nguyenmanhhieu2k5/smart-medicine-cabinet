import { router } from "expo-router";
import { Lock, Mail, Server, ShieldCheck } from "lucide-react-native";
import { useRef, useState } from "react";
import { Pressable, Text, View, type TextInputInstance } from "react-native";
import { ApiError } from "@/api";
import { useAuth } from "@/auth/AuthProvider";
import { BrandRow } from "@/components/brand";
import { Screen } from "@/components/layout";
import { Button, ErrorBanner, InfoBox, LinkButton, TextField, type as T } from "@/components/ui";
import { colors, font } from "@/theme";

/**
 * Đăng nhập (thiết kế 01). Đăng nhập Google/Apple/số điện thoại chỉ hiện khi máy chủ bật và hỗ trợ
 * (/api/v1/app/config → providers) — hiện máy chủ chưa hỗ trợ nên không hiển thị nút giả.
 */
export default function LoginScreen() {
  const { login, config, serverUrl, lastEmail, notice, clearNotice } = useAuth();
  const [email, setEmail] = useState(lastEmail);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Chỉ khi không tới được máy chủ mới hiện lối đổi địa chỉ (bình thường app tự dùng địa chỉ gài sẵn).
  const [offline, setOffline] = useState(false);
  const passwordRef = useRef<TextInputInstance>(null);
  const emailValid = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim());

  const submit = async () => {
    if (!serverUrl) {
      router.push("/server");
      return;
    }
    if (!emailValid) return setError("Email không hợp lệ.");
    if (!password) return setError("Hãy nhập mật khẩu.");
    setBusy(true);
    setError(null);
    setOffline(false);
    clearNotice();
    try {
      await login(email, password);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Đăng nhập thất bại. Vui lòng thử lại.");
      setOffline(e instanceof ApiError && (e.kind === "network" || e.kind === "timeout"));
      setPassword("");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen scroll keyboard testID="login-screen">
      <View style={{ paddingTop: 36 }}>
        <BrandRow />
        <Text style={[T.display, { marginTop: 36 }]} accessibilityRole="header">Chào mừng trở lại</Text>
        <Text style={[T.body, { marginTop: 8, fontSize: 16 }]}>Đăng nhập để nhận diện và tra cứu thuốc.</Text>
      </View>

      {!serverUrl ? (
        <Pressable onPress={() => router.push("/server")} style={{ marginTop: 24 }} accessibilityRole="button">
          <InfoBox icon={Server} title="Chưa cấu hình máy chủ">Nhấn để nhập địa chỉ máy chủ Mini PC do quản trị viên cung cấp.</InfoBox>
        </Pressable>
      ) : null}

      <View style={{ marginTop: 28, gap: 20 }}>
        <TextField label="Email" icon={Mail} value={email} onChangeText={setEmail} placeholder="tenban@gmail.com" autoCapitalize="none"
          autoCorrect={false} keyboardType="email-address" autoComplete="email" textContentType="username" returnKeyType="next"
          onSubmitEditing={() => passwordRef.current?.focus()} testID="login-email" />
        <View style={{ gap: 12 }}>
          <TextField ref={passwordRef} label="Mật khẩu" icon={Lock} value={password} onChangeText={setPassword} placeholder="Nhập mật khẩu"
            secure autoCapitalize="none" autoComplete="current-password" textContentType="password" returnKeyType="go"
            onSubmitEditing={() => void submit()} testID="login-password" />
          <LinkButton title="Quên mật khẩu?" onPress={() => router.push("/forgot-password")} style={{ alignSelf: "flex-end" }} />
        </View>
        <ErrorBanner message={error ?? notice} />
        {offline ? (
          <LinkButton title="Kiểm tra địa chỉ máy chủ" icon={Server} onPress={() => router.push("/server")} style={{ alignSelf: "center" }} />
        ) : null}
        <Button title="Đăng nhập" onPress={() => void submit()} loading={busy} testID="login-submit" />
      </View>

      {config?.registration_enabled !== false ? (
        <View style={{ flexDirection: "row", justifyContent: "center", marginTop: 24 }}>
          <Text style={T.body}>Chưa có tài khoản? </Text>
          <Pressable onPress={() => router.push("/register")} accessibilityRole="link" hitSlop={8}>
            <Text style={[T.body, { color: colors.primary, fontFamily: font.bold }]}>Đăng ký</Text>
          </Pressable>
        </View>
      ) : null}

      <View style={{ flex: 1, minHeight: 28 }} />
      <InfoBox icon={ShieldCheck}>
        <Text style={{ fontFamily: font.bold, color: colors.navy }}>Tài khoản Scanner</Text> · Chỉ quét OCR và tra cứu, không thể thêm thuốc vào tủ.
      </InfoBox>
    </Screen>
  );
}
