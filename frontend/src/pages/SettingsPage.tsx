import { useQueryClient } from "@tanstack/react-query";
import {
  BellRing, Camera, Check, CircleCheck, Cpu, Database, Download, Droplet, FileSpreadsheet, FolderOpen, HardDrive, Languages, LoaderCircle,
  MonitorCog, Palette, PlugZap, RefreshCw, RotateCcw, ShieldCheck, Thermometer, Trash2, TriangleAlert, Upload, Volume2, Wifi, Zap, type LucideIcon,
} from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useLocation } from "react-router-dom";
import { IconButton, PrimaryButton } from "@/components/Button";
import { Card } from "@/components/Card";
import { Field, Segmented, Select, TextInput, Toggle } from "@/components/Form";
import { Note } from "@/components/MedicineBits";
import { ConfirmDialog } from "@/components/Modal";
import { LoadingState } from "@/components/States";
import { IconTile, StatusIndicator } from "@/components/StatusIndicator";
import { useLanguageStore, useT } from "@/i18n";
import { api, saveBlob } from "@/services/api";
import { formatBytes, formatDateTime, formatNumber } from "@/services/format";
import { errorMessage, keys, useBackups, useCatalogStatus, useDevice, useOcrStatus, useSettings, useUpdateSettings } from "@/services/queries";
import { isVietnamese, speak, stopSpeaking, ttsSupported, useVoices } from "@/services/tts";
import { usePageHeader } from "@/stores/page";
import { toast } from "@/stores/toast";
import type { AppSettings, SettingsPatch } from "@/types/api";

type Draft = SettingsPatch;

function Section({ id, title, hint, action, children }: { id?: string; title: string; hint?: string; action?: ReactNode; children: ReactNode }) {
  return (
    <Card id={id} padding="lg" className="mb-6 break-inside-avoid scroll-mt-6 short:mb-4">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <h2 className="font-display text-[19px] font-bold text-navy">{title}</h2>
          {hint && <p className="mt-0.5 text-[13px] text-muted">{hint}</p>}
        </div>
        {action}
      </div>
      {children}
    </Card>
  );
}

function Row({ icon, label, hint, children }: { icon?: LucideIcon; label: string; hint?: string; children: ReactNode }) {
  const Icon = icon;
  return (
    <div className="flex min-h-[64px] items-center justify-between gap-4 border-b border-line py-3 last:border-b-0">
      <div className="flex min-w-0 items-center gap-3">
        {Icon && <Icon size={20} strokeWidth={1.8} className="shrink-0 text-navy" />}
        <div className="min-w-0">
          <p className="text-[15px] text-navy">{label}</p>
          {hint && <p className="text-[12.5px] text-muted">{hint}</p>}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">{children}</div>
    </div>
  );
}

function NumberInput({ value, onChange, min, max, step = 1, suffix, label }: { value: number; onChange: (value: number) => void; min?: number; max?: number; step?: number; suffix?: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <TextInput
        type="number" aria-label={label} value={Number.isFinite(value) ? value : ""} min={min} max={max} step={step}
        onChange={(event) => onChange(event.target.value === "" ? Number.NaN : Number(event.target.value))}
        className="!h-10 !w-[88px] !px-3 text-right tabular-nums"
      />
      {suffix && <span className="w-6 text-sm text-muted">{suffix}</span>}
    </span>
  );
}

