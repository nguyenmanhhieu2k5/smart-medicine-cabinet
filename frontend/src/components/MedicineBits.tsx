import clsx from "clsx";
import { Pill } from "lucide-react";
import type { ReactNode } from "react";
import { StatusIndicator, type Tone } from "@/components/StatusIndicator";
import type { CabinetItem, MatchCandidate } from "@/types/api";

const PASTELS = [
  "bg-[#e3f0ff] dark:bg-[#17305a]", "bg-[#ffeedd] dark:bg-[#3d2a17]", "bg-[#ece8ff] dark:bg-[#2a2752]",
  "bg-[#e2f6ef] dark:bg-[#15362d]", "bg-[#fff1d6] dark:bg-[#3b3013]", "bg-[#ffe8ea] dark:bg-[#3d1d22]",
];

/** Ô biểu tượng thuốc với nền pastel ổn định theo tên (không dùng ảnh sản phẩm giả). */
export function MedicineAvatar({ name, size = "md" }: { name: string; size?: "sm" | "md" | "lg" | "xl" }) {
  let hash = 0;
  for (const ch of name) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  const sizes = { sm: "size-10 rounded-xl", md: "size-12 rounded-2xl", lg: "size-16 rounded-[20px]", xl: "size-20 rounded-3xl" };
  const icon = { sm: 18, md: 22, lg: 28, xl: 34 }[size];
  return (
    <span className={clsx("inline-flex shrink-0 items-center justify-center text-primary", sizes[size], PASTELS[hash % PASTELS.length])}>
      <Pill size={icon} strokeWidth={1.8} />
    </span>
  );
}

export function expiryTone(status: CabinetItem["expiry_status"]): Tone {
  return status === "expired" ? "danger" : status === "expiring" ? "warning" : status === "ok" ? "success" : "neutral";
}

export function ExpiryChip({ item, size = "sm" }: { item: Pick<CabinetItem, "expiry_status" | "expiry_status_label">; size?: "sm" | "md" }) {
  return <StatusIndicator tone={expiryTone(item.expiry_status)} size={size}>{item.expiry_status_label}</StatusIndicator>;
}

export function levelTone(level: MatchCandidate["level"]): Tone {
  return level === "high" ? "success" : level === "medium" ? "warning" : "neutral";
}

/** "Mức độ phù hợp" — điểm theo quy tắc so khớp, KHÔNG phải xác suất. */
export function MatchLevelChip({ candidate, size = "sm" }: { candidate: MatchCandidate; size?: "sm" | "md" }) {
  return (
    <StatusIndicator tone={levelTone(candidate.level)} size={size}>
      Mức độ phù hợp: {candidate.level_label} · {Math.round(candidate.score)}/100
    </StatusIndicator>
  );
}

/** Danh sách cặp nhãn–giá trị với đường kẻ mảnh (trang chi tiết, kết quả nhận diện). */
export function InfoRows({ rows }: { rows: { label: string; value: ReactNode; hint?: string }[] }) {
  return (
    <dl className="divide-y divide-line border-y border-line">
      {rows.map((row) => (
        <div key={row.label} className="grid grid-cols-[170px_1fr] items-baseline gap-4 py-3 max-xl:grid-cols-[140px_1fr]">
          <dt className="text-sm text-muted">{row.label}</dt>
          <dd className="min-w-0 break-words text-sm font-semibold text-navy">
            {row.value ?? <span className="font-normal text-muted">Không có trong dữ liệu nguồn</span>}
            {row.hint && <span className="mt-0.5 block text-[12.5px] font-normal text-muted">{row.hint}</span>}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export function Note({ tone = "info", children }: { tone?: "info" | "warning"; children: ReactNode }) {
  return (
    <div className={clsx("rounded-2xl px-4 py-3.5 text-[13px] leading-relaxed", tone === "warning" ? "bg-warning-soft text-warning-ink" : "bg-tile text-muted")}>
      {children}
    </div>
  );
}
