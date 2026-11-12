import { ArrowLeft, ChevronDown, CircleCheck, ImageOff, Minus, PackagePlus, Pencil, Plus, Square, Trash2, Volume2 } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { IconButton, PrimaryButton } from "@/components/Button";
import { CabinetItemModal, type CabinetModalRequest } from "@/components/CabinetItemModal";
import { Card } from "@/components/Card";
import { ExpiryChip, InfoRows, MedicineAvatar, Note } from "@/components/MedicineBits";
import { ConfirmDialog } from "@/components/Modal";
import { ErrorState, LoadingState } from "@/components/States";
import { StatusIndicator, type Tone } from "@/components/StatusIndicator";
import { useT } from "@/i18n";
import { assetUrl } from "@/services/api";
import { formatDate } from "@/services/format";
import { errorMessage, useCabinetItem, useCabinetMutations, useMedicine, useOcrJob, useSettings } from "@/services/queries";
import { buildSpeech, speak, spokenDate, stopSpeaking, ttsSupported } from "@/services/tts";
import { usePageHeader } from "@/stores/page";
import { toast } from "@/stores/toast";
import type { CabinetItem, MedicineDetail } from "@/types/api";

function registrationTone(code: MedicineDetail["registration_status"]["code"]): Tone {
  return code === "valid" ? "success" : code === "expired" ? "warning" : code === "withdrawn" ? "danger" : "neutral";
}

function useSpeech(text: string) {
  const t = useT();
  const settings = useSettings().data?.settings;
  const [speaking, setSpeaking] = useState(false);
  const [noVoice, setNoVoice] = useState(false);
  useEffect(() => () => stopSpeaking(), []);
  const toggle = () => {
    if (speaking) {
      stopSpeaking();
      setSpeaking(false);
      return;
    }
    const result = speak(text, { voiceUri: settings?.tts_voice, rate: settings?.tts_rate, onEnd: () => setSpeaking(false) });
    if (result.ok) {
      setSpeaking(true);
      setNoVoice(false);
    } else {
      setNoVoice(true);
      toast.warning(
        result.reason === "unsupported" ? t("Thiết bị không hỗ trợ đọc văn bản") : t("Chưa có giọng đọc tiếng Việt"),
        t("Xem hướng dẫn cài giọng đọc trong Cài đặt → Giọng đọc."),
      );
    }
  };
  return { speaking, noVoice, toggle, enabled: settings?.tts_enabled !== false && ttsSupported() };
}

