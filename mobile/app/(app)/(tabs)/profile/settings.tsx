import { Image } from "expo-image";
import { router } from "expo-router";
import { ChevronRight, HardDrive, ImageIcon, Server, Vibrate } from "lucide-react-native";
import { useState } from "react";
import { Platform, Pressable, StyleSheet, Switch, Text, View } from "react-native";
import { api, ApiError, type UserPreferences } from "@/api";
import { displayHost } from "@/api/server";
import { useAuth } from "@/auth/AuthProvider";
import { Screen, ScreenHeader } from "@/components/layout";
import { Card, ErrorBanner, type as T } from "@/components/ui";
import { colors, font } from "@/theme";

/** Cài đặt ứng dụng (thiết kế tổng quan 13, màn 12). Lưu trên máy chủ theo tài khoản (preferences). */
export default function SettingsScreen() {
  const { user, setUser, serverUrl } = useAuth();
  const prefs = user?.preferences ?? {};
  const [error, setError] = useState<string | null>(null);
  const [cleared, setCleared] = useState(false);

  const update = async (patch: UserPreferences) => {
    setError(null);
    try {
      setUser(await api.updateMe({ preferences: patch }));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Không lưu được cài đặt.");
    }
  };
  const quality = prefs.image_quality === "high" ? "high" : "standard";

  return (
    <Screen scroll>
      <ScreenHeader title="Cài đặt" />
      <ErrorBanner message={error} />
      <Card padded={false} style={{ overflow: "hidden", marginTop: error ? 12 : 0 }}>
        <View style={[styles.row, styles.border]}>
          <Vibrate size={22} color={colors.navy} strokeWidth={1.9} />
          <View style={{ flex: 1 }}>
            <Text style={styles.label}>Rung khi quét</Text>
            <Text style={T.small}>Rung nhẹ khi chụp ảnh gửi lên máy chủ</Text>
          </View>
          <Switch value={prefs.vibrate_on_scan !== false} onValueChange={(v) => void update({ vibrate_on_scan: v })}
            trackColor={{ true: colors.primary, false: colors.border }} thumbColor="#fff" disabled={Platform.OS === "web"} accessibilityLabel="Rung khi quét" />
        </View>
        <Pressable style={[styles.row, styles.border]} accessibilityRole="button" accessibilityLabel="Chất lượng ảnh quét"
          onPress={() => void update({ image_quality: quality === "high" ? "standard" : "high" })}>
          <ImageIcon size={22} color={colors.navy} strokeWidth={1.9} />
          <View style={{ flex: 1 }}>
            <Text style={styles.label}>Chất lượng ảnh quét</Text>
            <Text style={T.small}>{quality === "high" ? "Cao (2000 px) — rõ chữ nhỏ, tải lâu hơn" : "Tiêu chuẩn (1600 px) — mặc định"}</Text>
          </View>
          <Text style={[T.link, { fontSize: 14 }]}>{quality === "high" ? "Cao" : "Tiêu chuẩn"}</Text>
        </Pressable>
        <Pressable style={[styles.row, styles.border]} accessibilityRole="button" accessibilityLabel="Máy chủ" onPress={() => router.push("/server")}>
          <Server size={22} color={colors.navy} strokeWidth={1.9} />
          <View style={{ flex: 1 }}>
            <Text style={styles.label}>Máy chủ</Text>
            <Text style={T.small} numberOfLines={1}>{displayHost(serverUrl)}</Text>
          </View>
          <ChevronRight size={20} color="#7A8499" />
        </Pressable>
        <Pressable style={styles.row} accessibilityRole="button" accessibilityLabel="Xóa bộ nhớ đệm ảnh"
          onPress={() => void Promise.all([Image.clearDiskCache(), Image.clearMemoryCache()]).then(() => setCleared(true))}>
          <HardDrive size={22} color={colors.navy} strokeWidth={1.9} />
          <View style={{ flex: 1 }}>
            <Text style={styles.label}>Xóa bộ nhớ đệm ảnh</Text>
            <Text style={T.small}>{cleared ? "Đã xóa ảnh lưu tạm trên điện thoại" : "Ảnh thu nhỏ của các lượt quét đã xem"}</Text>
          </View>
          <ChevronRight size={20} color="#7A8499" />
        </Pressable>
      </Card>
      <Text style={[T.small, { marginTop: 14 }]}>Đổi máy chủ sẽ đăng xuất khỏi máy chủ hiện tại.</Text>
    </Screen>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: 14, paddingHorizontal: 18, paddingVertical: 15 },
  border: { borderBottomWidth: 1, borderBottomColor: colors.border },
  label: { fontFamily: font.medium, fontSize: 16, color: colors.navy },
});
