import { useEffect, useState } from "react";
import { PrimaryButton } from "@/components/Button";
import { Field, Select, TextArea, TextInput } from "@/components/Form";
import { MedicineAvatar, Note } from "@/components/MedicineBits";
import { Modal } from "@/components/Modal";
import { useT } from "@/i18n";
import { formatDate } from "@/services/format";
import { useCabinetMutations } from "@/services/queries";
import { toast } from "@/stores/toast";
import type { CabinetInput, CabinetItem, MedicineSummary } from "@/types/api";

export const UNITS = ["viên", "vỉ", "hộp", "chai", "lọ", "ống", "gói", "tuýp", "ml", "g"];

export interface CabinetModalRequest {
  /** Sửa một thuốc đang có trong tủ. */
  item?: CabinetItem;
  /** Thêm từ danh mục (thông tin nhận diện lấy từ dữ liệu Excel). */
  catalog?: MedicineSummary;
  /** Lần quét mà người dùng đang xác nhận. */
  scanJobId?: string | null;
  /** Hạn dùng đọc được từ ảnh — chỉ là gợi ý, người dùng phải kiểm tra. */
  expirySuggestion?: { date: string; text: string; precision: "day" | "month" } | null;
}

interface Props {
  request: CabinetModalRequest | null;
  onClose: () => void;
  onSaved?: (item: CabinetItem) => void;
}

interface FormState {
  name: string;
  ingredient: string;
  strength: string;
  quantity: string;
  unit: string;
  expiry: string;
  lot: string;
  location: string;
  note: string;
  threshold: string;
}

function initial(request: CabinetModalRequest | null): FormState {
  const item = request?.item;
  return {
    name: item?.name ?? "",
    ingredient: item?.ingredient ?? "",
    strength: item?.strength ?? "",
    quantity: item ? String(item.quantity) : "1",
    unit: item?.unit ?? "viên",
    expiry: item?.expiry_date ?? request?.expirySuggestion?.date ?? "",
    lot: item?.lot_number ?? "",
    location: item?.location ?? "",
    note: item?.note ?? "",
    threshold: item?.low_stock_threshold != null ? String(item.low_stock_threshold) : "",
  };
}

