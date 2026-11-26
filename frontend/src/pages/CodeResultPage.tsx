import { useQuery } from "@tanstack/react-query";
import { BadgeCheck, CircleAlert, Eye, Plus, QrCode, RefreshCw, ScanBarcode as BarcodeIcon } from "lucide-react";
import { useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { AiLookupPanel } from "@/components/AiLookupPanel";
import { PrimaryButton } from "@/components/Button";
import { CabinetItemModal, type CabinetModalRequest } from "@/components/CabinetItemModal";
import { Card } from "@/components/Card";
import { InfoRows, MedicineAvatar } from "@/components/MedicineBits";
import { ErrorState } from "@/components/States";
import { StatusIndicator } from "@/components/StatusIndicator";
import { useT } from "@/i18n";
import { isQrFormat } from "@/scan/codeReader";
import { api } from "@/services/api";
import { errorMessage } from "@/services/queries";
import { usePageHeader } from "@/stores/page";

const FORMAT_LABEL: Record<string, string> = {
  EAN13: "EAN-13", EAN8: "EAN-8", UPCA: "UPC-A", UPCE: "UPC-E", ITF: "ITF", ITF14: "ITF-14", Code128: "Code 128",
  QRCode: "QR Code", MicroQRCode: "Micro QR", DataMatrix: "Data Matrix",
};

function viDate(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
}

/**
 * Kết quả khi camera tự đọc được mã (không cần bấm chụp):
 * - mã có trong dữ liệu mã vạch → hiện thuốc ngay (kèm hạn dùng / số lô nếu là DataMatrix hoặc QR chuẩn GS1);
 * - mã sản phẩm chưa có dữ liệu, hoặc mã QR thường → TỰ tìm trên mạng (Tavily) theo đúng mã đó.
 */
export function CodeResultPage() {
  const t = useT();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const code = params.get("code") ?? "";
  const format = params.get("format") ?? "";
  const qr = isQrFormat(format);
  const [saving, setSaving] = useState<CabinetModalRequest | null>(null);
  usePageHeader(t("Kết quả quét mã"), t("Camera đã tự đọc mã trên hộp thuốc"), `${t("Tủ thuốc thông minh")} / ${t("Kết quả quét mã")}`);

  const lookup = useQuery({ queryKey: ["barcode-lookup", code], queryFn: () => api.barcodeLookup(code), enabled: code.length > 0 });
  const data = lookup.data;
  const rescan = () => navigate("/scan");
  const Icon = qr ? QrCode : BarcodeIcon;
  const shown = data?.status === "found" || data?.status === "not_found" ? data.code : code;
  // Mã sản phẩm chưa có dữ liệu → tra mã vạch trên mạng; mã QR không theo chuẩn GS1 → tra nội dung QR trên mạng.
  const web = data?.status === "not_found" ? { kind: "barcode" as const, value: data.code, label: t("Mã vạch {code}", { code: data.code }) }
    : data?.status === "invalid" && qr ? { kind: "qr" as const, value: code, label: t("Mã QR") }
    : null;
  const gs1 = data?.gs1;

  if (!code) {
    return <Card padding="lg"><ErrorState title={t("Không có mã để tra")} description={t("Hãy đưa mã vạch hoặc mã QR vào khung camera.")} /></Card>;
  }

  return (
    <div className="space-y-6">
      <Card padding="lg" data-testid="code-card">
        <div className="flex flex-wrap items-center gap-3">
          <span className="inline-flex size-12 items-center justify-center rounded-2xl bg-primary-soft text-primary"><Icon size={24} /></span>
          <div className="min-w-0 flex-1">
            <p className="text-[13px] font-semibold text-muted">{FORMAT_LABEL[format] ?? format}</p>
            <p className="truncate font-mono text-[18px] font-bold text-navy" title={code}>{shown}</p>
          </div>
          {data?.status === "found" && <StatusIndicator tone="success" icon={BadgeCheck}>{t("Khớp dữ liệu mã vạch")}</StatusIndicator>}
          {data?.status === "not_found" && <StatusIndicator tone="warning">{t("Chưa có dữ liệu mã vạch")}</StatusIndicator>}
          {data?.status === "invalid" && qr && <StatusIndicator tone="info">{t("Nội dung mã QR")}</StatusIndicator>}
          {gs1?.expiry && <StatusIndicator tone="info">{t("HSD")}: {viDate(gs1.expiry)}</StatusIndicator>}
          {gs1?.lot && <StatusIndicator>{t("Lô")}: {gs1.lot}</StatusIndicator>}
          <PrimaryButton variant="secondary" icon={RefreshCw} onClick={rescan}>{t("Quét mã khác")}</PrimaryButton>
        </div>

        {lookup.isLoading && <div className="mt-5 space-y-3" role="status"><div className="skeleton h-6 w-2/5" /><div className="skeleton h-4 w-3/5" /></div>}
        {lookup.isError && <div className="mt-5"><ErrorState description={errorMessage(lookup.error)} onRetry={() => void lookup.refetch()} /></div>}

        {data?.status === "found" && data.medicine && (
          <div className="mt-5 grid gap-5 border-t border-line pt-5 lg:grid-cols-[minmax(0,1fr)_auto]" data-testid="code-medicine">
            <div className="flex min-w-0 gap-4">
              <MedicineAvatar name={data.medicine.ten_thuoc} size="lg" />
              <div className="min-w-0 flex-1">
                <h2 className="font-display text-[22px] font-extrabold text-navy">{data.medicine.ten_thuoc}</h2>
                <div className="mt-2">
                  <InfoRows rows={[
                    { label: t("Hoạt chất"), value: data.medicine.hoat_chat_chinh },
                    { label: t("Hàm lượng"), value: data.medicine.ham_luong },
                    { label: t("Dạng bào chế"), value: data.medicine.dang_bao_che },
                    { label: t("Số đăng ký"), value: data.medicine.so_dang_ky },
                    { label: t("Nhà sản xuất"), value: data.medicine.ten_cong_ty_san_xuat },
                  ]} />
                </div>
              </div>
            </div>
            <div className="flex flex-col gap-3">
              <PrimaryButton icon={Plus} onClick={() => setSaving({
                catalog: data.medicine!, scanJobId: null,
                expirySuggestion: gs1?.expiry ? { date: gs1.expiry, precision: "day", text: viDate(gs1.expiry) } : null,
              })}>{t("Thêm vào tủ")}</PrimaryButton>
              <PrimaryButton variant="secondary" icon={Eye} onClick={() => navigate(`/medicines/${data.medicine!.id}`)}>{t("Thông tin đầy đủ")}</PrimaryButton>
            </div>
          </div>
        )}

        {(data?.status === "internal" || (data?.status === "invalid" && !qr)) && (
          <div className="mt-5 flex gap-3 rounded-2xl bg-warning-soft px-4 py-3.5 text-[14px] text-warning-ink" role="alert">
            <CircleAlert size={20} className="mt-0.5 shrink-0" />
            <span>{data.status === "internal" ? t("Đây là mã nội bộ của cửa hàng, không dùng để nhận ra thuốc. Hãy quét mã vạch in sẵn trên hộp hoặc chụp mặt hộp có tên thuốc.") : data.message || t("Mã này không phải mã sản phẩm.")}</span>
          </div>
        )}
      </Card>

      {web && <AiLookupPanel key={`${web.kind}:${web.value}`} code={web} autoStart />}

      <CabinetItemModal request={saving} onClose={() => setSaving(null)} onSaved={(item) => navigate(`/cabinet/${item.id}`)} />
    </div>
  );
}
