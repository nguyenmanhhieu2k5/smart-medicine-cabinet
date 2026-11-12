import { Activity, Bell, CalendarDays, ChevronRight, Database, Pencil, Plus, ScanLine, Settings, Trash2, TriangleAlert, type LucideIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { PrimaryButton } from "@/components/Button";
import { Card } from "@/components/Card";
import { Pagination } from "@/components/DataTable";
import { SearchInput, Segmented, TextInput } from "@/components/Form";
import { ConfirmDialog, Modal } from "@/components/Modal";
import { EmptyState, ErrorState, LoadingState } from "@/components/States";
import { IconTile, StatusIndicator } from "@/components/StatusIndicator";
import { useT } from "@/i18n";
import { api } from "@/services/api";
import { formatDate, formatDateTime, formatTime, relativeDay } from "@/services/format";
import { errorMessage, useHistory } from "@/services/queries";
import { usePageHeader } from "@/stores/page";
import { toast } from "@/stores/toast";
import type { HistoryEvent, HistoryGroup } from "@/types/api";

type Filter = "all" | HistoryGroup;
const ICONS: Record<string, LucideIcon> = {
  scan: ScanLine, ocr_completed: ScanLine, scan_confirmed: ScanLine, ocr_failed: TriangleAlert,
  cabinet_add: Plus, cabinet_update: Pencil, cabinet_delete: Trash2, quantity_change: Pencil,
  catalog_import: Database, backup_created: Database, backup_restored: Database,
};
const GROUP_ICONS: Record<HistoryGroup, LucideIcon> = { scan: ScanLine, cabinet: Pencil, reminder: Bell, alert: TriangleAlert, system: Settings };
const DATA_LABELS: Record<string, string> = {
  job_id: "Mã lần quét", source: "Nguồn ảnh", status: "Kết quả", lines: "Số dòng chữ", top_id: "Mã bản ghi danh mục",
  cabinet_item_id: "Mã thuốc trong tủ", catalog_id: "Mã bản ghi danh mục", quantity: "Số lượng", from: "Từ", to: "Thành",
  reason: "Lý do", fields: "Trường đã sửa", reminder_id: "Mã lời nhắc", scheduled_for: "Giờ hẹn", alert_id: "Mã cảnh báo", severity: "Mức độ",
};

function EventDetail({ event, onClose, onDeleted }: { event: HistoryEvent | null; onClose: () => void; onDeleted: () => void }) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const entries = Object.entries(event?.data ?? {}).filter(([, value]) => value !== null && typeof value !== "object");
  const remove = async () => {
    if (!event) return;
    setBusy(true);
    try {
      await api.historyDelete(event.id);
      toast.success(t("Đã xóa hoạt động"));
      onDeleted();
    } catch (error) {
      toast.error(t("Không xóa được"), errorMessage(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open={event !== null} onClose={onClose} title={event?.title ?? ""} description={event ? formatDateTime(event.created_at) : undefined} size="sm"
      footer={
        <>
          <PrimaryButton variant="danger" icon={Trash2} loading={busy} onClick={remove}>{t("Xóa mục này")}</PrimaryButton>
          <PrimaryButton variant="secondary" onClick={onClose}>{t("Đóng")}</PrimaryButton>
        </>
      }
    >
      {event && (
        <div className="space-y-4">
          <StatusIndicator tone="info" icon={GROUP_ICONS[event.group]}>{t(event.group_label)}</StatusIndicator>
          {event.description && <p className="text-[15px] text-navy">{event.description}</p>}
          {entries.length > 0 && (
            <dl className="divide-y divide-line rounded-2xl bg-tile px-4">
              {entries.map(([key, value]) => (
                <div key={key} className="flex items-baseline justify-between gap-4 py-2.5 text-[13px]">
                  <dt className="text-muted">{t(DATA_LABELS[key] ?? key)}</dt>
                  <dd className="break-all text-right font-semibold text-navy">{String(value)}</dd>
                </div>
              ))}
            </dl>
          )}
        </div>
      )}
    </Modal>
  );
}

export function HistoryPage() {
  const t = useT();
  const client = useQueryClient();
  const [params, setParams] = useSearchParams();
  usePageHeader(t("Lịch sử"), t("Các hoạt động nhận diện và quản lý thuốc"), `${t("Tủ thuốc thông minh")} / ${t("Lịch sử")}`);
  const initialGroup = (["scan", "cabinet", "reminder", "alert", "system"] as const).find((g) => g === params.get("group")) ?? "all";
  const [group, setGroup] = useState<Filter>(initialGroup);
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [page, setPage] = useState(1);
  const [detail, setDetail] = useState<HistoryEvent | null>(null);
  const [clearing, setClearing] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const timer = window.setTimeout(() => { setQuery(search); setPage(1); }, 250);
    return () => window.clearTimeout(timer);
  }, [search]);

  const history = useHistory({ q: query, group, from, to, page, page_size: 8 });
  const data = history.data;
  const filtered = Boolean(query || from || to || group !== "all");
  const changeGroup = (value: Filter) => {
    setGroup(value);
    setPage(1);
    setParams(value === "all" ? {} : { group: value }, { replace: true });
  };
  const clearAll = async () => {
    setBusy(true);
    try {
      const result = await api.historyClear();
      toast.success(t("Đã xóa lịch sử"), t("{count} hoạt động, {images} ảnh quét tạm", { count: result.deleted, images: result.removed_images }));
      void client.invalidateQueries({ queryKey: ["history"] });
      setClearing(false);
      setPage(1);
    } catch (error) {
      toast.error(t("Không xóa được lịch sử"), errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card padding="lg">
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-line pb-5">
        <Segmented<Filter>
          size="sm" value={group} onChange={changeGroup}
          options={[
            { value: "all", label: t("Tất cả") }, { value: "scan", label: t("Quét thuốc") }, { value: "cabinet", label: t("Quản lý thuốc") },
            { value: "reminder", label: t("Nhắc uống") }, { value: "alert", label: t("Cảnh báo") }, { value: "system", label: t("Hệ thống") },
          ]}
        />
        <div className="flex flex-wrap items-center gap-2.5">
          <label className="flex items-center gap-2 text-[13px] text-muted">
            {t("Từ")} <TextInput type="date" value={from} max={to || undefined} onChange={(event) => { setFrom(event.target.value); setPage(1); }} className="!h-12 !w-[156px]" aria-label={t("Từ ngày")} />
          </label>
          <label className="flex items-center gap-2 text-[13px] text-muted">
            {t("đến")} <TextInput type="date" value={to} min={from || undefined} onChange={(event) => { setTo(event.target.value); setPage(1); }} className="!h-12 !w-[156px]" aria-label={t("Đến ngày")} />
          </label>
          <SearchInput value={search} onChange={setSearch} placeholder={t("Tìm hoạt động…")} className="w-[260px]" aria-label={t("Tìm trong lịch sử")} />
        </div>
      </div>

      {history.isLoading ? (
        <div className="pt-6"><LoadingState rows={5} /></div>
      ) : history.isError ? (
        <ErrorState description={errorMessage(history.error)} onRetry={() => void history.refetch()} />
      ) : !data || data.items.length === 0 ? (
        <EmptyState icon={Activity} title={filtered ? t("Không có hoạt động phù hợp") : t("Chưa có hoạt động nào")}
          description={filtered ? t("Thử bỏ bớt bộ lọc hoặc đổi khoảng thời gian.") : t("Các lần quét, thay đổi tủ thuốc, lời nhắc và cảnh báo sẽ được ghi lại tại đây.")} />
      ) : (
        <ul>
          {data.items.map((event) => {
            const Icon = ICONS[event.type] ?? GROUP_ICONS[event.group] ?? CalendarDays;
            const day = relativeDay(event.created_at);
            return (
              <li key={event.id}>
                <button type="button" onClick={() => setDetail(event)}
                  className="flex min-h-[92px] w-full items-center gap-5 border-b border-line px-2 py-3 text-left transition-colors hover:bg-tile/70 short:min-h-[76px]">
                  <span className="w-[86px] shrink-0 text-right">
                    <span className="block font-display text-[15px] font-bold tabular-nums text-navy">{day === "Hôm nay" ? formatTime(event.created_at) : t(day)}</span>
                    <span className="block text-[12px] tabular-nums text-muted">{day === "Hôm nay" ? formatDate(event.created_at) : formatTime(event.created_at)}</span>
                  </span>
                  <IconTile icon={Icon} tone={event.group === "alert" ? "warning" : "info"} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-display text-[16px] font-bold text-navy">{event.title}</span>
                    <span className="block truncate text-sm text-muted">{event.description ?? "—"}</span>
                  </span>
                  <span className="inline-flex size-11 shrink-0 items-center justify-center rounded-full bg-tile text-muted"><ChevronRight size={18} /></span>
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {data && data.total > 0 && (
        <div className="flex items-end justify-between gap-4">
          <div className="flex-1"><Pagination page={data.page} pages={data.pages} total={data.total} onChange={setPage} label={t("{total} hoạt động", { total: data.total })} /></div>
        </div>
      )}
      <div className="mt-5 flex items-center justify-between gap-4 rounded-2xl bg-tile px-4 py-3">
        <p className="text-[13px] text-muted">{t("Lịch sử được lưu cục bộ trong SQLite. Ảnh quét chỉ được giữ tạm trừ khi bạn bật lưu ảnh trong Cài đặt.")}</p>
        <PrimaryButton variant="danger" size="sm" icon={Trash2} disabled={!data || (data.total === 0 && !filtered)} onClick={() => setClearing(true)}>{t("Xóa toàn bộ lịch sử")}</PrimaryButton>
      </div>

      <EventDetail event={detail} onClose={() => setDetail(null)} onDeleted={() => { setDetail(null); void client.invalidateQueries({ queryKey: ["history"] }); }} />
      <ConfirmDialog open={clearing} danger loading={busy} title={t("Xóa toàn bộ lịch sử?")} confirmLabel={t("Xóa lịch sử")}
        description={t("Mọi hoạt động đã ghi và ảnh quét tạm sẽ bị xóa. Thuốc trong tủ, lời nhắc và cài đặt không bị ảnh hưởng.")}
        onClose={() => setClearing(false)} onConfirm={clearAll} />
    </Card>
  );
}
