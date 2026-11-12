import clsx from "clsx";
import { Bell, CalendarDays, ChevronRight, CircleAlert, CircleCheck, Droplet, Package, PlugZap, ShieldAlert, ShieldCheck, Thermometer, Unplug, type LucideIcon } from "lucide-react";
import { Link, useNavigate } from "react-router-dom";
import { Card, Tile } from "@/components/Card";
import { ScanStage } from "@/components/ScanStage";
import { IconTile, StatusIndicator, type Tone } from "@/components/StatusIndicator";
import { SystemBanner } from "@/components/SystemBanner";
import { useT } from "@/i18n";
import { formatTime } from "@/services/format";
import { useAlertCount, useDevice, useProfile } from "@/services/queries";
import { usePageHeader } from "@/stores/page";
import type { DeviceStatus } from "@/types/api";

function Reading({ icon, label, value, unit, min, max, state }: { icon: LucideIcon; label: string; value: number | null; unit: string; min: number; max: number; state: "high" | "low" | "normal" | null }) {
  const t = useT();
  const out = state === "high" || state === "low";
  return (
    <Tile className="flex flex-col items-center px-3 py-6 text-center short:py-4">
      <IconTile icon={icon} tone={out ? "danger" : "info"} size="sm" />
      <p className={clsx("mt-3 font-display text-[28px] font-extrabold leading-none tabular-nums short:text-2xl", value === null ? "text-muted/60" : out ? "text-danger" : "text-navy")}>
        {value === null ? "—" : `${value.toLocaleString("vi-VN", { maximumFractionDigits: 1 })}${unit}`}
      </p>
      <p className="mt-2.5 text-[13px] text-muted">{label}</p>
      <p className="mt-1 text-[11.5px] text-muted/80">
        {t("Ngưỡng")} {min}–{max}{unit}
        {state === "high" && ` · ${t("cao")}`}{state === "low" && ` · ${t("thấp")}`}
      </p>
    </Tile>
  );
}

function environmentTone(code: DeviceStatus["environment"]["code"] | undefined): Tone {
  if (code === "normal") return "success";
  if (code === "out_of_range") return "danger";
  if (code === "disconnected" || code === "no_data") return "warning";
  return "neutral";
}

function EnvironmentCard() {
  const t = useT();
  const device = useDevice();
  const data = device.data;
  const env = data?.environment;
  const tone = environmentTone(env?.code);
  const connected = data?.state === "connected";
  const StatusIcon = env?.code === "normal" ? CircleCheck : env?.code === "out_of_range" ? CircleAlert : Unplug;
  const chip = !data ? null
    : connected ? <StatusIndicator tone="success" icon={CircleCheck} size="sm">{t("Đang hoạt động")}</StatusIndicator>
    : data.state === "connecting" ? <StatusIndicator tone="info" size="sm" dot>{t("Đang kết nối")}</StatusIndicator>
    : data.enabled ? <StatusIndicator tone="warning" icon={Unplug} size="sm">{t(env?.label ?? "Mất kết nối")}</StatusIndicator>
    : <StatusIndicator tone="neutral" size="sm" dot>{t("Chưa kết nối")}</StatusIndicator>;

  return (
    <Card padding="lg" className="flex flex-col">
      <div className="mb-5 flex items-center justify-between gap-3 short:mb-3">
        <h2 className="font-display text-[19px] font-bold text-navy">{t("Môi trường tủ thuốc")}</h2>
        <div className="flex items-center gap-2">
          {data?.simulated && connected && <StatusIndicator tone="info" size="sm">{t("Mô phỏng")}</StatusIndicator>}
          {chip}
        </div>
      </div>
      {device.isLoading ? (
        <div className="grid grid-cols-2 gap-3"><div className="skeleton h-[150px] !rounded-tile" /><div className="skeleton h-[150px] !rounded-tile" /></div>
      ) : (
        <div className="grid grid-cols-2 gap-3">
          <Reading icon={Thermometer} label={t("Nhiệt độ")} unit="°C" value={data?.temperature ?? null} min={data?.thresholds.temp_min ?? 0} max={data?.thresholds.temp_max ?? 0} state={env?.temperature ?? null} />
          <Reading icon={Droplet} label={t("Độ ẩm")} unit="%" value={data?.humidity ?? null} min={data?.thresholds.humidity_min ?? 0} max={data?.thresholds.humidity_max ?? 0} state={env?.humidity ?? null} />
        </div>
      )}
      <div
        className={clsx(
          "mt-4 flex min-h-[56px] items-center justify-center gap-2.5 rounded-tile px-4 py-3 text-[15px] font-semibold short:mt-3 short:min-h-12",
          tone === "success" && "bg-success-soft text-success", tone === "danger" && "bg-danger-soft text-danger",
          tone === "warning" && "bg-warning-soft text-warning-ink", tone === "neutral" && "bg-tile text-muted",
        )}
      >
        <StatusIcon size={19} strokeWidth={2} />
        {t("Trạng thái")}: {t(env?.label ?? "Chưa kết nối")}
      </div>
      <p className="mt-3 text-center text-[12.5px] text-muted">
        {connected && data?.last_update
          ? t("Cập nhật lúc {time} từ cảm biến", { time: formatTime(data.last_update) })
          : data?.enabled
            ? (data.last_error ?? t("Đang chờ dữ liệu từ thiết bị"))
            : (
              <Link to="/settings#esp32" className="inline-flex items-center gap-1.5 font-semibold text-primary hover:underline">
                <PlugZap size={14} /> {t("Thiết lập kết nối ESP32")}
              </Link>
            )}
      </p>
    </Card>
  );
}

