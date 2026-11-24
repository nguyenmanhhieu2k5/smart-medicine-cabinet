/**
 * Hạn dùng thuốc trong tủ — tài khoản tự đăng ký (SCANNER) XEM và SỬA NGÀY HẾT HẠN.
 * Không thêm/xóa thuốc, không sửa tên/số lượng (máy chủ chỉ nhận đúng trường expiry_date; thêm/xóa thuốc do Admin làm
 * trên ứng dụng Windows). Dữ liệu là tủ thuốc chung lưu trên Mini PC.
 */
import { useFocusEffect } from "expo-router";
import { CalendarClock, CalendarX2, Package, Pencil, Search, ShieldCheck, X } from "lucide-react-native";
import { useCallback, useState } from "react";
import { ActivityIndicator, FlatList, Modal, Pressable, RefreshControl, StyleSheet, Text, TextInput, View } from "react-native";
import { api, ApiError, type CabinetList, type CabinetMedicine, type ExpiryStatus } from "@/api";
import { ConnectionErrorView } from "@/components/states";
import { Screen, ScreenHeader } from "@/components/layout";
import { Button, Chip, ErrorBanner, InfoBox, TextField, type as T, type Tone } from "@/components/ui";
import { colors, font, radius } from "@/theme";
import { isoToVnDate, maskDateInput, vnDateToIso } from "@/utils/format";

/** Chữ thường, bỏ dấu — để "paracetamol" tìm được "Paracetamol", "thuoc" tìm được "thuốc". */
function fold(text: string): string {
  return text.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/g, "d").replace(/Đ/g, "D").toLowerCase().trim();
}

type Filter = "all" | "expired" | "expiring" | "ok" | "unknown";
const FILTERS: { key: Filter; label: string }[] = [
  { key: "all", label: "Tất cả" }, { key: "expired", label: "Hết hạn" }, { key: "expiring", label: "Sắp hết hạn" },
  { key: "ok", label: "Còn hạn" }, { key: "unknown", label: "Chưa rõ" },
];
const TONE: Record<ExpiryStatus, Tone> = { expired: "danger", expiring: "warning", ok: "success", unknown: "neutral" };

function ExpiryEditor({ item, onClose, onSaved }: { item: CabinetMedicine; onClose: () => void; onSaved: (next: CabinetMedicine) => void }) {
  const [text, setText] = useState(isoToVnDate(item.expiry_date));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async (value: string | null) => {
    setBusy(true);
    setError(null);
    try {
      onSaved(await api.updateExpiry(item.id, value));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Không lưu được. Vui lòng thử lại.");
    } finally {
      setBusy(false);
    }
  };
  const submit = () => {
    const iso = vnDateToIso(text);
    if (!iso) {
      setError("Nhập ngày theo dạng ngày/tháng/năm, ví dụ 15/06/2027.");
      return;
    }
    void save(iso);
  };
  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose} accessibilityLabel="Đóng" />
      <View style={styles.sheet} testID="expiry-editor">
        <View style={styles.grabber} />
        <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 12 }}>
          <View style={{ flex: 1 }}>
            <Text style={T.section} numberOfLines={2}>{item.name}</Text>
            <Text style={[T.body, { marginTop: 2 }]}>{[item.strength, item.quantity_text].filter(Boolean).join(" · ")}</Text>
          </View>
          <Pressable onPress={onClose} accessibilityRole="button" accessibilityLabel="Đóng" hitSlop={8}><X size={24} color={colors.muted} /></Pressable>
        </View>
        <View style={{ marginTop: 18 }}>
          <TextField label="Ngày hết hạn (ngày/tháng/năm)" icon={CalendarClock} value={text} onChangeText={(v) => setText(maskDateInput(v))}
            keyboardType="number-pad" placeholder="15/06/2027" maxLength={10} autoFocus testID="expiry-input" onSubmitEditing={submit} />
        </View>
        <ErrorBanner message={error} />
        <Button title="Lưu ngày hết hạn" onPress={submit} loading={busy} disabled={busy || text.length < 8} style={{ marginTop: 16 }} testID="expiry-save" />
        {item.expiry_date ? (
          <Button title="Xóa ngày hết hạn (chưa rõ)" icon={CalendarX2} variant="outline" onPress={() => void save(null)} disabled={busy} style={{ marginTop: 10 }} />
        ) : null}
        <Text style={[T.small, { textAlign: "center", marginTop: 14 }]}>Bạn chỉ sửa được ngày hết hạn. Thêm/xóa thuốc do quản trị viên thực hiện.</Text>
      </View>
    </Modal>
  );
}

function Row({ item, onEdit }: { item: CabinetMedicine; onEdit: () => void }) {
  return (
    <Pressable onPress={onEdit} accessibilityRole="button" accessibilityLabel={`Sửa ngày hết hạn ${item.name}`} testID={`expiry-row-${item.id}`}
      style={({ pressed }) => [styles.row, pressed && { opacity: 0.85 }]}>
      <View style={styles.rowIcon}><Package size={22} color={colors.primary} strokeWidth={1.9} /></View>
      <View style={{ flex: 1, gap: 4 }}>
        <Text style={[T.label, { fontSize: 16 }]} numberOfLines={2}>{item.name}</Text>
        <Text style={[T.small, { fontSize: 13 }]} numberOfLines={1}>{[item.strength, item.quantity_text].filter(Boolean).join(" · ")}</Text>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <Text style={styles.date}>HSD: {item.expiry_date ? isoToVnDate(item.expiry_date) : "chưa rõ"}</Text>
          <Chip label={item.expiry_status_label} tone={TONE[item.expiry_status]} size="sm" />
        </View>
      </View>
      <Pencil size={18} color={colors.muted} />
    </Pressable>
  );
}

