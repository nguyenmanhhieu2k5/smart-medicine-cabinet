import { ArrowLeft, Globe, Server } from "lucide-react-native";
import { useState } from "react";
import { Text, View } from "react-native";
import { ApiError } from "@/api";
import { ServerUrlError, displayHost } from "@/api/server";
import { useAuth } from "@/auth/AuthProvider";
import { Screen } from "@/components/layout";
import { Button, CircleButton, ErrorBanner, IconTile, InfoBox, TextField, type as T } from "@/components/ui";
import { colors } from "@/theme";

/** Địa chỉ API công khai của Mini PC (Tailscale Funnel hoặc Cloudflare Tunnel). Kiểm tra /api/v1/health rồi mới lưu. */
export function ServerScreen({ onDone, onBack }: { onDone: () => void; onBack?: () => void }) {
  const { serverUrl, setServer } = useAuth();
  const [value, setValue] = useState(serverUrl);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    setOk(null);
    try {
      const { version } = await setServer(value);
      setOk(`Đã kết nối máy chủ phiên bản ${version}.`);
      onDone();
    } catch (e) {
      if (e instanceof ServerUrlError) setError(e.message);
      else if (e instanceof ApiError && e.status === 404) setError("Địa chỉ này không phải API của Tủ thuốc thông minh.");
      else setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen scroll keyboard>
      <View style={{ paddingTop: 10, flexDirection: "row" }}>
        <CircleButton icon={ArrowLeft} label="Quay lại" tone="outline" onPress={onBack ?? onDone} />
      </View>
      <View style={{ alignItems: "center", marginTop: 12 }}>
        <IconTile icon={Server} size={96} iconSize={40} />
        <Text style={[T.display, { textAlign: "center", marginTop: 26 }]}>Máy chủ</Text>
        <Text style={[T.body, { textAlign: "center", marginTop: 10 }]}>
          Nhập địa chỉ công khai của máy chủ Mini PC. Điện thoại không cần chung mạng Wi-Fi với máy chủ.
        </Text>
      </View>
      <View style={{ marginTop: 30, gap: 18 }}>
        <TextField label="Địa chỉ máy chủ" icon={Globe} value={value} onChangeText={setValue} placeholder="https://may-chu.ten-tailnet.ts.net:8443"
          autoCapitalize="none" autoCorrect={false} keyboardType="url" returnKeyType="done" onSubmitEditing={() => void submit()} testID="server-url" />
        <ErrorBanner message={error} />
        {ok ? <Text style={[T.small, { color: colors.success }]}>{ok}</Text> : null}
        <Button title="Kiểm tra và lưu" onPress={() => void submit()} loading={busy} disabled={!value.trim()} />
        {serverUrl ? <Text style={[T.small, { textAlign: "center" }]}>Đang dùng: {displayHost(serverUrl)}</Text> : null}
      </View>
      <View style={{ marginTop: 28 }}>
        <InfoBox icon={Server} tone="neutral">
          Địa chỉ do quản trị viên cung cấp, ví dụ https://may-chu.ten-tailnet.ts.net:8443 (Tailscale Funnel) hoặc https://api.tuthuoc.example (Cloudflare). Điện thoại không cần cài Tailscale. Ứng dụng chỉ dùng kết nối mã hóa https.
        </InfoBox>
      </View>
    </Screen>
  );
}