// ---- Danh mục thuốc --------------------------------------------------------------- //
function CatalogSection() {
  const t = useT();
  const client = useQueryClient();
  const language = useLanguageStore((state) => state.language);
  const catalog = useCatalogStatus();
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const data = catalog.data;
  const progress = data?.progress;
  const wasRunning = useRef(false);

  useEffect(() => {
    if (progress?.running) wasRunning.current = true;
    else if (wasRunning.current && progress) {
      wasRunning.current = false;
      void client.invalidateQueries({ queryKey: keys.health });
      if (progress.stage === "failed") toast.error(t("Nhập dữ liệu thất bại"), progress.message);
      else toast.success(t("Đã nhập danh mục thuốc"), progress.message);
    }
  }, [progress, client, t]);

  const start = async (action: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await action();
      await client.invalidateQueries({ queryKey: keys.catalog });
    } catch (error) {
      toast.error(t("Không bắt đầu nhập được"), errorMessage(error));
    } finally {
      setBusy(false);
    }
  };
  const choose = async () => {
    if (window.smc) {
      const path = await window.smc.pickExcelFile();
      if (path) await start(() => api.catalogImport(path, false));
    } else fileRef.current?.click();
  };
  const last = data?.last_import;
  const source = data?.source_path ?? data?.default_source;

  return (
    <Section title={t("Dữ liệu thuốc")} hint={t("Danh mục tra cứu nhập từ file Excel (DAV_unique.xlsx). Tách biệt với thuốc trong tủ.")}
      action={data && (data.count > 0
        ? <StatusIndicator tone="success" icon={CircleCheck} size="sm">{t("{count} thuốc", { count: formatNumber(data.count, language) })}</StatusIndicator>
        : <StatusIndicator tone="warning" icon={TriangleAlert} size="sm">{t("Chưa có dữ liệu")}</StatusIndicator>)}>
      {!data ? <LoadingState rows={2} /> : (
        <>
          <Row icon={FileSpreadsheet} label={t("Nguồn dữ liệu Excel")} hint={source ?? t("Chưa chọn file")}>
            <PrimaryButton variant="secondary" size="sm" icon={Upload} loading={busy} disabled={progress?.running} onClick={() => void choose()}>{t("Chọn file Excel…")}</PrimaryButton>
          </Row>
          <Row icon={Database} label={t("Lần nhập gần nhất")}
            hint={last ? `${formatDateTime(last.finished_at ?? last.started_at)} · ${last.file_name}` : t("Chưa nhập lần nào")}>
            {last && <StatusIndicator size="sm" tone={last.status === "success" ? "success" : last.status === "failed" ? "danger" : "neutral"}>
              {last.status === "success" ? t("Thành công") : last.status === "failed" ? t("Thất bại") : last.status === "running" ? t("Đang chạy") : t("Bỏ qua")}
            </StatusIndicator>}
            <PrimaryButton variant="secondary" size="sm" icon={RefreshCw} disabled={!source || progress?.running || busy} onClick={() => void start(() => api.catalogImport(null, true))}>{t("Nhập lại")}</PrimaryButton>
          </Row>
          {last?.status === "success" && (
            <p className="pt-2 text-[12.5px] text-muted">
              {t("{total} dòng: {inserted} mới, {updated} cập nhật, {unchanged} không đổi, {skipped} bỏ qua.", {
                total: formatNumber(last.rows_total, language), inserted: formatNumber(last.inserted, language), updated: formatNumber(last.updated, language),
                unchanged: formatNumber(last.unchanged, language), skipped: formatNumber(last.skipped, language),
              })}
            </p>
          )}
          {last?.status === "failed" && <p className="pt-2 text-[12.5px] text-danger">{last.message}</p>}
          {progress?.running && (
            <div className="mt-3 rounded-2xl bg-primary-soft p-4" role="status">
              <div className="mb-2 flex items-center justify-between text-[13px] font-semibold text-primary">
                <span className="flex items-center gap-2"><LoaderCircle size={15} className="animate-spin" />
                  {progress.stage === "indexing" ? t("Đang tạo chỉ mục tìm kiếm") : progress.stage === "hashing" ? t("Đang kiểm tra file nguồn") : t("Đang đọc và chuẩn hóa dữ liệu")}
                </span>
                <span className="tabular-nums">{formatNumber(progress.rows_read, language)}{progress.rows_total ? ` / ${formatNumber(progress.rows_total, language)}` : ""}</span>
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-primary/15"><div className="h-full rounded-full bg-primary transition-all duration-500" style={{ width: `${progress.percent ?? 6}%` }} /></div>
            </div>
          )}
          <input ref={fileRef} type="file" accept=".xlsx,.xlsm" className="hidden"
            onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; if (file) void start(() => api.catalogUpload(file)); }} />
        </>
      )}
    </Section>
  );
}

