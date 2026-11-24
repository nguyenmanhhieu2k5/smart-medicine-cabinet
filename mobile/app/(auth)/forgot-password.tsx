import { router } from "expo-router";
import { ArrowLeft, Info, Mail } from "lucide-react-native";
import { useState } from "react";
import { Text, View } from "react-native";
import { api, ApiError } from "@/api";
import { useAuth } from "@/auth/AuthProvider";
import { Screen } from "@/components/layout";
import { Button, CircleButton, ErrorBanner, IconTile, InfoBox, LinkButton, TextField, type as T } from "@/components/ui";

/** Quên mật khẩu (thiết kế 03). Máy chủ gửi MÃ 6 số qua email (nếu đã cấu hình SMTP), rồi nhập mã ở màn sau. */
export default function ForgotPasswordScreen() {
  const { config, lastEmail } = useAuth();
  const [email, setEmail] = useState(lastEmail);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const emailValid = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim());
  const available = config?.password_reset_enabled !== false;

  const submit = async () => {
    if (!emailValid) return setError("Email không hợp lệ.");
    setBusy(true);
    setError(null);
    try {
      await api.forgotPassword(email);
      router.push({ pathname: "/reset-password", params: { email: email.trim() } });
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Không gửi được yêu cầu. Vui lòng thử lại.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen scroll keyboard>
      <View style={{ paddingTop: 10, flexDirection: "row" }}>
        <CircleButton icon={ArrowLeft} label="Quay lại" tone="outline" onPress={() => router.back()} />
      </View>
      <View style={{ alignItems: "center", marginTop: 8 }}>
        <IconTile icon={Mail} size={96} iconSize={40} />
        <Text style={[T.display, { textAlign: "center", marginTop: 28 }]} accessibilityRole="header">Quên mật khẩu?</Text>
        <Text style={[T.body, { textAlign: "center", marginTop: 12, fontSize: 16, lineHeight: 24 }]}>
          Nhập email của bạn. Chúng tôi sẽ gửi mã khôi phục mật khẩu nếu tài khoản tồn tại.
        </Text>
      </View>
      {available ? (
        <View style={{ marginTop: 34, gap: 20 }}>
          <TextField label="Địa chỉ email" icon={Mail} value={email} onChangeText={setEmail} placeholder="tenban@gmail.com"
            autoCapitalize="none" autoCorrect={false} keyboardType="email-address" autoComplete="email" />
          <ErrorBanner message={error} />
          <Button title="Gửi mã khôi phục" onPress={() => void submit()} loading={busy} />
          <LinkButton title="Quay lại đăng nhập" icon={ArrowLeft} onPress={() => router.back()} style={{ alignSelf: "center" }} />
          <InfoBox icon={Info} tone="neutral">Vui lòng kiểm tra cả thư mục Spam nếu không thấy email trong hộp thư đến.</InfoBox>
        </View>
      ) : (
        <View style={{ marginTop: 34, gap: 20 }}>
          <InfoBox icon={Info} title="Máy chủ chưa bật gửi email">
            Quản trị viên có thể đặt lại mật khẩu cho bạn trên ứng dụng Windows (Quản trị → Tài khoản).
          </InfoBox>
          <LinkButton title="Quay lại đăng nhập" icon={ArrowLeft} onPress={() => router.back()} style={{ alignSelf: "center" }} />
        </View>
      )}
    </Screen>
  );
}
