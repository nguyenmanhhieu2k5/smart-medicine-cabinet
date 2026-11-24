import { router, useFocusEffect } from "expo-router";
import { ChevronRight, CircleAlert, CircleCheck, Clock, ScanLine, Search, SlidersHorizontal, X } from "lucide-react-native";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator, Modal, Pressable, RefreshControl, SectionList, StyleSheet, Text, TextInput, View, useWindowDimensions,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { api, ApiError, type HistoryFilter, type HistoryItem } from "@/api";
import { AppHeaderBrand } from "@/components/brand";
import { ScanThumbnail } from "@/components/ScanThumbnail";
import { ConnectionErrorView } from "@/components/states";
import { Button, Chip, type as T } from "@/components/ui";
import { colors, font, gutter, radius, shadow } from "@/theme";
import { HISTORY_STATUS, formatDateTime, groupHistory } from "@/utils/format";

const FILTERS: { value: HistoryFilter; label: string }[] = [
  { value: "all", label: "Tất cả" },
  { value: "found", label: "Đã tra cứu" },
  { value: "multiple", label: "Nhiều kết quả" },
  { value: "unrecognized", label: "Không nhận diện được" },
  { value: "failed", label: "Lỗi / đã hủy" },
];

function HistoryRow({ item }: { item: HistoryItem }) {
  const status = HISTORY_STATUS[item.status] ?? { label: item.status, tone: "neutral" as const };
  const icon = status.tone === "success" ? CircleCheck : CircleAlert;
  return (
    <Pressable onPress={() => router.push({ pathname: "/history/[historyId]", params: { historyId: item.id } })} accessibilityRole="button"
      accessibilityLabel={`${item.title}, ${status.label}`} style={({ pressed }) => [styles.row, pressed && { opacity: 0.8 }]}>
      <ScanThumbnail jobId={item.has_thumbnail ? item.job_id : null} width={64} height={54} radius={12} />
      <View style={{ flex: 1, minWidth: 0, gap: 6 }}>
        <Text style={[T.cardTitle, { fontSize: 16.5 }]} numberOfLines={1}>{item.title}</Text>
        <View style={styles.rowMeta}>
          <Text style={[T.small, { fontSize: 13.5, flexShrink: 1 }]} numberOfLines={1}>{formatDateTime(item.created_at)}</Text>
          <Chip label={status.label} tone={status.tone} size="sm" icon={icon} />
        </View>
      </View>
      <ChevronRight size={22} color="#7A8499" strokeWidth={2} />
    </Pressable>
  );
}