export default function ExpiryScreen() {
  const [data, setData] = useState<CabinetList | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [editing, setEditing] = useState<CabinetMedicine | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  const load = useCallback(async (status: Filter) => {
    try {
      setData(await api.cabinet({ status }));
      setError(null);
    } catch (e) {
      setError(e instanceof ApiError ? e : new ApiError(String(e), "http"));
    }
  }, []);
  useFocusEffect(useCallback(() => { void load(filter); }, [load, filter]));
  // Tìm theo tên ngay trên máy (không gọi máy chủ mỗi lần gõ).
  const needle = fold(query);
  const items = (data?.items ?? []).filter((m) => !needle || fold([m.name, m.ingredient, m.strength, m.registration_no].filter(Boolean).join(" ")).includes(needle));

  const refresh = async () => {
    setRefreshing(true);
    await load(filter);
    setRefreshing(false);
  };

  if (error && !data && (error.kind === "network" || error.kind === "timeout")) {
    return <Screen><ScreenHeader title="Hạn dùng thuốc" /><ConnectionErrorView onRetry={() => void load(filter)} /></Screen>;
  }

  return (
    <Screen testID="expiry-screen">
      <ScreenHeader title="Hạn dùng thuốc" />
      <View style={styles.search}>
        <Search size={20} color={colors.muted} />
        <TextInput value={query} onChangeText={setQuery} placeholder="Tìm thuốc trong tủ…" placeholderTextColor={colors.placeholder}
          style={styles.searchInput} accessibilityLabel="Tìm thuốc trong tủ" returnKeyType="search" />
      </View>
      <View style={styles.filters}>
        {FILTERS.map((f) => {
          const count = data?.counts[f.key];
          const active = filter === f.key;
          return (
            <Pressable key={f.key} onPress={() => setFilter(f.key)} accessibilityRole="button" accessibilityState={{ selected: active }}
              style={[styles.filter, active && styles.filterActive]}>
              <Text style={[styles.filterText, active && { color: "#FFFFFF" }]}>{f.label}{typeof count === "number" ? ` ${count}` : ""}</Text>
            </Pressable>
          );
        })}
      </View>
      {saved ? <View style={{ marginBottom: 10 }}><InfoBox icon={ShieldCheck} title="Đã lưu">{saved}</InfoBox></View> : null}
      <ErrorBanner message={error?.message} />
      {!data ? (
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}><ActivityIndicator color={colors.primary} size="large" /></View>
      ) : (
        <FlatList
          data={items}
          keyExtractor={(item) => String(item.id)}
          renderItem={({ item }) => <Row item={item} onEdit={() => { setSaved(null); setEditing(item); }} />}
          ItemSeparatorComponent={() => <View style={{ height: 10 }} />}
          contentContainerStyle={{ paddingBottom: 24, flexGrow: 1 }}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void refresh()} tintColor={colors.primary} />}
          ListEmptyComponent={
            <View style={{ alignItems: "center", paddingTop: 48, gap: 8 }} testID="expiry-empty">
              <Package size={44} color={colors.muted} strokeWidth={1.5} />
              <Text style={[T.section, { textAlign: "center" }]}>{data.counts.all === 0 ? "Tủ thuốc chưa có thuốc" : "Không có thuốc phù hợp"}</Text>
              <Text style={[T.body, { textAlign: "center" }]}>
                {data.counts.all === 0 ? "Quản trị viên thêm thuốc vào tủ trên ứng dụng Windows." : "Thử bộ lọc hoặc từ khóa khác."}
              </Text>
            </View>
          }
        />
      )}
      {editing ? (
        <ExpiryEditor item={editing} onClose={() => setEditing(null)}
          onSaved={(next) => {
            setEditing(null);
            setSaved(`${next.name}: hạn dùng ${next.expiry_date ? isoToVnDate(next.expiry_date) : "chưa rõ"}.`);
            void load(filter);
          }} />
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  search: {
    flexDirection: "row", alignItems: "center", gap: 10, backgroundColor: colors.surface, borderRadius: radius.control, paddingHorizontal: 14,
    borderWidth: 1, borderColor: colors.border, minHeight: 50,
  },
  searchInput: { flex: 1, fontFamily: font.regular, fontSize: 16, color: colors.navy, paddingVertical: 10 },
  filters: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginVertical: 14 },
  filter: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 999, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border },
  filterActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  filterText: { fontFamily: font.semibold, fontSize: 13.5, color: colors.navy },
  row: {
    flexDirection: "row", alignItems: "center", gap: 12, backgroundColor: colors.surface, borderRadius: radius.card, padding: 14,
    borderWidth: 1, borderColor: colors.border,
  },
  rowIcon: { width: 46, height: 46, borderRadius: 23, backgroundColor: colors.primaryTint, alignItems: "center", justifyContent: "center" },
  date: { fontFamily: font.semibold, fontSize: 14, color: colors.navy },
  backdrop: { flex: 1, backgroundColor: colors.overlay },
  sheet: { backgroundColor: colors.surface, borderTopLeftRadius: 28, borderTopRightRadius: 28, padding: 24, paddingBottom: 36 },
  grabber: { alignSelf: "center", width: 44, height: 5, borderRadius: 3, backgroundColor: colors.border, marginBottom: 16 },
});
