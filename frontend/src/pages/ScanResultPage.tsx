import clsx from "clsx";
import {
  Check, ChevronDown, CircleCheck, CircleHelp, CircleMinus, CircleX, Database, Eye, RefreshCw, ScanSearch, Search, TextSearch, TriangleAlert,
} from "lucide-react";
import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { PrimaryButton } from "@/components/Button";
import { CabinetItemModal, type CabinetModalRequest } from "@/components/CabinetItemModal";
import { Card } from "@/components/Card";
import { InfoRows, MatchLevelChip, MedicineAvatar, Note } from "@/components/MedicineBits";
import { EmptyState, ErrorState } from "@/components/States";
import { StatusIndicator } from "@/components/StatusIndicator";
import { useT } from "@/i18n";
import { assetUrl } from "@/services/api";
import { errorMessage, useOcrJob } from "@/services/queries";
import { usePageHeader } from "@/stores/page";
import { useUiStore } from "@/stores/ui";
import type { ComponentStatus, MatchCandidate, OcrJob } from "@/types/api";

const STATUS_ICON: Record<ComponentStatus, { icon: typeof Check; className: string }> = {
  match: { icon: CircleCheck, className: "text-success" },
  partial: { icon: CircleMinus, className: "text-warning" },
  conflict: { icon: CircleX, className: "text-danger" },
  not_observed: { icon: CircleHelp, className: "text-muted/70" },
  no_data: { icon: CircleHelp, className: "text-muted/70" },
};

function ScannedImage({ job, processing }: { job: OcrJob | undefined; processing: boolean }) {
  const t = useT();
  const [showText, setShowText] = useState(false);
  const ocr = job?.result?.ocr;
  return (
    <Card padding="lg" className="flex flex-col">
      <h2 className="mb-4 font-display text-[19px] font-bold text-navy">{t("Hình ảnh đã quét")}</h2>
      <div className="relative flex h-[clamp(220px,calc(100vh-470px),460px)] items-center justify-center overflow-hidden rounded-[22px] bg-tile">
        {job?.has_image ? (
          <img src={assetUrl(`/ocr/jobs/${job.id}/image`, job.id)} alt={t("Ảnh vừa quét")} className="size-full object-contain" />
        ) : (
          <p className="text-sm text-muted">{t("Ảnh quét không còn được lưu.")}</p>
        )}
        {processing && (
          <>
            <div className="absolute inset-0 bg-[#111b39]/20" />
            <span aria-hidden className="scanline absolute inset-x-6 top-4 h-0.5 rounded-full bg-primary shadow-[0_0_18px_3px_rgba(8,120,249,0.7)]" style={{ ["--scan-distance" as string]: "300px" }} />
          </>
        )}
      </div>

      {processing && job && (
        <div className="mt-5" role="status">
          <div className="mb-2 flex items-center justify-between text-sm">
            <span className="font-semibold text-navy">{t(job.message)}</span>
            <span className="tabular-nums text-muted">{job.progress}%</span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-tile">
            <div className="h-full rounded-full bg-primary transition-all duration-500" style={{ width: `${Math.max(6, job.progress)}%` }} />
          </div>
        </div>
      )}

      {ocr && (
        <>
          <div className="mt-5 flex flex-wrap items-center gap-2">
            <StatusIndicator tone="success" icon={CircleCheck} size="sm">{t("Đã xử lý ảnh")}</StatusIndicator>
            <StatusIndicator tone="neutral" size="sm">{t("Tiền xử lý")}: {ocr.preprocess_label}</StatusIndicator>
            <StatusIndicator tone="neutral" size="sm">{t("{count} dòng chữ", { count: ocr.line_count })}</StatusIndicator>
            <button type="button" onClick={() => setShowText((v) => !v)} aria-expanded={showText}
              className="ml-auto inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[13px] font-semibold text-primary hover:bg-primary-soft">
              <TextSearch size={15} /> {t("Văn bản OCR")} <ChevronDown size={14} className={clsx("transition-transform", showText && "rotate-180")} />
            </button>
          </div>
          {showText && (
            <div className="scroll-area mt-3 max-h-56 overflow-y-auto rounded-2xl bg-tile p-4">
              {ocr.lines.length === 0 ? (
                <p className="text-sm text-muted">{t("Không đọc được dòng chữ nào.")}</p>
              ) : (
                <ul className="space-y-1.5 text-[13px]">
                  {ocr.lines.map((line, index) => (
                    <li key={index} className="flex items-baseline justify-between gap-4">
                      <span className="break-words font-medium text-navy">{line.text}</span>
                      <span className="shrink-0 tabular-nums text-muted" title={t("Độ tin cậy của OCR cho dòng này")}>{line.score != null ? line.score.toFixed(2) : "—"}</span>
                    </li>
                  ))}
                </ul>
              )}
              <p className="mt-3 border-t border-line pt-2 text-[12px] text-muted">
                {t("Văn bản gốc từ PaddleOCR; cột số là độ tin cậy nhận dạng từng dòng (0–1).")}
              </p>
            </div>
          )}
        </>
      )}
    </Card>
  );
}

