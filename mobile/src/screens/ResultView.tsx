import { router } from "expo-router";
import { ArrowRight, BarChart3, Check, ChevronRight, CircleAlert, Globe, QrCode, ScanBarcode as BarcodeIcon, ScanLine, SunDim, Target } from "lucide-react-native";
import { useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import { api, type Candidate, type ScanBarcode, type ScanJob } from "@/api";
import { ScanThumbnail } from "@/components/ScanThumbnail";
import { Screen, ScreenHeader } from "@/components/layout";
import { UnrecognizedView } from "@/components/states";
import { Button, Chip, type as T } from "@/components/ui";
import { pickFromLibrary } from "@/scan/image";
import { submitOrPromptLogin } from "@/scan/startScan";
import { colors, font, radius, shadow } from "@/theme";
import { candidateBadge } from "@/utils/format";

const EMPTY_TEXT: Record<string, { title: string; message: string }> = {
  no_text: { title: "Không nhận diện được thông tin thuốc", message: "Ảnh có thể bị mờ, thiếu sáng hoặc không chứa chữ rõ ràng. Vui lòng thử lại với ảnh khác." },
  no_match: { title: "Không tìm thấy thuốc phù hợp", message: "Đã đọc được chữ trên ảnh nhưng không khớp thuốc nào trong cơ sở dữ liệu. Hãy chụp rõ tên thuốc hoặc số đăng ký." },
  no_catalog: { title: "Máy chủ chưa có danh mục thuốc", message: "Quản trị viên cần nhập danh mục thuốc (DAV_unique.xlsx) trên ứng dụng Windows." },
};

/** Cùng ngưỡng với ứng dụng Windows: ≥ 3% vùng giữa ảnh cháy trắng. */
const GLARE_TIP_PERCENT = 3;
const GLARE_TIP = "Ảnh bị lóa sáng ở vùng giữa nên chữ nằm dưới chỗ lóa bị mất. Tắt đèn flash, nghiêng nhẹ hộp/vỉ thuốc để tránh đèn chiếu thẳng rồi chụp lại.";

/** Lời nhắc chụp lại khi ảnh lóa mà kết quả chưa chắc chắn (giấy bạc vỉ thuốc, hộp bóng, đèn flash). */
export function glareTip(job: ScanJob): string | null {
  const result = job.result;
  if (!result || (result.glare ?? 0) < GLARE_TIP_PERCENT || result.match.status === "confident") return null;
  return GLARE_TIP;
}

function Row({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel} numberOfLines={1}>{label}</Text>
      <Text style={styles.rowValue} numberOfLines={1}>{value || "—"}</Text>
    </View>
  );
}

function CandidateCard({ candidate, index, selected, jobId, onSelect, compact }: {
  candidate: Candidate; index: number; selected: boolean; jobId: string; onSelect: () => void; compact: boolean;
}) {
  const badge = candidateBadge(candidate, index);
  const m = candidate.medicine;
  return (
    <Pressable onPress={onSelect} accessibilityRole="radio" accessibilityState={{ selected }} accessibilityLabel={`${m.ten_thuoc}, ${badge.label}`}
      style={[styles.card, selected && styles.cardSelected]} testID={`candidate-${index}`}>
      <ScanThumbnail jobId={jobId} width={compact ? 64 : 76} height={compact ? 64 : 76} radius={14} />
      <View style={{ flex: 1, minWidth: 0 }}>
        <View style={styles.titleRow}>
          <Text style={[T.cardTitle, { flexShrink: 1, fontSize: compact ? 16 : 17 }]} numberOfLines={2}>{m.ten_thuoc}</Text>
        </View>
        <View style={{ marginTop: 6 }}>
          <Chip label={badge.label} tone={badge.tone} size="sm" icon={badge.best ? Target : BarChart3} lines={2} />
        </View>
        <View style={{ marginTop: 8 }}>
          <Row label="Hoạt chất" value={m.hoat_chat_chinh} />
          <Row label="Hàm lượng" value={m.ham_luong} />
          <Row label="Số đăng ký" value={m.so_dang_ky} />
        </View>
      </View>
      <View style={[styles.radio, selected && styles.radioOn]}>{selected ? <View style={styles.radioDot} /> : null}</View>
    </Pressable>
  );
}

