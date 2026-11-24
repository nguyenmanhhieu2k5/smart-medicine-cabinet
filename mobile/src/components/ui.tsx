import type { LucideIcon } from "lucide-react-native";
import { forwardRef, useState, type ReactNode } from "react";
import {
  ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View, type StyleProp, type TextInputInstance, type TextInputProps, type TextStyle,
  type ViewStyle,
} from "react-native";
import { Eye, EyeOff } from "lucide-react-native";
import { buttonShadow, colors, font, radius, shadow } from "@/theme";

// ---- Chữ ------------------------------------------------------------------------------------ //
export const type = StyleSheet.create({
  display: { fontFamily: font.extrabold, fontSize: 30, lineHeight: 37, color: colors.navy, letterSpacing: -0.6 },
  pageTitle: { fontFamily: font.extrabold, fontSize: 28, lineHeight: 34, color: colors.navy, letterSpacing: -0.5 },
  screenTitle: { fontFamily: font.bold, fontSize: 20, lineHeight: 26, color: colors.navy, letterSpacing: -0.2 },
  section: { fontFamily: font.bold, fontSize: 18, lineHeight: 24, color: colors.navy },
  cardTitle: { fontFamily: font.bold, fontSize: 17, lineHeight: 22, color: colors.navy },
  body: { fontFamily: font.regular, fontSize: 15, lineHeight: 22, color: colors.muted },
  bodyNavy: { fontFamily: font.regular, fontSize: 15, lineHeight: 22, color: colors.navy },
  label: { fontFamily: font.semibold, fontSize: 14, lineHeight: 20, color: colors.navy },
  small: { fontFamily: font.regular, fontSize: 13, lineHeight: 18, color: colors.muted },
  link: { fontFamily: font.semibold, fontSize: 14, lineHeight: 20, color: colors.primary },
});

// ---- Nút ------------------------------------------------------------------------------------ //
interface ButtonProps {
  title: string;
  onPress?: () => void;
  icon?: LucideIcon;
  iconRight?: LucideIcon;
  loading?: boolean;
  disabled?: boolean;
  variant?: "primary" | "outline" | "secondary" | "danger";
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

export function Button({ title, onPress, icon: Icon, iconRight: IconRight, loading, disabled, variant = "primary", style, testID }: ButtonProps) {
  const inactive = disabled || loading;
  const palette = {
    primary: { bg: colors.primary, fg: "#FFFFFF", border: colors.primary },
    outline: { bg: colors.surface, fg: colors.primary, border: colors.primary },
    secondary: { bg: colors.surface, fg: colors.navy, border: colors.border },
    danger: { bg: colors.dangerSoft, fg: colors.danger, border: colors.dangerSoft },
  }[variant];
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={title}
      accessibilityState={{ disabled: Boolean(inactive), busy: Boolean(loading) }}
      disabled={inactive}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        { backgroundColor: palette.bg, borderColor: palette.border },
        variant === "primary" && !inactive && buttonShadow,
        pressed && { opacity: 0.85 },
        inactive && { opacity: variant === "primary" ? 0.7 : 0.55 },
        style,
      ]}
    >
      {loading ? <ActivityIndicator color={palette.fg} /> : Icon ? <Icon size={20} color={palette.fg} strokeWidth={2} /> : null}
      <Text style={[styles.buttonText, { color: palette.fg }]} numberOfLines={1}>{title}</Text>
      {IconRight && !loading ? <IconRight size={20} color={palette.fg} strokeWidth={2} /> : null}
    </Pressable>
  );
}

export function LinkButton({ title, onPress, icon: Icon, style, textStyle }: { title: string; onPress: () => void; icon?: LucideIcon; style?: StyleProp<ViewStyle>; textStyle?: StyleProp<TextStyle> }) {
  return (
    <Pressable accessibilityRole="link" accessibilityLabel={title} onPress={onPress} hitSlop={8} style={({ pressed }) => [styles.link, pressed && { opacity: 0.6 }, style]}>
      {Icon ? <Icon size={18} color={colors.primary} strokeWidth={2} /> : null}
      <Text style={[type.link, textStyle]}>{title}</Text>
    </Pressable>
  );
}

