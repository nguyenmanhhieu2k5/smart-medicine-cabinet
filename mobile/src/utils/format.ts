import type { Candidate, HistoryItem, HistoryStatus } from "@/api/types";
import type { Tone } from "@/components/ui";

const pad = (n: number) => String(n).padStart(2, "0");

/** Máy chủ trả thời gian có múi giờ (+07:00). Hiển thị theo giờ của điện thoại. */
export function parseTime(iso: string): Date {
  return new Date(iso);
}

export function formatTime(iso: string): string {
  const d = parseTime(iso);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function formatDate(iso: string): string {
  const d = parseTime(iso);
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
}

/** “10:24, 16/01/2025” như thiết kế 09. */
export function formatDateTime(iso: string): string {
  return `${formatTime(iso)}, ${formatDate(iso)}`;
}

export type HistorySectionKey = "today" | "yesterday" | "earlier";
export const SECTION_TITLES: Record<HistorySectionKey, string> = { today: "Hôm nay", yesterday: "Hôm qua", earlier: "Trước đó" };

function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** Nhóm lịch sử theo Hôm nay / Hôm qua / Trước đó (giữ thứ tự mới nhất trước). */
export function groupHistory(items: HistoryItem[], now = new Date()): { key: HistorySectionKey; title: string; data: HistoryItem[] }[] {
  const today = startOfDay(now);
  const yesterday = today - 86_400_000;
  const groups: Record<HistorySectionKey, HistoryItem[]> = { today: [], yesterday: [], earlier: [] };
  for (const item of items) {
    const day = startOfDay(parseTime(item.created_at));
    groups[day >= today ? "today" : day >= yesterday ? "yesterday" : "earlier"].push(item);
  }
  return (Object.keys(groups) as HistorySectionKey[])
    .filter((key) => groups[key].length > 0)
    .map((key) => ({ key, title: SECTION_TITLES[key], data: groups[key] }));
}

export const HISTORY_STATUS: Record<HistoryStatus, { label: string; tone: Tone }> = {
  confident: { label: "Đã tra cứu", tone: "success" },
  uncertain: { label: "Nhiều kết quả", tone: "warning" },
  no_text: { label: "Không đọc được", tone: "neutral" },
  no_match: { label: "Không tìm thấy", tone: "neutral" },
  no_catalog: { label: "Chưa có danh mục", tone: "warning" },
  failed: { label: "Lỗi", tone: "danger" },
  cancelled: { label: "Đã hủy", tone: "neutral" },
};

/** Nhãn mức độ phù hợp trên thẻ kết quả (thiết kế 07). */
export function candidateBadge(candidate: Candidate, index: number): { label: string; tone: Tone; best: boolean } {
  if (index === 0 && candidate.level === "high") return { label: "Phù hợp nhất", tone: "success", best: true };
  if (candidate.level === "high") return { label: "Mức độ phù hợp: Cao", tone: "primary", best: false };
  if (candidate.level === "medium") return { label: "Mức độ phù hợp: Trung bình", tone: "warning", best: false };
  return { label: "Mức độ phù hợp: Thấp", tone: "neutral", best: false };
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  const first = parts.length > 1 ? parts[parts.length - 2][0] : "";
  return (first + parts[parts.length - 1][0]).toUpperCase();
}

/** Che bớt email: ng•••@gmail.com */
export function maskEmail(email: string): string {
  const [local, domain] = email.split("@");
  if (!domain) return email;
  return `${local.slice(0, 2)}${"•".repeat(Math.max(1, Math.min(4, local.length - 2)))}@${domain}`;
}

/** "2027-06-15" → "15/06/2027" (chỉ tách chuỗi — không qua Date nên không lệch múi giờ). */
export function isoToVnDate(iso: string | null | undefined): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso ?? "");
  return m ? `${m[3]}/${m[2]}/${m[1]}` : "";
}

/** "15/6/2027" → "2027-06-15"; null nếu không phải ngày có thật (31/02, 00/13…). */
export function vnDateToIso(text: string): string | null {
  const m = /^\s*(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})\s*$/.exec(text);
  if (!m) return null;
  const [d, mo, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) return null;
  return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** Gõ ngày dễ dàng: chỉ giữ chữ số và tự chèn "/" → "15062027" thành "15/06/2027". */
export function maskDateInput(text: string): string {
  const digits = text.replace(/\D/g, "").slice(0, 8);
  if (digits.length <= 2) return digits;
  if (digits.length <= 4) return `${digits.slice(0, 2)}/${digits.slice(2)}`;
  return `${digits.slice(0, 2)}/${digits.slice(2, 4)}/${digits.slice(4)}`;
}
