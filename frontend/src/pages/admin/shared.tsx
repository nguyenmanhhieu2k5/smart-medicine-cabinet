import { Check, Copy } from "lucide-react";
import { useState } from "react";
import { IconButton } from "@/components/Button";
import { TextInput } from "@/components/Form";
import { StatusIndicator, type Tone } from "@/components/StatusIndicator";
import { useT } from "@/i18n";
import type { CommandStatus, DeviceCommand } from "@/types/api";

export const COMMAND_STATUS: Record<CommandStatus, { label: string; tone: Tone }> = {
  pending: { label: "Chờ gửi", tone: "neutral" },
  sent: { label: "Đã gửi, chờ thiết bị", tone: "info" },
  acknowledged: { label: "Thiết bị đã nhận", tone: "info" },
  applied: { label: "Đã thực hiện", tone: "success" },
  failed: { label: "Thất bại", tone: "danger" },
  timed_out: { label: "Hết thời gian", tone: "warning" },
  cancelled: { label: "Đã hủy", tone: "neutral" },
};

export function CommandStatusChip({ status }: { status: CommandStatus }) {
  const t = useT();
  const meta = COMMAND_STATUS[status] ?? { label: status, tone: "neutral" as Tone };
  return <StatusIndicator tone={meta.tone} size="sm" dot>{t(meta.label)}</StatusIndicator>;
}

/** Mô tả ngắn tham số của lệnh (hiển thị trong lịch sử lệnh). */
export function payloadSummary(command: Pick<DeviceCommand, "action" | "payload">, t: (text: string, vars?: Record<string, string | number>) => string): string {
  const p = command.payload ?? {};
  switch (command.action) {
    case "buzzer":
      return p.on ? (p.duration_s ? t("Bật · {s} giây", { s: Number(p.duration_s) }) : t("Bật")) : t("Tắt");
    case "set_alarm":
      return p.enabled ? t("Bật còi tự động") : t("Tắt còi tự động");
    case "set_interval":
      return t("Mỗi {s} giây", { s: Number(p.seconds) });
    case "set_thresholds":
      return `${p.temp_min}–${p.temp_max}°C · ${p.humidity_min}–${p.humidity_max}%`;
    case "read_now":
      return "";
    default:
      return Object.keys(p).length ? JSON.stringify(p) : "";
  }
}

export const AUDIT_ACTIONS: Record<string, string> = {
  "auth.login": "Đăng nhập",
  "auth.logout": "Đăng xuất",
  "auth.register": "Đăng ký tài khoản",
  "auth.password_change": "Đổi mật khẩu",
  "auth.password_reset": "Đặt lại mật khẩu",
  "auth.password_reset_request": "Yêu cầu đặt lại mật khẩu",
  "auth.refresh_reuse": "Phát hiện dùng lại phiên cũ",
  "backup.create": "Tạo bản sao lưu",
  "backup.delete": "Xóa bản sao lưu",
  "backup.download": "Tải bản sao lưu",
  "device.command": "Gửi lệnh thiết bị",
  "device.command_cancel": "Hủy lệnh thiết bị",
  "device.connect": "Thiết bị kết nối",
  "device.create": "Thêm thiết bị",
  "device.delete": "Xóa thiết bị",
  "device.rotate_token": "Đổi token thiết bị",
  "device.update": "Sửa thiết bị",
  "settings.update": "Đổi cài đặt",
  "user.create": "Tạo tài khoản",
  "user.delete": "Xóa tài khoản",
  "user.password_reset": "Quản trị đặt lại mật khẩu",
  "user.sessions_revoke": "Đăng xuất mọi phiên",
  "user.update": "Sửa tài khoản",
};

export const CHANNEL_LABELS: Record<string, string> = {
  admin: "Quản trị",
  public: "Ứng dụng di động",
  device: "Thiết bị",
  system: "Hệ thống",
  cli: "Dòng lệnh",
};

/** Ô chỉ đọc + nút sao chép (token thiết bị, địa chỉ kết nối). */
export function CopyField({ value, label, mono = true }: { value: string; label: string; mono?: boolean }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };
  return (
    <div className="flex items-center gap-2">
      <TextInput readOnly value={value} aria-label={label} className={mono ? "font-mono text-[12.5px]" : undefined} onFocus={(event) => event.currentTarget.select()} />
      <IconButton icon={copied ? Check : Copy} label={copied ? t("Đã sao chép") : t("Sao chép")} size="md" onClick={() => void copy()} />
    </div>
  );
}

export function formatDuration(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d} ngày ${h} giờ`;
  if (h > 0) return `${h} giờ ${m} phút`;
  return `${m} phút`;
}
