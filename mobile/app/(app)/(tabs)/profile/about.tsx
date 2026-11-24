import Constants from "expo-constants";
import { Database, ScanLine, ShieldCheck } from "lucide-react-native";
import { Text, View } from "react-native";
import { displayHost } from "@/api/server";
import { useAuth } from "@/auth/AuthProvider";
import { LogoMark } from "@/components/brand";
import { Screen, ScreenHeader } from "@/components/layout";
import { Card, InfoBox, type as T } from "@/components/ui";
import { colors } from "@/theme";

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View style={{ flexDirection: "row", justifyContent: "space-between", paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: colors.border, gap: 12 }}>
      <Text style={T.body}>{label}</Text>
      <Text style={[T.label, { flexShrink: 1, textAlign: "right" }]}>{value}</Text>
    </View>
  );
}

export default function AboutScreen() {
  const { config, serverUrl } = useAuth();
  return (
    <Screen scroll>
      <ScreenHeader title="Giới thiệu ứng dụng" />
      <View style={{ alignItems: "center", marginTop: 6 }}>
        <LogoMark size={84} />
        <Text style={[T.display, { fontSize: 24, marginTop: 16 }]}>Tủ thuốc thông minh</Text>
        <Text style={[T.body, { textAlign: "center", marginTop: 6 }]}>Nhận diện thuốc bằng OCR và tra cứu trong cơ sở dữ liệu thuốc.</Text>
      </View>
      <Card style={{ marginTop: 22, paddingVertical: 4 }}>
        <Row label="Phiên bản ứng dụng" value={Constants.expoConfig?.version ?? "—"} />
        <Row label="Phiên bản máy chủ" value={config?.server_version ?? "—"} />
        <Row label="Máy chủ" value={displayHost(serverUrl)} />
        <Row label="Nguồn dữ liệu" value="CSDL Dược (DAV_unique)" />
      </Card>
      <View style={{ gap: 12, marginTop: 18 }}>
        <InfoBox icon={ScanLine}>Ảnh được nhận diện trên máy chủ Mini PC (PaddleOCR), tối đa 3 kết quả phù hợp cho mỗi lần quét.</InfoBox>
        <InfoBox icon={Database}>Dữ liệu thuốc, lịch sử quét và tài khoản lưu trong PostgreSQL trên Mini PC.</InfoBox>
        <InfoBox icon={ShieldCheck}>Ứng dụng điện thoại chỉ có quyền Scanner: không thêm thuốc vào tủ và không điều khiển thiết bị.</InfoBox>
      </View>
    </Screen>
  );
}
