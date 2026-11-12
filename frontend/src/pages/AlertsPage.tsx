import clsx from "clsx";
import { Check, CircleAlert, CircleCheck, Droplet, Eye, Info, Pill, ShieldCheck, Thermometer, TriangleAlert, Wifi, Wrench, type LucideIcon } from "lucide-react";
import { lazy, Suspense, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { PrimaryButton } from "@/components/Button";
import { Card } from "@/components/Card";
import { Segmented } from "@/components/Form";
import { Note } from "@/components/MedicineBits";
import { ErrorState, LoadingState } from "@/components/States";
import { IconTile, StatusIndicator, type Tone } from "@/components/StatusIndicator";
import { useT } from "@/i18n";
import { formatDateTime, formatTime } from "@/services/format";
import { errorMessage, useAlertActions, useAlerts, useDevice, useReadings, useSettings } from "@/services/queries";
import { usePageHeader } from "@/stores/page";
import type { AlertCategory, AlertItem, Severity } from "@/types/api";

const TrendChart = lazy(() => import("@/components/TrendChart"));

const SEVERITY: Record<Severity, { tone: Tone; icon: LucideIcon }> = {
  normal: { tone: "success", icon: CircleCheck },
  info: { tone: "info", icon: Info },
  warning: { tone: "warning", icon: TriangleAlert },
  danger: { tone: "danger", icon: CircleAlert },
};
const CATEGORY_ICON: Record<AlertCategory, LucideIcon> = { environment: Thermometer, medicine: Pill, system: Wrench };

function AlertRow({ alert }: { alert: AlertItem }) {
  const t = useT();
  const navigate = useNavigate();
  const { update } = useAlertActions();
  const severity = SEVERITY[alert.severity];
  const CategoryIcon = CATEGORY_ICON[alert.category];
  const itemId = typeof alert.data?.cabinet_item_id === "number" ? alert.data.cabinet_item_id : null;
  const resolved = alert.status === "resolved";
  return (
    <li className={clsx("flex flex-wrap items-center gap-4 border-b border-line py-4 last:border-b-0", resolved && "opacity-70")}>
      <IconTile icon={severity.icon} tone={severity.tone} size="lg" />
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-center gap-2">
          <span className="font-display text-[16px] font-bold text-navy">{alert.title}</span>
          <StatusIndicator tone={severity.tone} size="sm">{t(alert.severity_label)}</StatusIndicator>
        </p>
        <p className="mt-0.5 text-sm text-muted">{alert.message}</p>
        <p className="mt-1 flex flex-wrap items-center gap-x-1.5 text-[12.5px] text-muted/80">
          <CategoryIcon size={13} /> {t(alert.category_label)} · {formatDateTime(alert.created_at)} · {t(alert.status_label)}
          {alert.resolved_at && ` · ${t("kết thúc")} ${formatDateTime(alert.resolved_at)}`}
        </p>
      </div>
      <div className="flex items-center gap-2">
        {itemId !== null && !resolved && <PrimaryButton size="sm" variant="ghost" onClick={() => navigate(`/cabinet/${itemId}`)}>{t("Xem thuốc")}</PrimaryButton>}
        {alert.status === "active" && (
          <PrimaryButton size="sm" variant="secondary" icon={Eye} disabled={update.isPending} onClick={() => update.mutate({ id: alert.id, status: "seen" })}>{t("Đã xem")}</PrimaryButton>
        )}
        {(alert.status === "active" || alert.status === "seen") && (
          <PrimaryButton size="sm" variant="soft" icon={Check} disabled={update.isPending} onClick={() => update.mutate({ id: alert.id, status: "acknowledged" })}>{t("Xác nhận")}</PrimaryButton>
        )}
      </div>
    </li>
  );
}

function MonitorCard() {
  const t = useT();
  const device = useDevice().data;
  const env = device?.environment;
  const connected = device?.state === "connected";
  const chip = (state: "high" | "low" | "normal" | null | undefined) =>
    state === "normal" ? <StatusIndicator tone="success" size="sm">{t("Bình thường")}</StatusIndicator>
    : state === "high" ? <StatusIndicator tone="danger" size="sm">{t("Vượt ngưỡng")}</StatusIndicator>
    : state === "low" ? <StatusIndicator tone="danger" size="sm">{t("Dưới ngưỡng")}</StatusIndicator>
    : <StatusIndicator tone="neutral" size="sm">{t("Chưa có dữ liệu")}</StatusIndicator>;
  const rows: { icon: LucideIcon; label: string; value: string; chip: React.ReactNode }[] = [
    { icon: Thermometer, label: t("Nhiệt độ"), value: device?.temperature != null ? `${device.temperature}°C` : "—", chip: chip(env?.temperature) },
    { icon: Droplet, label: t("Độ ẩm"), value: device?.humidity != null ? `${device.humidity}%` : "—", chip: chip(env?.humidity) },
    {
      icon: Wifi, label: t("Kết nối"), value: "",
      chip: connected ? <StatusIndicator tone="success" size="sm">{t("Đã kết nối")}</StatusIndicator>
        : device?.enabled ? <StatusIndicator tone="warning" size="sm">{t(env?.label ?? "Mất kết nối")}</StatusIndicator>
        : <StatusIndicator tone="neutral" size="sm">{t("Chưa kết nối")}</StatusIndicator>,
    },
  ];
  return (
    <Card padding="lg">
      <div className="mb-2 flex items-center justify-between gap-3">
        <h2 className="font-display text-[19px] font-bold text-navy">{t("Trạng thái theo dõi")}</h2>
        {device?.simulated && connected && <StatusIndicator tone="info" size="sm">{t("Mô phỏng")}</StatusIndicator>}
      </div>
      <ul className="divide-y divide-line">
        {rows.map((row) => (
          <li key={row.label} className="flex items-center gap-3 py-3.5">
            <row.icon size={20} strokeWidth={1.8} className="text-navy" />
            <span className="flex-1 text-[15px] text-navy">{row.label}</span>
            <span className="font-display text-[16px] font-bold tabular-nums text-navy">{row.value}</span>
            {row.chip}
          </li>
        ))}
      </ul>
      {connected && device?.last_update && <p className="mt-1 text-[12.5px] text-muted">{t("Cập nhật lúc {time} từ cảm biến", { time: formatTime(device.last_update) })}</p>}
      {!device?.enabled && <p className="mt-1 text-[12.5px] text-muted">{t("Chưa kết nối ESP32 nên không có số đo.")} <Link to="/settings#esp32" className="font-semibold text-primary hover:underline">{t("Thiết lập")}</Link></p>}
    </Card>
  );
}

function TrendCard() {
  const t = useT();
  const device = useDevice().data;
  const readings = useReadings(24, Boolean(device?.enabled));
  const points = (readings.data?.items ?? []).map((p) => ({ time: formatTime(p.recorded_at), temperature: p.temperature, humidity: p.humidity }));
  if (points.length < 2) return null; // chỉ vẽ khi có số đo thật
  return (
    <Card padding="lg">
      <h2 className="mb-1 font-display text-[19px] font-bold text-navy">{t("Diễn biến 24 giờ")}</h2>
      <p className="mb-3 text-[12.5px] text-muted">{t("Số đo thật đã lưu từ thiết bị ({count} điểm).", { count: points.length })}</p>
      <div className="h-[170px]">
        <Suspense fallback={<div className="skeleton size-full" />}>
          <TrendChart points={points} temperatureLabel={t("Nhiệt độ (°C)")} humidityLabel={t("Độ ẩm (%)")} />
        </Suspense>
      </div>
    </Card>
  );
}

function ThresholdCard() {
  const t = useT();
  const settings = useSettings().data?.settings;
  const rows = settings
    ? [
        [t("Nhiệt độ"), `${settings.temp_min} – ${settings.temp_max}°C`],
        [t("Độ ẩm"), `${settings.humidity_min} – ${settings.humidity_max}%`],
        [t("Sắp hết hạn"), t("trước {days} ngày", { days: settings.expiry_warning_days })],
        [t("Số lượng thấp"), `≤ ${settings.low_stock_threshold}`],
      ]
    : [];
  return (
    <Card padding="lg">
      <div className="mb-2 flex items-center justify-between gap-3">
        <h2 className="font-display text-[19px] font-bold text-navy">{t("Ngưỡng cảnh báo")}</h2>
        <Link to="/settings#thresholds" className="rounded-lg px-2 py-1 text-[15px] font-bold text-primary hover:bg-primary-soft">{t("Chỉnh sửa")}</Link>
      </div>
      {settings ? (
        <dl className="divide-y divide-line">
          {rows.map(([label, value]) => (
            <div key={label} className="flex items-center justify-between py-3.5">
              <dt className="text-sm text-muted">{label}</dt>
              <dd className="font-display text-[16px] font-bold tabular-nums text-navy">{value}</dd>
            </div>
          ))}
        </dl>
      ) : <LoadingState rows={2} />}
      <div className="mt-3"><Note>{t("Khi cảm biến vượt ngưỡng hoặc mất kết nối, ứng dụng sẽ hiển thị cảnh báo phù hợp.")}</Note></div>
    </Card>
  );
}

export function AlertsPage() {
  const t = useT();
  usePageHeader(t("Cảnh báo"), t("Theo dõi tình trạng thiết bị và thuốc"), `${t("Tủ thuốc thông minh")} / ${t("Cảnh báo")}`);
  const [scope, setScope] = useState<"open" | "resolved">("open");
  const [category, setCategory] = useState<"all" | AlertCategory>("all");
  const [severity, setSeverity] = useState<"all" | Severity>("all");
  const alerts = useAlerts({ scope, category, severity });
  const { markAll } = useAlertActions();
  const data = alerts.data;
  const filtered = category !== "all" || severity !== "all" || scope !== "open";
  const nothingOpen = data !== undefined && data.open === 0 && scope === "open";

  return (
    <div className="grid grid-cols-[minmax(0,1.82fr)_minmax(340px,1fr)] gap-6 short:gap-4">
      <Card padding="lg" className="min-h-[520px] short:min-h-[400px]">
        {alerts.isLoading ? (
          <LoadingState rows={4} />
        ) : alerts.isError ? (
          <ErrorState description={errorMessage(alerts.error)} onRetry={() => void alerts.refetch()} />
        ) : nothingOpen && !filtered ? (
          <div className="flex h-full min-h-[440px] flex-col items-center justify-center text-center short:min-h-[340px]" data-testid="no-alerts">
            <span className="inline-flex size-[124px] items-center justify-center rounded-full bg-success-soft text-success short:size-24">
              <ShieldCheck size={40} strokeWidth={1.7} />
            </span>
            <h2 className="mt-7 font-display text-[28px] font-extrabold text-navy short:mt-5 short:text-2xl">{t("Không có cảnh báo")}</h2>
            <p className="mt-2 text-[15px] text-muted">{t("Không có cảnh báo – Hệ thống hoạt động bình thường.")}</p>
            <div className="mt-5"><StatusIndicator tone="success" icon={CircleCheck}>{t("Hệ thống ổn định")}</StatusIndicator></div>
            <button type="button" className="mt-6 text-[13px] font-semibold text-primary hover:underline" onClick={() => setScope("resolved")}>{t("Xem cảnh báo đã kết thúc")}</button>
          </div>
        ) : (
          <>
            <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="font-display text-[19px] font-bold text-navy">{scope === "open" ? t("Cảnh báo đang mở") : t("Cảnh báo đã kết thúc")}</h2>
                <p className="mt-0.5 text-[13px] text-muted">{t("{count} chưa xử lý", { count: data?.unhandled ?? 0 })} · {t("{count} đang mở", { count: data?.open ?? 0 })}</p>
              </div>
              <div className="flex items-center gap-2">
                <Segmented size="sm" value={scope} onChange={setScope} options={[{ value: "open", label: t("Đang mở") }, { value: "resolved", label: t("Đã kết thúc") }]} />
                {scope === "open" && (data?.unhandled ?? 0) > 0 && (
                  <PrimaryButton size="sm" variant="secondary" icon={Check} loading={markAll.isPending} onClick={() => markAll.mutate("acknowledged")}>{t("Xác nhận tất cả")}</PrimaryButton>
                )}
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-y border-line py-3">
              <Segmented<"all" | AlertCategory>
                size="sm" value={category} onChange={setCategory}
                options={[
                  { value: "all", label: t("Tất cả") },
                  { value: "environment", label: t("Môi trường"), count: scope === "open" ? data?.by_category.environment : undefined },
                  { value: "medicine", label: t("Thuốc"), count: scope === "open" ? data?.by_category.medicine : undefined },
                  { value: "system", label: t("Hệ thống"), count: scope === "open" ? data?.by_category.system : undefined },
                ]}
              />
              <Segmented<"all" | Severity>
                size="sm" value={severity} onChange={setSeverity}
                options={[{ value: "all", label: t("Mọi mức độ") }, { value: "info", label: t("Thông tin") }, { value: "warning", label: t("Cảnh báo") }, { value: "danger", label: t("Nguy hiểm") }]}
              />
            </div>
            {data && data.items.length === 0 ? (
              <div className="flex flex-col items-center py-14 text-center">
                <span className="inline-flex size-16 items-center justify-center rounded-3xl bg-success-soft text-success"><ShieldCheck size={30} strokeWidth={1.7} /></span>
                <p className="mt-4 font-display text-[17px] font-bold text-navy">{t("Không có cảnh báo trong nhóm này")}</p>
              </div>
            ) : (
              <ul>{data?.items.map((alert) => <AlertRow key={alert.id} alert={alert} />)}</ul>
            )}
          </>
        )}
      </Card>
      <div className="flex flex-col gap-5 short:gap-4">
        <MonitorCard />
        <TrendCard />
        <ThresholdCard />
      </div>
    </div>
  );
}