/** Thông tin đăng ký lưu hành lấy nguyên từ danh mục Excel. */
function RegistrationCard({ medicine }: { medicine: MedicineDetail }) {
  const t = useT();
  const [showRaw, setShowRaw] = useState(false);
  return (
    <Card padding="lg">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-display text-[19px] font-bold text-navy">{t("Thông tin đăng ký lưu hành")}</h2>
          <p className="mt-0.5 text-[13px] text-muted">{t("Nguồn: danh mục thuốc nhập từ Excel (mã bản ghi {id})", { id: medicine.id })}</p>
        </div>
        <StatusIndicator tone={registrationTone(medicine.registration_status.code)}>{t(medicine.registration_status.label)}</StatusIndicator>
      </div>
      <div className="grid gap-x-10 xl:grid-cols-2">
        <InfoRows
          rows={[
            { label: t("Số đăng ký"), value: medicine.so_dang_ky, hint: medicine.so_dang_ky_cu && medicine.so_dang_ky_cu !== medicine.so_dang_ky ? `${t("Số cũ")}: ${medicine.so_dang_ky_cu}` : undefined },
            { label: t("Quy cách đóng gói"), value: medicine.dong_goi },
            { label: t("Tiêu chuẩn"), value: medicine.tieu_chuan },
            { label: t("Tuổi thọ"), value: medicine.tuoi_tho ? (/^\d+$/.test(medicine.tuoi_tho) ? `${medicine.tuoi_tho} ${t("tháng")}` : medicine.tuoi_tho) : null },
            { label: t("Ngày cấp số đăng ký"), value: medicine.ngay_cap_so_dang_ky ? formatDate(medicine.ngay_cap_so_dang_ky) : null },
          ]}
        />
        <InfoRows
          rows={[
            {
              label: t("Hết hạn số đăng ký"), value: medicine.ngay_het_han_so_dang_ky ? formatDate(medicine.ngay_het_han_so_dang_ky) : null,
              hint: t("Hạn của giấy đăng ký lưu hành — không phải hạn dùng của hộp thuốc."),
            },
            { label: t("Công ty đăng ký"), value: medicine.ten_cong_ty_dang_ky, hint: medicine.nuoc_dang_ky ?? undefined },
            { label: t("Công ty sản xuất"), value: medicine.ten_cong_ty_san_xuat, hint: medicine.dia_chi_san_xuat ?? undefined },
            { label: t("Nước sản xuất"), value: medicine.nuoc_san_xuat },
            { label: t("Số quyết định"), value: medicine.so_quyet_dinh, hint: medicine.dot_cap ? `${t("Đợt cấp")}: ${medicine.dot_cap}` : undefined },
          ]}
        />
      </div>
      <button type="button" onClick={() => setShowRaw((v) => !v)} aria-expanded={showRaw} className="mt-4 inline-flex items-center gap-1.5 text-[13px] font-semibold text-primary hover:underline">
        {t("Toàn bộ {count} trường dữ liệu gốc", { count: Object.keys(medicine.raw).length })} <ChevronDown size={14} className={showRaw ? "rotate-180 transition-transform" : "transition-transform"} />
      </button>
      {showRaw && (
        <div className="scroll-area mt-3 max-h-80 overflow-y-auto rounded-2xl bg-tile p-4">
          <table className="w-full text-left text-[12.5px]">
            <tbody>
              {Object.entries(medicine.raw).map(([key, value]) => (
                <tr key={key} className="border-b border-line/70 last:border-0">
                  <th className="w-[210px] py-1.5 pr-4 align-top font-mono font-medium text-muted">{key}</th>
                  <td className="break-words py-1.5 text-navy">{value === null || value === "" ? <span className="text-muted">∅</span> : String(value)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function VoiceNotice() {
  const t = useT();
  return (
    <Note tone="warning">
      {t("Máy chưa có giọng đọc tiếng Việt. Trên Windows: Settings → Time & language → Speech → Add voices → Vietnamese, rồi mở lại ứng dụng.")}{" "}
      <Link to="/settings#tts" className="font-semibold underline">{t("Mở cài đặt giọng đọc")}</Link>
    </Note>
  );
}

function CabinetDetail({ item }: { item: CabinetItem }) {
  const t = useT();
  const navigate = useNavigate();
  const { adjust, remove } = useCabinetMutations();
  const [editing, setEditing] = useState<CabinetModalRequest | null>(null);
  const [deleting, setDeleting] = useState(false);
  const catalog = item.catalog ?? null;
  const speech = useSpeech(
    buildSpeech([
      ["Tên thuốc", item.name], ["Hoạt chất", item.ingredient], ["Hàm lượng", item.strength], ["Dạng bào chế", item.dosage_form],
      ["Số đăng ký", item.registration_no], ["Nhà sản xuất", item.manufacturer], ["Số lượng trong tủ", item.quantity_text],
      ["Hạn dùng trên bao bì", spokenDate(item.expiry_date) ?? "chưa nhập"],
    ]),
  );

  return (
    <div className="space-y-6 short:space-y-4">
      <div className="grid grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)] gap-6 short:gap-4">
        <Card padding="lg">
          <div className="flex h-[clamp(200px,calc(100vh-520px),440px)] items-center justify-center overflow-hidden rounded-[22px] bg-tile">
            {item.has_image ? (
              <img src={assetUrl(`/cabinet/medicines/${item.id}/image`, item.updated_at)} alt={t("Ảnh đã lưu khi quét")} className="size-full object-contain" />
            ) : (
              <div className="flex flex-col items-center gap-4 text-center">
                <MedicineAvatar name={item.name} size="xl" />
                <p className="inline-flex items-center gap-2 text-[13px] text-muted"><ImageOff size={15} /> {t("Chưa lưu ảnh cho thuốc này")}</p>
              </div>
            )}
          </div>
          <div className="mt-5 flex flex-wrap items-center gap-2.5">
            <StatusIndicator tone="success" icon={CircleCheck}>{t("Đang lưu trong tủ")}</StatusIndicator>
            <ExpiryChip item={item} size="md" />
            {item.low_stock && <StatusIndicator tone="warning">{t("Sắp hết số lượng")}</StatusIndicator>}
          </div>
          <div className="mt-5 flex items-center justify-between rounded-2xl bg-tile px-5 py-4">
            <div>
              <p className="text-[13px] text-muted">{t("Số lượng trong tủ")}</p>
              <p className="font-display text-[24px] font-extrabold tabular-nums text-navy">{item.quantity_text}</p>
            </div>
            <div className="flex items-center gap-2">
              <IconButton icon={Minus} label={t("Giảm 1")} variant="surface" disabled={item.quantity < 1 || adjust.isPending} onClick={() => adjust.mutate({ id: item.id, delta: -1 })} />
              <IconButton icon={Plus} label={t("Tăng 1")} variant="surface" disabled={adjust.isPending} onClick={() => adjust.mutate({ id: item.id, delta: 1 })} />
            </div>
          </div>
          <p className="mt-4 text-[13px] text-muted">
            {item.has_image ? t("Ảnh do bạn chụp khi quét; nội dung cần đối chiếu bao bì thực tế.") : t("Bật “Lưu ảnh quét” trong Cài đặt nếu muốn giữ ảnh khi xác nhận kết quả quét.")}
          </p>
        </Card>

        <Card padding="lg">
          <div className="mb-5 flex items-start justify-between gap-4">
            <div className="min-w-0">
              <h2 className="break-words font-display text-[26px] font-extrabold leading-tight text-navy">{item.name}</h2>
              <p className="mt-1 text-sm text-muted">
                {t("Thuốc trong tủ")} · {item.source === "scan" ? t("Thêm bằng quét OCR, đã được xác nhận") : catalog ? t("Chọn từ danh mục") : t("Nhập tay")}
              </p>
            </div>
            <IconButton icon={Trash2} label={t("Xóa khỏi tủ")} variant="danger" onClick={() => setDeleting(true)} />
          </div>
          <InfoRows
            rows={[
              { label: t("Hoạt chất"), value: item.ingredient },
              { label: t("Hàm lượng"), value: item.strength },
              { label: t("Dạng bào chế"), value: item.dosage_form },
              { label: t("Đường dùng"), value: catalog?.ten_duong_dung ?? null },
              { label: t("Số lượng"), value: item.quantity_text },
              {
                label: t("Hạn dùng"), value: item.expiry_date ? formatDate(item.expiry_date) : <span className="font-normal text-muted">{t("Chưa nhập — xem HSD trên bao bì")}</span>,
                hint: item.expiry_date ? (item.expiry_source === "ocr_confirmed" ? t("Đọc từ ảnh và đã được bạn xác nhận") : t("Do bạn nhập theo bao bì")) : undefined,
              },
              ...(item.lot_number ? [{ label: t("Số lô"), value: item.lot_number }] : []),
              ...(item.location ? [{ label: t("Vị trí"), value: item.location }] : []),
              ...(item.note ? [{ label: t("Ghi chú"), value: item.note }] : []),
              { label: t("Bảo quản"), value: <span className="font-normal text-muted">{t("Theo hướng dẫn trên bao bì")}</span> },
            ]}
          />
          <div className="mt-5 space-y-3">
            <Note>{t("Thông tin hiển thị để quản lý thuốc, không thay thế hướng dẫn sử dụng của bác sĩ hoặc dược sĩ.")}</Note>
            {speech.noVoice && <VoiceNotice />}
          </div>
          <div className="mt-5 flex flex-wrap items-center gap-3">
            <PrimaryButton size="lg" icon={Pencil} className="min-w-[200px] flex-1" onClick={() => setEditing({ item })}>{t("Chỉnh sửa thông tin")}</PrimaryButton>
            {speech.enabled && (
              <PrimaryButton size="lg" variant="secondary" icon={speech.speaking ? Square : Volume2} onClick={speech.toggle}>
                {speech.speaking ? t("Dừng đọc") : t("Đọc thông tin")}
              </PrimaryButton>
            )}
            <PrimaryButton size="lg" variant="secondary" icon={ArrowLeft} onClick={() => navigate(-1)}>{t("Quay lại")}</PrimaryButton>
          </div>
        </Card>
      </div>

      {catalog ? <RegistrationCard medicine={catalog} /> : (
        <Card padding="lg"><Note>{t("Thuốc này được nhập tay nên không có thông tin đăng ký lưu hành từ danh mục.")}</Note></Card>
      )}

      <CabinetItemModal request={editing} onClose={() => setEditing(null)} />
      <ConfirmDialog
        open={deleting} danger title={t("Xóa thuốc khỏi tủ?")} confirmLabel={t("Xóa thuốc")} loading={remove.isPending}
        description={t("“{name}” sẽ bị xóa khỏi tủ thuốc. Lời nhắc liên quan vẫn được giữ lại. Thao tác này không hoàn tác được.", { name: item.name })}
        onClose={() => setDeleting(false)}
        onConfirm={() => remove.mutate(item.id, { onSuccess: () => { toast.success(t("Đã xóa thuốc"), item.name); navigate("/cabinet", { replace: true }); } })}
      />
    </div>
  );
}

function CatalogDetail({ medicine, scanJobId }: { medicine: MedicineDetail; scanJobId: string | null }) {
  const t = useT();
  const navigate = useNavigate();
  const [adding, setAdding] = useState<CabinetModalRequest | null>(null);
  const job = useOcrJob(scanJobId);
  const speech = useSpeech(
    buildSpeech([
      ["Tên thuốc", medicine.ten_thuoc], ["Hoạt chất", medicine.hoat_chat_chinh], ["Hàm lượng", medicine.ham_luong],
      ["Dạng bào chế", medicine.dang_bao_che], ["Đường dùng", medicine.ten_duong_dung], ["Quy cách", medicine.dong_goi],
      ["Số đăng ký", medicine.so_dang_ky], ["Công ty sản xuất", medicine.ten_cong_ty_san_xuat], ["Nước sản xuất", medicine.nuoc_san_xuat],
    ]),
  );
  return (
    <div className="space-y-6 short:space-y-4">
      <div className="grid grid-cols-[minmax(0,0.8fr)_minmax(0,1.3fr)] gap-6 short:gap-4">
        <Card padding="lg" className="flex flex-col">
          <div className="flex flex-1 flex-col items-center justify-center gap-4 rounded-[22px] bg-tile px-6 py-10 text-center">
            <MedicineAvatar name={medicine.ten_thuoc} size="xl" />
            <div>
              <p className="font-display text-[18px] font-bold text-navy">{medicine.ten_thuoc}</p>
              <p className="mt-1 text-sm font-semibold text-primary">{medicine.ham_luong ?? t("Không ghi hàm lượng")}</p>
            </div>
          </div>
          <div className="mt-5 flex flex-wrap items-center gap-2.5">
            <StatusIndicator tone="info">{t("Bản ghi danh mục")}</StatusIndicator>
            {(medicine.in_cabinet_count ?? 0) > 0
              ? <StatusIndicator tone="success" icon={CircleCheck}>{t("Đang có {count} mục trong tủ", { count: medicine.in_cabinet_count ?? 0 })}</StatusIndicator>
              : <StatusIndicator tone="neutral">{t("Chưa có trong tủ")}</StatusIndicator>}
            {!medicine.in_source && <StatusIndicator tone="warning">{t("Không còn trong file nguồn mới nhất")}</StatusIndicator>}
          </div>
          <p className="mt-4 text-[13px] text-muted">{t("Danh mục không kèm ảnh sản phẩm. Hãy đối chiếu tên, hàm lượng và số đăng ký với bao bì thực tế.")}</p>
        </Card>

        <Card padding="lg">
          <h2 className="break-words font-display text-[26px] font-extrabold leading-tight text-navy">{medicine.ten_thuoc}</h2>
          <p className="mb-5 mt-1 text-sm text-muted">{t("Thông tin từ danh mục thuốc")}</p>
          <InfoRows
            rows={[
              { label: t("Hoạt chất chính"), value: medicine.hoat_chat_chinh },
              { label: t("Hàm lượng"), value: medicine.ham_luong, hint: medicine.ham_luong_source && medicine.ham_luong_source !== "hamLuong" ? t("Trích từ cột hoạt chất/tên thuốc của danh mục") : undefined },
              { label: t("Dạng bào chế"), value: medicine.dang_bao_che },
              { label: t("Đường dùng"), value: medicine.ten_duong_dung },
              { label: t("Quy cách đóng gói"), value: medicine.dong_goi },
              { label: t("Hạn dùng của hộp thuốc"), value: <span className="font-normal text-muted">{t("Xem HSD in trên bao bì và nhập khi thêm vào tủ")}</span> },
            ]}
          />
          <div className="mt-5 space-y-3">
            <Note>{t("Ứng dụng chỉ hiển thị dữ liệu có trong danh mục, không bổ sung thông tin y khoa. Liều dùng theo chỉ định của bác sĩ hoặc dược sĩ.")}</Note>
            {speech.noVoice && <VoiceNotice />}
          </div>
          <div className="mt-5 flex flex-wrap items-center gap-3">
            <PrimaryButton
              size="lg" icon={PackagePlus} className="min-w-[200px] flex-1"
              onClick={() => setAdding({ catalog: medicine, scanJobId, expirySuggestion: job.data?.result?.expiry_suggestion ?? null })}
            >
              {scanJobId ? t("Xác nhận và lưu vào tủ") : t("Thêm vào tủ")}
            </PrimaryButton>
            {speech.enabled && (
              <PrimaryButton size="lg" variant="secondary" icon={speech.speaking ? Square : Volume2} onClick={speech.toggle}>
                {speech.speaking ? t("Dừng đọc") : t("Đọc thông tin")}
              </PrimaryButton>
            )}
            <PrimaryButton size="lg" variant="secondary" icon={ArrowLeft} onClick={() => navigate(-1)}>{t("Quay lại")}</PrimaryButton>
          </div>
        </Card>
      </div>
      <RegistrationCard medicine={medicine} />
      <CabinetItemModal request={adding} onClose={() => setAdding(null)} onSaved={(saved) => navigate(`/cabinet/${saved.id}`, { replace: true })} />
    </div>
  );
}

export function MedicineDetailPage({ source }: { source: "cabinet" | "catalog" }) {
  const t = useT();
  const params = useParams();
  const [searchParams] = useSearchParams();
  const id = Number(source === "cabinet" ? params.itemId : params.medicineId);
  const valid = Number.isInteger(id) && id >= 0;
  const cabinet = useCabinetItem(source === "cabinet" && valid ? id : null);
  const catalog = useMedicine(source === "catalog" && valid ? id : null);
  usePageHeader(
    t("Thông tin thuốc"),
    source === "cabinet" ? t("Xem chi tiết và cập nhật thuốc") : t("Dữ liệu từ danh mục thuốc"),
    `${t("Tủ thuốc thông minh")} / ${t("Thông tin thuốc")}`,
  );

  const query = source === "cabinet" ? cabinet : catalog;
  if (!valid) return <Card padding="lg"><ErrorState title={t("Đường dẫn không hợp lệ")} /></Card>;
  if (query.isLoading) return <Card padding="lg"><LoadingState rows={6} /></Card>;
  if (query.isError || !query.data) {
    return <Card padding="lg"><ErrorState title={t("Không tìm thấy thuốc")} description={errorMessage(query.error)} onRetry={() => void query.refetch()} /></Card>;
  }
  return source === "cabinet"
    ? <CabinetDetail item={cabinet.data as CabinetItem} />
    : <CatalogDetail medicine={catalog.data as MedicineDetail} scanJobId={searchParams.get("scan")} />;
}
