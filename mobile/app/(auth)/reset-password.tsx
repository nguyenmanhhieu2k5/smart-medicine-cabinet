import { router, useLocalSearchParams } from "expo-router";
import { ArrowLeft, Lock, Mail, ShieldCheck } from "lucide-react-native";
import { useEffect, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View, type TextInputInstance } from "react-native";
import { api, ApiError } from "@/api";
import { Screen } from "@/components/layout";
import { Button, CircleButton, ErrorBanner, IconTile, InfoBox, TextField, type as T } from "@/components/ui";
import { colors, font, radius } from "@/theme";
import { maskEmail } from "@/utils/format";

const LENGTH = 6;

/** Nhập mã khôi phục 6 số + mật khẩu mới (bố cục theo thiết kế 04 “Xác minh”). */
export default function ResetPasswordScreen() {
  const { email = "" } = useLocalSearchParams<{ email?: string }>();
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [wait, setWait] = useState(60);
  const inputRef = useRef<TextInputInstance>(null);

  useEffect(() => {
    if (wait <= 0) return;
    const timer = setTimeout(() => setWait((w) => w - 1), 1000);
    return () => clearTimeout(timer);
  }, [wait]);

  const resend = async () => {
    setError(null);
    try {
      await api.forgotPassword(email);
      setWait(60);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Không gửi lại được mã.");
    }
  };

  const submit = async () => {
    if (code.length !== LENGTH) return setError("Hãy nhập đủ 6 chữ số của mã khôi phục.");
    if (password.length < 8) return setError("Mật khẩu mới cần tối thiểu 8 ký tự.");
    setBusy(true);
    setError(null);
    try {
      await api.resetPassword(email, code, password);
      setDone(true);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Không đặt lại được mật khẩu.");
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    return (
      <Screen>
        <View style={{ flex: 1, justifyContent: "center", alignItems: "center", gap: 18 }}>
          <IconTile icon={ShieldCheck} size={96} iconSize={40} tone="success" />
          <Text style={[T.display, { textAlign: "center" }]}>Đã đặt lại mật khẩu</Text>
          <Text style={[T.body, { textAlign: "center" }]}>Các phiên đăng nhập cũ đã bị đăng xuất. Hãy đăng nhập bằng mật khẩu mới.</Text>
          <Button title="Đăng nhập" onPress={() => router.dismissTo("/login")} style={{ alignSelf: "stretch", marginTop: 8 }} />
        </View>
      </Screen>
    );
  }

  return (
    <Screen scroll keyboard>
      <View style={{ paddingTop: 10, flexDirection: "row" }}>
        <CircleButton icon={ArrowLeft} label="Quay lại" tone="outline" onPress={() => router.back()} />
      </View>
      <View style={{ alignItems: "center", marginTop: 8 }}>
        <IconTile icon={Mail} size={96} iconSize={40} />
        <Text style={[T.display, { textAlign: "center", marginTop: 28 }]} accessibilityRole="header">Nhập mã khôi phục</Text>
        <Text style={[T.body, { textAlign: "center", marginTop: 12, fontSize: 16, lineHeight: 24 }]}>Nhập mã gồm 6 chữ số được gửi đến email của bạn.</Text>
        <Text style={[T.small, { marginTop: 12, fontSize: 14 }]}>{maskEmail(email)}</Text>
      </View>

      <Pressable onPress={() => inputRef.current?.focus()} style={styles.boxes} accessibilityLabel="Mã khôi phục">
        {Array.from({ length: LENGTH }, (_, i) => {
          const active = i === Math.min(code.length, LENGTH - 1);
          return (
            <View key={i} style={[styles.box, active && styles.boxActive]}>
              <Text style={styles.digit}>{code[i] ?? ""}</Text>
            </View>
          );
        })}
        <TextInput ref={inputRef} value={code} onChangeText={(v) => setCode(v.replace(/\D/g, "").slice(0, LENGTH))} keyboardType="number-pad"
          textContentType="oneTimeCode" autoComplete="one-time-code" maxLength={LENGTH} autoFocus style={styles.hidden} accessibilityLabel="Nhập mã khôi phục" testID="reset-code" />
      </Pressable>
      <View style={{ flexDirection: "row", justifyContent: "center", marginTop: 18 }}>
        <Text style={T.body}>Chưa nhận được mã? </Text>
        <Pressable disabled={wait > 0} onPress={() => void resend()} accessibilityRole="button" hitSlop={8}>
          <Text style={[T.body, { color: colors.primary, fontFamily: font.bold, opacity: wait > 0 ? 0.6 : 1 }]}>{wait > 0 ? `Gửi lại (${wait}s)` : "Gửi lại"}</Text>
        </Pressable>
      </View>

      <View style={{ marginTop: 24, gap: 20 }}>
        <TextField label="Mật khẩu mới" icon={Lock} value={password} onChangeText={setPassword} placeholder="Tối thiểu 8 ký tự" secure
          autoCapitalize="none" autoComplete="new-password" textContentType="newPassword" />
        <ErrorBanner message={error} />
        <Button title="Đặt lại mật khẩu" onPress={() => void submit()} loading={busy} />
        <InfoBox icon={ShieldCheck} tone="neutral">Mã xác minh có thời hạn 15 phút. Không chia sẻ mã này với người khác.</InfoBox>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  boxes: { flexDirection: "row", justifyContent: "space-between", marginTop: 30, gap: 8 },
  box: {
    flex: 1, aspectRatio: 0.95, maxWidth: 58, borderRadius: radius.control, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface,
    alignItems: "center", justifyContent: "center",
  },
  boxActive: { borderColor: colors.primary, borderWidth: 1.5, backgroundColor: colors.primaryTint },
  digit: { fontFamily: font.bold, fontSize: 22, color: colors.navy },
  hidden: { position: "absolute", opacity: 0, width: 1, height: 1 },
});
