import { router, useFocusEffect } from "expo-router";
import { CalendarClock, ChevronRight, Info, KeyRound, LogOut, Settings, ShieldCheck, UserRound, type LucideIcon } from "lucide-react-native";
import { useCallback, useState } from "react";
import { Alert, Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { api } from "@/api";
import { useAuth } from "@/auth/AuthProvider";
import { Screen } from "@/components/layout";
import { Card, Chip, type as T } from "@/components/ui";
import { colors, font } from "@/theme";
import { initials } from "@/utils/format";

function MenuRow({ icon: Icon, label, onPress, danger, last, badge }: {
  icon: LucideIcon; label: string; onPress: () => void; danger?: boolean; last?: boolean; badge?: number;
}) {
  const color = danger ? colors.danger : colors.navy;
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={label}
      style={({ pressed }) => [styles.menuRow, !last && styles.menuBorder, pressed && { backgroundColor: "#F6F8FB" }]}>
      <Icon size={22} color={color} strokeWidth={1.9} />
      <Text style={[T.bodyNavy, { flex: 1, fontSize: 16, color }, danger && { fontFamily: font.semibold }]}>{label}</Text>
      {badge ? (
        <View style={styles.badge} accessibilityLabel={`${badge} thuốc hết hạn hoặc sắp hết hạn`}>
          <Text style={styles.badgeText}>{badge > 99 ? "99+" : badge}</Text>
        </View>
      ) : null}
      {!danger ? <ChevronRight size={20} color="#7A8499" strokeWidth={2} /> : null}
    </Pressable>
  );
}

/** Hồ sơ (thiết kế tổng quan 14): tài khoản Scanner — quét, lịch sử, sửa ngày hết hạn thuốc trong tủ. */
export default function ProfileScreen() {
  const { user, logout, reloadUser } = useAuth();
  const [busy, setBusy] = useState(false);
  const [attention, setAttention] = useState(0);
  useFocusEffect(useCallback(() => {
    void reloadUser().catch(() => undefined);
    // Số thuốc đã/sắp hết hạn → nhắc ngay trên menu.
    void api.cabinet().then((c) => setAttention(c.counts.expired + c.counts.expiring)).catch(() => undefined);
  }, [reloadUser]));
  const name = user?.full_name?.trim() || "Scanner";

  const confirmLogout = () => {
    const run = () => {
      setBusy(true);
      void logout().finally(() => setBusy(false));
    };
    if (Platform.OS === "web") {
      run();
      return;
    }
    Alert.alert("Đăng xuất?", "Bạn sẽ cần đăng nhập lại để quét thuốc.", [
      { text: "Hủy", style: "cancel" },
      { text: "Đăng xuất", style: "destructive", onPress: run },
    ]);
  };

  return (
    <Screen scroll testID="profile-screen">
      <Text style={[T.screenTitle, { textAlign: "center", paddingTop: 18, paddingBottom: 8 }]} accessibilityRole="header">Hồ sơ</Text>
      <View style={{ alignItems: "center", marginTop: 10 }}>
        <View style={styles.avatar}><Text style={styles.avatarText}>{initials(name)}</Text></View>
        <Text style={[T.display, { fontSize: 26, marginTop: 14, textAlign: "center" }]} numberOfLines={2}>{name}</Text>
        <Text style={[T.body, { marginTop: 4 }]}>{user?.email}</Text>
        <View style={{ marginTop: 10 }}><Chip label="Tài khoản Scanner" icon={ShieldCheck} /></View>
        {typeof user?.scan_count === "number" ? <Text style={[T.small, { marginTop: 10 }]}>{user.scan_count} lượt quét</Text> : null}
      </View>
      <Card padded={false} style={{ marginTop: 26, overflow: "hidden" }}>
        <MenuRow icon={CalendarClock} label="Hạn dùng thuốc trong tủ" onPress={() => router.push("/profile/expiry")} badge={attention} />
        <MenuRow icon={UserRound} label="Thông tin tài khoản" onPress={() => router.push("/profile/account")} />
        <MenuRow icon={KeyRound} label="Đổi mật khẩu" onPress={() => router.push("/profile/password")} />
        <MenuRow icon={Settings} label="Cài đặt ứng dụng" onPress={() => router.push("/profile/settings")} />
        <MenuRow icon={Info} label="Giới thiệu ứng dụng" onPress={() => router.push("/profile/about")} last />
      </Card>
      <Card padded={false} style={{ marginTop: 16, overflow: "hidden", opacity: busy ? 0.6 : 1 }}>
        <MenuRow icon={LogOut} label={busy ? "Đang đăng xuất…" : "Đăng xuất"} onPress={confirmLogout} danger last />
      </Card>
    </Screen>
  );
}

const styles = StyleSheet.create({
  avatar: { width: 96, height: 96, borderRadius: 48, backgroundColor: colors.primarySoft, alignItems: "center", justifyContent: "center", borderWidth: 3, borderColor: "#fff" },
  avatarText: { fontFamily: font.bold, fontSize: 32, color: colors.primary },
  menuRow: { flexDirection: "row", alignItems: "center", gap: 14, paddingHorizontal: 18, paddingVertical: 17 },
  menuBorder: { borderBottomWidth: 1, borderBottomColor: colors.border },
  badge: { minWidth: 24, height: 24, borderRadius: 12, paddingHorizontal: 7, backgroundColor: colors.danger, alignItems: "center", justifyContent: "center" },
  badgeText: { fontFamily: font.bold, fontSize: 12.5, color: "#FFFFFF" },
});
