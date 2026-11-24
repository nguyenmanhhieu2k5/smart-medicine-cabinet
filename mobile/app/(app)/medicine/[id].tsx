import { router, useLocalSearchParams } from "expo-router";
import {
  BadgeCheck, Barcode, Building2, CalendarClock, CircleCheck, ClipboardList, Factory, FileText, FlaskConical, Globe, Info, Layers, Package,
  Pill, Square, Volume2, type LucideIcon,
} from "lucide-react-native";
import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import { api, ApiError, type MedicineDetail } from "@/api";
import { ScanThumbnail } from "@/components/ScanThumbnail";
import { Screen, ScreenHeader } from "@/components/layout";
import { ConnectionErrorView } from "@/components/states";
import { Card, Chip, CircleButton, ErrorBanner, IconTile, InfoBox, type as T } from "@/components/ui";
import { medicineSpeechText } from "@/speech/medicineSpeech";
import { useSpeech } from "@/speech/useSpeech";
import { colors, font, radius } from "@/theme";

/** "2027-01-31" → "31/01/2027" (không qua Date để khỏi lệch múi giờ). */
function formatIsoDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : iso;
}

function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function InfoRow({ icon, label, value, last }: { icon: LucideIcon; label: string; value: string | null | undefined; last?: boolean }) {
  // Giá trị dài (hàm lượng ghi đủ thành phần, tên công ty) → nhãn ở trên, giá trị bên dưới cho dễ đọc.
  const long = (value ?? "").length > 22;
  return (
    <View style={[styles.infoRow, !last && styles.infoBorder]}>
      <IconTile icon={icon} size={42} iconSize={21} />
      {long ? (
        <View style={{ flex: 1, gap: 3 }}>
          <Text style={[styles.infoLabel, { width: undefined }]}>{label}</Text>
          <Text style={styles.infoValue} selectable>{value}</Text>
        </View>
      ) : (
        <>
          <Text style={styles.infoLabel}>{label}</Text>
          <Text style={styles.infoValue} selectable>{value || "—"}</Text>
        </>
      )}
    </View>
  );
}

