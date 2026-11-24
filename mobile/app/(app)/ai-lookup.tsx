/**
 * Tìm thông tin thuốc trên mạng (máy chủ dùng Tavily không AI — mặc định — hoặc Gemini; điện thoại không giữ khóa nào).
 * Mở khi: mã vạch/QR chưa có trong dữ liệu, hoặc người dùng xác nhận "không có thuốc đúng" trong kết quả quét.
 * Chỉ đọc — kết quả không tự vào tủ thuốc; thuốc khớp trong danh mục mở ra màn Chi tiết thuốc (dữ liệu chính thức).
 */
import { router, useLocalSearchParams } from "expo-router";
import {
  BadgeCheck, Building2, ChevronRight, ClipboardList, ExternalLink, FlaskConical, Globe, Info, Layers, Package, Pill, RotateCcw, ScanLine,
  SearchX, ShieldAlert, Sparkles, type LucideIcon,
} from "lucide-react-native";
import { useEffect, useState } from "react";
import { ActivityIndicator, Linking, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { api, ApiError, type AiLookupResult } from "@/api";
import { Screen, ScreenHeader } from "@/components/layout";
import { Button, Card, Chip, IconTile, InfoBox, type as T } from "@/components/ui";
import { colors, font, radius } from "@/theme";

type Kind = "barcode" | "qr" | "scan";
const CONFIDENCE: Record<string, { label: string; tone: "success" | "warning" | "danger" }> = {
  cao: { label: "Độ tin cậy: Cao", tone: "success" },
  trung_binh: { label: "Độ tin cậy: Trung bình", tone: "warning" },
  thap: { label: "Độ tin cậy: Thấp", tone: "danger" },
};

/** Nhãn chế độ tra cứu — luôn nói rõ có dùng AI hay không. */
const MODE_LABEL: Record<"web" | "offline" | "search" | "text", string> = {
  web: "AI · đã tra trên mạng",
  offline: "AI · chỉ đọc ảnh/mã",
  search: "Tra trên mạng · không dùng AI",
  text: "Đọc từ nội dung mã · không dùng AI",
};

function subject(kind: Kind, code?: string): string {
  if (kind === "barcode") return `Mã vạch ${code ?? ""}`.trim();
  if (kind === "qr") return "Nội dung mã QR";
  return "Ảnh hộp thuốc vừa quét";
}

function Row({ icon, label, value, last }: { icon: LucideIcon; label: string; value: string | null; last?: boolean }) {
  if (!value) return null;
  return (
    <View style={[styles.row, !last && styles.rowBorder]}>
      <IconTile icon={icon} size={40} iconSize={20} />
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={styles.rowLabel}>{label}</Text>
        <Text style={styles.rowValue} selectable>{value}</Text>
      </View>
    </View>
  );
}

export default function AiLookupScreen() {
  const { kind = "scan", code, jobId } = useLocalSearchParams<{ kind?: Kind; code?: string; jobId?: string }>();
  const [data, setData] = useState<AiLookupResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const loading = !data && !error;

  useEffect(() => {
    let cancelled = false;
    const request = kind === "scan" ? api.aiScan(String(jobId)) : api.aiLookup(kind, String(code ?? ""));
    request.then(
      (value) => { if (!cancelled) setData(value); },
      (e: unknown) => { if (!cancelled) setError(e instanceof ApiError ? e.message : "Không tìm được. Vui lòng thử lại."); },
    );
    return () => { cancelled = true; };
  }, [kind, code, jobId, attempt]);

  useEffect(() => {
    if (!loading) return;
    const started = Date.now();
    const timer = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [loading, attempt]);

  const retry = () => {
    setData(null);
    setError(null);
    setElapsed(0);
    setAttempt((n) => n + 1);
  };
  const back = () => (router.canGoBack() ? router.back() : router.replace("/scan"));
  const rescan = () => router.navigate("/scan");

  if (loading) {
    return (
      <Screen testID="ai-lookup-screen">
        <ScreenHeader title="Tìm trên mạng" onBack={back} />
        <View style={styles.center} testID="ai-loading">
          <View style={styles.pulse}><Globe size={40} color={colors.primary} strokeWidth={1.8} /></View>
          <Text style={[T.section, { textAlign: "center", marginTop: 18 }]}>Đang tìm thông tin thuốc trên mạng…</Text>
          <Text style={[T.body, { textAlign: "center", marginTop: 6 }]}>{subject(kind, code)}</Text>
          <View style={styles.elapsed}>
            <ActivityIndicator color={colors.primary} />
            <Text style={[T.small, { fontSize: 14 }]}>{elapsed > 0 ? `${elapsed} giây · ` : ""}thường mất vài giây</Text>
          </View>
        </View>
      </Screen>
    );
  }

  if (error || !data || data.status === "unavailable" || data.status === "not_configured") {
    return (
      <Screen testID="ai-lookup-screen">
        <ScreenHeader title="Tìm trên mạng" onBack={back} />
        <View style={styles.center} testID="ai-unavailable">
          <IconTile icon={ShieldAlert} tone="warning" size={88} iconSize={40} />
          <Text style={[T.section, { textAlign: "center", marginTop: 18 }]}>Chưa tìm được trên mạng</Text>
          <Text style={[T.body, { textAlign: "center", marginTop: 6 }]}>{error ?? data?.message}</Text>
          <Button title="Thử lại" icon={RotateCcw} onPress={retry} style={styles.wide} />
          <Button title="Quét lại" icon={ScanLine} variant="outline" onPress={rescan} style={[styles.wide, { marginTop: 12 }]} />
        </View>
      </Screen>
    );
  }

  if (data.status === "not_found" || !data.result) {
    return (
      <Screen testID="ai-lookup-screen">
        <ScreenHeader title="Tìm trên mạng" onBack={back} />
        <View style={styles.center} testID="ai-not-found">
          <IconTile icon={SearchX} size={88} iconSize={40} />
          <Text style={[T.section, { textAlign: "center", marginTop: 18 }]}>Không tìm thấy thông tin</Text>
          <Text style={[T.body, { textAlign: "center", marginTop: 6 }]}>
            {data.message} Hãy thử chụp rõ mặt hộp có tên thuốc và số đăng ký.
          </Text>
          <Button title="Quét lại" icon={ScanLine} onPress={rescan} style={styles.wide} />
        </View>
      </Screen>
    );
  }

  const info = data.result;
  const confidence = CONFIDENCE[info.do_tin_cay] ?? CONFIDENCE.thap;
  return (
    <Screen testID="ai-lookup-screen">
      <ScreenHeader title="Tìm trên mạng" onBack={back} />
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: 24, gap: 16 }} showsVerticalScrollIndicator={false}>
        <Card style={{ padding: 18, gap: 10 }} testID="ai-result">
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            <Chip label={MODE_LABEL[data.mode ?? "web"]} icon={data.mode === "web" || data.mode === "search" ? Globe : Sparkles} size="sm" />
            <Chip label={confidence.label} tone={confidence.tone} size="sm" />
          </View>
          <Text style={[T.display, { fontSize: 24, lineHeight: 30 }]} selectable>{info.ten_thuoc}</Text>
          {info.ham_luong ? <Chip label={info.ham_luong} tone="primary" lines={2} /> : null}
          <Text style={[T.small, { fontSize: 13.5 }]}>{subject(kind, code)}{data.cached ? " · kết quả đã lưu" : ""}</Text>
        </Card>

        {data.catalog_matches.length > 0 ? (
          <View style={{ gap: 10 }}>
            <Text style={[T.section, { fontSize: 19 }]}>Trong danh mục thuốc</Text>
            {data.catalog_matches.map((m) => (
              <Pressable key={m.id} accessibilityRole="button" accessibilityLabel={`Xem chi tiết ${m.ten_thuoc}`} testID={`ai-match-${m.id}`}
                onPress={() => router.push({ pathname: "/medicine/[id]", params: { id: String(m.id) } })}
                style={({ pressed }) => [styles.match, pressed && { opacity: 0.85 }]}>
                <IconTile icon={m.match_by === "registration" ? BadgeCheck : Pill} tone={m.match_by === "registration" ? "success" : "primary"} size={44} iconSize={22} />
                <View style={{ flex: 1, gap: 2 }}>
                  <Text style={[T.label, { fontSize: 16 }]} numberOfLines={2}>{m.ten_thuoc}</Text>
                  <Text style={[T.small, { fontSize: 13 }]} numberOfLines={1}>
                    {m.match_by === "registration" ? "Khớp số đăng ký" : "Gợi ý theo tên"}{m.so_dang_ky ? ` · ${m.so_dang_ky}` : ""}
                  </Text>
                </View>
                <ChevronRight size={20} color={colors.muted} />
              </Pressable>
            ))}
          </View>
        ) : null}

        <Card padded={false} style={{ paddingHorizontal: 16, paddingVertical: 4 }}>
          <Row icon={FlaskConical} label="Hoạt chất" value={info.hoat_chat} />
          <Row icon={Layers} label="Hàm lượng" value={info.ham_luong} />
          <Row icon={Pill} label="Dạng bào chế" value={info.dang_bao_che} />
          <Row icon={Package} label="Quy cách" value={info.quy_cach} />
          <Row icon={ClipboardList} label="Số đăng ký" value={info.so_dang_ky} />
          <Row icon={Building2} label="Nhà sản xuất" value={[info.nha_san_xuat, info.nuoc_san_xuat].filter(Boolean).join(" · ") || null} last={!info.ghi_chu} />
          <Row icon={data.mode === "search" || data.mode === "text" ? Info : Sparkles} label={data.mode === "search" || data.mode === "text" ? "Ghi chú" : "Ghi chú của AI"} value={info.ghi_chu} last />
        </Card>

        {data.sources.length > 0 ? (
          <View style={{ gap: 8 }}>
            <Text style={[T.section, { fontSize: 19 }]}>Nguồn tham khảo</Text>
            {data.sources.map((s) => (
              <Pressable key={s.url} accessibilityRole="link" onPress={() => void Linking.openURL(s.url)} style={({ pressed }) => [styles.source, pressed && { opacity: 0.8 }]}>
                <Globe size={18} color={colors.primary} />
                <Text style={styles.sourceText} numberOfLines={1}>{s.title}</Text>
                <ExternalLink size={16} color={colors.muted} />
              </Pressable>
            ))}
          </View>
        ) : null}

        <InfoBox icon={ShieldAlert} tone="warning" title="Lưu ý">{data.notice}</InfoBox>
        <Button title="Quét thuốc khác" icon={ScanLine} variant="outline" onPress={rescan} />
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: "center", justifyContent: "center", paddingVertical: 24 },
  pulse: { width: 96, height: 96, borderRadius: 48, backgroundColor: colors.primarySoft, alignItems: "center", justifyContent: "center" },
  elapsed: { flexDirection: "row", alignItems: "center", gap: 10, marginTop: 22 },
  wide: { alignSelf: "stretch", marginTop: 24 },
  row: { flexDirection: "row", alignItems: "center", gap: 14, paddingVertical: 12 },
  rowBorder: { borderBottomWidth: 1, borderBottomColor: colors.border },
  rowLabel: { fontFamily: font.regular, fontSize: 13.5, color: colors.muted },
  rowValue: { fontFamily: font.semibold, fontSize: 15, lineHeight: 21, color: colors.navy },
  match: {
    flexDirection: "row", alignItems: "center", gap: 12, backgroundColor: colors.surface, borderRadius: radius.card, padding: 14,
    borderWidth: 1, borderColor: colors.border,
  },
  source: {
    flexDirection: "row", alignItems: "center", gap: 10, backgroundColor: colors.surface, borderRadius: radius.control,
    paddingHorizontal: 14, paddingVertical: 12, borderWidth: 1, borderColor: colors.border,
  },
  sourceText: { flex: 1, fontFamily: font.medium, fontSize: 14.5, color: colors.primary },
});
