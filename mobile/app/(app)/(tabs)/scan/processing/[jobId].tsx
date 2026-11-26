import { router, useLocalSearchParams } from "expo-router";
import { Check, Info, ScanLine, Square } from "lucide-react-native";
import { useCallback, useEffect, useRef, useState } from "react";
import { Animated, Easing, StyleSheet, Text, View } from "react-native";
import Svg, { Circle } from "react-native-svg";
import { api, ApiError, type ScanJob, type ScanStage } from "@/api";
import { useAuth } from "@/auth/AuthProvider";
import { Screen, ScreenHeader } from "@/components/layout";
import { useHideTabBar } from "@/components/tabBarVisibility";
import { ConnectionErrorView, UnrecognizedView } from "@/components/states";
import { Button, Card, Chip, InfoBox, type as T } from "@/components/ui";
import { pickFromLibrary } from "@/scan/image";
import { scanErrorMessage, submitOrPromptLogin } from "@/scan/startScan";
import { colors, font } from "@/theme";

const POLL_MS = 600;
const FALLBACK_STAGES: ScanStage[] = [
  { key: "image", label: "Xử lý hình ảnh", state: "active" },
  { key: "ocr", label: "Nhận dạng văn bản (OCR)", state: "pending" },
  { key: "lookup", label: "Tra cứu trong cơ sở dữ liệu", state: "pending" },
  { key: "summary", label: "Tổng hợp kết quả", state: "pending" },
];

function Ring({ progress }: { progress: number }) {
  const [spin] = useState(() => new Animated.Value(0));
  useEffect(() => {
    const loop = Animated.loop(Animated.timing(spin, { toValue: 1, duration: 1600, easing: Easing.linear, useNativeDriver: true }));
    loop.start();
    return () => loop.stop();
  }, [spin]);
  const rotate = spin.interpolate({ inputRange: [0, 1], outputRange: ["0deg", "360deg"] });
  const size = 172;
  const r = 79;
  const c = 2 * Math.PI * r;
  const arc = Math.max(0.12, Math.min(1, progress / 100)) * c * 0.5;
  return (
    <View style={{ width: size, height: size, alignItems: "center", justifyContent: "center" }}>
      <View style={styles.outer} />
      <View style={styles.inner}><ScanLine size={58} color={colors.primary} strokeWidth={2} /></View>
      <Animated.View style={[StyleSheet.absoluteFill, { transform: [{ rotate }] }]}>
        <Svg width={size} height={size}>
          <Circle cx={size / 2} cy={size / 2} r={r} stroke={colors.primary} strokeWidth={6} strokeLinecap="round" fill="none"
            strokeDasharray={`${arc} ${c}`} transform={`rotate(-90 ${size / 2} ${size / 2})`} />
        </Svg>
      </Animated.View>
    </View>
  );
}

function StageRow({ stage, last }: { stage: ScanStage; last: boolean }) {
  const icon =
    stage.state === "done" ? <View style={styles.doneDot}><Check size={16} color="#fff" strokeWidth={3} /></View>
    : stage.state === "active" ? <View style={[styles.ring, { borderColor: colors.primary, borderRightColor: colors.primarySoft }]} />
    : stage.state === "failed" ? <View style={[styles.ring, { borderColor: colors.danger }]} />
    : <View style={styles.ring} />;
  return (
    <View style={[styles.stage, !last && styles.stageBorder]}>
      {icon}
      <Text style={[T.bodyNavy, { flex: 1, fontSize: 15 }, stage.state === "pending" && { color: colors.muted }]} numberOfLines={1}>{stage.label}</Text>
      {stage.state === "done" ? <Chip label="Hoàn thành" tone="success" size="sm" />
        : stage.state === "active" ? <Chip label="Đang xử lý" tone="primary" size="sm" />
        : stage.state === "failed" ? <Chip label="Lỗi" tone="danger" size="sm" />
        : <Text style={[T.small, { fontSize: 13 }]}>Chờ xử lý</Text>}
    </View>
  );
}

