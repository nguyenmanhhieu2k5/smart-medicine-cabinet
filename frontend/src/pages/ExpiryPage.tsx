import clsx from "clsx";
import { CalendarClock, CalendarPlus, ChevronRight, CircleCheck, CircleHelp, PackageSearch, TriangleAlert, type LucideIcon } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { PrimaryButton } from "@/components/Button";
import { CabinetItemModal, type CabinetModalRequest } from "@/components/CabinetItemModal";
import { Card } from "@/components/Card";
import { Segmented, Select } from "@/components/Form";
import { ExpiryChip, MedicineAvatar, Note } from "@/components/MedicineBits";
import { EmptyState, ErrorState, LoadingState } from "@/components/States";
import { IconTile, type Tone } from "@/components/StatusIndicator";
import { useT } from "@/i18n";
import { formatDate } from "@/services/format";
import { errorMessage, useCabinet, useSettings, useUpdateSettings } from "@/services/queries";
import { usePageHeader } from "@/stores/page";
import type { ExpiryStatus } from "@/types/api";

type Filter = "all" | ExpiryStatus;

function Stat({ icon, tone, label, count, active, onClick }: { icon: LucideIcon; tone: Tone; label: string; count: number | undefined; active: boolean; onClick: () => void }) {
  const t = useT();
  const text = { danger: "text-danger", warning: "text-warning-ink", success: "text-navy", neutral: "text-navy", info: "text-navy" }[tone];
  return (
    <button type="button" onClick={onClick} aria-pressed={active} className="rounded-card text-left outline-offset-4">
      <Card padding="none" interactive className={clsx("flex h-[92px] items-center gap-4 px-6 short:h-20", active && "ring-2 !ring-primary/60")}>
        <IconTile icon={icon} tone={tone} size="lg" />
        <div className="min-w-0">
          <p className="truncate text-sm text-muted">{label}</p>
          {count === undefined
            ? <div className="skeleton mt-1.5 h-6 w-24" />
            : <p className={clsx("font-display text-[26px] font-extrabold leading-tight tabular-nums", count > 0 ? text : "text-navy")}>{t("{count} thuốc", { count })}</p>}
        </div>
      </Card>
    </button>
  );
}

