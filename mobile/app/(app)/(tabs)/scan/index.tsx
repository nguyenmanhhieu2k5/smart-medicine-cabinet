import { CameraView, useCameraPermissions } from "expo-camera";
import { useIsFocused } from "expo-router";
import { Barcode, Camera, CameraOff, Check, Flashlight, FlashlightOff, ImageIcon, ShieldCheck, User, X } from "lucide-react-native";
import { useRef, useState } from "react";
import { ActivityIndicator, Linking, Modal, Platform, Pressable, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import { useAuth } from "@/auth/AuthProvider";
import { AppHeaderBrand } from "@/components/brand";
import { Screen } from "@/components/layout";
import { Button, Chip, ErrorBanner, type as T } from "@/components/ui";
import { BARCODE_TYPES, useBarcodeScanner } from "@/scan/barcode";
import { pickFromLibrary, prepareImage, type ImageQuality } from "@/scan/image";
import { cameraErrorMessage, scanErrorMessage, startScan } from "@/scan/startScan";
import { colors, font } from "@/theme";

function Corners() {
  const corner = (pos: object) => <View style={[styles.corner, pos]} />;
  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      {corner({ top: 22, left: 22, borderTopWidth: 4, borderLeftWidth: 4, borderTopLeftRadius: 18 })}
      {corner({ top: 22, right: 22, borderTopWidth: 4, borderRightWidth: 4, borderTopRightRadius: 18 })}
      {corner({ bottom: 22, left: 22, borderBottomWidth: 4, borderLeftWidth: 4, borderBottomLeftRadius: 18 })}
      {corner({ bottom: 22, right: 22, borderBottomWidth: 4, borderRightWidth: 4, borderBottomRightRadius: 18 })}
    </View>
  );
}

function RoleSheet({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const rows = [
    [true, "Quét ảnh hoặc mã vạch hộp thuốc, xem tối đa 3 kết quả phù hợp"],
    [true, "Xem chi tiết thuốc từ cơ sở dữ liệu (chỉ đọc)"],
    [true, "Xem lại lịch sử quét của chính bạn"],
    [true, "Xem thuốc trong tủ và sửa ngày hết hạn"],
    [false, "Không thể thêm, xóa thuốc hay sửa thông tin khác trong tủ"],
    [false, "Không thể điều khiển tủ thuốc (ESP32)"],
  ] as const;
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose} accessibilityLabel="Đóng" />
      <View style={styles.sheet}>
        <View style={styles.grabber} />
        <Text style={T.section}>Tài khoản Scanner</Text>
        <Text style={[T.body, { marginTop: 4 }]}>Tài khoản tự đăng ký: quét, tra cứu, xem lịch sử và sửa hạn dùng thuốc trong tủ.</Text>
        <View style={{ marginTop: 16, gap: 12 }}>
          {rows.map(([allowed, text]) => (
            <View key={text} style={{ flexDirection: "row", gap: 12, alignItems: "flex-start" }}>
              {allowed ? <Check size={20} color={colors.success} strokeWidth={2.4} /> : <X size={20} color={colors.danger} strokeWidth={2.4} />}
              <Text style={[T.bodyNavy, { flex: 1 }]}>{text}</Text>
            </View>
          ))}
        </View>
        <Button title="Đã hiểu" onPress={onClose} style={{ marginTop: 24 }} />
      </View>
    </Modal>
  );
}

