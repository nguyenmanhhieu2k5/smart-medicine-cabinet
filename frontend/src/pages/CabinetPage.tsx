import { ChevronRight, Download, FileSpreadsheet, Keyboard, ListFilter, Minus, Package, Pencil, Plus, ScanLine, Search, SearchX, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { IconButton, PrimaryButton } from "@/components/Button";
import { CabinetItemModal, type CabinetModalRequest } from "@/components/CabinetItemModal";
import { Card } from "@/components/Card";
import { DataTable, Pagination, type Column } from "@/components/DataTable";
import { SearchInput, Segmented, Select } from "@/components/Form";
import { ExpiryChip, MedicineAvatar } from "@/components/MedicineBits";
import { ConfirmDialog, Modal } from "@/components/Modal";
import { EmptyState, ErrorState } from "@/components/States";
import { useT } from "@/i18n";
import { api, saveBlob } from "@/services/api";
import { formatDate } from "@/services/format";
import { errorMessage, useCabinet, useCabinetMutations } from "@/services/queries";
import { usePageHeader } from "@/stores/page";
import { toast } from "@/stores/toast";
import { useUiStore } from "@/stores/ui";
import type { CabinetFilter, CabinetItem } from "@/types/api";

const PAGE_SIZE = 8;

/** Chỉ hiện hàm lượng cạnh tên khi nó ngắn và chưa nằm sẵn trong tên ("500 mg" ≡ "500mg"). */
function showStrength(item: CabinetItem): boolean {
  if (!item.strength || item.strength.length > 22) return false;
  const squash = (text: string) => text.toLowerCase().replace(/[\s.,]/g, "");
  return !squash(item.name).includes(squash(item.strength));
}

function AddChooser({ open, onClose, onManual }: { open: boolean; onClose: () => void; onManual: () => void }) {
  const t = useT();
  const navigate = useNavigate();
  const openSearch = useUiStore((state) => state.openCatalogSearch);
  const options = [
    { icon: Search, title: t("Tìm trong danh mục"), text: t("Chọn từ dữ liệu thuốc đã nhập (khuyến nghị)."), run: () => { onClose(); openSearch(); } },
    { icon: ScanLine, title: t("Quét bằng camera"), text: t("Nhận diện hộp hoặc vỉ thuốc bằng OCR."), run: () => { onClose(); navigate("/scan"); } },
    { icon: Keyboard, title: t("Nhập tay"), text: t("Dùng khi thuốc không có trong danh mục."), run: () => { onClose(); onManual(); } },
  ];
  return (
    <Modal open={open} onClose={onClose} title={t("Thêm thuốc vào tủ")} description={t("Chọn cách thêm thuốc.")} size="md">
      <div className="space-y-3">
        {options.map((option, index) => (
          <button key={option.title} type="button" onClick={option.run} data-autofocus={index === 0 ? true : undefined}
            className="flex w-full items-center gap-4 rounded-2xl p-4 text-left ring-1 ring-line transition hover:bg-tile hover:ring-primary/40">
            <span className="inline-flex size-12 shrink-0 items-center justify-center rounded-2xl bg-primary-soft text-primary"><option.icon size={22} strokeWidth={1.8} /></span>
            <span className="min-w-0 flex-1">
              <span className="block font-display text-[16px] font-bold text-navy">{option.title}</span>
              <span className="block text-[13px] text-muted">{option.text}</span>
            </span>
            <ChevronRight size={18} className="text-muted" />
          </button>
        ))}
      </div>
    </Modal>
  );
}

export function CabinetPage() {
  const t = useT();
  const navigate = useNavigate();
  usePageHeader(t("Thuốc trong tủ"), t("Danh sách thuốc và số lượng đang lưu"), `${t("Tủ thuốc thông minh")} / ${t("Thuốc trong tủ")}`);

  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<CabinetFilter>("all");
  const [sort, setSort] = useState("name");
  const [page, setPage] = useState(1);
  const [showFilters, setShowFilters] = useState(false);
  const [chooser, setChooser] = useState(false);
  const [editing, setEditing] = useState<CabinetModalRequest | null>(null);
  const [deleting, setDeleting] = useState<CabinetItem | null>(null);
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    const timer = window.setTimeout(() => { setQuery(search); setPage(1); }, 250);
    return () => window.clearTimeout(timer);
  }, [search]);

  const list = useCabinet({ q: query, status, sort, page, page_size: PAGE_SIZE });
  const { adjust, remove } = useCabinetMutations();
  const counts = list.data?.counts;
  const data = list.data;

  const doExport = async (format: "xlsx" | "csv") => {
    setExporting(true);
    try {
      const file = await api.cabinetExport(format, status);
      saveBlob(file.blob, file.filename);
      toast.success(t("Đã xuất danh sách"), file.filename);
    } catch (error) {
      toast.error(t("Không xuất được danh sách"), errorMessage(error));
    } finally {
      setExporting(false);
    }
  };

  const columns: Column<CabinetItem>[] = [
    {
      key: "name", header: t("Tên thuốc / hoạt chất"), width: "minmax(0,2.6fr)",
      render: (item) => (
        <div className="flex min-w-0 items-center gap-4">
          <MedicineAvatar name={item.name} />
          <div className="min-w-0">
            <p className="truncate text-[15.5px] font-semibold text-navy">
              {item.name}
              {showStrength(item) && <span className="ml-2 text-[13px] font-medium text-primary">{item.strength}</span>}
            </p>
            <p className="truncate text-[13px] text-muted">{item.ingredient ?? "—"}</p>
          </div>
        </div>
      ),
    },
    {
      key: "quantity", header: t("Số lượng"), width: "minmax(150px,1fr)",
      render: (item) => (
        <div className="flex items-center gap-1.5" onClick={(event) => event.stopPropagation()}>
          <IconButton icon={Minus} label={t("Giảm 1")} size="sm" variant="ghost" disabled={item.quantity < 1 || adjust.isPending} onClick={() => adjust.mutate({ id: item.id, delta: -1 })} />
          <span className="min-w-[76px] text-center">
            <span className="block text-[15px] font-bold tabular-nums text-navy">{item.quantity_text}</span>
            {item.low_stock && <span className="block text-[11.5px] font-semibold text-warning-ink">{t("Sắp hết")}</span>}
          </span>
          <IconButton icon={Plus} label={t("Tăng 1")} size="sm" variant="ghost" disabled={adjust.isPending} onClick={() => adjust.mutate({ id: item.id, delta: 1 })} />
        </div>
      ),
    },
    { key: "expiry", header: t("Hạn dùng"), width: "minmax(100px,0.8fr)", render: (item) => <span className="tabular-nums text-muted">{formatDate(item.expiry_date)}</span> },
    { key: "status", header: t("Trạng thái"), width: "minmax(120px,0.9fr)", render: (item) => <ExpiryChip item={item} /> },
    {
      key: "actions", header: "", width: "132px", align: "right",
      render: (item) => (
        <div className="flex items-center gap-1" onClick={(event) => event.stopPropagation()}>
          <IconButton icon={Pencil} label={t("Sửa")} size="sm" variant="ghost" onClick={() => setEditing({ item })} />
          <IconButton icon={Trash2} label={t("Xóa")} size="sm" variant="danger" onClick={() => setDeleting(item)} />
          <IconButton icon={ChevronRight} label={t("Xem chi tiết")} size="sm" onClick={() => navigate(`/cabinet/${item.id}`)} />
        </div>
      ),
    },
  ];

  const emptyCabinet = data && data.counts.all === 0;

  return (
    <Card padding="none" className="pb-5">
      <div className="flex items-center gap-3 p-6 pb-5">
        <SearchInput value={search} onChange={setSearch} placeholder={t("Tìm tên thuốc, hoạt chất…")} className="flex-1" aria-label={t("Tìm trong tủ thuốc")} />
        <PrimaryButton variant="secondary" size="lg" icon={ListFilter} onClick={() => setShowFilters((v) => !v)} aria-expanded={showFilters}>{t("Bộ lọc")}</PrimaryButton>
        <PrimaryButton size="lg" icon={Plus} onClick={() => setChooser(true)} data-testid="add-medicine">{t("Thêm thuốc")}</PrimaryButton>
      </div>
      <div className="border-t border-line px-6 pt-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Segmented<CabinetFilter>
            size="sm" value={status} onChange={(value) => { setStatus(value); setPage(1); }}
            options={[
              { value: "all", label: t("Tất cả"), count: counts?.all },
              { value: "ok", label: t("Còn hạn"), count: counts?.ok },
              { value: "expiring", label: t("Sắp hết hạn"), count: counts?.expiring, tone: "warning" },
              { value: "expired", label: t("Hết hạn"), count: counts?.expired, tone: "danger" },
              { value: "unknown", label: t("Chưa có hạn"), count: counts?.unknown },
              { value: "low_stock", label: t("Sắp hết số lượng"), count: counts?.low_stock },
            ]}
          />
        </div>
        {showFilters && (
          <div className="mt-4 flex flex-wrap items-center gap-3 rounded-2xl bg-tile p-3">
            <span className="pl-2 text-[13px] font-semibold text-muted">{t("Sắp xếp")}</span>
            <Select value={sort} onChange={(event) => setSort(event.target.value)} className="!h-10 !w-56" aria-label={t("Sắp xếp")}>
              <option value="name">{t("Tên thuốc (A → Z)")}</option>
              <option value="expiry">{t("Hạn dùng gần nhất")}</option>
              <option value="quantity">{t("Số lượng ít nhất")}</option>
              <option value="recent">{t("Mới thêm gần đây")}</option>
            </Select>
            <span className="ml-auto text-[13px] font-semibold text-muted">{t("Xuất danh sách")}</span>
            <PrimaryButton variant="secondary" size="sm" icon={FileSpreadsheet} loading={exporting} disabled={!data || data.total === 0} onClick={() => void doExport("xlsx")}>Excel</PrimaryButton>
            <PrimaryButton variant="secondary" size="sm" icon={Download} disabled={exporting || !data || data.total === 0} onClick={() => void doExport("csv")}>CSV</PrimaryButton>
          </div>
        )}
      </div>

      <div className="px-1 pt-5">
        {list.isError ? (
          <ErrorState description={errorMessage(list.error)} onRetry={() => void list.refetch()} />
        ) : (
          <DataTable
            columns={columns} rows={data?.items ?? []} rowKey={(item) => item.id} loading={list.isLoading}
            onRowClick={(item) => navigate(`/cabinet/${item.id}`)}
            rowClassName={(item) => (item.expiry_status === "expired" ? "bg-danger-soft/35" : undefined)}
            empty={
              emptyCabinet ? (
                <EmptyState icon={Package} title={t("Tủ thuốc đang trống")}
                  description={t("Chỉ những thuốc bạn thực sự thêm mới xuất hiện ở đây. Danh mục thuốc từ Excel được dùng để tra cứu, không tự thêm vào tủ.")}
                  action={<PrimaryButton icon={Plus} onClick={() => setChooser(true)}>{t("Thêm thuốc đầu tiên")}</PrimaryButton>} />
              ) : (
                <EmptyState icon={SearchX} title={t("Không có thuốc phù hợp bộ lọc")} description={t("Thử từ khóa khác hoặc chọn “Tất cả”.")} />
              )
            }
          />
        )}
      </div>
      {data && data.total > 0 && (
        <div className="px-1">
          <Pagination page={data.page} pages={data.pages} total={data.total} onChange={setPage}
            label={t("Hiển thị {shown} trong {total} thuốc", { shown: data.items.length, total: data.total })} />
        </div>
      )}

      <AddChooser open={chooser} onClose={() => setChooser(false)} onManual={() => setEditing({})} />
      <CabinetItemModal request={editing} onClose={() => setEditing(null)} />
      <ConfirmDialog
        open={deleting !== null} danger title={t("Xóa thuốc khỏi tủ?")} confirmLabel={t("Xóa thuốc")} loading={remove.isPending}
        description={t("“{name}” sẽ bị xóa khỏi tủ thuốc. Lời nhắc liên quan vẫn được giữ lại. Thao tác này không hoàn tác được.", { name: deleting?.name ?? "" })}
        onClose={() => setDeleting(null)}
        onConfirm={() => deleting && remove.mutate(deleting.id, { onSuccess: () => { toast.success(t("Đã xóa thuốc"), deleting.name); setDeleting(null); } })}
      />
    </Card>
  );
}
