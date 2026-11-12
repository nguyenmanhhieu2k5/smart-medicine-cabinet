import clsx from "clsx";
import { CircleAlert, LoaderCircle, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { PrimaryButton } from "@/components/Button";
import { useT } from "@/i18n";

interface EmptyStateProps {
  icon: LucideIcon;
  title: string;
  description?: string;
  action?: ReactNode;
  tone?: "neutral" | "success";
  compact?: boolean;
}

/** Trạng thái trống: giải thích ngắn gọn và đưa ra bước tiếp theo. */
export function EmptyState({ icon: Icon, title, description, action, tone = "neutral", compact = false }: EmptyStateProps) {
  return (
    <div className={clsx("flex flex-col items-center justify-center text-center", compact ? "px-4 py-8" : "px-6 py-14")}>
      <span
        className={clsx(
          "mb-4 inline-flex items-center justify-center rounded-3xl",
          compact ? "size-14" : "size-[72px]",
          tone === "success" ? "bg-success-soft text-success" : "bg-tile text-muted",
        )}
      >
        <Icon size={compact ? 26 : 32} strokeWidth={1.6} />
      </span>
      <p className="font-display text-[17px] font-bold text-navy">{title}</p>
      {description && <p className="mt-1.5 max-w-md text-sm text-muted">{description}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

/** Khung chờ dạng skeleton hoặc vòng xoay kèm chú thích. */
export function LoadingState({ rows = 4, label, variant = "skeleton" }: { rows?: number; label?: string; variant?: "skeleton" | "spinner" }) {
  const t = useT();
  if (variant === "spinner") {
    return (
      <div className="flex flex-col items-center justify-center gap-3 py-12 text-muted" role="status">
        <LoaderCircle size={26} className="animate-spin text-primary" />
        <span className="text-sm">{label ?? t("Đang tải…")}</span>
      </div>
    );
  }
  return (
    <div className="space-y-3" role="status" aria-label={label ?? t("Đang tải…")}>
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="flex items-center gap-4">
          <div className="skeleton size-11 shrink-0 !rounded-2xl" />
          <div className="flex-1 space-y-2">
            <div className="skeleton h-3.5" style={{ width: `${62 - index * 7}%` }} />
            <div className="skeleton h-3" style={{ width: `${38 - index * 4}%` }} />
          </div>
        </div>
      ))}
    </div>
  );
}

export function ErrorState({ title, description, onRetry }: { title?: string; description?: string; onRetry?: () => void }) {
  const t = useT();
  return (
    <div className="flex flex-col items-center justify-center px-6 py-12 text-center">
      <span className="mb-4 inline-flex size-16 items-center justify-center rounded-3xl bg-danger-soft text-danger">
        <CircleAlert size={30} strokeWidth={1.6} />
      </span>
      <p className="font-display text-[17px] font-bold text-navy">{title ?? t("Không tải được dữ liệu")}</p>
      {description && <p className="mt-1.5 max-w-md text-sm text-muted">{description}</p>}
      {onRetry && (
        <PrimaryButton variant="secondary" className="mt-5" onClick={onRetry}>
          {t("Thử lại")}
        </PrimaryButton>
      )}
    </div>
  );
}