export default function ProcessingScreen() {
  useHideTabBar(); // thiết kế 06 không có thanh tab
  const { jobId } = useLocalSearchParams<{ jobId: string }>();
  const { config } = useAuth();
  const timeoutMs = (config?.ocr_timeout_seconds ?? 30) * 1000;
  const [job, setJob] = useState<ScanJob | null>(null);
  const [phase, setPhase] = useState<"polling" | "timeout" | "offline" | "failed">("polling");
  const [failure, setFailure] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const started = useRef(0);
  const networkFailures = useRef(0);

  const poll = useCallback(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    if (!started.current) started.current = Date.now();
    const tick = async () => {
      try {
        const current = await api.scan(jobId);
        networkFailures.current = 0;
        if (stopped) return;
        setJob(current);
        if (current.status === "done") {
          router.replace({ pathname: "/scan/result/[jobId]", params: { jobId } });
          return;
        }
        if (current.status === "error" || current.status === "cancelled") {
          setFailure(current.error || current.message || "Nhận diện thất bại.");
          setPhase("failed");
          return;
        }
        if (Date.now() - started.current > timeoutMs) {
          setPhase("timeout");
          return;
        }
      } catch (e) {
        if (stopped) return;
        if (e instanceof ApiError && (e.kind === "network" || e.kind === "timeout")) {
          networkFailures.current += 1;
          if (networkFailures.current >= 3) {
            setPhase("offline");
            return;
          }
        } else {
          setFailure(scanErrorMessage(e));
          setPhase("failed");
          return;
        }
      }
      timer = setTimeout(tick, POLL_MS);
    };
    void tick();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [jobId, timeoutMs]);

  useEffect(() => (phase === "polling" ? poll() : undefined), [phase, poll]);

  const cancel = async () => {
    setCancelling(true);
    await api.cancelScan(jobId).catch(() => undefined);
    setCancelling(false);
    router.back();
  };

  const pickOther = async () => {
    try {
      const image = await pickFromLibrary();
      if (!image) return;
      const next = await submitOrPromptLogin(image, "upload"); // khách hết lượt quét thử → đăng nhập
      if (next) router.replace({ pathname: "/scan/processing/[jobId]", params: { jobId: next.id } });
    } catch (e) {
      setFailure(scanErrorMessage(e));
    }
  };

  if (phase === "offline") {
    return (
      <Screen>
        <ScreenHeader title="Nhận diện thuốc" onBack={() => router.back()} />
        <ConnectionErrorView onRetry={() => { networkFailures.current = 0; started.current = Date.now(); setPhase("polling"); }} />
      </Screen>
    );
  }
  if (phase === "failed") {
    return (
      <Screen>
        <ScreenHeader title="Không thể nhận diện" onBack={() => router.back()} />
        <UnrecognizedView message={failure} onRescan={() => router.back()} onPickOther={() => void pickOther()} />
      </Screen>
    );
  }

  const progress = Math.round(job?.progress ?? 5);
  const stages = job?.stages ?? FALLBACK_STAGES;
  const timedOut = phase === "timeout";

  return (
    <Screen scroll testID="processing-screen">
      <ScreenHeader title="Nhận diện thuốc" onBack={() => void cancel()} />
      <View style={{ alignItems: "center", marginTop: 8 }}>
        <Ring progress={progress} />
        <Text style={[T.display, { fontSize: 26, marginTop: 18, textAlign: "center" }]} accessibilityLiveRegion="polite">
          {timedOut ? "Xử lý lâu hơn dự kiến" : "Đang xử lý ảnh..."}
        </Text>
        <Text style={[T.body, { marginTop: 6, textAlign: "center", fontSize: 14 }]}>
          {timedOut ? "Máy chủ chưa trả kết quả sau 30 giây." : "Hệ thống đang nhận diện và tra cứu thông tin thuốc"}
        </Text>
      </View>
      <View style={styles.progressRow} accessibilityRole="progressbar" accessibilityValue={{ min: 0, max: 100, now: progress }}>
        <View style={styles.track}><View style={[styles.fill, { width: `${Math.max(4, progress)}%` }]} /></View>
        <Text style={styles.percent}>{progress}%</Text>
      </View>
      <Card padded={false} style={{ paddingHorizontal: 16, marginTop: 18 }}>
        {stages.map((stage, i) => <StageRow key={stage.key} stage={stage} last={i === stages.length - 1} />)}
      </Card>
      <View style={{ marginTop: 16 }}>
        <InfoBox icon={Info} title={`Quá trình có thể mất tối đa ${Math.round(timeoutMs / 1000)} giây`}>
          Nếu xử lý quá lâu, vui lòng thử lại hoặc kiểm tra kết nối Internet.
        </InfoBox>
      </View>
      {timedOut ? (
        <View style={{ gap: 12, marginTop: 22 }}>
          <Button title="Tiếp tục chờ" onPress={() => { started.current = Date.now(); setPhase("polling"); }} />
          <Button title="Hủy và quét lại" variant="outline" onPress={() => void cancel()} loading={cancelling} />
        </View>
      ) : (
        <Button title="Hủy xử lý" icon={Square} variant="outline" onPress={() => void cancel()} loading={cancelling} style={{ marginTop: 18 }} testID="cancel-scan" />
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  outer: { position: "absolute", width: 172, height: 172, borderRadius: 86, backgroundColor: colors.primaryTint },
  inner: { width: 124, height: 124, borderRadius: 62, backgroundColor: colors.primarySoft, alignItems: "center", justifyContent: "center" },
  progressRow: { flexDirection: "row", alignItems: "center", gap: 14, marginTop: 20 },
  track: { flex: 1, height: 12, borderRadius: 6, backgroundColor: colors.primarySoft, overflow: "hidden" },
  fill: { height: "100%", borderRadius: 6, backgroundColor: colors.primary },
  percent: { fontFamily: font.bold, fontSize: 18, color: colors.primary, minWidth: 48, textAlign: "right" },
  stage: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 14 },
  stageBorder: { borderBottomWidth: 1, borderBottomColor: colors.border },
  doneDot: { width: 26, height: 26, borderRadius: 13, backgroundColor: colors.primary, alignItems: "center", justifyContent: "center" },
  ring: { width: 26, height: 26, borderRadius: 13, borderWidth: 2.5, borderColor: "#C5CBD6" },
});
