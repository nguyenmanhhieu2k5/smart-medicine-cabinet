import { FileClock, ScanLine } from "lucide-react";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { PrimaryButton } from "@/components/Button";
import { Card } from "@/components/Card";
import { DataTable, Pagination, type Column } from "@/components/DataTable";
import { SearchInput, Segmented } from "@/components/Form";
import { Modal } from "@/components/Modal";
import { EmptyState, ErrorState } from "@/components/States";
import { StatusIndicator } from "@/components/StatusIndicator";
import { useT } from "@/i18n";
import { formatDateTime } from "@/services/format";
import { errorMessage, useAdminScans, useAudit } from "@/services/queries";
import type { AdminScan, AuditEntry } from "@/types/api";
import { AUDIT_ACTIONS, CHANNEL_LABELS } from "./shared";

const PAGE_SIZE = 25;

/** Gõ tới đâu lọc tới đó nhưng chỉ gọi máy chủ khi người dùng ngừng gõ. */
function useDebounced(value: string, delay = 300): string {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delay);
    return () => window.clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

// ---- Lượt quét của mọi tài khoản ------------------------------------------------------ //
const SCAN_STATUS: Record<string, { label: string; tone: "success" | "warning" | "danger" | "neutral" | "info" }> = {
  confident: { label: "Khớp chắc chắn", tone: "success" },
  uncertain: { label: "Cần kiểm tra", tone: "warning" },
  no_text: { label: "Không đọc được chữ", tone: "neutral" },
  no_match: { label: "Không tìm thấy", tone: "neutral" },
  no_catalog: { label: "Chưa có danh mục", tone: "warning" },
  failed: { label: "Lỗi", tone: "danger" },
  cancelled: { label: "Đã hủy", tone: "neutral" },
};

export function ScansTab() {
  const t = useT();
  const navigate = useNavigate();
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const query = useDebounced(q);
  useEffect(() => setPage(1), [query]);
  const scans = useAdminScans({ q: query.trim() || undefined, limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE });
  const data = scans.data;
  const pages = Math.max(1, Math.ceil((data?.total ?? 0) / PAGE_SIZE));

  const columns: Column<AdminScan>[] = [
    { key: "time", header: t("Thời gian"), width: "160px", render: (s) => <span className="tabular-nums text-[13px] text-muted">{formatDateTime(s.created_at)}</span> },
    { key: "user", header: t("Tài khoản"), width: "minmax(0,1.2fr)", render: (s) => <span className="truncate text-[13px] text-navy">{s.user_email}</span> },
    {
      key: "result", header: t("Kết quả"), width: "minmax(0,2fr)", render: (s) => (
        <div className="min-w-0">
          <p className="truncate font-semibold text-navy">{s.title}</p>
          {s.subtitle && <p className="truncate text-[12.5px] text-muted">{s.subtitle}</p>}
        </div>
      ),
    },
    { key: "status", header: t("Trạng thái"), width: "150px", render: (s) => {
      const meta = SCAN_STATUS[s.status] ?? { label: s.status, tone: "neutral" as const };
      return <StatusIndicator tone={meta.tone} size="sm" dot>{t(meta.label)}</StatusIndicator>;
    } },
    { key: "candidates", header: t("Gợi ý"), width: "70px", align: "center", render: (s) => <span className="tabular-nums text-navy">{s.candidate_count}</span> },
    { key: "open", header: "", width: "120px", align: "right", render: (s) => s.top_medicine_id ? (
      <PrimaryButton variant="ghost" size="sm" onClick={(event) => { event.stopPropagation(); navigate(`/medicines/${s.top_medicine_id}`); }}>{t("Xem thuốc")}</PrimaryButton>
    ) : null },
  ];

  return (
    <Card padding="none" className="pb-4">
      <div className="flex flex-wrap items-center gap-3 px-6 pb-4 pt-6">
        <SearchInput value={q} onChange={setQ} placeholder={t("Tìm theo tên thuốc, hoạt chất")} className="w-[380px] max-w-full" />
        <p className="text-[13px] text-muted">{t("Lượt quét từ ứng dụng điện thoại và ứng dụng Windows. Quét không tự thêm thuốc vào tủ.")}</p>
      </div>
      {scans.isError ? <ErrorState description={errorMessage(scans.error)} onRetry={() => void scans.refetch()} /> : (
        <DataTable columns={columns} rows={data?.items ?? []} rowKey={(s) => s.id} loading={scans.isLoading}
          empty={<EmptyState icon={ScanLine} title={t("Chưa có lượt quét nào")} compact />}
          footer={data && <Pagination page={page} pages={pages} total={data.total} onChange={setPage} label={t("{total} lượt quét", { total: data.total })} />} />
      )}
    </Card>
  );
}