export function ExpiryPage() {
  const t = useT();
  const navigate = useNavigate();
  usePageHeader(t("Hạn dùng"), t("Theo dõi hạn sử dụng của thuốc trong tủ"), `${t("Tủ thuốc thông minh")} / ${t("Hạn dùng")}`);
  const [filter, setFilter] = useState<Filter>("all");
  const [editing, setEditing] = useState<CabinetModalRequest | null>(null);
  const settings = useSettings();
  const save = useUpdateSettings(true);
  const days = settings.data?.settings.expiry_warning_days ?? 30;
  const list = useCabinet({ status: filter, sort: "expiry", page: 1, page_size: 200 });
  const counts = list.data?.counts;
  const items = list.data?.items ?? [];

  return (
    <div className="space-y-6 short:space-y-4">
      <div className="grid grid-cols-4 gap-5 max-xl:grid-cols-2 short:gap-4">
        <Stat icon={TriangleAlert} tone="danger" label={t("Đã hết hạn")} count={counts?.expired} active={filter === "expired"} onClick={() => setFilter(filter === "expired" ? "all" : "expired")} />
        <Stat icon={CalendarClock} tone="warning" label={t("Trong {days} ngày tới", { days })} count={counts?.expiring} active={filter === "expiring"} onClick={() => setFilter(filter === "expiring" ? "all" : "expiring")} />
        <Stat icon={CircleCheck} tone="success" label={t("Còn hạn an toàn")} count={counts?.ok} active={filter === "ok"} onClick={() => setFilter(filter === "ok" ? "all" : "ok")} />
        <Stat icon={CircleHelp} tone="neutral" label={t("Chưa có thông tin hạn dùng")} count={counts?.unknown} active={filter === "unknown"} onClick={() => setFilter(filter === "unknown" ? "all" : "unknown")} />
      </div>

      <Card padding="lg">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-4 border-b border-line pb-5">
          <div>
            <h2 className="font-display text-[19px] font-bold text-navy">{t("Danh sách theo hạn dùng")}</h2>
            <p className="mt-0.5 text-[13px] text-muted">{t("Hạn sử dụng thực tế in trên bao bì, do bạn nhập hoặc xác nhận.")}</p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-2 text-[13px] font-semibold text-muted">
              {t("Cảnh báo trước")}
              <Select value={String(days)} disabled={save.isPending} className="!h-10 !w-[118px]" aria-label={t("Ngưỡng cảnh báo trước hạn")}
                onChange={(event) => save.mutate({ expiry_warning_days: Number(event.target.value) })}>
                {[7, 14, 30, 45, 60, 90, 180].concat([7, 14, 30, 45, 60, 90, 180].includes(days) ? [] : [days]).sort((a, b) => a - b).map((value) => (
                  <option key={value} value={value}>{t("{days} ngày", { days: value })}</option>
                ))}
              </Select>
            </label>
            <Segmented<Filter>
              value={filter} onChange={setFilter}
              options={[
                { value: "all", label: t("Tất cả") },
                { value: "expiring", label: t("{days} ngày", { days }) },
                { value: "expired", label: t("Đã hết hạn") },
                { value: "unknown", label: t("Chưa có hạn") },
              ]}
            />
          </div>
        </div>

        {list.isLoading ? (
          <div className="pt-5"><LoadingState rows={5} /></div>
        ) : list.isError ? (
          <ErrorState description={errorMessage(list.error)} onRetry={() => void list.refetch()} />
        ) : items.length === 0 ? (
          counts?.all === 0 ? (
            <EmptyState icon={PackageSearch} title={t("Chưa có thuốc nào trong tủ")} description={t("Thêm thuốc và nhập hạn dùng trên bao bì để bắt đầu theo dõi.")}
              action={<PrimaryButton onClick={() => navigate("/cabinet")}>{t("Mở Thuốc trong tủ")}</PrimaryButton>} />
          ) : (
            <EmptyState icon={CircleCheck} tone="success" title={t("Không có thuốc nào trong nhóm này")} />
          )
        ) : (
          <ul>
            {items.map((item) => (
              <li key={item.id}
                className={clsx(
                  "flex min-h-[88px] items-center gap-5 border-b border-line px-3 py-3 last:border-b-0 short:min-h-[72px]",
                  item.expiry_status === "expired" && "rounded-2xl !border-transparent bg-danger-soft/50",
                )}
              >
                <MedicineAvatar name={item.name} />
                <button type="button" className="min-w-0 flex-1 text-left" onClick={() => navigate(`/cabinet/${item.id}`)}>
                  <p className="truncate font-display text-[16.5px] font-bold text-navy hover:text-primary">{item.name}</p>
                  <p className="truncate text-[13px] text-muted">
                    {item.expiry_date ? `${t("Hạn dùng")}: ${formatDate(item.expiry_date)}` : t("Chưa nhập hạn dùng")} · {t("Số lượng")}: {item.quantity_text}
                  </p>
                </button>
                <span className={clsx("w-28 text-right text-[15px] tabular-nums", item.expiry_status === "expired" ? "font-semibold text-danger" : "text-muted")}>
                  {item.days_left === null ? "—"
                    : item.days_left < 0 ? t("Quá {days} ngày", { days: -item.days_left })
                    : item.days_left === 0 ? t("Hôm nay") : t("Còn {days} ngày", { days: item.days_left })}
                </span>
                <span className="flex w-40 justify-center">
                  {item.expiry_status === "unknown"
                    ? <PrimaryButton variant="soft" size="sm" icon={CalendarPlus} onClick={() => setEditing({ item })}>{t("Nhập hạn dùng")}</PrimaryButton>
                    : <ExpiryChip item={{ ...item, expiry_status_label: item.expiry_status === "ok" ? t("Còn hạn") : item.expiry_status === "expired" ? t("Đã hết hạn") : t("Sắp hết hạn") }} size="md" />}
                </span>
                <button type="button" aria-label={t("Xem chi tiết")} onClick={() => navigate(`/cabinet/${item.id}`)}
                  className="inline-flex size-9 shrink-0 items-center justify-center rounded-full bg-tile text-muted transition hover:bg-primary-soft hover:text-primary">
                  <ChevronRight size={18} />
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="mt-5"><Note>{t("Ưu tiên kiểm tra sản phẩm đã hết hạn. Không sử dụng thuốc quá hạn; tham khảo hướng dẫn xử lý tại địa phương.")}</Note></div>
      </Card>
      <CabinetItemModal request={editing} onClose={() => setEditing(null)} />
    </div>
  );
}
