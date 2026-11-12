import { Database, LoaderCircle, TriangleAlert } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { PrimaryButton } from "@/components/Button";
import { useLanguageStore, useT } from "@/i18n";
import { formatNumber } from "@/services/format";
import { useCatalogStatus, useHealth, useOcrStatus } from "@/services/queries";

/** Dải thông báo trạng thái hệ thống cho luồng quét: thiếu danh mục, đang nhập, OCR lỗi. */
export function SystemBanner() {
  const t = useT();
  const navigate = useNavigate();
  const language = useLanguageStore((state) => state.language);
  const health = useHealth();
  const catalog = useCatalogStatus();
  const ocr = useOcrStatus(health.data?.status === "ok");
  const progress = catalog.data?.progress;

  if (health.isError && health.failureCount > 8) {
    return (
      <Strip tone="danger" icon={<TriangleAlert size={18} />}>
        {t("Không kết nối được dịch vụ nền. Hãy khởi động lại ứng dụng.")}
      </Strip>
    );
  }
  if (progress?.running) {
    const detail = progress.rows_total
      ? `${formatNumber(progress.rows_read, language)} / ${formatNumber(progress.rows_total, language)}`
      : formatNumber(progress.rows_read, language);
    return (
      <Strip tone="info" icon={<LoaderCircle size={18} className="animate-spin" />}>
        <span className="flex-1">{t("Đang nhập danh mục thuốc từ Excel")} · {progress.message || detail} {progress.percent != null && `(${Math.round(progress.percent)}%)`}</span>
        <span className="h-1.5 w-40 overflow-hidden rounded-full bg-primary/15">
          <span className="block h-full rounded-full bg-primary transition-all duration-500" style={{ width: `${progress.percent ?? 8}%` }} />
        </span>
      </Strip>
    );
  }
  if (catalog.data && catalog.data.count === 0) {
    return (
      <Strip tone="warning" icon={<Database size={18} />}>
        <span className="flex-1">{t("Chưa có danh mục thuốc. Hãy nhập file Excel DAV_unique.xlsx để nhận diện và tra cứu.")}</span>
        <PrimaryButton size="sm" variant="secondary" onClick={() => navigate("/settings")}>{t("Nhập dữ liệu")}</PrimaryButton>
      </Strip>
    );
  }
  if (ocr.data?.state === "error") {
    return (
      <Strip tone="danger" icon={<TriangleAlert size={18} />}>
        <span className="flex-1">{t("OCR chưa sẵn sàng")}: {ocr.data.error}</span>
        <PrimaryButton size="sm" variant="secondary" onClick={() => navigate("/settings")}>{t("Cấu hình OCR")}</PrimaryButton>
      </Strip>
    );
  }
  return null;
}

function Strip({ tone, icon, children }: { tone: "info" | "warning" | "danger"; icon: React.ReactNode; children: React.ReactNode }) {
  const tones = { info: "bg-primary-soft text-primary", warning: "bg-warning-soft text-warning-ink", danger: "bg-danger-soft text-danger" };
  return (
    <div role="status" className={`mb-5 flex items-center gap-3 rounded-2xl px-5 py-3 text-[13.5px] font-medium ${tones[tone]}`}>
      {icon}
      {children}
    </div>
  );
}