/** Chi tiết thuốc (thiết kế 08) — CHỈ ĐỌC, lấy từ danh mục DAV_unique trong PostgreSQL trên Mini PC. */
export default function MedicineDetailScreen() {
  // barcode/expiry/lot: có khi mở từ quét mã vạch (expiry, lot đọc từ mã 2D DataMatrix của chính hộp thuốc).
  const { id, jobId, barcode, expiry, lot } = useLocalSearchParams<{ id: string; jobId?: string; barcode?: string; expiry?: string; lot?: string }>();
  const { width } = useWindowDimensions();
  const [data, setData] = useState<MedicineDetail | null>(null);
  const [error, setError] = useState<ApiError | null>(null);

  const speech = useSpeech();
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let cancelled = false;
    api.medicine(Number(id)).then(
      (value) => {
        if (!cancelled) {
          setData(value);
          setError(null);
        }
      },
      (e: unknown) => {
        if (!cancelled) setError(e instanceof ApiError ? e : new ApiError(String(e), "http"));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [id, attempt]);
  const load = useCallback(() => {
    setError(null);
    setAttempt((n) => n + 1);
  }, []);

  const back = () => (router.canGoBack() ? router.back() : router.replace("/scan"));
  if (error?.kind === "network" || error?.kind === "timeout") {
    return <Screen><ScreenHeader title="Chi tiết thuốc" onBack={back} /><ConnectionErrorView onRetry={() => void load()} /></Screen>;
  }
  if (!data) {
    return (
      <Screen>
        <ScreenHeader title="Chi tiết thuốc" onBack={back} />
        {error ? <ErrorBanner message={error.message} /> : <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}><ActivityIndicator color={colors.primary} size="large" /></View>}
      </Screen>
    );
  }
  const thumb = width < 380 ? 104 : 124;
  const rows: [LucideIcon, string, string | null | undefined][] = [
    [FlaskConical, "Hoạt chất chính", data.hoat_chat_chinh],
    [Layers, "Hàm lượng", data.ham_luong],
    [Pill, "Dạng bào chế", data.dang_bao_che],
    [Package, "Đóng gói", data.dong_goi],
    [ClipboardList, "Số đăng ký", data.so_dang_ky],
    [BadgeCheck, "Hiệu lực SĐK", data.registration_status?.label],
    [Building2, "Công ty đăng ký", data.ten_cong_ty_dang_ky],
    [Factory, "Công ty sản xuất", data.ten_cong_ty_san_xuat],
    [Globe, "Nước sản xuất", data.nuoc_san_xuat],
    [FileText, "Nguồn dữ liệu", data.source],
  ];

  // Nút loa ở góc phải tiêu đề (chỗ trống đối xứng nút Quay lại trong thiết kế 08): đọc thông tin thuốc bằng tiếng Việt.
  const readAloud = (
    <CircleButton
      icon={speech.speaking ? Square : Volume2} label={speech.speaking ? "Dừng đọc" : "Đọc thông tin thuốc"} size={46}
      active={speech.speaking} testID="read-aloud"
      onPress={() => (speech.speaking ? speech.stop() : void speech.speak(medicineSpeechText(data, { expiry, lot })))}
    />
  );

  return (
    <Screen scroll testID="medicine-screen">
      <ScreenHeader title="Chi tiết thuốc" onBack={back} right={readAloud} />
      {speech.notice ? <View style={{ marginBottom: 14 }}><InfoBox icon={Volume2} title="Chưa đọc được">{speech.notice}</InfoBox></View> : null}
      <Card style={styles.hero}>
        <ScanThumbnail jobId={jobId} width={thumb} height={thumb} radius={18} />
        <View style={{ flex: 1, minWidth: 0, gap: 8 }}>
          <Text style={[T.display, { fontSize: data.ten_thuoc.length > 18 ? 21 : 24, lineHeight: data.ten_thuoc.length > 18 ? 27 : 30 }]} numberOfLines={3}>{data.ten_thuoc}</Text>
          {data.ham_luong ? <Chip label={data.ham_luong} tone="primary" lines={2} /> : null}
          {data.dang_bao_che ? <Text style={[T.body, { fontSize: 16 }]} numberOfLines={2}>{data.dang_bao_che}</Text> : null}
          <Chip label="Đã tra cứu từ cơ sở dữ liệu" tone="success" icon={CircleCheck} size="sm" lines={2} />
        </View>
      </Card>
      {barcode || expiry || lot ? (
        <View style={styles.boxInfo} testID="box-info">
          {barcode ? <Chip label={`Mã vạch ${barcode}`} tone="neutral" icon={Barcode} size="sm" /> : null}
          {expiry ? <Chip label={`HSD ${formatIsoDate(expiry)}`} tone={expiry < todayIso() ? "danger" : "warning"} icon={CalendarClock} size="sm" /> : null}
          {lot ? <Chip label={`Lô ${lot}`} tone="neutral" size="sm" /> : null}
        </View>
      ) : null}
      <Text style={[T.section, { fontSize: 22, marginTop: 26, marginBottom: 14 }]}>Thông tin tra cứu</Text>
      <Card padded={false} style={{ paddingHorizontal: 16, paddingBottom: 16 }}>
        {rows.map(([icon, label, value], i) => <InfoRow key={label} icon={icon} label={label} value={value} last={i === rows.length - 1} />)}
        <View style={styles.readonly}>
          <Info size={26} color={colors.primary} strokeWidth={1.9} />
          <View style={styles.readonlyBar} />
          <View style={{ flex: 1 }}>
            <Text style={[T.label, { fontSize: 17 }]}>Chỉ đọc</Text>
            <Text style={[T.small, { fontSize: 14, lineHeight: 20, marginTop: 2 }]}>Thông tin thuốc được truy xuất từ hệ thống, không thể chỉnh sửa trên ứng dụng di động.</Text>
          </View>
        </View>
      </Card>
    </Screen>
  );
}

const styles = StyleSheet.create({
  hero: { flexDirection: "row", gap: 16, alignItems: "center", padding: 16 },
  boxInfo: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 12 },
  infoRow: { flexDirection: "row", alignItems: "center", gap: 14, paddingVertical: 13 },
  infoBorder: { borderBottomWidth: 1, borderBottomColor: colors.border },
  infoLabel: { fontFamily: font.regular, fontSize: 14.5, color: colors.muted, width: 108 },
  infoValue: { flex: 1, fontFamily: font.semibold, fontSize: 15, lineHeight: 21, color: colors.navy },
  readonly: { flexDirection: "row", alignItems: "center", gap: 12, backgroundColor: colors.primaryTint, borderRadius: radius.control, padding: 16, marginTop: 14 },
  readonlyBar: { width: 1, alignSelf: "stretch", backgroundColor: "#C9DDF8" },
});