function CandidateRow({ candidate, selected, onSelect, index }: { candidate: MatchCandidate; selected: boolean; onSelect: () => void; index: number }) {
  const t = useT();
  const med = candidate.medicine;
  return (
    <button
      type="button" role="radio" aria-checked={selected} onClick={onSelect}
      className={clsx(
        "flex w-full items-start gap-3.5 rounded-2xl p-4 text-left ring-1 transition duration-150",
        selected ? "bg-primary-soft/60 ring-2 ring-primary" : "bg-surface ring-line hover:bg-tile",
      )}
    >
      <span className={clsx("mt-0.5 inline-flex size-6 shrink-0 items-center justify-center rounded-full ring-2", selected ? "bg-primary text-white ring-primary" : "text-transparent ring-line")}>
        <Check size={14} strokeWidth={3} />
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-[15px] font-semibold text-navy">{med.ten_thuoc}</p>
        <p className="line-clamp-2 text-[13.5px] font-semibold text-primary">{med.ham_luong ?? t("Không ghi hàm lượng")}</p>
        <p className="mt-0.5 truncate text-[12.5px] text-muted">{[med.dang_bao_che, med.so_dang_ky && `${t("SĐK")} ${med.so_dang_ky}`].filter(Boolean).join(" · ") || "—"}</p>
        <p className="truncate text-[12.5px] text-muted">{med.ten_cong_ty_san_xuat ?? "—"}</p>
        <div className="mt-2.5 flex flex-wrap items-center gap-2">
          <MatchLevelChip candidate={candidate} />
          {index === 0 && <span className="text-[12px] font-medium text-muted">{t("phù hợp nhất")}</span>}
        </div>
      </div>
    </button>
  );
}

function SelectedPanel({ candidate, onConfirm, onDetail, onRescan, confirmDisabled }: { candidate: MatchCandidate; onConfirm: () => void; onDetail: () => void; onRescan: () => void; confirmDisabled: boolean }) {
  const t = useT();
  const [why, setWhy] = useState(false);
  const med = candidate.medicine;
  return (
    <>
      <div className="flex items-start gap-5">
        <MedicineAvatar name={med.ten_thuoc} size="xl" />
        <div className="min-w-0 flex-1">
          <h3 className="break-words font-display text-[24px] font-extrabold leading-tight text-navy">{med.ten_thuoc}</h3>
          <p className="mt-1 line-clamp-2 text-sm text-muted">{t("Hoạt chất")}: {med.hoat_chat_chinh ?? t("Không có trong dữ liệu nguồn")}</p>
          <div className="mt-2.5"><MatchLevelChip candidate={candidate} /></div>
        </div>
      </div>
      <div className="mt-5">
        <InfoRows
          rows={[
            { label: t("Hàm lượng"), value: med.ham_luong, hint: med.ham_luong_source && med.ham_luong_source !== "hamLuong" ? t("Trích từ cột hoạt chất/tên thuốc của danh mục") : undefined },
            { label: t("Dạng bào chế"), value: med.dang_bao_che },
            { label: t("Số đăng ký"), value: med.so_dang_ky },
            { label: t("Nhà sản xuất"), value: med.ten_cong_ty_san_xuat },
            { label: t("Quy cách"), value: med.dong_goi },
          ]}
        />
      </div>

      <button type="button" onClick={() => setWhy((v) => !v)} aria-expanded={why} className="mt-3 inline-flex items-center gap-1.5 text-[13px] font-semibold text-primary hover:underline">
        {t("Vì sao có mức độ phù hợp này?")} <ChevronDown size={14} className={clsx("transition-transform", why && "rotate-180")} />
      </button>
      {why && (
        <ul className="mt-2 space-y-2 rounded-2xl bg-tile p-4 text-[13px]">
          {candidate.components.map((component) => {
            const { icon: Icon, className } = STATUS_ICON[component.status];
            return (
              <li key={component.key} className="flex items-start gap-2.5">
                <Icon size={16} className={clsx("mt-0.5 shrink-0", className)} />
                <span><span className="font-semibold text-navy">{component.label}:</span> <span className="text-muted">{component.detail}</span></span>
              </li>
            );
          })}
          <li className="border-t border-line pt-2 text-[12px] text-muted">{t("Điểm tính theo quy tắc so khớp (số đăng ký, tên, hàm lượng, hoạt chất, dạng bào chế). Đây không phải xác suất.")}</li>
        </ul>
      )}

      <p className="mt-4 text-sm leading-relaxed text-muted">
        {t("Ứng dụng không tự xác định chắc chắn danh tính thuốc chỉ từ một ảnh. Hãy xác nhận đúng sản phẩm.")}
      </p>
      <div className="mt-5 flex flex-wrap items-center gap-3">
        <PrimaryButton size="lg" icon={Check} className="min-w-[220px] flex-1" disabled={confirmDisabled} onClick={onConfirm} data-testid="confirm-save">
          {t("Xác nhận và lưu")}
        </PrimaryButton>
        <PrimaryButton size="lg" variant="secondary" icon={Eye} onClick={onDetail}>{t("Thông tin đầy đủ")}</PrimaryButton>
        <PrimaryButton size="lg" variant="secondary" icon={RefreshCw} onClick={onRescan}>{t("Quét lại")}</PrimaryButton>
      </div>
    </>
  );
}

