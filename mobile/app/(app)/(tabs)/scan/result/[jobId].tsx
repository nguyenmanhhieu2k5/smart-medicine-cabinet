import { router, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, View } from "react-native";
import { api, ApiError, type ScanJob } from "@/api";
import { Screen, ScreenHeader } from "@/components/layout";
import { ConnectionErrorView, UnrecognizedView } from "@/components/states";
import { ResultView } from "@/screens/ResultView";
import { colors } from "@/theme";

export default function ScanResultRoute() {
  const { jobId } = useLocalSearchParams<{ jobId: string }>();
  const [job, setJob] = useState<ScanJob | null>(null);
  const [error, setError] = useState<ApiError | null>(null);

  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let cancelled = false;
    api.scan(jobId).then(
      (value) => {
        if (!cancelled) {
          setJob(value);
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
  }, [jobId, attempt]);
  const load = useCallback(() => {
    setError(null);
    setAttempt((n) => n + 1);
  }, []);

  const back = () => router.navigate("/scan");
  if (error) {
    return (
      <Screen>
        <ScreenHeader title="Kết quả nhận diện" onBack={back} />
        {error.kind === "network" || error.kind === "timeout"
          ? <ConnectionErrorView onRetry={() => void load()} />
          : <UnrecognizedView title="Không mở được kết quả" message={error.message} onRescan={back} onPickOther={back} />}
      </Screen>
    );
  }
  if (!job) {
    return (
      <Screen>
        <ScreenHeader title="Kết quả nhận diện" onBack={back} />
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}><ActivityIndicator color={colors.primary} size="large" /></View>
      </Screen>
    );
  }
  return <ResultView job={job} historyId={job.history_id} onBack={back} />;
}