// ---- Sao lưu ------------------------------------------------------------------------ //
function BackupSection() {
  const t = useT();
  const client = useQueryClient();
  const backups = useBackups();
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [restoring, setRestoring] = useState<{ name?: string; file?: File } | null>(null);

  const run = async (label: string, action: () => Promise<unknown>, success: string) => {
    setBusy(label);
    try {
      await action();
      toast.success(success);
      await client.invalidateQueries();
    } catch (error) {
      toast.error(t("Không thực hiện được"), errorMessage(error));
    } finally {
      setBusy(null);
    }
  };
  const items = backups.data?.items ?? [];

  return (
    <Section title={t("Sao lưu và khôi phục")} hint={t("Gồm thuốc trong tủ, lời nhắc, lịch sử, cảnh báo và cài đặt. Danh mục thuốc được nhập lại từ Excel nên không nằm trong bản sao lưu.")}>
      <div className="flex flex-wrap items-center gap-2.5">
        <PrimaryButton icon={HardDrive} loading={busy === "create"} onClick={() => void run("create", () => api.backupCreate(), t("Đã tạo bản sao lưu"))}>{t("Tạo bản sao lưu")}</PrimaryButton>
        <PrimaryButton variant="secondary" icon={Upload} onClick={() => fileRef.current?.click()}>{t("Khôi phục từ file…")}</PrimaryButton>
        {window.smc && <PrimaryButton variant="ghost" icon={FolderOpen} onClick={() => void window.smc?.openDataFolder()}>{t("Mở thư mục dữ liệu")}</PrimaryButton>}
        <input ref={fileRef} type="file" accept=".smcbak" className="hidden" onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; if (file) setRestoring({ file }); }} />
      </div>
      {backups.isLoading ? <div className="pt-4"><LoadingState rows={2} /></div> : items.length === 0 ? (
        <p className="pt-4 text-[13px] text-muted">{t("Chưa có bản sao lưu nào.")}</p>
      ) : (
        <ul className="mt-3 divide-y divide-line">
          {items.slice(0, 6).map((item) => (
            <li key={item.name} className="flex items-center gap-3 py-2.5">
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13.5px] font-semibold text-navy">{item.name}</p>
                <p className="text-[12px] text-muted">{formatDateTime(item.created_at)} · {formatBytes(item.size)}</p>
              </div>
              <IconButton icon={Download} label={t("Tải về")} size="sm" variant="ghost" onClick={() => void api.backupDownload(item.name).then((f) => saveBlob(f.blob, item.name)).catch((e) => toast.error(t("Không tải được file"), errorMessage(e)))} />
              <IconButton icon={RotateCcw} label={t("Khôi phục")} size="sm" variant="ghost" onClick={() => setRestoring({ name: item.name })} />
              <IconButton icon={Trash2} label={t("Xóa")} size="sm" variant="danger" disabled={busy !== null} onClick={() => void run("delete", () => api.backupDelete(item.name), t("Đã xóa bản sao lưu"))} />
            </li>
          ))}
        </ul>
      )}
      {backups.data && <p className="mt-3 break-all text-[12px] text-muted">{t("Thư mục sao lưu")}: {backups.data.directory}</p>}
      <ConfirmDialog
        open={restoring !== null} danger title={t("Khôi phục dữ liệu?")} confirmLabel={t("Khôi phục")} loading={busy === "restore"}
        description={t("Thuốc trong tủ, lời nhắc, lịch sử và cài đặt hiện tại sẽ được thay bằng nội dung bản sao lưu “{name}”. Ứng dụng tự tạo một bản sao lưu an toàn trước khi khôi phục.", { name: restoring?.name ?? restoring?.file?.name ?? "" })}
        onClose={() => setRestoring(null)}
        onConfirm={() => {
          const target = restoring;
          if (!target) return;
          void run("restore", () => (target.file ? api.backupRestoreUpload(target.file) : api.backupRestore(target.name as string)), t("Đã khôi phục dữ liệu")).then(() => setRestoring(null));
        }}
      />
    </Section>
  );
}

