import clsx from "clsx";
import { LoaderCircle, type LucideIcon } from "lucide-react";
import type { ButtonHTMLAttributes, ReactNode } from "react";

type Variant = "primary" | "secondary" | "ghost" | "danger" | "soft";
type Size = "sm" | "md" | "lg";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  icon?: LucideIcon;
  iconRight?: LucideIcon;
  loading?: boolean;
  block?: boolean;
  children?: ReactNode;
}

const VARIANTS: Record<Variant, string> = {
  primary: "btn-gradient text-white shadow-button hover:brightness-105 active:brightness-95",
  secondary: "bg-surface text-navy ring-1 ring-line hover:bg-tile",
  ghost: "text-muted hover:bg-tile hover:text-navy",
  danger: "bg-danger-soft text-danger hover:brightness-95",
  soft: "bg-primary-soft text-primary hover:brightness-95",
};
const SIZES: Record<Size, string> = {
  sm: "h-9 px-3.5 text-[13px] gap-1.5 rounded-xl",
  md: "h-11 px-5 text-sm gap-2 rounded-control",
  lg: "h-13 px-6 text-[15px] gap-2.5 rounded-control",
};

/** Nút hành động. `variant="primary"` là hành động chính duy nhất của mỗi trang. */
export function PrimaryButton({
  variant = "primary", size = "md", icon: Icon, iconRight: IconRight, loading = false, block = false,
  className, children, disabled, type = "button", ...rest
}: ButtonProps) {
  const iconSize = size === "sm" ? 15 : 18;
  return (
    <button
      type={type}
      disabled={disabled || loading}
      className={clsx(
        "inline-flex shrink-0 items-center justify-center whitespace-nowrap font-semibold transition duration-150",
        "disabled:opacity-55 disabled:shadow-none",
        VARIANTS[variant], SIZES[size], block && "w-full", className,
      )}
      {...rest}
    >
      {loading ? <LoaderCircle size={iconSize} className="animate-spin" /> : Icon ? <Icon size={iconSize} strokeWidth={2} /> : null}
      {children}
      {IconRight && !loading && <IconRight size={iconSize} strokeWidth={2} />}
    </button>
  );
}

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  icon: LucideIcon;
  label: string;
  variant?: "surface" | "tile" | "ghost" | "danger";
  size?: "sm" | "md" | "lg";
  badge?: number;
  active?: boolean;
}

const ICON_SIZES = { sm: "size-9 rounded-xl", md: "size-11 rounded-2xl", lg: "size-[52px] rounded-2xl" };
const ICON_VARIANTS = {
  surface: "bg-surface text-navy shadow-card ring-1 ring-line/40 hover:text-primary",
  tile: "bg-tile text-muted hover:bg-primary-soft hover:text-primary",
  ghost: "text-muted hover:bg-tile hover:text-navy",
  danger: "text-muted hover:bg-danger-soft hover:text-danger",
};

/** Nút chỉ có biểu tượng (luôn kèm nhãn trợ năng). */
export function IconButton({ icon: Icon, label, variant = "tile", size = "md", badge, active, className, type = "button", ...rest }: IconButtonProps) {
  return (
    <button
      type={type}
      aria-label={label}
      title={label}
      className={clsx(
        "relative inline-flex shrink-0 items-center justify-center transition duration-150 disabled:opacity-50",
        ICON_SIZES[size], ICON_VARIANTS[variant], active && "!bg-primary-soft !text-primary", className,
      )}
      {...rest}
    >
      <Icon size={size === "sm" ? 16 : 20} strokeWidth={1.8} />
      {badge !== undefined && badge > 0 && (
        <span className="absolute -right-1 -top-1 flex h-5 min-w-5 items-center justify-center rounded-full bg-danger px-1 text-[11px] font-bold text-white ring-2 ring-surface">
          {badge > 99 ? "99+" : badge}
        </span>
      )}
    </button>
  );
}