// ---- Nhật ký kiểm toán ---------------------------------------------------------------- //
export function AuditTab() {
  const t = useT();
  const [q, setQ] = useState("");
  const [result, setResult] = useState<"all" | "ok" | "failed">("all");
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState<AuditEntry | null>(null);
  const query = useDebounced(q);
  useEffect(() => setPage(1), [query, result]);
  const audit = useAudit({
    q: query.trim() || undefined, success: result === "all" ? undefined : result === "ok", limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE,
  });
  const data = audit.data;
  const pages = Math.max(1, Math.ceil((data?.total ?? 0) / PAGE_SIZE));

  const columns: Column<AuditEntry>[] = [
    { key: "time", header: t("Thời gian"), width: "160px", render: (e) => <span className="tabular-nums text-[13px] text-muted">{formatDateTime(e.created_at)}</span> },
    { key: "actor", header: t("Người thực hiện"), width: "minmax(0,1.3fr)", render: (e) => <span className="truncate text-[13px] text-navy">{e.actor ?? "—"}</span> },
    { key: "channel", header: t("Kênh"), width: "150px", render: (e) => <StatusIndicator tone="neutral" size="sm">{t(CHANNEL_LABELS[e.channel] ?? e.channel)}</StatusIndicator> },
    { key: "action", header: t("Hành động"), width: "minmax(0,1.5fr)", render: (e) => (
      <div className="min-w-0">
        <p className="truncate font-semibold text-navy">{t(AUDIT_ACTIONS[e.action] ?? e.action)}</p>
        <p className="truncate font-mono text-[11.5px] text-muted">{e.action}</p>
      </div>
    ) },
    { key: "result", header: t("Kết quả"), width: "120px", render: (e) => e.success
      ? <StatusIndicator tone="success" size="sm" dot>{t("Thành công")}</StatusIndicator>
      : <StatusIndicator tone="danger" size="sm" dot>{t("Bị từ chối")}</StatusIndicator> },
    { key: "ip", header: "IP", width: "130px", render: (e) => <span className="truncate font-mono text-[12px] text-muted">{e.ip ?? "—"}</span> },
  ];

  return (
    <Card padding="none" className="pb-4">
      <div className="flex flex-wrap items-center gap-3 px-6 pb-4 pt-6">
        <SearchInput value={q} onChange={setQ} placeholder={t("Tìm theo email, hành động, mã đối tượng")} className="w-[380px] max-w-full" />
        <Segmented size="sm" value={result} onChange={setResult}
          options={[{ value: "all", label: t("Tất cả") }, { value: "ok", label: t("Thành công") }, { value: "failed", label: t("Bị từ chối") }]} />
      </div>
      {audit.isError ? <ErrorState description={errorMessage(audit.error)} onRetry={() => void audit.refetch()} /> : (
        <DataTable columns={columns} rows={data?.items ?? []} rowKey={(e) => e.id} loading={audit.isLoading} onRowClick={setOpen}
          empty={<EmptyState icon={FileClock} title={t("Chưa có sự kiện nào")} compact />}
          footer={data && <Pagination page={page} pages={pages} total={data.total} onChange={setPage} label={t("{total} sự kiện", { total: data.total })} />} />
      )}
      <Modal open={open !== null} onClose={() => setOpen(null)} size="md" title={open ? t(AUDIT_ACTIONS[open.action] ?? open.action) : ""}
        description={open ? `${formatDateTime(open.created_at)} · ${open.actor ?? "—"}` : undefined}>
        {open && (
          <dl className="divide-y divide-line rounded-2xl bg-tile px-4 text-[13px]">
            {([
              [t("Hành động"), open.action], [t("Kênh"), t(CHANNEL_LABELS[open.channel] ?? open.channel)], [t("Kết quả"), open.success ? t("Thành công") : t("Bị từ chối")],
              [t("Đối tượng"), [open.resource_type, open.resource_id].filter(Boolean).join(" · ") || "—"], ["IP", open.ip ?? "—"],
            ] as const).map(([label, value]) => (
              <div key={label} className="flex items-baseline justify-between gap-4 py-2.5">
                <dt className="text-muted">{label}</dt>
                <dd className="break-all text-right font-semibold text-navy">{value}</dd>
              </div>
            ))}
            {open.detail && (
              <div className="py-2.5">
                <dt className="mb-1 text-muted">{t("Chi tiết")}</dt>
                <dd><pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all font-mono text-[12px] text-navy">{JSON.stringify(open.detail, null, 2)}</pre></dd>
              </div>
            )}
          </dl>
        )}
      </Modal>
    </Card>
  );
}