/** Thêm / sửa thuốc trong tủ. Hạn dùng ở đây là hạn THỰC TẾ in trên bao bì. */
export function CabinetItemModal({ request, onClose, onSaved }: Props) {
  const t = useT();
  const { create, update } = useCabinetMutations();
  const [form, setForm] = useState<FormState>(() => initial(request));
  const [errors, setErrors] = useState<Partial<Record<keyof FormState, string>>>({});
  const editing = Boolean(request?.item);
  const catalog = request?.catalog;
  const manual = !editing && !catalog;
  const suggestion = request?.expirySuggestion ?? null;

  useEffect(() => {
    setForm(initial(request));
    setErrors({});
  }, [request]);

  const set = (key: keyof FormState) => (event: { target: { value: string } }) => setForm((prev) => ({ ...prev, [key]: event.target.value }));

  const submit = () => {
    const next: typeof errors = {};
    const quantity = Number(form.quantity.replace(",", "."));
    if ((manual || (editing && !request?.item?.catalog_id)) && !form.name.trim()) next.name = t("Hãy nhập tên thuốc.");
    if (!Number.isFinite(quantity) || quantity < 0) next.quantity = t("Số lượng phải là số không âm.");
    const threshold = form.threshold.trim() === "" ? null : Number(form.threshold.replace(",", "."));
    if (threshold !== null && (!Number.isFinite(threshold) || threshold < 0)) next.threshold = t("Ngưỡng phải là số không âm.");
    if (form.expiry && !/^\d{4}-\d{2}-\d{2}$/.test(form.expiry)) next.expiry = t("Ngày không hợp lệ.");
    setErrors(next);
    if (Object.keys(next).length > 0) return;

    const body: CabinetInput = {
      quantity,
      unit: form.unit,
      expiry_date: form.expiry || null,
      lot_number: form.lot || null,
      location: form.location || null,
      note: form.note || null,
      low_stock_threshold: threshold,
    };
    if (form.expiry) body.expiry_source = suggestion && form.expiry === suggestion.date ? "ocr_confirmed" : "manual";
    if (manual || (editing && !request?.item?.catalog_id)) {
      body.name = form.name.trim();
      body.ingredient = form.ingredient || null;
      body.strength = form.strength || null;
    }
    const done = (saved: CabinetItem) => {
      toast.success(editing ? t("Đã cập nhật thuốc") : t("Đã lưu vào tủ thuốc"), saved.name);
      onSaved?.(saved);
      onClose();
    };
    if (editing && request?.item) update.mutate({ id: request.item.id, body }, { onSuccess: done });
    else create.mutate({ ...body, catalog_id: catalog?.id ?? null, scan_job_id: request?.scanJobId ?? null }, { onSuccess: done });
  };

  const identityName = request?.item?.name ?? catalog?.ten_thuoc ?? "";
  const identityLine = request?.item
    ? [request.item.strength, request.item.dosage_form].filter(Boolean).join(" · ")
    : [catalog?.ham_luong, catalog?.dang_bao_che].filter(Boolean).join(" · ");

  return (
    <Modal
      open={request !== null} onClose={onClose} size="md"
      title={editing ? t("Chỉnh sửa thuốc trong tủ") : request?.scanJobId ? t("Xác nhận và lưu vào tủ") : t("Thêm thuốc vào tủ")}
      description={editing ? undefined : t("Thuốc chỉ được lưu sau khi bạn bấm xác nhận.")}
      footer={
        <>
          <PrimaryButton variant="secondary" onClick={onClose}>{t("Hủy")}</PrimaryButton>
          <PrimaryButton loading={create.isPending || update.isPending} onClick={submit}>
            {editing ? t("Lưu thay đổi") : t("Xác nhận và lưu")}
          </PrimaryButton>
        </>
      }
    >
      <div className="space-y-5">
        {!manual && identityName && (
          <div className="flex items-center gap-4 rounded-2xl bg-tile p-4">
            <MedicineAvatar name={identityName} />
            <div className="min-w-0">
              <p className="truncate font-display text-[16px] font-bold text-navy">{identityName}</p>
              <p className="truncate text-[13px] text-muted">{identityLine || t("Không có hàm lượng trong dữ liệu")}</p>
              {(catalog?.so_dang_ky || request?.item?.registration_no) && (
                <p className="truncate text-[12.5px] text-muted">{t("Số đăng ký")}: {catalog?.so_dang_ky ?? request?.item?.registration_no}</p>
              )}
            </div>
          </div>
        )}

        {(manual || (editing && !request?.item?.catalog_id)) && (
          <>
            <Field label={t("Tên thuốc")} required error={errors.name}>
              <TextInput value={form.name} onChange={set("name")} placeholder={t("Ví dụ: Oresol")} maxLength={300} data-autofocus />
            </Field>
            <div className="grid grid-cols-2 gap-4">
              <Field label={t("Hoạt chất")}><TextInput value={form.ingredient} onChange={set("ingredient")} maxLength={300} /></Field>
              <Field label={t("Hàm lượng")}><TextInput value={form.strength} onChange={set("strength")} maxLength={120} /></Field>
            </div>
            {manual && <Note>{t("Thuốc nhập tay không liên kết với danh mục. Nếu thuốc có trong danh mục, hãy tìm và chọn từ đó để có đủ thông tin.")}</Note>}
          </>
        )}

        <div className="grid grid-cols-[1fr_150px] gap-4">
          <Field label={t("Số lượng")} required error={errors.quantity}>
            <TextInput type="number" min={0} step="any" inputMode="decimal" value={form.quantity} onChange={set("quantity")} />
          </Field>
          <Field label={t("Đơn vị")}>
            <Select value={form.unit} onChange={set("unit")}>
              {(UNITS.includes(form.unit) ? UNITS : [form.unit, ...UNITS]).map((unit) => <option key={unit} value={unit}>{unit}</option>)}
            </Select>
          </Field>
        </div>

        <Field
          label={t("Hạn dùng trên bao bì")} error={errors.expiry}
          hint={
            suggestion && form.expiry === suggestion.date
              ? t("Đọc từ ảnh: “{text}” → {date}. Hãy đối chiếu với bao bì trước khi lưu.", { text: suggestion.text, date: formatDate(suggestion.date) })
                + (suggestion.precision === "month" ? " " + t("Bao bì chỉ ghi tháng/năm nên lấy ngày cuối tháng.") : "")
              : t("Nhập theo HSD/EXP in trên hộp hoặc vỉ. Đây không phải hạn của số đăng ký lưu hành.")
          }
        >
          <TextInput type="date" value={form.expiry} onChange={set("expiry")} min="2000-01-01" max="2100-12-31" />
        </Field>

        <div className="grid grid-cols-2 gap-4">
          <Field label={t("Số lô")}><TextInput value={form.lot} onChange={set("lot")} maxLength={64} /></Field>
          <Field label={t("Vị trí trong tủ")}><TextInput value={form.location} onChange={set("location")} maxLength={200} placeholder={t("Ví dụ: Ngăn trên")} /></Field>
        </div>
        <Field label={t("Ngưỡng báo sắp hết")} error={errors.threshold} hint={t("Bỏ trống để dùng ngưỡng chung trong Cài đặt.")}>
          <TextInput type="number" min={0} step="any" value={form.threshold} onChange={set("threshold")} />
        </Field>
        <Field label={t("Ghi chú")}><TextArea value={form.note} onChange={set("note")} maxLength={1000} /></Field>
      </div>
    </Modal>
  );
}
