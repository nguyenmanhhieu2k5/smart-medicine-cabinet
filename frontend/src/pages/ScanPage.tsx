import { ChevronRight, CircleCheck, Info, LoaderCircle, ScanLine, TriangleAlert } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { PrimaryButton } from "@/components/Button";
import { Card } from "@/components/Card";
import { MedicineAvatar, Note } from "@/components/MedicineBits";
import { ScanStage } from "@/components/ScanStage";
import { EmptyState } from "@/components/States";
import { StatusIndicator } from "@/components/StatusIndicator";
import { SystemBanner } from "@/components/SystemBanner";
import { useT } from "@/i18n";
import { api } from "@/services/api";
import { formatTime, relativeDay } from "@/services/format";
import { useOcrStatus } from "@/services/queries";
import { usePageHeader } from "@/stores/page";

const STEPS = [
  ["Đặt thuốc trong khung", "Hướng mặt có chữ về phía camera."],
  ["Giữ hình ảnh rõ nét", "Tránh rung tay và ánh sáng quá yếu."],
  ["Xác nhận kết quả", "Kiểm tra tên, hàm lượng và dạng thuốc."],
];

function OcrEngineLine() {
  const t = useT();
  const ocr = useOcrStatus().data;
  if (!ocr) return null;
  const engine = ocr.engine;
  const name = [engine.library ?? "PaddleOCR", engine.version, engine.recognition_model].filter(Boolean).join(" · ");
  if (ocr.state === "ready") return <StatusIndicator tone="success" icon={CircleCheck} size="sm">{name}</StatusIndicator>;
  if (ocr.state === "loading") return <StatusIndicator tone="info" icon={LoaderCircle} size="sm">{t("Đang nạp mô hình OCR…")}</StatusIndicator>;
  if (ocr.state === "error") return <StatusIndicator tone="danger" icon={TriangleAlert} size="sm">{t("OCR lỗi")}</StatusIndicator>;
  if (ocr.state === "disabled") return <StatusIndicator tone="neutral" size="sm">{t("OCR đang tắt")}</StatusIndicator>;
  return <StatusIndicator tone="neutral" size="sm" dot>{t("OCR sẽ nạp ở lần quét đầu")}</StatusIndicator>;
}

function LatestResult() {
  const t = useT();
  const navigate = useNavigate();
  const history = useQuery({ queryKey: ["history", { group: "scan", latest: true }], queryFn: () => api.history({ group: "scan", page_size: 10 }) });
  const events = history.data?.items ?? [];
  const confirmed = events.find((event) => event.type === "scan_confirmed");
  const latest = confirmed ?? events.find((event) => event.type === "ocr_completed");
  const name = confirmed?.description?.replace(/^Người dùng xác nhận:\s*/, "") ?? latest?.description?.split(" · ")[0].replace(/^Ứng viên tốt nhất:\s*/, "");

  return (
    <Card padding="lg" className="flex flex-1 flex-col">
      <div className="mb-5 flex items-center justify-between gap-3">
        <h2 className="font-display text-[19px] font-bold text-navy">{t("Kết quả gần nhất")}</h2>
        {latest && (confirmed
          ? <StatusIndicator tone="success" icon={CircleCheck} size="sm">{t("Đã xác nhận")}</StatusIndicator>
          : <StatusIndicator tone="warning" size="sm">{t("Chưa xác nhận")}</StatusIndicator>)}
      </div>
      {!latest ? (
        <EmptyState compact icon={ScanLine} title={t("Chưa có lần quét nào")} description={t("Kết quả nhận diện gần nhất sẽ hiển thị ở đây.")} />
      ) : (
        <>
          <div className="flex items-center gap-4">
            <MedicineAvatar name={name ?? "?"} size="lg" />
            <div className="min-w-0">
              <p className="truncate font-display text-[17px] font-bold text-navy">{name}</p>
              <p className="text-sm text-muted">{t("Nhận diện")} • {formatTime(latest.created_at)} {t(relativeDay(latest.created_at)).toLowerCase()}</p>
            </div>
          </div>
          <div className="mt-5"><Note>{t("Kết quả từ OCR chỉ hỗ trợ nhận diện. Người dùng cần xác nhận trước khi lưu hoặc sử dụng.")}</Note></div>
          <PrimaryButton variant="secondary" block className="mt-5" iconRight={ChevronRight} onClick={() => navigate("/history?group=scan")}>
            {t("Xem lịch sử quét")}
          </PrimaryButton>
        </>
      )}
    </Card>
  );
}

export function ScanPage() {
  const t = useT();
  usePageHeader(t("Quét thuốc"), t("Đưa hộp hoặc vỉ thuốc vào khung hình"), `${t("Tủ thuốc thông minh")} / ${t("Quét thuốc")}`);
  return (
    <div>
      <SystemBanner />
      <div className="grid grid-cols-[minmax(0,1.82fr)_minmax(340px,1fr)] gap-6 short:gap-4">
        <Card padding="none" className="flex flex-col p-[22px] pb-6 short:p-4">
          <ScanStage
            autoStart
            previewClassName="min-h-[clamp(240px,calc(100vh-430px),680px)]"
            caption={<p className="text-sm text-muted">{t("Nhấn nút tròn để nhận diện thuốc")} • {t("hoặc chọn ảnh, nhập thủ công")}</p>}
          />
        </Card>
        <div className="flex flex-col gap-5 short:gap-4">
          <Card padding="lg">
            <div className="mb-4 flex items-center justify-between gap-3">
              <h2 className="font-display text-[19px] font-bold text-navy">{t("Hướng dẫn quét")}</h2>
              <StatusIndicator tone="info" icon={Info} size="sm">{t("3 bước")}</StatusIndicator>
            </div>
            <ol className="divide-y divide-line">
              {STEPS.map(([title, text], index) => (
                <li key={title} className="flex gap-4 py-3.5 short:py-2.5">
                  <span className="inline-flex size-7 shrink-0 items-center justify-center rounded-full bg-primary-soft text-[13px] font-bold text-primary">{index + 1}</span>
                  <div>
                    <p className="text-sm font-semibold text-navy">{t(title)}</p>
                    <p className="text-sm text-muted">{t(text)}</p>
                  </div>
                </li>
              ))}
            </ol>
            <div className="mt-3"><OcrEngineLine /></div>
          </Card>
          <LatestResult />
        </div>
      </div>
    </div>
  );
}
