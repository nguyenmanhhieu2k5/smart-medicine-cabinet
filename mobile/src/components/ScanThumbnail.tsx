import { Image, type ImageSource } from "expo-image";
import { Pill } from "lucide-react-native";
import { useEffect, useState } from "react";
import { Platform, View, type StyleProp, type ViewStyle } from "react-native";
import { api } from "@/api";
import { colors } from "@/theme";

/**
 * Ảnh thu nhỏ của lượt quét (ảnh người dùng chụp), tải từ máy chủ KÈM access token.
 * Android/iOS: expo-image gửi header Authorization. Web (kiểm tra giao diện): tải blob rồi hiển thị.
 * Không còn ảnh (quá thời gian lưu giữ) → ô biểu tượng viên thuốc.
 */
export function ScanThumbnail({ jobId, width, height, radius = 14, style }: { jobId: string | null | undefined; width: number; height: number; radius?: number; style?: StyleProp<ViewStyle> }) {
  const [loaded, setLoaded] = useState<{ key: string; source: ImageSource | string | null; failed: boolean } | null>(null);
  const current = jobId && loaded?.key === jobId ? loaded : null;
  const source = current?.source ?? null;
  const failed = current?.failed ?? false;
  const setFailed = () => jobId && setLoaded({ key: jobId, source: null, failed: true });

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;
    if (!jobId) return;
    (async () => {
      try {
        const headers = await api.authHeaders();
        const uri = api.thumbnailUrl(jobId);
        if (Platform.OS === "web") {
          const response = await fetch(uri, { headers });
          if (!response.ok) throw new Error(String(response.status));
          objectUrl = URL.createObjectURL(await response.blob());
          if (!cancelled) setLoaded({ key: jobId, source: objectUrl, failed: false });
        } else if (!cancelled) {
          setLoaded({ key: jobId, source: { uri, headers, cacheKey: `scan-${jobId}` }, failed: false });
        }
      } catch {
        if (!cancelled) setLoaded({ key: jobId, source: null, failed: true });
      }
    })();
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [jobId]);

  const box = [{ width, height, borderRadius: radius, overflow: "hidden" as const, backgroundColor: colors.primarySoft }, style];
  if (!source || failed) {
    return (
      <View style={[box, { alignItems: "center", justifyContent: "center" }]} accessibilityLabel="Không có ảnh">
        <Pill size={Math.min(width, height) * 0.38} color={colors.primary} strokeWidth={1.6} />
      </View>
    );
  }
  return (
    <View style={box}>
      <Image source={source} style={{ width: "100%", height: "100%" }} contentFit="cover" transition={150} onError={setFailed}
        accessibilityLabel="Ảnh đã quét" />
    </View>
  );
}