export function CircleButton({ icon: Icon, label, onPress, tone = "soft", size = 44, active, testID }: {
  icon: LucideIcon; label: string; onPress: () => void; tone?: "soft" | "outline"; size?: number; active?: boolean; testID?: string;
}) {
  return (
    <Pressable
      accessibilityRole="button" accessibilityLabel={label} accessibilityState={active === undefined ? undefined : { selected: active }}
      onPress={onPress} hitSlop={6} testID={testID}
      style={({ pressed }) => [
        { width: size, height: size, borderRadius: size / 2, alignItems: "center", justifyContent: "center" },
        tone === "soft" ? { backgroundColor: colors.primarySoft } : { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border },
        active && { backgroundColor: colors.primary, borderColor: colors.primary },
        pressed && { opacity: 0.7 },
      ]}
    >
      <Icon size={22} color={active ? colors.surface : colors.navy} strokeWidth={2} />
    </Pressable>
  );
}

// ---- Ô nhập --------------------------------------------------------------------------------- //
interface FieldProps extends TextInputProps {
  label: string;
  icon?: LucideIcon;
  error?: string | null;
  secure?: boolean;
  right?: ReactNode;
}

export const TextField = forwardRef<TextInputInstance, FieldProps>(function TextField({ label, icon: Icon, error, secure, right, style, editable = true, ...rest }, ref) {
  const [focused, setFocused] = useState(false);
  const [hidden, setHidden] = useState(true);
  return (
    <View style={styles.fieldWrap}>
      <Text style={type.label}>{label}</Text>
      <View style={[styles.field, focused && styles.fieldFocused, Boolean(error) && styles.fieldError, !editable && styles.fieldDisabled]}>
        {Icon ? <Icon size={20} color={colors.muted} strokeWidth={1.8} /> : null}
        <TextInput
          ref={ref}
          accessibilityLabel={label}
          placeholderTextColor={colors.placeholder}
          secureTextEntry={secure && hidden}
          editable={editable}
          onFocus={(e) => { setFocused(true); rest.onFocus?.(e); }}
          onBlur={(e) => { setFocused(false); rest.onBlur?.(e); }}
          style={[styles.input, !editable && { color: colors.muted }, style]}
          {...rest}
        />
        {secure ? (
          <Pressable accessibilityRole="button" accessibilityLabel={hidden ? "Hiện mật khẩu" : "Ẩn mật khẩu"} onPress={() => setHidden((v) => !v)} hitSlop={10}>
            {hidden ? <Eye size={20} color={colors.muted} strokeWidth={1.8} /> : <EyeOff size={20} color={colors.muted} strokeWidth={1.8} />}
          </Pressable>
        ) : right}
      </View>
      {error ? <Text style={[type.small, { color: colors.danger }]}>{error}</Text> : null}
    </View>
  );
});

// ---- Bề mặt, nhãn, hộp thông tin --------------------------------------------------------------- //
export function Card({ children, style, padded = true, testID }: { children: ReactNode; style?: StyleProp<ViewStyle>; padded?: boolean; testID?: string }) {
  return <View style={[styles.card, padded && { padding: 16 }, style]} testID={testID}>{children}</View>;
}

export type Tone = "primary" | "success" | "warning" | "danger" | "neutral";
const TONES: Record<Tone, { bg: string; fg: string }> = {
  primary: { bg: colors.primarySoft, fg: colors.primary },
  success: { bg: colors.successSoft, fg: colors.success },
  warning: { bg: colors.warningSoft, fg: colors.warningInk },
  danger: { bg: colors.dangerSoft, fg: colors.danger },
  neutral: { bg: "#F1F3F7", fg: colors.muted },
};

export function Chip({ label, tone = "primary", icon: Icon, size = "md", lines = 1 }: { label: string; tone?: Tone; icon?: LucideIcon; size?: "sm" | "md"; lines?: number }) {
  const t = TONES[tone];
  return (
    <View style={[styles.chip, { backgroundColor: t.bg }, size === "sm" && { paddingHorizontal: 9, paddingVertical: 4 }]}>
      {Icon ? <Icon size={size === "sm" ? 13 : 15} color={t.fg} strokeWidth={2.2} /> : null}
      <Text style={[styles.chipText, { color: t.fg, flexShrink: 1 }, size === "sm" && { fontSize: 12 }]} numberOfLines={lines}>{label}</Text>
    </View>
  );
}

