import { CalendarDays, Lock, Mail, Phone, ShieldCheck, UserRound } from "lucide-react-native";
import { useState } from "react";
import { Text, View } from "react-native";
import { api, ApiError } from "@/api";
import { useAuth } from "@/auth/AuthProvider";
import { Screen, ScreenHeader } from "@/components/layout";
import { Button, ErrorBanner, InfoBox, TextField, type as T } from "@/components/ui";
import { colors } from "@/theme";
import { formatDate } from "@/utils/format";

/** Thông tin tài khoản (thiết kế tổng quan 13, màn 11). Email và vai trò không sửa được trên điện thoại. */
export default function AccountScreen() {
  const { user, setUser } = useAuth();
  const [name, setName] = useState(user?.full_name ?? "");
  const [phone, setPhone] = useState(user?.phone ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const dirty = name.trim() !== (user?.full_name ?? "") || phone.trim() !== (user?.phone ?? "");

  const save = async () => {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      setUser(await api.updateMe({ full_name: name.trim(), phone: phone.trim() || null }));
      setSaved(true);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Không lưu được thông tin.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen scroll keyboard>
      <ScreenHeader title="Thông tin tài khoản" />
      <View style={{ gap: 18, marginTop: 6 }}>
        <TextField label="Họ và tên" icon={UserRound} value={name} onChangeText={setName} maxLength={120} autoComplete="name" />
        <TextField label="Email" icon={Mail} value={user?.email ?? ""} editable={false} right={<Lock size={18} color={colors.muted} />} />
        <TextField label="Số điện thoại" icon={Phone} value={phone} onChangeText={setPhone} keyboardType="phone-pad" maxLength={32} placeholder="Chưa có" />
        <TextField label="Vai trò" icon={ShieldCheck} value="Người dùng (Scanner) · chỉ đọc" editable={false} right={<Lock size={18} color={colors.muted} />} />
        {user?.created_at ? <TextField label="Ngày tạo tài khoản" icon={CalendarDays} value={formatDate(user.created_at)} editable={false} /> : null}
        <ErrorBanner message={error} />
        {saved ? <Text style={[T.small, { color: colors.success }]}>Đã lưu thông tin tài khoản.</Text> : null}
        <Button title="Lưu thay đổi" onPress={() => void save()} loading={busy} disabled={!dirty || !name.trim()} />
        {user?.account_role === "ADMIN" ? (
          <InfoBox icon={ShieldCheck}>Đây là tài khoản quản trị, nhưng trên điện thoại chỉ có quyền Scanner. Quản lý thuốc và thiết bị trên ứng dụng Windows.</InfoBox>
        ) : null}
      </View>
    </Screen>
  );
}
