import { router, useLocalSearchParams } from "expo-router";
import { Clock } from "lucide-react-native";
import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Text, View } from "react-native";
import { api, ApiError, type HistoryItem, type ScanJob } from "@/api";
import { Screen, ScreenHeader } from "@/components/layout";
import { ConnectionErrorView } from "@/components/states";
import { Button, ErrorBanner, IconTile, type as T } from "@/components/ui";
import { ResultView } from "@/screens/ResultView";
import { colors } from "@/theme";
import { formatDateTime } from "@/utils/format";

/** Mở lại một lượt quét trong lịch sử: hiện lại đúng kết quả đã lưu trong PostgreSQL. */
export default function HistoryDetailRoute() {
  const { historyId } = useLocalSearchParams<{ historyId: string }>();
  const [data, setData] = useState<{ item: HistoryItem; scan: ScanJob | null } | null>(null);
  const [error, setError] = useState<ApiError | null>(null);

  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let cancelled = false;
    api.historyDetail(historyId).then(
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
  }, [historyId, attempt]);
  const load = useCallback(() => {
    setError(null);
    setAttempt((n) => n + 1);
  }, []);

  const back = () => (router.canGoBack() ? router.back() : router.replace("/history"));
  if (error?.kind === "network" || error?.kind === "timeout") {
    return <Screen><ScreenHeader title="Kết quả nhận diện" onBack={back} /><ConnectionErrorView onRetry={() => void load()} /></Screen>;
  }
  if (!data) {
    return (
      <Screen>
        <ScreenHeader title="Kết quả nhận diện" onBack={back} />
        {error ? <ErrorBanner message={error.message} /> : <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}><ActivityIndicator color={colors.primary} size="large" /></View>}
      </Screen>
    );
  }
  if (data.scan?.status === "done") {
    return <ResultView job={data.scan} historyId={data.item.id} initialSelected={data.item.selected_medicine_id} onBack={back} />;
  }
  return (
    <Screen>
      <ScreenHeader title="Kết quả nhận diện" onBack={back} />
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center", gap: 12 }}>
        <IconTile icon={Clock} size={88} iconSize={38} />
        <Text style={[T.section, { textAlign: "center" }]}>{data.item.title}</Text>
        <Text style={[T.body, { textAlign: "center" }]}>{formatDateTime(data.item.created_at)}</Text>
        <Text style={[T.body, { textAlign: "center" }]}>{data.item.subtitle || "Lượt quét này không có kết quả để xem lại."}</Text>
        {data.item.top_medicine_id ? (
          <Button title="Xem thuốc đã nhận diện" onPress={() => router.push({ pathname: "/medicine/[id]", params: { id: String(data.item.top_medicine_id) } })}
            style={{ alignSelf: "stretch", marginTop: 12 }} />
        ) : null}
      </View>
    </Screen>
  );
}