// ---- Trang ---------------------------------------------------------------------------- //
export function SettingsPage() {
  const t = useT();
  const location = useLocation();
  usePageHeader(t("Cài đặt"), t("Tùy chỉnh thiết bị và ứng dụng"), `${t("Tủ thuốc thông minh")} / ${t("Cài đặt")}`);
  const query = useSettings();
  const save = useUpdateSettings();
  const device = useDevice().data;
  const ocr = useOcrStatus();
  const voices = useVoices();
  const [draft, setDraft] = useState<Draft>({});
  const [token, setToken] = useState("");
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [cameras, setCameras] = useState<MediaDeviceInfo[]>([]);
  const [speaking, setSpeaking] = useState(false);
  const stored = query.data?.settings;

  useEffect(() => {
    if (!location.hash) return;
    const timer = window.setTimeout(() => document.getElementById(location.hash.slice(1))?.scrollIntoView({ behavior: "smooth", block: "start" }), 250);
    return () => window.clearTimeout(timer);
  }, [location.hash, query.isSuccess]);

  useEffect(() => {
    navigator.mediaDevices?.enumerateDevices?.().then((list) => setCameras(list.filter((d) => d.kind === "videoinput"))).catch(() => setCameras([]));
    return () => stopSpeaking();
  }, []);

  if (!stored) return <Card padding="lg"><LoadingState rows={6} /></Card>;

  const value = <K extends keyof AppSettings>(key: K): AppSettings[K] => (key in draft ? (draft as unknown as AppSettings)[key] : stored[key]);
  const set = <K extends keyof Draft>(key: K, next: Draft[K]) =>
    setDraft((prev) => {
      const copy = { ...prev, [key]: next };
      if ((stored as unknown as Record<string, unknown>)[key as string] === next) delete (copy as Record<string, unknown>)[key as string];
      return copy;
    });
  const dirtyKeys = Object.keys(draft).length + (token ? 1 : 0);

  const numbersValid = (["temp_min", "temp_max", "humidity_min", "humidity_max", "expiry_warning_days", "low_stock_threshold", "esp32_port", "esp32_poll_seconds", "esp32_timeout_seconds", "ocr_det_limit_side_len", "ocr_cpu_threads"] as const)
    .every((key) => Number.isFinite(value(key)));
  const rangeError = value("temp_min") >= value("temp_max") ? t("Nhiệt độ tối thiểu phải nhỏ hơn tối đa.")
    : value("humidity_min") >= value("humidity_max") ? t("Độ ẩm tối thiểu phải nhỏ hơn tối đa.") : null;

  const submit = () => {
    if (!numbersValid) return toast.error(t("Có ô số đang để trống"), t("Hãy nhập đủ giá trị trước khi lưu."));
    if (rangeError) return toast.error(t("Ngưỡng không hợp lệ"), rangeError);
    const body: Draft = { ...draft };
    if (token) body.esp32_token = token;
    save.mutate(body, { onSuccess: () => { setDraft({}); setToken(""); } });
  };

  const testDevice = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const result = await api.deviceTest({
        mode: value("esp32_mode"), host: value("esp32_host"), port: value("esp32_port"), path: value("esp32_path"),
        timeout: value("esp32_timeout_seconds"), token: token || null,
      });
      setTestResult(result.ok
        ? { ok: true, text: `${t("Kết nối được")}: ${result.temperature ?? "—"}°C · ${result.humidity ?? "—"}%${result.simulated ? ` (${t("Mô phỏng")})` : ""}` }
        : { ok: false, text: result.error ?? t("Không kết nối được") });
    } catch (error) {
      setTestResult({ ok: false, text: errorMessage(error) });
    } finally {
      setTesting(false);
    }
  };

  const viVoices = voices.filter(isVietnamese);
  const deps = query.data?.options.ocr_dependencies;
  const ocrData = ocr.data;
  const activeProfile = query.data?.options.ocr_profiles.find((profile) => profile.value === stored.ocr_profile);
  const esp32Chip = device?.state === "connected" ? <StatusIndicator tone="success" size="sm">{t("Đã kết nối")}</StatusIndicator>
    : device?.state === "connecting" ? <StatusIndicator tone="info" size="sm">{t("Đang kết nối")}</StatusIndicator>
    : device?.enabled ? <StatusIndicator tone="warning" size="sm">{t(device.environment.label)}</StatusIndicator>
    : <StatusIndicator tone="neutral" size="sm">{t("Chưa kết nối")}</StatusIndicator>;

  return (
    <div className="pb-20">
      <div className="columns-2 gap-6 max-xl:columns-1 short:gap-4">
        <Section id="thresholds" title={t("Ngưỡng môi trường")}>
          <div className="flex items-center justify-between gap-4 border-b border-line py-3.5">
            <div className="flex items-center gap-3.5">
              <IconTile icon={Thermometer} tone="info" size="lg" />
              <div><p className="font-display text-[16px] font-bold text-navy">{t("Nhiệt độ")}</p><p className="text-[13px] text-muted">{t("Ngưỡng đặt")}</p></div>
            </div>
            <div className="flex items-center gap-2">
              <NumberInput label={t("Nhiệt độ tối thiểu")} value={value("temp_min")} min={-20} max={60} step={0.5} onChange={(v) => set("temp_min", v)} />
              <span className="text-muted">–</span>
              <NumberInput label={t("Nhiệt độ tối đa")} value={value("temp_max")} min={-20} max={60} step={0.5} suffix="°C" onChange={(v) => set("temp_max", v)} />
            </div>
          </div>
          <div className="flex items-center justify-between gap-4 border-b border-line py-3.5">
            <div className="flex items-center gap-3.5">
              <IconTile icon={Droplet} tone="info" size="lg" />
              <div><p className="font-display text-[16px] font-bold text-navy">{t("Độ ẩm")}</p><p className="text-[13px] text-muted">{t("Ngưỡng đặt")}</p></div>
            </div>
            <div className="flex items-center gap-2">
              <NumberInput label={t("Độ ẩm tối thiểu")} value={value("humidity_min")} min={0} max={100} onChange={(v) => set("humidity_min", v)} />
              <span className="text-muted">–</span>
              <NumberInput label={t("Độ ẩm tối đa")} value={value("humidity_max")} min={0} max={100} suffix="%" onChange={(v) => set("humidity_max", v)} />
            </div>
          </div>
          {rangeError && <p role="alert" className="pt-3 text-[13px] font-medium text-danger">{rangeError}</p>}
          <div className="mt-4"><Note>{t("Giá trị mặc định chỉ là điểm khởi đầu. Hãy đặt ngưỡng theo điều kiện bảo quản in trên bao bì của các thuốc bạn đang giữ.")}</Note></div>
        </Section>

        <Section title={t("Ngưỡng thuốc")}>
          <Row label={t("Cảnh báo trước khi hết hạn")} hint={t("Thuốc còn ít hơn số ngày này được xếp vào “Sắp hết hạn”.")}>
            <NumberInput label={t("Số ngày cảnh báo trước hạn")} value={value("expiry_warning_days")} min={1} max={365} suffix={t("ngày")} onChange={(v) => set("expiry_warning_days", v)} />
          </Row>
          <Row label={t("Ngưỡng số lượng thấp")} hint={t("Cảnh báo khi số lượng còn lại nhỏ hơn hoặc bằng giá trị này.")}>
            <NumberInput label={t("Ngưỡng số lượng thấp")} value={value("low_stock_threshold")} min={0} onChange={(v) => set("low_stock_threshold", v)} />
          </Row>
        </Section>

        <Section id="esp32" title={t("Kết nối thiết bị")} hint={t("ESP32 gửi nhiệt độ, độ ẩm qua mạng nội bộ. Giao thức: docs/ESP32_PROTOCOL.md.")} action={esp32Chip}>
          <Row icon={Wifi} label={t("Kết nối ESP32")} hint={device?.enabled && device.last_error ? device.last_error : device?.address ?? undefined}>
            <Toggle checked={value("esp32_enabled")} onChange={(v) => set("esp32_enabled", v)} label={t("Bật kết nối ESP32")} />
          </Row>
          <div className="grid grid-cols-[1fr_110px] gap-3 pt-4">
            <Field label={t("Địa chỉ thiết bị (IP hoặc tên máy)")}><TextInput value={value("esp32_host")} placeholder="192.168.1.50" maxLength={255} onChange={(event) => set("esp32_host", event.target.value)} /></Field>
            <Field label={t("Cổng")}><TextInput type="number" min={1} max={65535} value={Number.isFinite(value("esp32_port")) ? value("esp32_port") : ""} onChange={(event) => set("esp32_port", event.target.value === "" ? Number.NaN : Number(event.target.value))} /></Field>
          </div>
          <div className="grid grid-cols-3 gap-3 pt-3">
            <Field label={t("Giao thức")}>
              <Select value={value("esp32_mode")} onChange={(event) => set("esp32_mode", event.target.value as AppSettings["esp32_mode"])}>
                <option value="http">HTTP (polling)</option>
                <option value="websocket">WebSocket</option>
              </Select>
            </Field>
            <Field label={t("Đường dẫn")}><TextInput value={value("esp32_path")} maxLength={200} onChange={(event) => set("esp32_path", event.target.value)} /></Field>
            <Field label={t("Chu kỳ đọc (giây)")}><TextInput type="number" min={1} max={600} value={Number.isFinite(value("esp32_poll_seconds")) ? value("esp32_poll_seconds") : ""} onChange={(event) => set("esp32_poll_seconds", event.target.value === "" ? Number.NaN : Number(event.target.value))} /></Field>
          </div>
          <div className="grid grid-cols-[1fr_auto] items-end gap-3 pt-3">
            <Field label={t("Mã truy cập thiết bị (tùy chọn)")} hint={stored.esp32_token_set ? t("Đã lưu một mã. Nhập mã mới để thay thế.") : t("Gửi kèm header X-Device-Token nếu firmware yêu cầu.")}>
              <TextInput type="password" value={token} autoComplete="off" maxLength={200} placeholder={stored.esp32_token_set ? "••••••••" : ""} onChange={(event) => setToken(event.target.value)} />
            </Field>
            <PrimaryButton variant="secondary" icon={PlugZap} loading={testing} className="mb-[26px]" onClick={() => void testDevice()}>{t("Thử kết nối")}</PrimaryButton>
          </div>
          {testResult && (
            <p role="status" className={`mt-1 rounded-2xl px-4 py-3 text-[13px] font-medium ${testResult.ok ? "bg-success-soft text-success" : "bg-danger-soft text-danger"}`}>{testResult.text}</p>
          )}
          <div className="mt-4"><Note>{t("Khi chưa kết nối, ứng dụng hiển thị “Chưa kết nối” và không tự tạo số đo. Lệnh điều khiển chỉ được gửi nếu firmware khai báo hỗ trợ.")}</Note></div>
        </Section>

        <CatalogSection />

        <Section title={t("Camera")}>
          <Row icon={Camera} label={t("Camera mặc định")} hint={cameras.length === 0 ? t("Không tìm thấy camera nào") : cameras.some((c) => c.label) ? undefined : t("Tên camera hiện sau khi cấp quyền ở trang Quét thuốc.")}>
            <Select value={value("camera_device_id") ?? ""} className="!h-10 !w-[260px]" aria-label={t("Camera mặc định")}
              onChange={(event) => set("camera_device_id", event.target.value || null)}>
              <option value="">{t("Theo mặc định của hệ thống")}</option>
              {cameras.map((camera, index) => <option key={camera.deviceId || index} value={camera.deviceId}>{camera.label || `Camera ${index + 1}`}</option>)}
            </Select>
          </Row>
        </Section>

        <Section title={t("Cấu hình OCR")} hint={t("PaddleOCR chạy cục bộ trên máy. Engine PaddlePaddle dùng GPU NVIDIA nếu có, không có thì chạy CPU; ONNX Runtime luôn chạy CPU.")}
          action={ocrData && (ocrData.state === "ready" ? <StatusIndicator tone="success" size="sm" icon={CircleCheck}>{t("Sẵn sàng")}</StatusIndicator>
            : ocrData.state === "loading" ? <StatusIndicator tone="info" size="sm" icon={LoaderCircle}>{t("Đang nạp")}</StatusIndicator>
            : ocrData.state === "error" ? <StatusIndicator tone="danger" size="sm" icon={TriangleAlert}>{t("Lỗi")}</StatusIndicator>
            : <StatusIndicator tone="neutral" size="sm">{t("Chưa nạp")}</StatusIndicator>)}>
          <Row icon={Cpu} label={t("Engine suy luận")} hint={value("ocr_engine") === "paddle" && deps && !deps.paddle ? t("Chưa cài PaddlePaddle trên máy này.") : undefined}>
            <Select value={value("ocr_engine")} className="!h-10 !w-[330px] max-w-full" aria-label={t("Engine suy luận")} onChange={(event) => set("ocr_engine", event.target.value as AppSettings["ocr_engine"])}>
              <option value="onnxruntime">ONNX Runtime ({t("khuyến nghị cho CPU")})</option>
              <option value="paddle">PaddlePaddle{deps?.paddle_gpu ? " (GPU)" : ""}{deps && !deps.paddle ? ` (${t("chưa cài")})` : ""}</option>
            </Select>
          </Row>
          <Row icon={Zap} label={t("Thiết bị chạy")}
            hint={value("ocr_engine") !== "paddle" ? t("ONNX Runtime luôn chạy trên CPU.") : deps && deps.paddle && !deps.paddle_gpu ? t("PaddlePaddle trên máy này là bản CPU.") : undefined}>
            <Select value={value("ocr_engine") === "paddle" ? value("ocr_device") : "cpu"} className="!h-10 !w-[330px] max-w-full" aria-label={t("Thiết bị chạy")}
              disabled={value("ocr_engine") !== "paddle"} onChange={(event) => set("ocr_device", event.target.value as AppSettings["ocr_device"])}>
              <option value="auto">{t("Tự động (GPU nếu có)")}</option>
              <option value="gpu">GPU (NVIDIA CUDA)</option>
              <option value="cpu">CPU</option>
            </Select>
          </Row>
          <Row icon={MonitorCog} label={t("Bộ mô hình")}>
            <Select value={value("ocr_profile")} className="!h-10 !w-[330px] max-w-full" aria-label={t("Bộ mô hình")} onChange={(event) => set("ocr_profile", event.target.value as AppSettings["ocr_profile"])}>
              {query.data?.options.ocr_profiles.map((profile) => <option key={profile.value} value={profile.value}>{profile.label}</option>)}
            </Select>
          </Row>
          <Row label={t("Cạnh dài tối đa khi phát hiện chữ")} hint={t("Lớn hơn đọc được chữ nhỏ nhưng chậm hơn.")}>
            <NumberInput label={t("Cạnh dài tối đa")} value={value("ocr_det_limit_side_len")} min={320} max={2560} step={32} suffix="px" onChange={(v) => set("ocr_det_limit_side_len", v)} />
          </Row>
          <Row label={t("Số luồng CPU")} hint={t("0 = tự chọn theo số nhân của máy.")}>
            <NumberInput label={t("Số luồng CPU")} value={value("ocr_cpu_threads")} min={0} max={64} onChange={(v) => set("ocr_cpu_threads", v)} />
          </Row>
          <Row label={t("Tự thử tiền xử lý khi ảnh khó đọc")} hint={t("Tăng tương phản, xoay, nắn nghiêng — chỉ dùng khi cho kết quả tốt hơn ảnh gốc.")}>
            <Toggle checked={value("ocr_auto_enhance")} onChange={(v) => set("ocr_auto_enhance", v)} label={t("Tự thử tiền xử lý")} />
          </Row>
          <Row label={t("Phân loại hướng dòng chữ")} hint={t("Cần thêm mô hình PP-LCNet; bật nếu hay quét chữ lộn ngược.")}>
            <Toggle checked={value("ocr_use_textline_orientation")} onChange={(v) => set("ocr_use_textline_orientation", v)} label={t("Phân loại hướng dòng chữ")} />
          </Row>
          <Row label={t("Lưu ảnh quét khi xác nhận")} hint={t("Tắt: ảnh chỉ giữ tạm và tự xóa. Bật: lưu một ảnh kèm thuốc trong tủ.")}>
            <Toggle checked={value("ocr_save_scan_images")} onChange={(v) => set("ocr_save_scan_images", v)} label={t("Lưu ảnh quét")} />
          </Row>
          {ocrData && (
            <div className="mt-3 rounded-2xl bg-tile p-4 text-[12.5px] text-muted">
              <p>
                <span className="font-semibold text-navy">PaddleOCR</span> {ocrData.engine.version ?? (ocrData.dependencies.paddleocr ? "" : `(${t("chưa cài")})`)} ·{" "}
                {ocrData.engine.detection_model ?? activeProfile?.detection ?? "—"} + {ocrData.engine.recognition_model ?? activeProfile?.recognition ?? "—"}
              </p>
              {ocrData.engine.device && (
                <p className="mt-1">
                  {t("Đang chạy trên")}:{" "}
                  <span className="font-semibold text-navy">{ocrData.engine.device === "cpu" ? "CPU" : `GPU${ocrData.engine.gpu_name ? ` · ${ocrData.engine.gpu_name}` : ""}`}</span>
                </p>
              )}
              {ocrData.engine.device_note && <p className="mt-1 text-warning-ink">{ocrData.engine.device_note}</p>}
              {ocrData.engine.models_available_offline === false && <p className="mt-1 text-warning-ink">{t("Mô hình chưa có trên máy: lần nạp đầu cần Internet, hoặc chạy scripts/download_ocr_models.py.")}</p>}
              {ocrData.error && <p className="mt-1 break-words text-danger">{ocrData.error}</p>}
              <PrimaryButton variant="soft" size="sm" className="mt-3" icon={RefreshCw} disabled={ocrData.state === "loading" || dirtyKeys > 0}
                onClick={() => void api.ocrWarmup().then(() => ocr.refetch()).catch((e) => toast.error(t("Không nạp được OCR"), errorMessage(e)))}>
                {t("Nạp mô hình ngay")}
              </PrimaryButton>
            </div>
          )}
        </Section>

        <Section title={t("Thông báo")}>
          <Row label={t("Cảnh báo vượt ngưỡng")}><Toggle checked={value("notify_environment")} onChange={(v) => set("notify_environment", v)} label={t("Cảnh báo vượt ngưỡng")} /></Row>
          <Row label={t("Nhắc uống thuốc")}><Toggle checked={value("notify_reminders")} onChange={(v) => set("notify_reminders", v)} label={t("Nhắc uống thuốc")} /></Row>
          <Row label={t("Thông báo trên Windows")}><Toggle checked={value("notify_windows")} onChange={(v) => set("notify_windows", v)} label={t("Thông báo trên Windows")} /></Row>
          <Row icon={BellRing} label={t("Âm thanh thông báo")}><Toggle checked={value("sound_enabled")} onChange={(v) => set("sound_enabled", v)} label={t("Âm thanh thông báo")} /></Row>
          <Row label={t("Chạy nền ở khay hệ thống")} hint={t("Đóng cửa sổ vẫn nhắc uống thuốc. Thoát hẳn từ biểu tượng ở khay.")}>
            <Toggle checked={value("minimize_to_tray")} onChange={(v) => set("minimize_to_tray", v)} label={t("Chạy nền ở khay hệ thống")} disabled={!window.smc} />
          </Row>
        </Section>

        <Section id="tts" title={t("Giọng đọc")} hint={t("Đọc thông tin thuốc bằng giọng đã cài trên máy (hoạt động offline).")}>
          <Row icon={Volume2} label={t("Bật đọc thông tin thuốc")}><Toggle checked={value("tts_enabled")} onChange={(v) => set("tts_enabled", v)} label={t("Bật đọc thông tin thuốc")} /></Row>
          <Row label={t("Giọng đọc")} hint={!ttsSupported() ? t("Thiết bị không hỗ trợ đọc văn bản") : t("{count} giọng tiếng Việt", { count: viVoices.length })}>
            <Select value={value("tts_voice") ?? ""} className="!h-10 !w-[280px]" aria-label={t("Giọng đọc")} disabled={voices.length === 0} onChange={(event) => set("tts_voice", event.target.value || null)}>
              <option value="">{t("Tự chọn giọng tiếng Việt")}</option>
              {[...viVoices, ...voices.filter((v) => !isVietnamese(v))].map((voice) => <option key={voice.voiceURI} value={voice.voiceURI}>{voice.name} ({voice.lang})</option>)}
            </Select>
          </Row>
          <Row label={t("Tốc độ đọc")} hint={`${value("tts_rate").toFixed(2)}×`}>
            <input type="range" min={0.5} max={2} step={0.05} value={value("tts_rate")} aria-label={t("Tốc độ đọc")} onChange={(event) => set("tts_rate", Number(event.target.value))} className="w-44 accent-[var(--smc-primary)]" />
            <PrimaryButton variant="soft" size="sm" icon={Volume2} disabled={!ttsSupported()}
              onClick={() => {
                if (speaking) { stopSpeaking(); setSpeaking(false); return; }
                const result = speak("Xin chào. Đây là giọng đọc thông tin thuốc của tủ thuốc thông minh.", { voiceUri: value("tts_voice"), rate: value("tts_rate"), onEnd: () => setSpeaking(false) });
                if (result.ok) setSpeaking(true);
                else toast.warning(t("Chưa có giọng đọc tiếng Việt"), t("Xem hướng dẫn bên dưới để cài giọng đọc."));
              }}>
              {speaking ? t("Dừng") : t("Đọc thử")}
            </PrimaryButton>
          </Row>
          {ttsSupported() && viVoices.length === 0 && (
            <div className="mt-3">
              <Note tone="warning">
                {t("Máy chưa có giọng đọc tiếng Việt offline. Trên Windows 10/11: Settings → Time & language → Speech → Manage voices → Add voices → Vietnamese, rồi mở lại ứng dụng. Bạn cũng có thể chọn tạm một giọng khác trong danh sách.")}
              </Note>
            </div>
          )}
        </Section>

        <Section title={t("Giao diện")}>
          <Row icon={Palette} label={t("Chế độ hiển thị")}>
            <Segmented size="sm" value={value("theme")} onChange={(v) => set("theme", v)} options={[{ value: "light", label: t("Sáng") }, { value: "dark", label: t("Tối") }, { value: "system", label: t("Theo hệ thống") }]} />
          </Row>
          <Row icon={Languages} label={t("Ngôn ngữ")} hint={t("Nội dung do hệ thống sinh ra (cảnh báo, lịch sử) luôn là tiếng Việt.")}>
            <Segmented size="sm" value={value("language")} onChange={(v) => set("language", v)} options={[{ value: "vi", label: "Tiếng Việt" }, { value: "en", label: "English" }]} />
          </Row>
          <Row icon={ShieldCheck} label={t("Phiên bản")}><span className="text-sm tabular-nums text-muted">{window.smc?.appVersion ?? "1.0.0"}</span></Row>
        </Section>

        <BackupSection />
      </div>

      {/* Hành động chính của trang: lưu mọi thay đổi */}
      <div className="fixed bottom-7 right-10 z-30 flex items-center gap-2.5 rounded-[22px] bg-surface/95 p-2 shadow-card ring-1 ring-line/60 backdrop-blur 3xl:right-12">
        {dirtyKeys > 0 && (
          <PrimaryButton variant="secondary" size="lg" onClick={() => { setDraft({}); setToken(""); setTestResult(null); }}>{t("Hủy thay đổi")}</PrimaryButton>
        )}
        <PrimaryButton size="lg" icon={Check} loading={save.isPending} disabled={dirtyKeys === 0} onClick={submit} data-testid="save-settings">
          {dirtyKeys > 0 ? t("Lưu cài đặt ({count})", { count: dirtyKeys }) : t("Lưu cài đặt")}
        </PrimaryButton>
      </div>
    </div>
  );
}