export default function HistoryScreen() {
  const { width } = useWindowDimensions();
  const pad = gutter(width);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<HistoryFilter>("all");
  const [items, setItems] = useState<HistoryItem[]>([]);
  const [nextBefore, setNextBefore] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [filterOpen, setFilterOpen] = useState(false);
  const request = useRef(0);

  const load = useCallback(async (mode: "initial" | "refresh" = "initial") => {
    const id = ++request.current;
    if (mode === "refresh") setRefreshing(true);
    else setLoading(true);
    setError(null);
    try {
      const page = await api.history({ q: query.trim() || undefined, status: filter });
      if (id !== request.current) return;
      setItems(page.items);
      setNextBefore(page.has_more ? page.next_before : null);
    } catch (e) {
      if (id === request.current) setError(e instanceof ApiError ? e : new ApiError(String(e), "http"));
    } finally {
      if (id === request.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [query, filter]);

  // Tìm kiếm: chờ người dùng ngừng gõ 300 ms.
  useEffect(() => {
    const timer = setTimeout(() => void load(), 300);
    return () => clearTimeout(timer);
  }, [load]);
  // Quay lại tab Lịch sử sau khi quét → làm mới (lần mở đầu đã tải ở trên).
  const latestLoad = useRef(load);
  useEffect(() => {
    latestLoad.current = load;
  }, [load]);
  const seen = useRef(false);
  useFocusEffect(useCallback(() => {
    if (seen.current) void latestLoad.current("refresh");
    seen.current = true;
  }, []));

  const loadMore = async () => {
    if (!nextBefore || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await api.history({ q: query.trim() || undefined, status: filter, before: nextBefore });
      setItems((prev) => [...prev, ...page.items.filter((i) => !prev.some((p) => p.id === i.id))]);
      setNextBefore(page.has_more ? page.next_before : null);
    } catch {
      /* thử lại khi cuộn tiếp */
    } finally {
      setLoadingMore(false);
    }
  };

  const sections = groupHistory(items);
  const filtered = Boolean(query.trim()) || filter !== "all";

  const header = (
    <View>
      <View style={{ paddingTop: 10, height: 52, justifyContent: "center" }}><AppHeaderBrand /></View>
      <Text style={[T.pageTitle, { fontSize: 30, lineHeight: 38, marginTop: 12 }]} accessibilityRole="header">Lịch sử quét</Text>
      <View style={styles.searchRow}>
        <View style={styles.search}>
          <Search size={22} color={colors.muted} strokeWidth={1.9} />
          <TextInput value={query} onChangeText={setQuery} placeholder="Tìm theo tên thuốc..." placeholderTextColor={colors.placeholder}
            style={styles.searchInput} returnKeyType="search" autoCorrect={false} accessibilityLabel="Tìm theo tên thuốc" testID="history-search" />
          {query ? <Pressable onPress={() => setQuery("")} accessibilityLabel="Xóa tìm kiếm" hitSlop={8}><X size={18} color={colors.muted} /></Pressable> : null}
        </View>
        <Pressable onPress={() => setFilterOpen(true)} accessibilityRole="button" accessibilityLabel="Lọc theo trạng thái"
          style={[styles.filterButton, filter !== "all" && { backgroundColor: colors.primary }]}>
          <SlidersHorizontal size={24} color={filter !== "all" ? "#fff" : colors.primary} strokeWidth={2} />
        </Pressable>
      </View>
      {filter !== "all" ? (
        <View style={{ flexDirection: "row", marginTop: 12 }}>
          <Pressable onPress={() => setFilter("all")} accessibilityRole="button" accessibilityLabel="Bỏ lọc">
            <Chip label={`${FILTERS.find((f) => f.value === filter)?.label}  ✕`} tone="primary" />
          </Pressable>
        </View>
      ) : null}
    </View>
  );

  return (
    <SafeAreaView edges={["top"]} style={{ flex: 1, backgroundColor: colors.bg }} testID="history-screen">
      <SectionList
        sections={sections}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => <HistoryRow item={item} />}
        renderSectionHeader={({ section }) => <Text style={styles.sectionTitle}>{section.title}</Text>}
        ItemSeparatorComponent={() => <View style={{ height: 12 }} />}
        ListHeaderComponent={header}
        stickySectionHeadersEnabled={false}
        contentContainerStyle={{ paddingHorizontal: pad, paddingBottom: 28, flexGrow: 1 }}
        onEndReached={() => void loadMore()}
        onEndReachedThreshold={0.4}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void load("refresh")} tintColor={colors.primary} colors={[colors.primary]} />}
        ListFooterComponent={loadingMore ? <ActivityIndicator color={colors.primary} style={{ marginTop: 16 }} /> : undefined}
        ListEmptyComponent={
          loading ? <ActivityIndicator color={colors.primary} size="large" style={{ marginTop: 48 }} />
          : error?.kind === "network" || error?.kind === "timeout" ? <ConnectionErrorView onRetry={() => void load()} />
          : error ? <Text style={[T.body, { color: colors.danger, marginTop: 24 }]}>{error.message}</Text>
          : (
            <View style={styles.empty}>
              <View style={styles.emptyIcon}><Clock size={40} color={colors.primary} strokeWidth={1.7} /></View>
              <Text style={[T.section, { textAlign: "center" }]}>{filtered ? "Không có lượt quét phù hợp" : "Chưa có lượt quét nào"}</Text>
              <Text style={[T.body, { textAlign: "center" }]}>{filtered ? "Thử từ khóa hoặc bộ lọc khác." : "Các lần quét thuốc của bạn sẽ được lưu ở đây để xem lại."}</Text>
              {!filtered ? <Button title="Quét thuốc" icon={ScanLine} onPress={() => router.navigate("/scan")} style={{ alignSelf: "stretch", marginTop: 8 }} /> : null}
            </View>
          )
        }
      />
      <Modal visible={filterOpen} transparent animationType="slide" onRequestClose={() => setFilterOpen(false)}>
        <Pressable style={{ flex: 1, backgroundColor: colors.overlay }} onPress={() => setFilterOpen(false)} accessibilityLabel="Đóng" />
        <View style={styles.sheet}>
          <View style={styles.grabber} />
          <Text style={T.section}>Lọc theo trạng thái</Text>
          <View style={{ marginTop: 12 }}>
            {FILTERS.map((option) => (
              <Pressable key={option.value} onPress={() => { setFilter(option.value); setFilterOpen(false); }} accessibilityRole="radio"
                accessibilityState={{ selected: filter === option.value }} style={styles.option}>
                <Text style={[T.bodyNavy, { fontSize: 16 }, filter === option.value && { color: colors.primary, fontFamily: font.semibold }]}>{option.label}</Text>
                <View style={[styles.radio, filter === option.value && { borderColor: colors.primary }]}>
                  {filter === option.value ? <View style={styles.radioDot} /> : null}
                </View>
              </Pressable>
            ))}
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  searchRow: { flexDirection: "row", gap: 12, marginTop: 20 },
  search: { flex: 1, flexDirection: "row", alignItems: "center", gap: 12, backgroundColor: "#EEF2F7", borderRadius: radius.card, paddingHorizontal: 16, minHeight: 54 },
  searchInput: { flex: 1, fontFamily: font.regular, fontSize: 16, color: colors.navy, paddingVertical: 12, outlineWidth: 0 },
  filterButton: { width: 54, height: 54, borderRadius: 18, backgroundColor: colors.primarySoft, alignItems: "center", justifyContent: "center" },
  sectionTitle: { fontFamily: font.bold, fontSize: 19, color: colors.navy, marginTop: 24, marginBottom: 12 },
  row: {
    flexDirection: "row", alignItems: "center", gap: 12, backgroundColor: colors.surface, borderRadius: radius.card, padding: 12,
    borderWidth: 1, borderColor: "#EEF1F5", ...shadow,
  },
  rowMeta: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8, flexWrap: "wrap" },
  empty: { alignItems: "center", gap: 10, marginTop: 48, paddingHorizontal: 8 },
  emptyIcon: { width: 96, height: 96, borderRadius: 48, backgroundColor: colors.primarySoft, alignItems: "center", justifyContent: "center", marginBottom: 8 },
  sheet: { backgroundColor: colors.surface, borderTopLeftRadius: 28, borderTopRightRadius: 28, padding: 24, paddingBottom: 36 },
  grabber: { alignSelf: "center", width: 44, height: 5, borderRadius: 3, backgroundColor: colors.border, marginBottom: 16 },
  option: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: colors.border },
  radio: { width: 24, height: 24, borderRadius: 12, borderWidth: 2, borderColor: "#B9C0CC", alignItems: "center", justifyContent: "center" },
  radioDot: { width: 12, height: 12, borderRadius: 6, backgroundColor: colors.primary },
});
