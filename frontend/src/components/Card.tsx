import clsx from "clsx";
import type { HTMLAttributes, ReactNode } from "react";

interface CardProps extends HTMLAttributes<HTMLDivElement> {
  padding?: "none" | "sm" | "md" | "lg";
  interactive?: boolean;
}

const PADDING = { none: "", sm: "p-4", md: "p-5 3xl:p-6", lg: "p-6 3xl:p-7" };

/** Bề mặt trắng bo góc lớn, bóng rất nhẹ — khối cơ bản của mọi màn hình. */
export function Card({ padding = "md", interactive = false, className, children, ...rest }: CardProps) {
  return (
    <div
      className={clsx(
        "rounded-card bg-surface shadow-card ring-1 ring-line/40",
        PADDING[padding],
        interactive && "transition-transform duration-200 hover:-translate-y-0.5",
        className,
      )}
      {...rest}
    >
      {children}
    </div>
  );
}

export function CardTitle({ children, hint, action }: { children: ReactNode; hint?: ReactNode; action?: ReactNode }) {
  return (
    <div className="mb-4 flex items-start justify-between gap-3">
      <div className="min-w-0">
        <h2 className="font-display text-[19px] font-bold leading-tight text-navy">{children}</h2>
        {hint && <p className="mt-1 text-[13px] text-muted">{hint}</p>}
      </div>
      {action}
    </div>
  );
}

/** Ô nền xám nhạt bên trong Card (chỉ số, nhóm thông tin). */
export function Tile({ className, children, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={clsx("rounded-tile bg-tile", className)} {...rest}>
      {children}
    </div>
  );
}
