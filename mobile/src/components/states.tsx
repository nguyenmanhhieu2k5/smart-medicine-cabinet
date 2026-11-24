import { Globe, ImageIcon, RadioTower, RefreshCw, ScanLine, Server, X } from "lucide-react-native";
import type { ReactNode } from "react";
import { StyleSheet, Text, View } from "react-native";
import { colors, font } from "@/theme";
import { Button, LinkButton, type as T } from "./ui";

function Illustration({ children, badge }: { children: ReactNode; badge: ReactNode }) {
  return (
    <View style={styles.illustration}>
      {children}
      <View style={styles.badge}>{badge}</View>
    </View>
  );
}

/** “Không thể kết nối đến máy chủ” (thiết kế tổng quan 14). */
export function ConnectionErrorView({ message, onRetry, onServer, retrying }: { message?: string | null; onRetry: () => void; onServer?: () => void; retrying?: boolean }) {
  return (
    <View style={styles.wrap} accessibilityRole="alert">
      <Illustration badge={<X size={20} color="#fff" strokeWidth={3} />}>
        <RadioTower size={64} color={colors.primary} strokeWidth={1.6} />
      </Illustration>
      <Text style={[T.display, styles.title]}>Không thể kết nối đến máy chủ</Text>
      <Text style={[T.body, styles.text]}>{message || "Vui lòng kiểm tra kết nối Internet và thử lại."}</Text>
      <Button title="Thử lại" icon={RefreshCw} onPress={onRetry} loading={retrying} style={styles.button} testID="retry-connection" />
      {onServer ? <LinkButton title="Kiểm tra địa chỉ máy chủ" icon={Server} onPress={onServer} style={{ marginTop: 18 }} /> : null}
    </View>
  );
}

/** “Không nhận diện được thông tin thuốc” (thiết kế tổng quan 14). */
export function UnrecognizedView({ title, message, onRescan, onPickOther, onAi }: {
  title?: string; message?: string | null; onRescan: () => void; onPickOther: () => void; onAi?: () => void;
}) {
  return (
    <View style={styles.wrap} testID="unrecognized">
      <Illustration badge={<Text style={styles.bang}>!</Text>}>
        <ImageIcon size={64} color={colors.primary} strokeWidth={1.6} />
      </Illustration>
      <Text style={[T.display, styles.title]}>{title ?? "Không nhận diện được thông tin thuốc"}</Text>
      <Text style={[T.body, styles.text]}>{message || "Ảnh có thể bị mờ, thiếu sáng hoặc không chứa chữ rõ ràng. Vui lòng thử lại với ảnh khác."}</Text>
      <Button title="Quét lại" icon={ScanLine} onPress={onRescan} style={styles.button} />
      <Button title="Chọn ảnh khác" icon={ImageIcon} variant="outline" onPress={onPickOther} style={[styles.button, { marginTop: 12 }]} />
      {onAi ? (
        <Button title="Tìm trên mạng" icon={Globe} variant="secondary" onPress={onAi} style={[styles.button, { marginTop: 12 }]} testID="ai-search" />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, alignItems: "center", justifyContent: "center", paddingVertical: 24 },
  illustration: {
    width: 148, height: 148, borderRadius: 74, backgroundColor: colors.primarySoft, alignItems: "center", justifyContent: "center", marginBottom: 28,
  },
  badge: {
    position: "absolute", right: 14, bottom: 22, width: 40, height: 40, borderRadius: 20, backgroundColor: colors.danger,
    alignItems: "center", justifyContent: "center", borderWidth: 3, borderColor: colors.bg,
  },
  bang: { color: "#fff", fontFamily: font.extrabold, fontSize: 22, lineHeight: 26 },
  title: { textAlign: "center", fontSize: 26, lineHeight: 32 },
  text: { textAlign: "center", marginTop: 12, maxWidth: 320 },
  button: { alignSelf: "stretch", marginTop: 28 },
});
