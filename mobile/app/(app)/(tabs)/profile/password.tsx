import { router } from "expo-router";
import { KeyRound, Lock, ShieldCheck } from "lucide-react-native";
import { useState } from "react";
import { Text, View } from "react-native";
import { api, ApiError } from "@/api";
import { Screen, ScreenHeader } from "@/components/layout";
import { Button, ErrorBanner, InfoBox, TextField, type as T } from "@/components/ui";
import { colors } from "@/theme";

export default function ChangePasswordScreen() {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const mismatch = confirm.length > 0 && next !== confirm ? "Mật khẩu nhập lại không khớp." : null;

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.changePassword(current, next);
      setDone(true);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Không đổi được mật khẩu.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen scroll keyboard>
      <ScreenHeader title="Đổi mật khẩu" />
      {done ? (
        <View style={{ gap: 16, marginTop: 12 }}>
          <InfoBox icon={ShieldCheck} title="Đã đổi mật khẩu">Các thiết bị khác đang đăng nhập tài khoản này đã bị đăng xuất.</InfoBox>
          <Button title="Xong" onPress={() => router.back()} />
        </View>
      ) : (
        <View style={{ gap: 18, marginTop: 6 }}>
          <TextField label="Mật khẩu hiện tại" icon={Lock} value={current} onChangeText={setCurrent} secure autoCapitalize="none" autoComplete="current-password" />
          <TextField label="Mật khẩu mới" icon={KeyRound} value={next} onChangeText={setNext} secure autoCapitalize="none" autoComplete="new-password" placeholder="Tối thiểu 8 ký tự, có chữ và số" />
          <TextField label="Nhập lại mật khẩu mới" icon={KeyRound} value={confirm} onChangeText={setConfirm} secure autoCapitalize="none" autoComplete="new-password" error={mismatch} />
          <ErrorBanner message={error} />
          <Button title="Đổi mật khẩu" onPress={() => void submit()} loading={busy} disabled={!current || next.length < 8 || next !== confirm} />
          <Text style={[T.small, { color: colors.muted }]}>Sau khi đổi, phiên trên điện thoại này vẫn giữ; các phiên khác bị đăng xuất.</Text>
        </View>
      )}
    </Screen>
  );
}
