import { Database, PackagePlus, SearchX, TextSearch } from "lucide-react";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { PrimaryButton } from "@/components/Button";
import { CabinetItemModal, type CabinetModalRequest } from "@/components/CabinetItemModal";
import { SearchInput } from "@/components/Form";
import { MedicineAvatar } from "@/components/MedicineBits";
import { Modal } from "@/components/Modal";
import { EmptyState, LoadingState } from "@/components/States";
import { StatusIndicator } from "@/components/StatusIndicator";
import { useLanguageStore, useT } from "@/i18n";
import { formatNumber } from "@/services/format";
import { useHealth, useMedicineSearch } from "@/services/queries";
import { useUiStore } from "@/stores/ui";

function useDebounced<T>(value: T, delay = 220): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delay);
    return () => window.clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

/** Tìm thuốc thủ công trong danh mục (~55.000 bản ghi từ Excel) theo tên, hoạt chất, số đăng ký. */
export function CatalogSearchModal() {
  const t = useT();
  const navigate = useNavigate();
  const language = useLanguageStore((state) => state.language);
  const { catalogSearch, closeCatalogSearch } = useUiStore();
  const health = useHealth();
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(20);
  const [adding, setAdding] = useState<CabinetModalRequest | null>(null);
  const debounced = useDebounced(query);
  const search = useMedicineSearch(catalogSearch.open ? debounced : "", limit);

  useEffect(() => {
    if (catalogSearch.open) {
      setQuery(catalogSearch.query);
      setLimit(20);
    }
  }, [catalogSearch.open, catalogSearch.query]);

  const catalogCount = health.data?.catalog_count ?? 0;
  const items = search.data?.items ?? [];
  const typing = query.trim().length >= 2;

  return (
    <>
      <Modal
        open={catalogSearch.open && adding === null} onClose={closeCatalogSearch} size="lg"
        title={t("Tìm thuốc trong danh mục")}
        description={catalogCount > 0 ? t("Tra cứu trong {count} thuốc của danh mục. Nhập tên, hoạt chất, hàm lượng hoặc số đăng ký.", { count: formatNumber(catalogCount, language) }) : undefined}
      >
        {catalogCount === 0 ? (
          <EmptyState
            icon={Database} title={t("Chưa có danh mục thuốc")}
            description={t("Hãy nhập file Excel DAV_unique.xlsx để tra cứu và nhận diện thuốc.")}
            action={<PrimaryButton onClick={() => { closeCatalogSearch(); navigate("/settings"); }}>{t("Mở Cài đặt")}</PrimaryButton>}
          />
        ) : (
          <div className="min-h-[420px]">
            <SearchInput value={query} onChange={(value) => { setQuery(value); setLimit(20); }} placeholder={t("Ví dụ: paracetamol 500mg, amoxicillin, VN-20169-16")} data-autofocus aria-label={t("Từ khóa tìm kiếm")} />
            <div className="mt-4">
              {!typing ? (
                <EmptyState compact icon={TextSearch} title={t("Nhập ít nhất 2 ký tự")} description={t("Không phân biệt hoa thường, dấu tiếng Việt hay khoảng trắng: “PARACETAMOL 500 MG” và “paracetamol-500mg” cho cùng kết quả.")} />
              ) : search.isLoading || (search.isFetching && items.length === 0) ? (
                <LoadingState rows={5} />
              ) : items.length === 0 ? (
                <EmptyState compact icon={SearchX} title={t("Không tìm thấy thuốc phù hợp")} description={t("Thử từ khóa ngắn hơn, tên hoạt chất hoặc số đăng ký in trên bao bì.")} />
              ) : (
                <>
                  <div className="mb-2 flex items-center justify-between text-[12.5px] text-muted">
                    <span>{t("{total} kết quả", { total: search.data?.total ?? 0 })}</span>
                    {search.data?.mode === "fuzzy" && <StatusIndicator tone="warning" size="sm">{t("Kết quả gần đúng")}</StatusIndicator>}
                    {search.data?.mode === "registration" && <StatusIndicator tone="info" size="sm">{t("Khớp số đăng ký")}</StatusIndicator>}
                  </div>
                  <ul className="divide-y divide-line">
                    {items.map((item) => (
                      <li key={item.id} className="flex items-center gap-4 py-3.5">
                        <MedicineAvatar name={item.ten_thuoc} />
                        <button
                          type="button" className="min-w-0 flex-1 text-left"
                          onClick={() => { closeCatalogSearch(); navigate(`/medicines/${item.id}${catalogSearch.scanJobId ? `?scan=${catalogSearch.scanJobId}` : ""}`); }}
                        >
                          <p className="truncate text-[15px] font-semibold text-navy hover:text-primary">
                            {item.ten_thuoc}
                            {item.ham_luong && <span className="ml-2 font-medium text-primary">{item.ham_luong}</span>}
                          </p>
                          <p className="truncate text-[13px] text-muted">{[item.hoat_chat_chinh, item.dang_bao_che].filter(Boolean).join(" · ") || "—"}</p>
                          <p className="truncate text-[12.5px] text-muted">
                            {t("SĐK")}: {item.so_dang_ky ?? "—"}{item.ten_cong_ty_san_xuat ? ` · ${item.ten_cong_ty_san_xuat}` : ""}
                          </p>
                        </button>
                        <PrimaryButton variant="soft" size="sm" icon={PackagePlus} onClick={() => setAdding({ catalog: item, scanJobId: catalogSearch.scanJobId })}>
                          {t("Thêm vào tủ")}
                        </PrimaryButton>
                      </li>
                    ))}
                  </ul>
                  {(search.data?.total ?? 0) > items.length && limit < 50 && (
                    <div className="pt-3 text-center">
                      <PrimaryButton variant="ghost" size="sm" loading={search.isFetching} onClick={() => setLimit(50)}>{t("Xem thêm kết quả")}</PrimaryButton>
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        )}
      </Modal>
      <CabinetItemModal
        request={adding} onClose={() => setAdding(null)}
        onSaved={(saved) => { closeCatalogSearch(); navigate(`/cabinet/${saved.id}`); }}
      />
    </>
  );
}
