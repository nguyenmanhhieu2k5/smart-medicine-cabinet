import { Cpu, Database, Globe, HardDrive, MemoryStick, Server, ShieldCheck, Workflow } from "lucide-react";
import type { ReactNode } from "react";
import { Card, CardTitle } from "@/components/Card";
import { ErrorState, LoadingState } from "@/components/States";
import { IconTile, StatusIndicator, type Tone } from "@/components/StatusIndicator";
import { useLanguageStore, useT } from "@/i18n";
import { connectionInfo } from "@/services/api";
import { formatBytes, formatDateTime, formatNumber } from "@/services/format";
import { errorMessage, useSystem } from "@/services/queries";
import type { ServiceState } from "@/types/api";
import { CopyField, formatDuration } from "./shared";

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 py-2.5 text-[13px]">
      <dt className="text-muted">{label}</dt>
      <dd className="min-w-0 truncate text-right font-semibold text-navy">{children}</dd>
    </div>
  );
}

function Meter({ percent }: { percent: number }) {
  const tone = percent >= 90 ? "bg-danger" : percent >= 75 ? "bg-warning" : "bg-primary";
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-tile" aria-hidden>
      <div className={`h-full rounded-full ${tone}`} style={{ width: `${Math.min(100, Math.max(2, percent))}%` }} />
    </div>
  );
}

const SERVICE_META: Record<string, { label: string; hint: string }> = {
  postgresql: { label: "PostgreSQL 17", hint: "postgresql-x64-17" },
  server: { label: "Máy chủ ứng dụng", hint: "SmartMedicineServer" },
  tailscale: { label: "Tailscale (kênh quản trị)", hint: "Tailscale" },
  cloudflared: { label: "Cloudflare Tunnel (chỉ khi không dùng Funnel)", hint: "cloudflared" },
};

function ServiceChip({ state }: { state: ServiceState }) {
  const t = useT();
  const map: Record<string, { label: string; tone: Tone }> = {
    running: { label: "Đang chạy", tone: "success" },
    stopped: { label: "Đã dừng", tone: "danger" },
    not_installed: { label: "Chưa cài", tone: "warning" },
    unknown: { label: "Không rõ", tone: "neutral" },
  };
  const meta = state ? map[state] : { label: "Không xác định", tone: "neutral" as Tone };
  return <StatusIndicator tone={meta.tone} size="sm" dot>{t(meta.label)}</StatusIndicator>;
}

