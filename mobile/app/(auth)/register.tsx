import { router } from "expo-router";
import { ArrowLeft, Lock, Mail, ShieldCheck } from "lucide-react-native";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { ApiError } from "@/api";
import { useAuth } from "@/auth/AuthProvider";
import { BrandRow } from "@/components/brand";
import { Screen } from "@/components/layout";
import { Button, CircleButton, ErrorBanner, InfoBox, TextField, type as T } from "@/components/ui";
import { colors, font } from "@/theme";

/** Đăng ký (thiết kế 02). Tài khoản mới luôn là SCANNER — máy chủ quyết định, ứng dụng không gửi vai trò. */
export default function RegisterScreen() {
  const { register, config } = useAuth();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const emailValid = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim());
  const passwordHint = password && (password.length < 8 || !/\d/.test(password) || !/[A-Za-zÀ-ỹ]/.test(password))
    ? "Mật khẩu cần tối thiểu 8 ký tự, gồm cả chữ và số." : null;

  const submit = async () => {
    if (!name.trim()) return setError("Hãy nhập họ và tên.");
    if (!emailValid) return setError("Email không hợp lệ.");
    if (!password || passwordHint) return setError("Mật khẩu cần tối thiểu 8 ký tự, gồm cả chữ và số.");
    setBusy(true);
    setError(null);
    try {
      await register(name, email, password);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Không tạo được tài khoản. Vui lòng thử lại.");
    } finally {
      setBusy(false);
    }
  };

  if (config && !config.registration_enabled) {
    return (
      <Screen>
        <View style={{ paddingTop: 10 }}><CircleButton icon={ArrowLeft} label="Quay lại" tone="outline" onPress={() => router.back()} /></View>
        <View style={{ flex: 1, justifyContent: "center" }}>
          <InfoBox icon={ShieldCheck} title="Đăng ký đang tắt">Quản trị viên tạo tài khoản cho bạn trên ứng dụng Windows. Vui lòng liên hệ quản trị viên.</InfoBox>
        </View>
      </Screen>
    );
  }

  return (
    <Screen scroll keyboard testID="register-screen">
      <View style={{ paddingTop: 10 }}>
        <CircleButton icon={ArrowLeft} label="Quay lại" tone="outline" onPress={() => router.back()} />
        <View style={{ marginTop: 22 }}><BrandRow /></View>
        <Text style={[T.display, { marginTop: 22 }]} accessibilityRole="header">Tạo tài khoản</Text>
        <Text style={[T.body, { marginTop: 8, fontSize: 16 }]}>Đăng ký để bắt đầu quét và tra cứu thuốc.</Text>
      </View>
      <View style={{ marginTop: 26, gap: 18 }}>
        <TextField label="Họ và tên" value={name} onChangeText={setName} placeholder="Tên của bạn" autoComplete="name" textContentType="name" maxLength={120} />
        <TextField label="Email" icon={Mail} value={email} onChangeText={setEmail} placeholder="tenban@gmail.com" autoCapitalize="none"
          autoCorrect={false} keyboardType="email-address" autoComplete="email" textContentType="emailAddress" />
        <TextField label="Mật khẩu" icon={Lock} value={password} onChangeText={setPassword} placeholder="Tối thiểu 8 ký tự" secure
          autoCapitalize="none" autoComplete="new-password" textContentType="newPassword" error={passwordHint} />
        <ErrorBanner message={error} />
        <Button title="Tạo tài khoản" onPress={() => void submit()} loading={busy} />
      </View>
      <View style={{ flexDirection: "row", justifyContent: "center", marginTop: 22 }}>
        <Text style={T.body}>Đã có tài khoản? </Text>
        <Pressable onPress={() => router.back()} accessibilityRole="link" hitSlop={8}>
          <Text style={[T.body, { color: colors.primary, fontFamily: font.bold }]}>Đăng nhập</Text>
        </Pressable>
      </View>
      <View style={{ flex: 1, minHeight: 28 }} />
      <InfoBox icon={ShieldCheck}>
        Tài khoản mới mặc định có quyền <Text style={{ fontFamily: font.bold, color: colors.navy }}>Scanner</Text>. Chỉ quản trị viên Windows mới quản lý thuốc.
      </InfoBox>
    </Screen>
  );
}