export function ScanResultPage() {
  const t = useT();
  const navigate = useNavigate();
  const { jobId = "" } = useParams();
  const query = useOcrJob(jobId);
  const openSearch = useUiStore((state) => state.openCatalogSearch);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [saving, setSaving] = useState<CabinetModalRequest | null>(null);
  usePageHeader(t("Kết quả nhận diện"), t("Kiểm tra và xác nhận thuốc trước khi lưu"), `${t("Tủ thuốc thông minh")} / ${t("Kết quả nhận diện")}`);

  const job = query.data;
  const match = job?.result?.match;
  const candidates = match?.candidates ?? [];
  const uncertain = match?.status === "uncertain";

  // Chỉ chọn sẵn khi kết quả đủ chắc chắn; khi chưa chắc, người dùng phải tự chọn.
  useEffect(() => {
    if (match?.status === "confident" && candidates.length > 0) setSelectedId(candidates[0].medicine.id);
    else setSelectedId(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job?.id, match?.status]);

  const selected = candidates.find((c) => c.medicine.id === selectedId) ?? null;
  const shown = selected ?? candidates[0] ?? null;
  const rescan = () => navigate("/scan");
  const manual = () => openSearch(match?.evidence.search_hint ?? "", jobId);

  if (query.isError) {
    return (
      <Card padding="lg">
        <ErrorState title={t("Không tìm thấy lần quét này")} description={errorMessage(query.error)} />
        <div className="flex justify-center pb-6"><PrimaryButton icon={RefreshCw} onClick={rescan}>{t("Quét lại")}</PrimaryButton></div>
      </Card>
    );
  }

  const processing = !job || (job.status !== "done" && job.status !== "error");

  return (
    <div className="space-y-6 short:space-y-4">
      <div className="grid grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)] gap-6 short:gap-4">
        <ScannedImage job={job} processing={processing} />

        <Card padding="lg">
          <div className="mb-5 flex items-center justify-between gap-3">
            <h2 className="font-display text-[19px] font-bold text-navy">
              {selected || match?.status === "confident" ? t("Ứng viên phù hợp nhất") : t("Kết quả nhận diện")}
            </h2>
            <StatusIndicator tone="info" size="sm">{t("OCR + Đối chiếu")}</StatusIndicator>
          </div>

          {processing ? (
            <div className="space-y-4" role="status" aria-label={t("Đang nhận diện")}>
              <div className="flex items-center gap-5"><div className="skeleton size-20 !rounded-3xl" /><div className="flex-1 space-y-3"><div className="skeleton h-6 w-3/5" /><div className="skeleton h-4 w-2/5" /></div></div>
              {Array.from({ length: 5 }, (_, i) => <div key={i} className="skeleton h-10" />)}
              <p className="pt-1 text-center text-sm text-muted">{t("Đang nhận diện, giao diện vẫn dùng được bình thường…")}</p>
            </div>
          ) : job.status === "error" ? (
            <>
              <ErrorState title={t("Nhận diện thất bại")} description={job.error ?? undefined} />
              <div className="flex justify-center gap-3">
                <PrimaryButton icon={RefreshCw} onClick={rescan}>{t("Quét lại")}</PrimaryButton>
                <PrimaryButton variant="secondary" icon={Search} onClick={manual}>{t("Tìm thủ công")}</PrimaryButton>
              </div>
            </>
          ) : match?.status === "no_catalog" ? (
            <EmptyState icon={Database} title={t("Chưa có danh mục thuốc")} description={match.message}
              action={<PrimaryButton onClick={() => navigate("/settings")}>{t("Mở Cài đặt")}</PrimaryButton>} />
          ) : !shown ? (
            <EmptyState
              icon={ScanSearch}
              title={match?.status === "no_text" ? t("Không đọc được chữ trên ảnh") : t("Không tìm thấy thuốc phù hợp")}
              description={match?.message}
              action={
                <div className="flex gap-3">
                  <PrimaryButton icon={Search} onClick={manual}>{t("Tìm thủ công")}</PrimaryButton>
                  <PrimaryButton variant="secondary" icon={RefreshCw} onClick={rescan}>{t("Quét lại")}</PrimaryButton>
                </div>
              }
            />
          ) : (
            <>
              {uncertain && (
                <div role="alert" className="mb-5 flex gap-3 rounded-2xl bg-warning-soft px-4 py-3.5 text-warning-ink">
                  <TriangleAlert size={20} className="mt-0.5 shrink-0" />
                  <div className="text-sm">
                    <p className="font-bold">{match?.message}</p>
                    {match?.reasons.map((reason) => <p key={reason} className="mt-0.5">{reason}</p>)}
                  </div>
                </div>
              )}
              <SelectedPanel
                candidate={shown}
                confirmDisabled={selected === null}
                onConfirm={() => selected && setSaving({ catalog: selected.medicine, scanJobId: jobId, expirySuggestion: job.result?.expiry_suggestion ?? null })}
                onDetail={() => navigate(`/medicines/${shown.medicine.id}?scan=${jobId}`)}
                onRescan={rescan}
              />
              {selected === null && <p className="mt-3 text-[13px] font-medium text-warning-ink">{t("Hãy chọn đúng thuốc trong danh sách ứng viên bên dưới để tiếp tục.")}</p>}
            </>
          )}
        </Card>
      </div>

      {!processing && job.status === "done" && candidates.length > 0 && (
        <Card padding="lg">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="font-display text-[19px] font-bold text-navy">{t("Ứng viên")}</h2>
              <p className="mt-0.5 text-[13px] text-muted">{t("Tối đa 3 ứng viên. Thuốc cùng tên nhưng khác hàm lượng là các sản phẩm khác nhau.")}</p>
            </div>
            <div className="flex items-center gap-3">
              <span className="text-[12.5px] text-muted">{t("Không tự động thay thế lựa chọn của bạn")}</span>
              <PrimaryButton variant="secondary" size="sm" icon={Search} onClick={manual}>{t("Không đúng? Tìm thủ công")}</PrimaryButton>
            </div>
          </div>
          <div role="radiogroup" aria-label={t("Chọn thuốc đúng")} className="grid gap-3 xl:grid-cols-3">
            {candidates.map((candidate, index) => (
              <CandidateRow key={candidate.medicine.id} candidate={candidate} index={index} selected={candidate.medicine.id === selectedId} onSelect={() => setSelectedId(candidate.medicine.id)} />
            ))}
          </div>
          {match && (match.evidence.strengths.length > 0 || match.evidence.registration_numbers.length > 0 || match.evidence.dosage_form) && (
            <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-line pt-4 text-[12.5px]">
              <span className="font-semibold text-muted">{t("Đọc được trên ảnh")}:</span>
              {match.evidence.name_guess && <StatusIndicator size="sm">{t("Tên")}: {match.evidence.name_guess}</StatusIndicator>}
              {match.evidence.ingredients.map((ing) => <StatusIndicator key={ing} size="sm">{t("Hoạt chất")}: {ing}</StatusIndicator>)}
              {match.evidence.strengths.map((s) => <StatusIndicator key={s} size="sm">{t("Hàm lượng")}: {s}</StatusIndicator>)}
              {match.evidence.dosage_form && <StatusIndicator size="sm">{t("Dạng")}: {match.evidence.dosage_form}</StatusIndicator>}
              {match.evidence.registration_numbers.filter((r) => r.in_catalog).map((r) => <StatusIndicator key={r.text} size="sm" tone="info">{t("SĐK")}: {r.text}</StatusIndicator>)}
              {job.result?.expiry_suggestion && <StatusIndicator size="sm" tone="warning">{t("Hạn dùng (cần kiểm tra)")}: {job.result.expiry_suggestion.text}</StatusIndicator>}
            </div>
          )}
          {match?.status === "confident" && <div className="mt-4"><Note>{match.message}</Note></div>}
        </Card>
      )}

      <CabinetItemModal request={saving} onClose={() => setSaving(null)} onSaved={(item) => navigate(`/cabinet/${item.id}`)} />
    </div>
  );
}
