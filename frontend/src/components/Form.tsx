import clsx from "clsx";
import { Search, X } from "lucide-react";
import type { InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from "react";

const CONTROL =
  "w-full rounded-control bg-surface px-4 text-sm text-navy ring-1 ring-line outline-none transition placeholder:text-muted/70 " +
  "focus:ring-2 focus:ring-primary disabled:bg-tile disabled:text-muted";

export function Field({ label, hint, error, required, children, className }: { label: string; hint?: ReactNode; error?: string | null; required?: boolean; children: ReactNode; className?: string }) {
  return (
    <label className={clsx("block", className)}>
      <span className="mb-1.5 block text-[13px] font-semibold text-navy">
        {label}
        {required && <span className="ml-0.5 text-danger">*</span>}
      </span>
      {children}
      {error ? <span className="mt-1.5 block text-[12.5px] text-danger">{error}</span> : hint ? <span className="mt-1.5 block text-[12.5px] text-muted">{hint}</span> : null}
    </label>
  );
}

export function TextInput({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={clsx(CONTROL, "h-11", className)} {...rest} />;
}

export function TextArea({ className, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={clsx(CONTROL, "min-h-[84px] resize-y py-3", className)} {...rest} />;
}

export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select className={clsx(CONTROL, "h-11 appearance-none bg-[length:16px] bg-[right_14px_center] bg-no-repeat pr-10", className)}
      style={{ backgroundImage: "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 24 24' fill='none' stroke='%23687287' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E\")" }}
      {...rest}
    >
      {children}
    </select>
  );
}

interface SearchInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "onChange" | "value"> {
  value: string;
  onChange: (value: string) => void;
}

export function SearchInput({ value, onChange, className, placeholder, ...rest }: SearchInputProps) {
  return (
    <div className={clsx("relative", className)}>
      <Search size={18} className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-muted" strokeWidth={1.8} />
      <input
        type="search" value={value} placeholder={placeholder} onChange={(event) => onChange(event.target.value)}
        className={clsx(CONTROL, "h-12 pl-11 pr-10 [&::-webkit-search-cancel-button]:hidden")} {...rest}
      />
      {value && (
        <button type="button" aria-label="Xóa" onClick={() => onChange("")} className="absolute right-3 top-1/2 -translate-y-1/2 rounded-lg p-1 text-muted hover:bg-tile hover:text-navy">
          <X size={15} />
        </button>
      )}
    </div>
  );
}

export function Toggle({ checked, onChange, label, disabled }: { checked: boolean; onChange: (checked: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button
      type="button" role="switch" aria-checked={checked} aria-label={label} disabled={disabled}
      onClick={() => onChange(!checked)}
      className={clsx(
        "relative inline-flex h-7 w-12 shrink-0 items-center rounded-full transition-colors duration-200 disabled:opacity-50",
        checked ? "bg-primary" : "bg-line",
      )}
    >
      <span className={clsx("inline-block size-[22px] rounded-full bg-white shadow transition-transform duration-200", checked ? "translate-x-[23px]" : "translate-x-[3px]")} />
    </button>
  );
}

interface SegmentedProps<T extends string> {
  value: T;
  onChange: (value: T) => void;
  options: { value: T; label: string; count?: number; tone?: "warning" | "danger" }[];
  size?: "sm" | "md";
  className?: string;
}

/** Bộ chọn dạng tab viên thuốc (bộ lọc trạng thái, chế độ xem…). */
export function Segmented<T extends string>({ value, onChange, options, size = "md", className }: SegmentedProps<T>) {
  return (
    <div role="tablist" className={clsx("inline-flex flex-wrap gap-1.5", className)}>
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value} role="tab" type="button" aria-selected={active} onClick={() => onChange(option.value)}
            className={clsx(
              "inline-flex items-center gap-1.5 rounded-full font-semibold transition duration-150",
              size === "sm" ? "h-8 px-3 text-[12.5px]" : "h-10 px-4 text-[13.5px]",
              option.tone === "warning" ? "bg-warning-soft text-warning-ink" : option.tone === "danger" ? "bg-danger-soft text-danger"
                : active ? "bg-primary-soft text-primary" : "bg-tile text-muted hover:text-navy",
              option.tone && (active ? "ring-2 ring-current/50" : "opacity-80 hover:opacity-100"),
            )}
          >
            {option.label}
            {option.count !== undefined && <span className="tabular-nums">· {option.count}</span>}
          </button>
        );
      })}
    </div>
  );
}