export default function ScanScreen() {
  const { user } = useAuth();
  const focused = useIsFocused();
  const { width } = useWindowDimensions();
  const [permission, requestPermission] = useCameraPermissions();
  const camera = useRef<CameraView>(null);
  const [torch, setTorch] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"camera" | "upload" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [roleOpen, setRoleOpen] = useState(false);
  const quality: ImageQuality = user?.preferences?.image_quality === "high" ? "high" : "standard";
  const vibrate = user?.preferences?.vibrate_on_scan !== false;
  const shutter = width < 375 ? 84 : 92;

  const capture = async () => {
    if (!camera.current || busy) return;
    setBusy("camera");
    setError(null);
    try {
      const photo = await camera.current.takePictureAsync({ quality: 0.92, exif: false }).catch(() => {
        throw new Error("Camera chưa sẵn sàng hoặc không chụp được. Đợi vài giây rồi thử lại, hoặc dùng “Chọn ảnh”.");
      });
      if (!photo) throw new Error("Không chụp được ảnh.");
      const image = await prepareImage(photo.uri, photo.width, photo.height, quality);
      await startScan(image, "camera", { vibrate });
    } catch (e) {
      setError(scanErrorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const pick = async () => {
    if (busy) return;
    setBusy("upload");
    setError(null);
    try {
      const image = await pickFromLibrary(quality);
      if (image) await startScan(image, "upload", { vibrate });
    } catch (e) {
      setError(scanErrorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const granted = permission?.granted === true;
  // Nút chụp KHÔNG chờ tín hiệu “camera sẵn sàng” (một số máy Android không gửi) — chụp lỗi thì báo rõ.
  const canShoot = granted && !cameraError && !busy;
  // Mã vạch được nhận ngay trong khung camera; tạm dừng khi đang gửi ảnh hoặc màn hình không hiển thị.
  const barcode = useBarcodeScanner({ enabled: granted && focused && !busy && !cameraError, vibrate });
  const firstName = user?.full_name?.trim() || "Scanner";

  return (
    <Screen testID="scan-screen">
      <View style={styles.top}>
        <AppHeaderBrand />
      </View>
      <View style={styles.greeting}>
        <View style={styles.avatar}><User size={30} color="#7A8BA8" strokeWidth={1.8} /></View>
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={[T.body, { fontSize: 16, color: colors.navy }]}>Xin chào,</Text>
          <Text style={styles.name} numberOfLines={1}>{firstName}</Text>
          <Chip label="Chỉ đọc" icon={ShieldCheck} size="sm" />
        </View>
        <Pressable onPress={() => setRoleOpen(true)} accessibilityRole="button" accessibilityLabel="Quyền của tài khoản" style={styles.shield} hitSlop={6}>
          <ShieldCheck size={26} color={colors.primary} strokeWidth={2} />
        </Pressable>
      </View>

      <View style={styles.frame} testID="camera-frame">
        {granted && focused && !cameraError ? (
          <CameraView ref={camera} style={StyleSheet.absoluteFill} facing="back" mirror={false} enableTorch={torch}
            barcodeScannerSettings={{ barcodeTypes: BARCODE_TYPES }}
            onBarcodeScanned={busy ? undefined : (result) => void barcode.onScanned(result)}
            onMountError={(e) => setCameraError(cameraErrorMessage(e.message))} />
        ) : null}
        {granted && cameraError ? (
          <View style={styles.placeholder} testID="camera-error">
            <CameraOff size={40} color={colors.primary} strokeWidth={1.6} />
            <Text style={styles.placeholderTitle}>Không mở được camera</Text>
            <Text style={styles.placeholderText}>{cameraError} Bạn vẫn quét được bằng ảnh có sẵn.</Text>
            <View style={{ flexDirection: "row", gap: 10, marginTop: 14 }}>
              <Button title="Chọn ảnh" icon={ImageIcon} variant="secondary" style={{ minHeight: 44 }} onPress={() => void pick()} />
              <Button title="Thử lại" variant="secondary" style={{ minHeight: 44 }} onPress={() => setCameraError(null)} />
            </View>
          </View>
        ) : null}
        {!permission ? (
          <View style={styles.placeholder}><ActivityIndicator color={colors.primary} /></View>
        ) : !granted ? (
          <View style={styles.placeholder}>
            <Camera size={40} color={colors.primary} strokeWidth={1.6} />
            <Text style={styles.placeholderTitle}>Cần quyền truy cập camera</Text>
            <Text style={styles.placeholderText}>
              {permission.canAskAgain ? "Cho phép camera để chụp hộp hoặc vỉ thuốc. Bạn vẫn có thể chọn ảnh có sẵn." : "Bạn đã tắt quyền camera. Hãy bật lại trong Cài đặt của điện thoại."}
            </Text>
            <Button title={permission.canAskAgain ? "Cho phép camera" : "Mở Cài đặt"} variant="secondary" style={{ marginTop: 14, minHeight: 44 }}
              onPress={() => (permission.canAskAgain ? void requestPermission() : void Linking.openSettings())} />
          </View>
        ) : null}
        <Corners />
        {barcode.looking || barcode.notice ? (
          <Pressable style={styles.barcodeNotice} onPress={barcode.dismiss} accessibilityRole="alert" testID="barcode-notice">
            {barcode.looking ? <ActivityIndicator color="#fff" size="small" /> : <Barcode size={20} color="#fff" strokeWidth={1.8} />}
            <Text style={styles.barcodeNoticeText}>{barcode.looking ? "Đang tra mã vạch…" : barcode.notice?.message}</Text>
          </Pressable>
        ) : null}
        {busy ? (
          <View style={[styles.placeholder, { backgroundColor: "rgba(17,27,57,0.55)" }]}>
            <ActivityIndicator color="#fff" size="large" />
            <Text style={[styles.placeholderTitle, { color: "#FFFFFF" }]}>Đang gửi ảnh lên máy chủ…</Text>
          </View>
        ) : null}
      </View>

      <Text style={styles.hint}>Đưa tên thuốc hoặc mã vạch trên hộp{"\n"}vào khung để quét</Text>
      <ErrorBanner message={error} />

      <View style={styles.controls}>
        <View style={styles.side}>
          <Pressable onPress={() => void pick()} disabled={Boolean(busy)} accessibilityRole="button" accessibilityLabel="Chọn ảnh"
            style={({ pressed }) => [styles.sideButton, pressed && { opacity: 0.7 }]} testID="pick-image">
            <ImageIcon size={26} color={colors.navy} strokeWidth={1.8} />
          </Pressable>
          <Text style={styles.sideLabel}>Chọn ảnh</Text>
        </View>
        <Pressable onPress={() => void capture()} disabled={!canShoot} accessibilityRole="button" accessibilityLabel="Chụp và quét"
          style={({ pressed }) => [styles.shutter, { width: shutter, height: shutter, borderRadius: shutter / 2 }, !canShoot && !busy && { opacity: 0.5 }, pressed && { transform: [{ scale: 0.96 }] }]}
          testID="shutter">
          {busy === "camera" ? <ActivityIndicator color="#fff" size="large" /> : <Camera size={38} color="#fff" strokeWidth={2} />}
        </Pressable>
        <View style={styles.side}>
          <Pressable onPress={() => setTorch((v) => !v)} disabled={!granted || Platform.OS === "web"} accessibilityRole="switch" accessibilityState={{ checked: torch }}
            accessibilityLabel="Đèn flash" style={({ pressed }) => [styles.sideButton, torch && { backgroundColor: colors.primarySoft, borderColor: colors.primary }, pressed && { opacity: 0.7 }]}>
            {torch ? <Flashlight size={26} color={colors.primary} strokeWidth={1.8} /> : <FlashlightOff size={26} color={colors.navy} strokeWidth={1.8} />}
          </Pressable>
          <Text style={styles.sideLabel}>Đèn flash</Text>
        </View>
      </View>
      <RoleSheet visible={roleOpen} onClose={() => setRoleOpen(false)} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  top: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingTop: 10, height: 52 },
  greeting: { flexDirection: "row", alignItems: "center", gap: 14, marginTop: 10, marginBottom: 16 },
  avatar: { width: 60, height: 60, borderRadius: 30, backgroundColor: colors.primaryTint, alignItems: "center", justifyContent: "center" },
  name: { fontFamily: font.extrabold, fontSize: 24, lineHeight: 30, color: colors.navy, letterSpacing: -0.4 },
  shield: { width: 52, height: 52, borderRadius: 18, backgroundColor: colors.primarySoft, alignItems: "center", justifyContent: "center" },
  // (4) Nền vùng camera/quét thuốc #E6F2FF (camera bật thì hình camera phủ lên).
  frame: { flex: 1, minHeight: 220, borderRadius: 26, overflow: "hidden", backgroundColor: colors.primarySoft },
  corner: { position: "absolute", width: 46, height: 46, borderColor: "#FFFFFF" },
  placeholder: { ...StyleSheet.absoluteFill, alignItems: "center", justifyContent: "center", padding: 28, gap: 8 },
  placeholderTitle: { fontFamily: font.semibold, fontSize: 16, color: colors.navy, textAlign: "center", marginTop: 6 },
  placeholderText: { fontFamily: font.regular, fontSize: 14, lineHeight: 20, color: colors.muted, textAlign: "center" },
  barcodeNotice: {
    position: "absolute", left: 16, right: 16, bottom: 16, flexDirection: "row", alignItems: "center", gap: 10,
    backgroundColor: "rgba(17,27,57,0.82)", borderRadius: 16, paddingVertical: 12, paddingHorizontal: 14,
  },
  barcodeNoticeText: { flex: 1, fontFamily: font.medium, fontSize: 14, lineHeight: 20, color: "#FFFFFF" },
  hint: { fontFamily: font.medium, fontSize: 16, lineHeight: 23, color: "#3A4560", textAlign: "center", marginVertical: 16 },
  controls: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 6, paddingBottom: 16 },
  side: { alignItems: "center", gap: 8, width: 88 },
  sideButton: {
    width: 56, height: 56, borderRadius: 28, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface,
    alignItems: "center", justifyContent: "center",
  },
  sideLabel: { fontFamily: font.medium, fontSize: 14, color: colors.navy },
  shutter: { backgroundColor: colors.primary, alignItems: "center", justifyContent: "center", shadowColor: colors.primary, shadowOpacity: 0.35, shadowRadius: 18, shadowOffset: { width: 0, height: 10 }, elevation: 6 },
  backdrop: { flex: 1, backgroundColor: colors.overlay },
  sheet: { backgroundColor: colors.surface, borderTopLeftRadius: 28, borderTopRightRadius: 28, padding: 24, paddingBottom: 36 },
  grabber: { alignSelf: "center", width: 44, height: 5, borderRadius: 3, backgroundColor: colors.border, marginBottom: 16 },
});