export function ResultView({ job, historyId, initialSelected, onBack }: { job: ScanJob; historyId?: string | null; initialSelected?: number | null; onBack?: () => void }) {
  const { width } = useWindowDimensions();
  const match = job.result?.match;
  const candidates = (match?.candidates ?? []).slice(0, 3);
  const [selected, setSelected] = useState<number>(() => Math.max(0, candidates.findIndex((c) => c.medicine.id === initialSelected)));
  const compact = width < 380;

  const rescan = () => router.navigate("/scan");
  const codes = job.result?.barcodes ?? [];
  const unknownCode = codeToLookUp(codes);
  // Người dùng xác nhận không có thuốc đúng → máy chủ tìm trên mạng: theo đúng mã vạch/QR trên ảnh nếu dữ liệu chưa có
  // mã đó, không thì theo tên thuốc in trên hộp (Tavily, hoặc Gemini).
  const askAi = () => router.push({
    pathname: "/ai-lookup",
    params: unknownCode ? { kind: unknownCode.kind, code: unknownCode.code } : { kind: "scan", jobId: job.id },
  });
  const pickOther = async () => {
    const image = await pickFromLibrary().catch(() => null);
    if (!image) return;
    const next = await submitOrPromptLogin(image, "upload"); // khách hết lượt quét thử → đăng nhập
    if (next) router.push({ pathname: "/scan/processing/[jobId]", params: { jobId: next.id } });
  };

  const tip = glareTip(job);
  if (candidates.length === 0) {
    const empty = EMPTY_TEXT[match?.status ?? "no_text"] ?? EMPTY_TEXT.no_text;
    const text = unknownCode
      ? { title: "Đã đọc được mã nhưng chưa có dữ liệu", message: `${unknownCode.label} chưa có trong dữ liệu. Bấm “Tìm trên mạng” để tra đúng mã này.` }
      : { title: empty.title, message: tip ?? empty.message };
    return (
      <Screen>
        <ScreenHeader title="Kết quả nhận diện" onBack={onBack} />
        <UnrecognizedView title={text.title} message={text.message} onRescan={rescan} onPickOther={() => void pickOther()} onAi={askAi} />
      </Screen>
    );
  }

  const uncertain = match?.status === "uncertain";
  const openDetail = () => {
    const medicine = candidates[selected].medicine;
    if (historyId) void api.selectCandidate(historyId, medicine.id).catch(() => undefined); // chỉ ghi vào lịch sử, không thêm vào tủ
    router.push({ pathname: "/medicine/[id]", params: { id: String(medicine.id), jobId: job.id } });
  };

  return (
    <Screen testID="result-screen">
      <ScreenHeader title="Kết quả nhận diện" onBack={onBack} />
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: 16 }} showsVerticalScrollIndicator={false}>
      <View style={[styles.banner, uncertain && { backgroundColor: colors.warningSoft }]}>
        <View style={[styles.bannerIcon, uncertain && { backgroundColor: colors.warningLabel }]}>
          {uncertain ? <CircleAlert size={24} color={colors.warningInk} strokeWidth={2.2} /> : <Check size={24} color={colors.success} strokeWidth={2.6} />}
        </View>
        <View style={{ flex: 1 }}>
          <Text style={[T.label, { fontSize: 16, lineHeight: 22 }]}>
            {uncertain ? `Chưa chắc chắn · ${candidates.length} khả năng` : `Đã tìm thấy ${candidates.length} kết quả phù hợp`}
          </Text>
          <Text style={[T.small, { fontSize: 14, marginTop: 2 }]}>Hãy chọn đúng thuốc để xem chi tiết</Text>
        </View>
      </View>
      {tip ? (
        <View style={styles.glareTip} testID="glare-tip" accessibilityRole="alert">
          <SunDim size={18} color={colors.warningInk} strokeWidth={2.2} />
          <Text style={[T.small, { flex: 1, fontSize: 13.5, color: colors.warningInk }]}>{tip}</Text>
        </View>
      ) : null}
      {codes.length > 0 && (
        <View style={{ gap: 8, marginTop: 12 }} testID="scan-barcodes">
          {codes.map((code) => {
            const Icon = /QR|Matrix/.test(code.format) ? QrCode : BarcodeIcon;
            return (
              <View key={code.text} style={styles.codeRow}>
                <Icon size={18} color={colors.primary} strokeWidth={2} />
                <Text style={[T.small, { fontSize: 13 }]}>{code.format}</Text>
                <Text style={[T.label, { flex: 1, fontSize: 14 }]} numberOfLines={1}>{code.kind === "gtin" ? code.display : code.text}</Text>
                <Text style={[T.small, { fontSize: 12.5, color: code.status === "found" ? colors.success : colors.muted }]}>{CODE_STATUS[code.status]}</Text>
              </View>
            );
          })}
        </View>
      )}
      <View style={{ gap: 12, marginTop: 16 }} accessibilityRole="radiogroup">
        {candidates.map((candidate, index) => (
          <CandidateCard key={candidate.medicine.id} candidate={candidate} index={index} selected={index === selected} jobId={job.id}
            onSelect={() => setSelected(index)} compact={compact} />
        ))}
      </View>
      <Pressable onPress={askAi} accessibilityRole="button" testID="ai-not-listed"
        style={({ pressed }) => [styles.aiRow, pressed && { opacity: 0.85 }]}>
        <View style={styles.aiIcon}><Globe size={22} color={colors.primary} strokeWidth={2} /></View>
        <View style={{ flex: 1 }}>
          <Text style={[T.label, { fontSize: 15.5 }]}>Không có thuốc đúng?</Text>
          <Text style={[T.small, { fontSize: 13.5, marginTop: 1 }]}>
            {unknownCode ? `Tìm ${unknownCode.label.toLowerCase()} trên mạng` : "Tìm tên thuốc trên hộp vừa chụp trên mạng"}
          </Text>
        </View>
        <ChevronRight size={20} color={colors.muted} />
      </Pressable>
      </ScrollView>
      <View style={styles.actions}>
        <Button title="Quét lại" icon={ScanLine} variant="outline" onPress={rescan} style={{ flex: 1 }} />
        <Button title="Xem chi tiết" iconRight={ArrowRight} onPress={openDetail} style={{ flex: 1.25 }} testID="open-detail" />
      </View>
    </Screen>
  );
}