export function SystemTab() {
  const t = useT();
  const language = useLanguageStore((state) => state.language);
  const system = useSystem();
  const data = system.data;
  if (system.isLoading) return <Card padding="lg"><LoadingState rows={6} /></Card>;
  if (!data) return <Card padding="lg"><ErrorState description={errorMessage(system.error)} onRetry={() => void system.refetch()} /></Card>;

  const db = data.database;
  const ocr = data.ocr;
  const host = data.host;
  const ocrTone: Tone = ocr.state === "ready" ? "success" : ocr.state === "loading" ? "info" : ocr.state === "error" ? "danger" : "neutral";
  const ocrLabel = ocr.state === "ready" ? "Sẵn sàng" : ocr.state === "loading" ? "Đang nạp" : ocr.state === "error" ? "Lỗi" : "Chưa nạp";
  const last = data.backup.last;

  return (
    <div className="grid grid-cols-3 gap-6 max-2xl:grid-cols-2 max-xl:grid-cols-1 short:gap-4">
      <Card padding="lg">
        <CardTitle action={<IconTile icon={Server} tone="info" size="sm" />}>{t("Máy chủ Mini PC")}</CardTitle>
        <dl className="divide-y divide-line">
          <Row label={t("Phiên bản máy chủ")}>{data.version}</Row>
          <Row label={t("Thời gian máy chủ")}>{formatDateTime(data.time)}</Row>
          <Row label={t("Đã chạy liên tục")}>{formatDuration(data.uptime_seconds)}</Row>
          <Row label={t("Khởi động Windows lúc")}>{formatDateTime(host.boot_time)}</Row>
          <Row label={t("Kết nối quản trị")}>{connectionInfo().baseUrl}</Row>
        </dl>
      </Card>

      <Card padding="lg">
        <CardTitle action={db.ok ? <StatusIndicator tone="success" size="sm" dot>{t("Hoạt động")}</StatusIndicator> : <StatusIndicator tone="danger" size="sm" dot>{t("Lỗi")}</StatusIndicator>}>
          {t("Cơ sở dữ liệu")}
        </CardTitle>
        <dl className="divide-y divide-line">
          <Row label={t("Máy chủ")}>{db.version ? `PostgreSQL ${db.version}` : "PostgreSQL"}</Row>
          <Row label={t("Kết nối")}><span className="font-mono text-[12px]" title={db.url}>{db.url}</span></Row>
          {db.size_bytes !== undefined && <Row label={t("Dung lượng")}>{formatBytes(db.size_bytes)}</Row>}
          {db.catalog_count !== undefined && <Row label={t("Danh mục thuốc")}>{formatNumber(db.catalog_count, language)}</Row>}
          {db.users !== undefined && <Row label={t("Tài khoản")}>{db.users}</Row>}
          {db.devices !== undefined && <Row label={t("Thiết bị")}>{db.devices}</Row>}
          <Row label={t("Phiên bản lược đồ")}><span className="font-mono text-[12px]">{db.schema_revision ?? "—"}</span></Row>
        </dl>
        {db.error && <p className="mt-2 text-[12.5px] text-danger">{db.error}</p>}
      </Card>

      <Card padding="lg">
        <CardTitle action={<StatusIndicator tone={ocrTone} size="sm" dot>{t(ocrLabel)}</StatusIndicator>}>{t("Nhận diện chữ (OCR)")}</CardTitle>
        <dl className="divide-y divide-line">
          <Row label={t("Engine")}>{ocr.engine.engine ?? "—"}{ocr.engine.version ? ` · ${ocr.engine.version}` : ""}</Row>
          <Row label={t("Mô hình")}>{ocr.engine.detection_model ? `${ocr.engine.detection_model} + ${ocr.engine.recognition_model ?? ""}` : "—"}</Row>
          <Row label={t("Đang chạy trên")}>{ocr.engine.device ? (ocr.engine.device === "cpu" ? "CPU" : `GPU${ocr.engine.gpu_name ? ` · ${ocr.engine.gpu_name}` : ""}`) : "—"}</Row>
          <Row label={t("Ảnh đang chờ")}>{ocr.queue_size}</Row>
          {ocr.engine.load_seconds ? <Row label={t("Thời gian nạp mô hình")}>{ocr.engine.load_seconds.toFixed(1)} s</Row> : null}
        </dl>
        {ocr.engine.device_note && <p className="mt-2 text-[12.5px] text-warning-ink">{ocr.engine.device_note}</p>}
        {ocr.error && <p className="mt-2 break-words text-[12.5px] text-danger">{ocr.error}</p>}
      </Card>

      <Card padding="lg">
        <CardTitle>{t("Tài nguyên")}</CardTitle>
        <div className="space-y-4">
          <div>
            <p className="mb-1.5 flex items-center justify-between text-[13px]"><span className="flex items-center gap-2 text-muted"><Cpu size={15} />CPU · {host.cpu_count} {t("luồng")}</span><span className="font-semibold tabular-nums text-navy">{host.cpu_percent.toFixed(0)}%</span></p>
            <Meter percent={host.cpu_percent} />
          </div>
          <div>
            <p className="mb-1.5 flex items-center justify-between text-[13px]"><span className="flex items-center gap-2 text-muted"><MemoryStick size={15} />RAM</span><span className="font-semibold tabular-nums text-navy">{formatBytes(host.memory_used)} / {formatBytes(host.memory_total)}</span></p>
            <Meter percent={host.memory_percent} />
          </div>
          <div>
            <p className="mb-1.5 flex items-center justify-between text-[13px]"><span className="flex items-center gap-2 text-muted"><HardDrive size={15} />{t("Ổ dữ liệu")}</span><span className="font-semibold tabular-nums text-navy">{t("còn {free}", { free: formatBytes(host.disk_free) })}</span></p>
            <Meter percent={host.disk_percent} />
          </div>
        </div>
      </Card>

      <Card padding="lg">
        <CardTitle hint={t("Dịch vụ Windows trên Mini PC — tự khởi động cùng máy.")}>{t("Dịch vụ chạy nền")}</CardTitle>
        <ul className="divide-y divide-line">
          {(Object.keys(SERVICE_META) as (keyof typeof data.services)[]).map((key) => (
            <li key={key} className="flex items-center justify-between gap-3 py-2.5">
              <div className="flex min-w-0 items-center gap-3">
                <IconTile icon={key === "postgresql" ? Database : key === "server" ? Workflow : key === "tailscale" ? ShieldCheck : Globe} size="sm" />
                <div className="min-w-0">
                  <p className="truncate text-[13.5px] font-semibold text-navy">{t(SERVICE_META[key].label)}</p>
                  <p className="truncate font-mono text-[11.5px] text-muted">{SERVICE_META[key].hint}</p>
                </div>
              </div>
              <ServiceChip state={data.services[key]} />
            </li>
          ))}
        </ul>
      </Card>

      <Card padding="lg">
        <CardTitle>{t("Kết nối Internet")}</CardTitle>
        <dl className="divide-y divide-line">
          <Row label={t("Thiết bị đang trực tuyến")}>{data.devices.online_count}</Row>
          <Row label={t("Sao lưu gần nhất")}>
            {last ? (last.ok === false ? <span className="text-danger">{t("Lỗi")}</span> : formatDateTime(last.created_at ?? null)) : t("Chưa có")}
          </Row>
        </dl>
        <div className="mt-3">
          {data.public_base_url ? (
            <>
              <p className="mb-1.5 text-[13px] font-semibold text-navy">{t("Địa chỉ công khai (ứng dụng điện thoại + ESP32)")}</p>
              <CopyField value={data.public_base_url} label={t("Địa chỉ công khai")} />
            </>
          ) : (
            <p className="rounded-2xl bg-warning-soft px-4 py-3 text-[13px] text-warning-ink">{t("Chưa cấu hình SMC_PUBLIC_BASE_URL (địa chỉ Tailscale Funnel hoặc Cloudflare Tunnel). Điện thoại và ESP32 chưa kết nối được qua Internet.")}</p>
          )}
        </div>
      </Card>
    </div>
  );
}
