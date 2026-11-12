import clsx from "clsx";
import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

export type Tone = "success" | "warning" | "danger" | "info" | "neutral";

const TONES: Record<Tone, string> = {
  success: "bg-success-soft text-success",
  warning: "bg-warning-soft text-warning-ink",
  danger: "bg-danger-soft text-danger",
  info: "bg-primary-soft text-primary",
  neutral: "bg-tile text-muted",
};
const DOTS: Record<Tone, string> = {
  success: "bg-success", warning: "bg-warning", danger: "bg-danger", info: "bg-primary", neutral: "bg-muted/60",
};

interface StatusIndicatorProps {
  tone?: Tone;
  icon?: LucideIcon;
  dot?: boolean;
  size?: "sm" | "md";
  className?: string;
  children: ReactNode;
}

/** Nhãn trạng thái dạng viên thuốc: luôn kèm chữ, không chỉ dựa vào màu. */
export function StatusIndicator({ tone = "neutral", icon: Icon, dot = false, size = "md", className, children }: StatusIndicatorProps) {
  return (
    <span
      className={clsx(
        "inline-flex items-center gap-1.5 whitespace-nowrap rounded-full font-semibold",
        size === "sm" ? "px-2.5 py-1 text-[12px]" : "px-3 py-1.5 text-[13px]",
        TONES[tone], className,
      )}
    >
      {Icon && <Icon size={size === "sm" ? 13 : 15} strokeWidth={2.2} />}
      {dot && <span className={clsx("size-1.5 rounded-full", DOTS[tone])} />}
      {children}
    </span>
  );
}

/** Ô biểu tượng vuông bo góc (đầu dòng danh sách, thẻ shortcut…). */
export function IconTile({ icon: Icon, tone = "neutral", size = "md", className }: { icon: LucideIcon; tone?: Tone; size?: "sm" | "md" | "lg"; className?: string }) {
  const sizes = { sm: "size-9 rounded-xl", md: "size-11 rounded-2xl", lg: "size-[52px] rounded-2xl" };
  return (
    <span className={clsx("inline-flex shrink-0 items-center justify-center", sizes[size], TONES[tone], className)}>
      <Icon size={size === "sm" ? 17 : size === "lg" ? 24 : 20} strokeWidth={1.8} />
    </span>
  );
}