const CODE_STATUS: Record<ScanBarcode["status"], string> = {
  found: "Khớp dữ liệu",
  not_found: "Chưa có dữ liệu",
  internal: "Mã nội bộ cửa hàng",
  text: "Nội dung mã",
};

/** Mã trên ảnh mà dữ liệu chưa có → tra đúng mã đó trên mạng. Đã có mã khớp thì không cần. */
export function codeToLookUp(codes: ScanBarcode[]): { kind: "barcode" | "qr"; code: string; label: string } | null {
  if (codes.some((c) => c.status === "found")) return null;
  const gtin = codes.find((c) => c.status === "not_found");
  if (gtin) return { kind: "barcode", code: gtin.display, label: `Mã vạch ${gtin.display}` };
  const qr = codes.find((c) => c.status === "text");
  return qr ? { kind: "qr", code: qr.text, label: "Mã QR" } : null;
}

const styles = StyleSheet.create({
  codeRow: {
    flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 14, paddingVertical: 10, borderRadius: radius.card,
    backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border,
  },
  glareTip: {
    flexDirection: "row", alignItems: "flex-start", gap: 10, marginTop: 12, paddingHorizontal: 14, paddingVertical: 12,
    borderRadius: radius.card, backgroundColor: colors.warningSoft,
  },
  banner: { flexDirection: "row", alignItems: "center", gap: 14, backgroundColor: colors.primarySoft, borderRadius: radius.card, padding: 16 },
  aiRow: {
    flexDirection: "row", alignItems: "center", gap: 12, marginTop: 14, padding: 14, borderRadius: radius.card,
    backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderStyle: "dashed",
  },
  aiIcon: { width: 44, height: 44, borderRadius: 22, backgroundColor: colors.primarySoft, alignItems: "center", justifyContent: "center" },
  bannerIcon: { width: 46, height: 46, borderRadius: 23, backgroundColor: colors.successSoft, alignItems: "center", justifyContent: "center" },
  card: {
    flexDirection: "row", gap: 12, backgroundColor: colors.surface, borderRadius: radius.card, padding: 12, borderWidth: 1.5,
    borderColor: "#EEF1F5", ...shadow,
  },
  cardSelected: { borderColor: colors.primary },
  titleRow: { flexDirection: "row", alignItems: "center", gap: 8, paddingRight: 4 },
  row: { flexDirection: "row", gap: 8, paddingVertical: 4, borderBottomWidth: 1, borderBottomColor: "#F0F2F6" },
  rowLabel: { fontFamily: font.regular, fontSize: 13.5, color: colors.muted, width: 78 },
  rowValue: { flex: 1, fontFamily: font.medium, fontSize: 13.5, color: colors.navy },
  radio: { width: 26, height: 26, borderRadius: 13, borderWidth: 2, borderColor: "#B9C0CC", alignItems: "center", justifyContent: "center" },
  radioOn: { borderColor: colors.primary },
  radioDot: { width: 14, height: 14, borderRadius: 7, backgroundColor: colors.primary },
  actions: { flexDirection: "row", gap: 12, paddingTop: 12, paddingBottom: 14 },
});