function AlertsCard() {
  const t = useT();
  const navigate = useNavigate();
  const count = useAlertCount().data?.unhandled ?? 0;
  const device = useDevice().data;
  const clean = count === 0;
  return (
    <Card padding="lg" interactive role="link" tabIndex={0} className="cursor-pointer" onClick={() => navigate("/alerts")} onKeyDown={(event) => { if (event.key === "Enter") navigate("/alerts"); }}>
      <div className="flex items-center gap-4">
        <IconTile icon={clean ? ShieldCheck : ShieldAlert} tone={clean ? "success" : "warning"} size="lg" />
        <div className="min-w-0 flex-1">
          <h2 className="font-display text-[19px] font-bold text-navy">{t("Cảnh báo")}</h2>
          <p className="mt-0.5 truncate text-sm text-muted">
            {clean ? t("Không có cảnh báo hiện tại") : t("{count} cảnh báo chưa xử lý", { count })}
          </p>
        </div>
        <span className="inline-flex size-11 shrink-0 items-center justify-center rounded-full bg-tile text-muted"><ChevronRight size={20} /></span>
      </div>
      <div className="mt-4 short:mt-3">
        {!clean ? (
          <StatusIndicator tone="warning" icon={Bell} size="sm">{t("Nhấn để xem và xử lý")}</StatusIndicator>
        ) : device?.environment.code === "normal" ? (
          <StatusIndicator tone="success" icon={CircleCheck} size="sm">{t("Tất cả chỉ số trong ngưỡng")}</StatusIndicator>
        ) : (
          <StatusIndicator tone="success" icon={CircleCheck} size="sm">{t("Hệ thống hoạt động bình thường")}</StatusIndicator>
        )}
      </div>
    </Card>
  );
}

function Shortcut({ to, icon, label }: { to: string; icon: LucideIcon; label: string }) {
  return (
    <Link to={to} className="group block rounded-card outline-offset-4">
      <Card padding="none" interactive className="flex h-[104px] items-center gap-4 px-6 short:h-[76px]">
        <IconTile icon={icon} size="lg" className="transition-colors duration-200 group-hover:bg-primary-soft group-hover:text-primary short:!size-11" />
        <span className="flex-1 truncate font-display text-[17px] font-bold text-navy">{label}</span>
        <span className="inline-flex size-9 items-center justify-center rounded-full bg-tile text-muted transition-colors duration-200 group-hover:bg-primary-soft group-hover:text-primary"><ChevronRight size={18} /></span>
      </Card>
    </Link>
  );
}

export function HomePage() {
  const t = useT();
  const profile = useProfile();
  const name = profile.data?.name?.trim();
  usePageHeader(name ? t("Xin chào, {name}", { name }) : t("Xin chào"), t("Nhận diện và quản lý thuốc thông minh"), t("Tủ thuốc thông minh"));

  return (
    <div>
      <SystemBanner />
      <div className="grid grid-cols-[minmax(0,1.72fr)_minmax(340px,1fr)] gap-6 short:gap-4">
        <Card padding="none" className="flex flex-col p-[22px] pb-6 short:p-4">
          <ScanStage
            previewClassName="min-h-[clamp(190px,calc(100vh-610px),560px)]"
            caption={
              <>
                <p className="font-display text-[22px] font-bold text-navy short:text-lg">{t("Quét thuốc")}</p>
                <p className="mt-0.5 text-sm text-muted short:text-[13px]">{t("Nhận diện hộp, vỉ thuốc và tra cứu thông tin")}</p>
              </>
            }
          />
        </Card>
        <div className="flex flex-col gap-5 short:gap-4">
          <EnvironmentCard />
          <AlertsCard />
        </div>
      </div>
      <div className="mt-6 grid grid-cols-3 gap-6 short:mt-4 short:gap-4">
        <Shortcut to="/cabinet" icon={Package} label={t("Thuốc trong tủ")} />
        <Shortcut to="/expiry" icon={CalendarDays} label={t("Hạn dùng")} />
        <Shortcut to="/reminders" icon={Bell} label={t("Nhắc uống thuốc")} />
      </div>
    </div>
  );
}