export function IconTile({ icon: Icon, size = 44, tone = "primary", iconSize }: { icon: LucideIcon; size?: number; tone?: Tone; iconSize?: number }) {
  const t = TONES[tone];
  return (
    <View style={{ width: size, height: size, borderRadius: size * 0.3, backgroundColor: t.bg, alignItems: "center", justifyContent: "center" }}>
      <Icon size={iconSize ?? size * 0.48} color={t.fg} strokeWidth={1.9} />
    </View>
  );
}

export function InfoBox({ icon: Icon, title, children, tone = "primary" }: { icon: LucideIcon; title?: string; children: ReactNode; tone?: "primary" | "neutral" | "warning" }) {
  const fg = tone === "primary" ? colors.primary : tone === "warning" ? colors.warningInk : colors.muted;
  const ink = tone === "primary" ? "#3D5A8A" : tone === "warning" ? colors.warningInk : colors.muted;
  return (
    <View style={[styles.info, tone === "neutral" && { backgroundColor: "#F2F4F8" }, tone === "warning" && { backgroundColor: colors.warningSoft }]}>
      <Icon size={22} color={fg} strokeWidth={1.9} />
      <View style={{ flex: 1, gap: 2 }}>
        {title ? <Text style={[type.label, { fontSize: 15 }]}>{title}</Text> : null}
        <Text style={[type.small, { fontSize: 14, lineHeight: 20, color: ink }]}>{children}</Text>
      </View>
    </View>
  );
}

export function ErrorBanner({ message }: { message: string | null | undefined }) {
  if (!message) return null;
  return (
    <View style={styles.errorBanner} accessibilityRole="alert">
      <Text style={[type.small, { color: colors.danger, fontFamily: font.medium, fontSize: 14 }]}>{message}</Text>
    </View>
  );
}

export function Divider({ label }: { label: string }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
      <View style={{ flex: 1, height: 1, backgroundColor: colors.border }} />
      <Text style={type.small}>{label}</Text>
      <View style={{ flex: 1, height: 1, backgroundColor: colors.border }} />
    </View>
  );
}

const styles = StyleSheet.create({
  button: {
    minHeight: 52, borderRadius: radius.button, borderWidth: 1.5, paddingHorizontal: 20,
    flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 10,
  },
  buttonText: { fontFamily: font.bold, fontSize: 16, letterSpacing: -0.1 },
  link: { flexDirection: "row", alignItems: "center", gap: 6 },
  fieldWrap: { gap: 8 },
  field: {
    minHeight: 54, borderRadius: radius.control, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface,
    flexDirection: "row", alignItems: "center", paddingHorizontal: 16, gap: 12,
  },
  fieldFocused: { borderColor: colors.primary, borderWidth: 1.5 },
  fieldError: { borderColor: colors.danger },
  fieldDisabled: { backgroundColor: "#F5F6F8" },
  input: { flex: 1, fontFamily: font.regular, fontSize: 16, color: colors.navy, paddingVertical: 14, outlineWidth: 0 },
  card: { backgroundColor: colors.surface, borderRadius: radius.card, borderWidth: 1, borderColor: "#EEF1F5", ...shadow },
  chip: { flexDirection: "row", alignItems: "center", gap: 5, borderRadius: 14, paddingHorizontal: 11, paddingVertical: 6, alignSelf: "flex-start", maxWidth: "100%" },
  chipText: { fontFamily: font.semibold, fontSize: 13 },
  info: { flexDirection: "row", gap: 12, alignItems: "flex-start", backgroundColor: colors.primaryTint, borderRadius: radius.card, padding: 16 },
  errorBanner: { backgroundColor: colors.dangerSoft, borderRadius: 14, paddingHorizontal: 14, paddingVertical: 11 },
});
