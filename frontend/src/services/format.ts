import type { Language } from "@/i18n";
import { getLocale } from "@/i18n";

const WEEKDAYS_VI = ["Chủ nhật", "Thứ Hai", "Thứ Ba", "Thứ Tư", "Thứ Năm", "Thứ Sáu", "Thứ Bảy"];

export function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/** "2027-06-15" → "15/06/2027" (không qua múi giờ). */
export function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return match ? `${match[3]}/${match[2]}/${match[1]}` : iso;
}

export function formatTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "—" : `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  return `${formatTime(iso)} · ${formatDate(iso)}`;
}

export function toIsoDate(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function weekdayDate(date: Date, language: Language): string {
  if (language === "vi") return `${WEEKDAYS_VI[date.getDay()]}, ${pad(date.getDate())}/${pad(date.getMonth() + 1)}/${date.getFullYear()}`;
  return date.toLocaleDateString(getLocale(language), { weekday: "short", day: "2-digit", month: "2-digit", year: "numeric" });
}

/** Nhãn ngày tương đối cho lịch sử: "Hôm nay", "Hôm qua" hoặc ngày đầy đủ. */
export function relativeDay(iso: string, today = new Date()): string {
  const date = new Date(iso);
  const start = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diff = Math.round((start(today) - start(date)) / 86_400_000);
  if (diff === 0) return "Hôm nay";
  if (diff === 1) return "Hôm qua";
  return formatDate(toIsoDate(date));
}

export function formatNumber(value: number, language: Language = "vi"): string {
  return value.toLocaleString(getLocale(language));
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function formatQuantity(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(3)));
}

/** Thứ Hai của tuần chứa `date`. */
export function startOfWeek(date: Date): Date {
  const copy = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  copy.setDate(copy.getDate() - ((copy.getDay() + 6) % 7));
  return copy;
}

export function addDays(date: Date, days: number): Date {
  const copy = new Date(date);
  copy.setDate(copy.getDate() + days);
  return copy;
}
