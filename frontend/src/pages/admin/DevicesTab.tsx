import { useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import {
  Cpu, Droplet, KeyRound, Plus, Power, RadioTower, Send, Star, Thermometer, Trash2, Wifi, WifiOff, X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { IconButton, PrimaryButton } from "@/components/Button";
import { Card, CardTitle, Tile } from "@/components/Card";
import { Field, Select, TextArea, TextInput, Toggle } from "@/components/Form";
import { Note } from "@/components/MedicineBits";
import { ConfirmDialog, Modal } from "@/components/Modal";
import { EmptyState, ErrorState, LoadingState } from "@/components/States";
import { IconTile, StatusIndicator } from "@/components/StatusIndicator";
import { useT } from "@/i18n";
import { api } from "@/services/api";
import { formatDateTime, formatTime } from "@/services/format";
import { errorMessage, keys, useCommand, useDeviceCommands, useDeviceDetail, useDevices, useSettings } from "@/services/queries";
import { toast } from "@/stores/toast";
import type { DeviceCommand, DeviceConnection, DeviceInfo, DeviceTokenResult } from "@/types/api";
import { CommandStatusChip, CopyField, payloadSummary } from "./shared";

const ACTION_LABELS: Record<string, string> = {
  buzzer: "Bật/tắt còi",
  read_now: "Đọc cảm biến ngay",
  set_thresholds: "Gửi ngưỡng cảnh báo cục bộ",
  set_alarm: "Còi tự động khi vượt ngưỡng",
  set_interval: "Đổi chu kỳ gửi số đo",
};

function DeviceStatusChip({ device }: { device: DeviceInfo }) {
  const t = useT();
  if (!device.is_active) return <StatusIndicator tone="neutral" size="sm" icon={Power}>{t("Đã vô hiệu")}</StatusIndicator>;
  return device.online
    ? <StatusIndicator tone="success" size="sm" icon={Wifi}>{t("Trực tuyến")}</StatusIndicator>
    : <StatusIndicator tone="warning" size="sm" icon={WifiOff}>{t("Ngoại tuyến")}</StatusIndicator>;
}

// ---- Token chỉ hiển thị một lần ------------------------------------------------------ //
function TokenDialog({ result, onClose }: { result: DeviceTokenResult | null; onClose: () => void }) {
  const t = useT();
  const host = (() => {
    try {
      return result?.connection.public_base_url ? new URL(result.connection.public_base_url).host : null;
    } catch {
      return null;
    }
  })();
  return (
    <Modal open={result !== null} onClose={onClose} size="md" title={t("Token của thiết bị “{name}”", { name: result?.device.name ?? "" })}
      description={t("Token chỉ hiển thị MỘT lần. Máy chủ chỉ lưu bản băm, không xem lại được.")}
      footer={<PrimaryButton onClick={onClose}>{t("Tôi đã lưu token")}</PrimaryButton>}>
      {result && (
        <div className="space-y-4">
          <Field label={t("Token thiết bị (DEVICE_TOKEN)")}><CopyField value={result.token} label={t("Token thiết bị")} /></Field>
          {result.connection.websocket_url
            ? <Field label={t("Địa chỉ kết nối WSS")}><CopyField value={result.connection.websocket_url} label={t("Địa chỉ kết nối WSS")} /></Field>
            : <Note tone="warning">{result.connection.note ?? t("Máy chủ chưa có tên miền công khai.")}</Note>}
          <div className="rounded-2xl bg-tile px-4 py-3.5 text-[13px] leading-relaxed text-muted">
            <p className="mb-1 font-semibold text-navy">{t("Cấu hình firmware")}</p>
            <ol className="list-decimal space-y-0.5 pl-5">
              <li>{t("Chép firmware/esp32_cabinet/config.example.h thành config.h.")}</li>
              <li>{t("Điền Wi-Fi của nơi đặt tủ (không cần chung mạng với máy này).")}</li>
              <li>
                {t("Đặt")} <code className="font-mono text-navy">DEVICE_TOKEN</code> {t("bằng token ở trên")}
                {host && <>; <code className="font-mono text-navy">SERVER_HOST</code> = <code className="font-mono text-navy">{host}</code></>}.
              </li>
              <li>{t("Nạp firmware bằng Arduino IDE. Thiết bị tự kết nối ra Internet tới máy chủ.")}</li>
            </ol>
          </div>
        </div>
      )}
    </Modal>
  );
}

function CreateDeviceDialog({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (result: DeviceTokenResult) => void }) {
  const t = useT();
  const client = useQueryClient();
  const [name, setName] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) {
      setName("");
      setNote("");
    }
  }, [open]);
  const submit = async () => {
    setBusy(true);
    try {
      const result = await api.deviceCreate({ name: name.trim(), note: note.trim() || null });
      await client.invalidateQueries({ queryKey: keys.devices });
      onCreated(result);
      onClose();
    } catch (error) {
      toast.error(t("Không thêm được thiết bị"), errorMessage(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open={open} onClose={onClose} size="sm" title={t("Thêm thiết bị ESP32")}
      footer={
        <>
          <PrimaryButton variant="secondary" onClick={onClose}>{t("Hủy")}</PrimaryButton>
          <PrimaryButton icon={Plus} loading={busy} disabled={!name.trim()} onClick={() => void submit()}>{t("Thêm và tạo token")}</PrimaryButton>
        </>
      }>
      <div className="space-y-4">
        <Field label={t("Tên thiết bị")} required><TextInput value={name} maxLength={80} placeholder={t("Tủ thuốc phòng khách")} onChange={(event) => setName(event.target.value)} /></Field>
        <Field label={t("Ghi chú")}><TextArea value={note} maxLength={500} onChange={(event) => setNote(event.target.value)} /></Field>
      </div>
    </Modal>
  );
}

// ---- Theo dõi một lệnh tới khi thiết bị phản hồi ------------------------------------- //
function CommandTracker({ commandId, onDone }: { commandId: string; onDone: () => void }) {
  const t = useT();
  const query = useCommand(commandId);
  const command = query.data;
  const notified = useRef(false);

  useEffect(() => {
    if (!command?.final || notified.current) return;
    notified.current = true;
    // Chỉ báo thành công khi THIẾT BỊ xác nhận đã thực hiện (ack applied), không phải khi máy chủ đã gửi.
    if (command.status === "applied") toast.success(t("Thiết bị đã thực hiện lệnh"), command.action_label);
    else if (command.status === "failed") toast.error(t("Thiết bị báo lỗi khi thực hiện lệnh"), command.error ?? command.action_label);
    else if (command.status === "timed_out") toast.warning(t("Lệnh hết thời gian"), t("Thiết bị không xác nhận trước khi lệnh hết hạn."));
  }, [command, t]);

  if (!command) return query.isError ? <p className="text-[13px] text-danger">{errorMessage(query.error)}</p> : <LoadingState rows={1} />;

  const ackTime = (status: "received" | "applied" | "failed") => command.acks?.find((a) => a.status === status)?.received_at ?? null;
  const steps: { label: string; at: string | null; done: boolean; failed?: boolean }[] = [
    { label: t("Máy chủ tạo lệnh"), at: command.created_at, done: true },
    { label: t("Đã gửi tới thiết bị"), at: command.sent_at, done: Boolean(command.sent_at) },
    { label: t("Thiết bị đã nhận (ACK)"), at: ackTime("received") ?? command.acknowledged_at, done: Boolean(command.acknowledged_at || ackTime("received")) },
    command.status === "failed"
      ? { label: t("Thiết bị báo thất bại"), at: command.completed_at, done: true, failed: true }
      : { label: t("Thiết bị đã thực hiện"), at: ackTime("applied") ?? (command.status === "applied" ? command.completed_at : null), done: command.status === "applied" },
  ];
  return (
    <div className="rounded-2xl bg-tile p-4" role="status" aria-live="polite" data-testid="command-tracker">
      <div className="mb-3 flex items-center justify-between gap-3">
        <p className="text-[14px] font-semibold text-navy">{command.action_label}</p>
        <div className="flex items-center gap-2">
          <CommandStatusChip status={command.status} />
          {command.final && <IconButton icon={X} label={t("Đóng")} size="sm" variant="ghost" onClick={onDone} />}
        </div>
      </div>
      <ol className="space-y-1.5">
        {steps.map((step) => (
          <li key={step.label} className="flex items-center gap-2.5 text-[13px]">
            <span className={clsx("size-2.5 shrink-0 rounded-full", step.failed ? "bg-danger" : step.done ? "bg-success" : "bg-line")} />
            <span className={step.done ? "text-navy" : "text-muted"}>{step.label}</span>
            {step.at && <span className="ml-auto tabular-nums text-muted">{formatTime(step.at)}</span>}
          </li>
        ))}
      </ol>
      {command.note && !command.final && <p className="mt-3 text-[12.5px] text-warning-ink">{command.note}</p>}
      {command.status === "timed_out" && <p className="mt-3 text-[12.5px] text-warning-ink">{command.error ?? t("Thiết bị không phản hồi trước khi lệnh hết hạn.")}</p>}
      {command.status === "failed" && command.error && <p className="mt-3 text-[12.5px] text-danger">{command.error}</p>}
      {!command.final && <p className="mt-3 text-[12px] text-muted">{t("Hết hạn lúc {time}. Chỉ trạng thái “Đã thực hiện” mới là thành công.", { time: formatTime(command.expires_at) })}</p>}
    </div>
  );
}

// ---- Soạn lệnh ------------------------------------------------------------------------ //
function CommandComposer({ device }: { device: DeviceInfo }) {
  const t = useT();
  const client = useQueryClient();
  const settings = useSettings().data?.settings;
  const supported = device.supported_actions;
  const [action, setAction] = useState(supported[0] ?? "");
  const [buzzerOn, setBuzzerOn] = useState(true);
  const [duration, setDuration] = useState(5);
  const [alarm, setAlarm] = useState(true);
  const [seconds, setSeconds] = useState(30);
  const [busy, setBusy] = useState(false);
  const [tracking, setTracking] = useState<string | null>(null);

  useEffect(() => {
    if (!supported.includes(action)) setAction(supported[0] ?? "");
  }, [supported, action]);
  useEffect(() => setTracking(null), [device.id]);

  if (supported.length === 0) {
    return (
      <Note tone="warning">
        {t("Thiết bị chưa khai báo lệnh nào được hỗ trợ. Danh sách lệnh có sau khi firmware kết nối và gửi “hello” lần đầu.")}
      </Note>
    );
  }

  const payload = (): Record<string, unknown> => {
    switch (action) {
      case "buzzer":
        return buzzerOn ? { on: true, duration_s: duration } : { on: false };
      case "set_alarm":
        return { enabled: alarm };
      case "set_interval":
        return { seconds };
      case "set_thresholds":
        return settings ? { temp_min: settings.temp_min, temp_max: settings.temp_max, humidity_min: settings.humidity_min, humidity_max: settings.humidity_max } : {};
      default:
        return {};
    }
  };
  const valid = action !== "" && (action !== "buzzer" || !buzzerOn || (duration >= 1 && duration <= 300))
    && (action !== "set_interval" || (seconds >= 5 && seconds <= 3600)) && (action !== "set_thresholds" || Boolean(settings));

  const send = async () => {
    setBusy(true);
    try {
      const command = await api.deviceCommandSend(device.id, action, payload());
      setTracking(command.id);
      void client.invalidateQueries({ queryKey: keys.deviceCommands(device.id) });
    } catch (error) {
      toast.error(t("Không gửi được lệnh"), errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-end gap-3">
        <Field label={t("Lệnh")}>
          <Select value={action} onChange={(event) => setAction(event.target.value)} aria-label={t("Lệnh")}>
            {supported.map((name) => <option key={name} value={name}>{t(ACTION_LABELS[name] ?? name)}</option>)}
          </Select>
        </Field>
        <PrimaryButton icon={Send} loading={busy} disabled={!valid || !device.is_active} onClick={() => void send()}>{t("Gửi lệnh")}</PrimaryButton>
      </div>
      {action === "buzzer" && (
        <div className="flex flex-wrap items-center gap-4 rounded-2xl bg-tile px-4 py-3">
          <span className="flex items-center gap-2 text-sm text-navy"><Toggle checked={buzzerOn} onChange={setBuzzerOn} label={t("Bật còi")} />{buzzerOn ? t("Bật còi") : t("Tắt còi")}</span>
          {buzzerOn && (
            <span className="flex items-center gap-2 text-sm text-muted">
              {t("Tự tắt sau")}
              <TextInput type="number" min={1} max={300} value={duration} aria-label={t("Số giây kêu")} className="!h-10 !w-[88px] text-right tabular-nums"
                onChange={(event) => setDuration(Number(event.target.value))} />
              {t("giây")}
            </span>
          )}
        </div>
      )}
      {action === "set_alarm" && (
        <div className="flex items-center gap-2 rounded-2xl bg-tile px-4 py-3 text-sm text-navy">
          <Toggle checked={alarm} onChange={setAlarm} label={t("Còi tự động")} />{alarm ? t("Bật còi tự động khi vượt ngưỡng") : t("Tắt còi tự động")}
        </div>
      )}
      {action === "set_interval" && (
        <div className="flex items-center gap-2 rounded-2xl bg-tile px-4 py-3 text-sm text-muted">
          {t("Gửi số đo mỗi")}
          <TextInput type="number" min={5} max={3600} value={seconds} aria-label={t("Chu kỳ (giây)")} className="!h-10 !w-[96px] text-right tabular-nums"
            onChange={(event) => setSeconds(Number(event.target.value))} />
          {t("giây (5–3600)")}
        </div>
      )}
      {action === "set_thresholds" && settings && (
        <p className="rounded-2xl bg-tile px-4 py-3 text-[13px] text-muted">
          {t("Gửi ngưỡng hiện tại trong Cài đặt")}: {settings.temp_min}–{settings.temp_max}°C · {settings.humidity_min}–{settings.humidity_max}%
        </p>
      )}
      {!device.online && device.is_active && (
        <p className="text-[12.5px] text-warning-ink">{t("Thiết bị đang ngoại tuyến: lệnh sẽ chờ và được gửi khi thiết bị kết nối lại (nếu chưa hết hạn).")}</p>
      )}
      {tracking && <CommandTracker key={tracking} commandId={tracking} onDone={() => setTracking(null)} />}
    </div>
  );
}

function CommandHistory({ deviceId }: { deviceId: string }) {
  const t = useT();
  const client = useQueryClient();
  const commands = useDeviceCommands(deviceId);
  const items = commands.data?.items ?? [];
  const cancel = async (command: DeviceCommand) => {
    try {
      await api.commandCancel(command.id);
      toast.info(t("Đã hủy lệnh"));
      void client.invalidateQueries({ queryKey: keys.deviceCommands(deviceId) });
    } catch (error) {
      toast.error(t("Không hủy được lệnh"), errorMessage(error));
    }
  };
  if (commands.isLoading) return <LoadingState rows={3} />;
  if (items.length === 0) return <p className="py-3 text-[13px] text-muted">{t("Chưa gửi lệnh nào tới thiết bị này.")}</p>;
  return (
    <ul className="divide-y divide-line" data-testid="command-history">
      {items.slice(0, 12).map((command) => {
        const summary = payloadSummary(command, t);
        return (
          <li key={command.id} className="flex items-center gap-3 py-2.5">
            <div className="min-w-0 flex-1">
              <p className="truncate text-[13.5px] font-semibold text-navy">{command.action_label}{summary ? <span className="font-normal text-muted"> · {summary}</span> : null}</p>
              <p className="truncate text-[12px] text-muted">
                {formatDateTime(command.created_at)}
                {command.error ? ` · ${command.error}` : ""}
                {command.result && typeof command.result.late === "boolean" && command.result.late ? ` · ${t("phản hồi đến muộn")}` : ""}
              </p>
            </div>
            <CommandStatusChip status={command.status} />
            {(command.status === "pending" || command.status === "sent") && (
              <IconButton icon={X} label={t("Hủy lệnh")} size="sm" variant="danger" onClick={() => void cancel(command)} />
            )}
          </li>
        );
      })}
    </ul>
  );
}

// ---- Chi tiết thiết bị ---------------------------------------------------------------- //
function DeviceDetail({ device, connection, onToken, onDeleted }: {
  device: DeviceInfo; connection: DeviceConnection | undefined; onToken: (result: DeviceTokenResult) => void; onDeleted: () => void;
}) {
  const t = useT();
  const client = useQueryClient();
  const detail = useDeviceDetail(device.id);
  const snapshot = detail.data?.snapshot;
  const [confirm, setConfirm] = useState<"rotate" | "delete" | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const run = async (label: string, action: () => Promise<unknown>, success?: string) => {
    setBusy(label);
    try {
      await action();
      if (success) toast.success(success);
      await client.invalidateQueries({ queryKey: ["devices"] });
      void client.invalidateQueries({ queryKey: keys.device });
    } catch (error) {
      toast.error(t("Không thực hiện được"), errorMessage(error));
    } finally {
      setBusy(null);
      setConfirm(null);
    }
  };
  const reading = (value: number | null | undefined, unit: string) => (value === null || value === undefined ? "—" : `${value.toFixed(1)}${unit}`);
  const showReading = snapshot?.state === "connected";

  return (
    <div className="flex min-w-0 flex-col gap-6 short:gap-4">
      <Card padding="lg">
        <div className="mb-4 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="truncate font-display text-[22px] font-bold text-navy">{device.name}</h2>
            <p className="mt-0.5 text-[13px] text-muted">{device.note || t("ESP32 + DHT22 + còi")}</p>
          </div>
          <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
            {device.is_primary && <StatusIndicator tone="info" size="sm" icon={Star}>{t("Tủ chính")}</StatusIndicator>}
            <DeviceStatusChip device={device} />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Tile className="flex items-center gap-3 p-4">
            <IconTile icon={Thermometer} tone="info" />
            <div>
              <p className="text-[12.5px] text-muted">{t("Nhiệt độ")}</p>
              <p className="font-display text-[22px] font-bold tabular-nums text-navy">{showReading ? reading(snapshot?.temperature, "°C") : "—"}</p>
            </div>
          </Tile>
          <Tile className="flex items-center gap-3 p-4">
            <IconTile icon={Droplet} tone="info" />
            <div>
              <p className="text-[12.5px] text-muted">{t("Độ ẩm")}</p>
              <p className="font-display text-[22px] font-bold tabular-nums text-navy">{showReading ? reading(snapshot?.humidity, "%") : "—"}</p>
            </div>
          </Tile>
        </div>
        {snapshot && !showReading && <p className="mt-2 text-[12.5px] text-muted">{snapshot.last_error ?? t(snapshot.environment?.label ?? "Chưa có số đo")}</p>}
        {snapshot?.simulated && <p className="mt-2 text-[12.5px] font-semibold text-warning-ink">{t("Số đo từ trình mô phỏng — không phải cảm biến thật.")}</p>}
        <dl className="mt-4 divide-y divide-line text-[13px]">
          <div className="flex justify-between gap-4 py-2.5"><dt className="text-muted">{t("Lần cuối kết nối")}</dt><dd className="font-semibold text-navy">{device.last_seen_at ? formatDateTime(device.last_seen_at) : t("Chưa từng kết nối")}</dd></div>
          <div className="flex justify-between gap-4 py-2.5"><dt className="text-muted">{t("Firmware")}</dt><dd className="font-semibold text-navy">{device.firmware ?? "—"}</dd></div>
          <div className="flex justify-between gap-4 py-2.5"><dt className="text-muted">{t("Địa chỉ IP gần nhất")}</dt><dd className="font-semibold text-navy">{device.last_ip ?? "—"}</dd></div>
          <div className="flex justify-between gap-4 py-2.5"><dt className="text-muted">{t("Token")}</dt><dd className="font-mono font-semibold text-navy">{device.token_hint}</dd></div>
          <div className="flex justify-between gap-4 py-2.5"><dt className="text-muted">{t("Lệnh hỗ trợ")}</dt><dd className="text-right font-semibold text-navy">{device.supported_actions.length ? device.supported_actions.map((a) => t(ACTION_LABELS[a] ?? a)).join(", ") : "—"}</dd></div>
        </dl>
        {connection?.websocket_url && (
          <div className="mt-3"><Field label={t("Địa chỉ kết nối của thiết bị (WSS)")}><CopyField value={connection.websocket_url} label={t("Địa chỉ kết nối WSS")} /></Field></div>
        )}
        {connection?.note && <div className="mt-3"><Note tone="warning">{connection.note}</Note></div>}
        <div className="mt-4 flex flex-wrap gap-2.5">
          {!device.is_primary && (
            <PrimaryButton variant="secondary" size="sm" icon={Star} loading={busy === "primary"}
              onClick={() => void run("primary", () => api.deviceUpdate(device.id, { is_primary: true }), t("Đã đặt làm tủ chính"))}>{t("Đặt làm tủ chính")}</PrimaryButton>
          )}
          <PrimaryButton variant="secondary" size="sm" icon={KeyRound} onClick={() => setConfirm("rotate")}>{t("Đổi token")}</PrimaryButton>
          <PrimaryButton variant="secondary" size="sm" icon={Power} loading={busy === "active"}
            onClick={() => void run("active", () => api.deviceUpdate(device.id, { is_active: !device.is_active }), device.is_active ? t("Đã vô hiệu hóa thiết bị") : t("Đã kích hoạt thiết bị"))}>
            {device.is_active ? t("Vô hiệu hóa") : t("Kích hoạt")}
          </PrimaryButton>
          <PrimaryButton variant="danger" size="sm" icon={Trash2} onClick={() => setConfirm("delete")}>{t("Xóa thiết bị")}</PrimaryButton>
        </div>
      </Card>

      <Card padding="lg">
        <CardTitle hint={t("Lệnh đi qua Internet tới thiết bị; trạng thái cập nhật theo phản hồi ACK của chính thiết bị.")}>{t("Điều khiển thiết bị")}</CardTitle>
        <CommandComposer device={device} />
        <div className="mt-5 border-t border-line pt-4">
          <p className="mb-1 text-[13px] font-semibold text-navy">{t("Lệnh gần đây")}</p>
          <CommandHistory deviceId={device.id} />
        </div>
      </Card>

      <ConfirmDialog open={confirm === "rotate"} title={t("Đổi token thiết bị?")} confirmLabel={t("Đổi token")} loading={busy === "rotate"}
        description={t("Token cũ hết hiệu lực ngay và thiết bị đang kết nối sẽ bị ngắt. Bạn phải nạp token mới vào firmware.")}
        onClose={() => setConfirm(null)}
        onConfirm={() => void run("rotate", async () => onToken(await api.deviceRotateToken(device.id)))} />
      <ConfirmDialog open={confirm === "delete"} danger title={t("Xóa thiết bị “{name}”?", { name: device.name })} confirmLabel={t("Xóa")} loading={busy === "delete"}
        description={t("Thiết bị bị ngắt kết nối; lịch sử số đo và lệnh của thiết bị cũng bị xóa. Không hoàn tác được.")}
        onClose={() => setConfirm(null)}
        onConfirm={() => void run("delete", () => api.deviceDelete(device.id), t("Đã xóa thiết bị")).then(onDeleted)} />
    </div>
  );
}

export function DevicesTab() {
  const t = useT();
  const devices = useDevices();
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [token, setToken] = useState<DeviceTokenResult | null>(null);
  const items = devices.data?.items ?? [];
  const current = items.find((d) => d.id === selected) ?? items[0] ?? null;

  return (
    <div className="grid grid-cols-[minmax(0,0.85fr)_minmax(0,1.4fr)] items-start gap-6 max-xl:grid-cols-1 short:gap-4">
      <Card padding="lg">
        <CardTitle hint={t("ESP32 tự kết nối ra Internet (WSS) — không cần chung Wi-Fi.")}
          action={<PrimaryButton size="sm" icon={Plus} onClick={() => setCreating(true)}>{t("Thêm thiết bị")}</PrimaryButton>}>
          {t("Thiết bị ESP32")}
        </CardTitle>
        {devices.isLoading ? <LoadingState rows={3} /> : devices.isError ? <ErrorState description={errorMessage(devices.error)} onRetry={() => void devices.refetch()} /> : items.length === 0 ? (
          <EmptyState compact icon={RadioTower} title={t("Chưa có thiết bị")} description={t("Thêm thiết bị để lấy token, rồi nạp token vào firmware ESP32.")} />
        ) : (
          <ul className="space-y-2" aria-label={t("Danh sách thiết bị")}>
            {items.map((device) => (
              <li key={device.id}>
                <button type="button" onClick={() => setSelected(device.id)} aria-pressed={current?.id === device.id}
                  className={clsx("flex w-full items-center gap-3 rounded-2xl px-3.5 py-3 text-left transition",
                    current?.id === device.id ? "bg-primary-soft ring-1 ring-primary/30" : "bg-tile/60 hover:bg-tile")}>
                  <IconTile icon={device.online ? Cpu : WifiOff} tone={device.online ? "success" : "neutral"} size="sm" />
                  <div className="min-w-0 flex-1">
                    <p className="flex items-center gap-1.5 truncate text-[14px] font-semibold text-navy">
                      {device.name}{device.is_primary && <Star size={13} className="shrink-0 text-primary" aria-label={t("Tủ chính")} />}
                    </p>
                    <p className="truncate text-[12px] text-muted">{device.last_seen_at ? formatDateTime(device.last_seen_at) : t("Chưa từng kết nối")}</p>
                  </div>
                  <DeviceStatusChip device={device} />
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="mt-4"><Note>{t("Mất Internet: ESP32 vẫn đọc cảm biến và tự kêu còi theo ngưỡng đã lưu; lệnh chờ ở máy chủ và chỉ được gửi lại nếu chưa hết hạn.")}</Note></div>
      </Card>

      {current ? (
        <DeviceDetail key={current.id} device={current} connection={devices.data?.connection} onToken={setToken} onDeleted={() => setSelected(null)} />
      ) : (
        <Card padding="lg"><EmptyState icon={Cpu} title={t("Chọn hoặc thêm thiết bị")} description={t("Chi tiết, số đo và lệnh điều khiển hiển thị ở đây.")} /></Card>
      )}

      <CreateDeviceDialog open={creating} onClose={() => setCreating(false)} onCreated={(result) => { setToken(result); setSelected(result.device.id); }} />
      <TokenDialog result={token} onClose={() => setToken(null)} />
    </div>
  );
}
