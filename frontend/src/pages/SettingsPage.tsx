import { useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import {
  Barcode, BellRing, Camera, Check, ChevronRight, CircleCheck, Cpu, Database, Download, Droplet, FileSpreadsheet, HardDrive, Languages,
  LoaderCircle, MonitorCog, Palette, RefreshCw, ScanBarcode, Search, Server, ShieldCheck, Sparkles, Thermometer, Trash2, TriangleAlert, Unlink, Upload,
  Volume2, Wifi, Zap, type LucideIcon,
} from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { IconButton, PrimaryButton } from "@/components/Button";
import { Card } from "@/components/Card";
import { Segmented, Select, TextInput, Toggle } from "@/components/Form";
import { Note } from "@/components/MedicineBits";
import { ConfirmDialog } from "@/components/Modal";
import { LoadingState } from "@/components/States";
import { IconTile, StatusIndicator } from "@/components/StatusIndicator";
import { useLanguageStore, useT } from "@/i18n";
import { api, connectionInfo, saveBlob } from "@/services/api";
import { formatBytes, formatDateTime, formatNumber } from "@/services/format";
import {
  errorMessage, keys, useAiStatus, useBackups, useBarcodeStatus, useCatalogStatus, useDevice, useHealth, useOcrStatus, useSettings, useUpdateSettings,
} from "@/services/queries";
import { isVietnamese, speak, stopSpeaking, ttsSupported, useVoices } from "@/services/tts";
import { usePageHeader } from "@/stores/page";
import { toast } from "@/stores/toast";
import type { AppSettings, BarcodeImportReport, BarcodeLookup, SettingsPatch } from "@/types/api";

type Draft = SettingsPatch;

function Section({ id, title, hint, action, children }: { id?: string; title: string; hint?: string; action?: ReactNode; children: ReactNode }) {
  return (
    <Card id={id} padding="lg" className="mb-6 break-inside-avoid scroll-mt-6 short:mb-4">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <h2 className="font-display text-[19px] font-bold text-navy">{title}</h2>
          {hint && <p className="mt-0.5 text-[13px] text-muted">{hint}</p>}
        </div>
        {action}
      </div>
      {children}
    </Card>
  );
}

function Row({ icon, label, hint, children }: { icon?: LucideIcon; label: string; hint?: string; children: ReactNode }) {
  const Icon = icon;
  return (
    <div className="flex min-h-[64px] items-center justify-between gap-4 border-b border-line py-3 last:border-b-0">
      <div className="flex min-w-0 items-center gap-3">
        {Icon && <Icon size={20} strokeWidth={1.8} className="shrink-0 text-navy" />}
        <div className="min-w-0">
          <p className="text-[15px] text-navy">{label}</p>
          {hint && <p className="text-[12.5px] text-muted">{hint}</p>}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">{children}</div>
    </div>
  );
}

function NumberInput({ value, onChange, min, max, step = 1, suffix, label }: { value: number; onChange: (value: number) => void; min?: number; max?: number; step?: number; suffix?: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <TextInput
        type="number" aria-label={label} value={Number.isFinite(value) ? value : ""} min={min} max={max} step={step}
        onChange={(event) => onChange(event.target.value === "" ? Number.NaN : Number(event.target.value))}
        className="!h-10 !w-[88px] !px-3 text-right tabular-nums"
      />
      {suffix && <span className="w-6 text-sm text-muted">{suffix}</span>}
    </span>
  );
}

// ---- Danh mục thuốc --------------------------------------------------------------- //
function CatalogSection() {
  const t = useT();
  const client = useQueryClient();
  const language = useLanguageStore((state) => state.language);
  const catalog = useCatalogStatus();
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const data = catalog.data;
  const progress = data?.progress;
  const wasRunning = useRef(false);

  useEffect(() => {
    if (progress?.running) wasRunning.current = true;
    else if (wasRunning.current && progress) {
      wasRunning.current = false;
      void client.invalidateQueries({ queryKey: keys.health });
      if (progress.stage === "failed") toast.error(t("Nhập dữ liệu thất bại"), progress.message);
      else toast.success(t("Đã nhập danh mục thuốc"), progress.message);
    }
  }, [progress, client, t]);

  const start = async (action: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await action();
      await client.invalidateQueries({ queryKey: keys.catalog });
    } catch (error) {
      toast.error(t("Không bắt đầu nhập được"), errorMessage(error));
    } finally {
      setBusy(false);
    }
  };
  // Máy Windows chỉ là máy quản trị: file Excel được TẢI LÊN máy chủ rồi nhập vào PostgreSQL trên Mini PC.
  const choose = () => fileRef.current?.click();
  const last = data?.last_import;
  const source = data?.source_path ?? data?.default_source;

  return (
    <Section title={t("Dữ liệu thuốc")} hint={t("Danh mục tra cứu nhập từ file Excel (DAV_unique.xlsx) vào PostgreSQL trên Mini PC. Tách biệt với thuốc trong tủ.")}
      action={data && (data.count > 0
        ? <StatusIndicator tone="success" icon={CircleCheck} size="sm">{t("{count} thuốc", { count: formatNumber(data.count, language) })}</StatusIndicator>
        : <StatusIndicator tone="warning" icon={TriangleAlert} size="sm">{t("Chưa có dữ liệu")}</StatusIndicator>)}>
      {!data ? <LoadingState rows={2} /> : (
        <>
          <Row icon={FileSpreadsheet} label={t("Nguồn dữ liệu Excel")} hint={source ? `${t("Trên máy chủ")}: ${source}` : t("Chưa chọn file")}>
            <PrimaryButton variant="secondary" size="sm" icon={Upload} loading={busy} disabled={progress?.running} onClick={choose}>{t("Tải file Excel lên…")}</PrimaryButton>
          </Row>
          <Row icon={Database} label={t("Lần nhập gần nhất")}
            hint={last ? `${formatDateTime(last.finished_at ?? last.started_at)} · ${last.file_name}` : t("Chưa nhập lần nào")}>
            {last && <StatusIndicator size="sm" tone={last.status === "success" ? "success" : last.status === "failed" ? "danger" : "neutral"}>
              {last.status === "success" ? t("Thành công") : last.status === "failed" ? t("Thất bại") : last.status === "running" ? t("Đang chạy") : t("Bỏ qua")}
            </StatusIndicator>}
            <PrimaryButton variant="secondary" size="sm" icon={RefreshCw} disabled={!source || progress?.running || busy} onClick={() => void start(() => api.catalogImport(null, true))}>{t("Nhập lại")}</PrimaryButton>
          </Row>
          {last?.status === "success" && (
            <p className="pt-2 text-[12.5px] text-muted">
              {t("{total} dòng: {inserted} mới, {updated} cập nhật, {unchanged} không đổi, {skipped} bỏ qua.", {
                total: formatNumber(last.rows_total, language), inserted: formatNumber(last.inserted, language), updated: formatNumber(last.updated, language),
                unchanged: formatNumber(last.unchanged, language), skipped: formatNumber(last.skipped, language),
              })}
            </p>
          )}
          {last?.status === "failed" && <p className="pt-2 text-[12.5px] text-danger">{last.message}</p>}
          {progress?.running && (
            <div className="mt-3 rounded-2xl bg-primary-soft p-4" role="status">
              <div className="mb-2 flex items-center justify-between text-[13px] font-semibold text-primary">
                <span className="flex items-center gap-2"><LoaderCircle size={15} className="animate-spin" />
                  {progress.stage === "indexing" ? t("Đang tạo chỉ mục tìm kiếm") : progress.stage === "hashing" ? t("Đang kiểm tra file nguồn") : t("Đang đọc và chuẩn hóa dữ liệu")}
                </span>
                <span className="tabular-nums">{formatNumber(progress.rows_read, language)}{progress.rows_total ? ` / ${formatNumber(progress.rows_total, language)}` : ""}</span>
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-primary/15"><div className="h-full rounded-full bg-primary transition-all duration-500" style={{ width: `${progress.percent ?? 6}%` }} /></div>
            </div>
          )}
          <input ref={fileRef} type="file" accept=".xlsx,.xlsm" className="hidden"
            onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; if (file) void start(() => api.catalogUpload(file)); }} />
        </>
      )}
    </Section>
  );
}

// ---- Mã vạch ------------------------------------------------------------------------ //
const ISSUE_LABEL: Record<BarcodeImportReport["issues"][number]["reason"], string> = {
  ambiguous: "Nhiều thuốc khớp", unmatched: "Không có trong danh mục", invalid: "Mã không hợp lệ", internal: "Mã nội bộ", conflict: "Xung đột",
};
const COLUMN_LABEL: Record<string, string> = {
  barcode: "Mã vạch", registration: "Số đăng ký", name: "Tên thuốc", strength: "Hàm lượng", unit: "Đơn vị", manufacturer: "Hãng sản xuất",
};

function Stat({ label, value, tone }: { label: string; value: string; tone?: "success" | "warning" | "danger" }) {
  return (
    <div className="rounded-2xl bg-tile px-4 py-3">
      <p className="text-[12px] text-muted">{label}</p>
      <p className={clsx("font-display text-[20px] font-bold tabular-nums", tone === "success" ? "text-success" : tone === "warning" ? "text-warning-ink" : tone === "danger" ? "text-danger" : "text-navy")}>{value}</p>
    </div>
  );
}

function BarcodeSection() {
  const t = useT();
  const client = useQueryClient();
  const language = useLanguageStore((state) => state.language);
  const status = useBarcodeStatus();
  const fileRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [report, setReport] = useState<BarcodeImportReport | null>(null);
  const [busy, setBusy] = useState<"check" | "import" | null>(null);
  const [code, setCode] = useState("");
  const [lookup, setLookup] = useState<BarcodeLookup | null>(null);
  const [looking, setLooking] = useState(false);
  const [unlinking, setUnlinking] = useState(false);
  const [confirmUnlink, setConfirmUnlink] = useState(false);
  const n = (value: number) => formatNumber(value, language);
  const data = status.data;

  // Bước 1: máy chủ CHỈ KIỂM TRA file (không ghi gì) và trả báo cáo khớp với danh mục.
  const check = async (picked: File) => {
    setFile(picked);
    setReport(null);
    setBusy("check");
    try {
      setReport(await api.barcodeImport(picked, true));
    } catch (error) {
      toast.error(t("Không đọc được file mã vạch"), errorMessage(error));
      setFile(null);
    } finally {
      setBusy(null);
    }
  };
  // Bước 2: quản trị viên xem báo cáo rồi mới nhập thật.
  const commit = async () => {
    if (!file) return;
    setBusy("import");
    try {
      const done = await api.barcodeImport(file, false);
      toast.success(t("Đã gắn mã vạch"), t("{linked} mã mới, {unchanged} mã đã có.", { linked: n(done.linked), unchanged: n(done.unchanged) }));
      setReport(null);
      setFile(null);
      await client.invalidateQueries({ queryKey: keys.barcodes });
    } catch (error) {
      toast.error(t("Nhập mã vạch thất bại"), errorMessage(error));
    } finally {
      setBusy(null);
    }
  };
  const find = async () => {
    if (!code.trim()) return;
    setLooking(true);
    try {
      setLookup(await api.barcodeLookup(code.trim()));
    } catch (error) {
      toast.error(t("Không tra được mã vạch"), errorMessage(error));
    } finally {
      setLooking(false);
    }
  };
  const unlink = async () => {
    if (!lookup?.gtin) return;
    setUnlinking(true);
    try {
      await api.barcodeDelete(lookup.gtin);
      toast.success(t("Đã gỡ liên kết mã vạch"), lookup.code);
      setLookup(null);
      setConfirmUnlink(false);
      await client.invalidateQueries({ queryKey: keys.barcodes });
    } catch (error) {
      toast.error(t("Không gỡ được liên kết"), errorMessage(error));
    } finally {
      setUnlinking(false);
    }
  };

  const last = data?.last_import;
  const review = report ? report.ambiguous + report.unmatched : 0;
  return (
    <Section title={t("Mã vạch thuốc")}
      hint={t("Gắn mã vạch (EAN/GTIN) vào thuốc CÓ SẴN trong danh mục từ file Excel/CSV của nhà thuốc: cột Mã vạch + Số đăng ký (hoặc Tên thuốc). Không tạo thuốc mới; dòng nào không chắc chắn sẽ được liệt kê để xem lại.")}
      action={data && (data.barcodes > 0
        ? <StatusIndicator tone="success" icon={CircleCheck} size="sm">{t("{count} mã · {medicines} thuốc", { count: n(data.barcodes), medicines: n(data.medicines_with_barcode) })}</StatusIndicator>
        : <StatusIndicator tone="neutral" icon={Barcode} size="sm">{t("Chưa có mã vạch")}</StatusIndicator>)}>
      {!data ? <LoadingState rows={2} /> : (
        <>
          <Row icon={FileSpreadsheet} label={t("Nhập file mã vạch")} hint={t("Excel .xlsx hoặc .csv — kiểm tra trước, chưa ghi gì cho tới khi bấm Nhập")}>
            <PrimaryButton variant="secondary" size="sm" icon={Upload} loading={busy === "check"} disabled={busy !== null} onClick={() => fileRef.current?.click()}>
              {t("Chọn file…")}
            </PrimaryButton>
          </Row>
          {report && (
            <div className="mt-3 rounded-2xl border border-line p-4" data-testid="barcode-report">
              <p className="text-[14px] font-semibold text-navy">{report.file_name}{report.sheet ? ` · ${report.sheet}` : ""}</p>
              <p className="mt-0.5 text-[12.5px] text-muted">
                {t("Cột đã nhận")}: {Object.entries(report.columns).map(([role, name]) => `${t(COLUMN_LABEL[role] ?? role)} = “${name}”`).join(" · ")}
              </p>
              <div className="mt-3 grid grid-cols-2 gap-2 md:grid-cols-4">
                <Stat label={t("Dòng khớp danh mục")} value={`${n(report.matched_rows)} / ${n(report.rows_with_barcode)}`} tone="success" />
                <Stat label={t("Theo số đăng ký / theo tên")} value={`${n(report.by_registration)} / ${n(report.by_name)}`} />
                <Stat label={t("Mã sẽ gắn mới")} value={n(report.linked)} tone="success" />
                <Stat label={t("Mã đã có sẵn")} value={n(report.unchanged)} />
                <Stat label={t("Cần xem lại")} value={n(review)} tone={review ? "warning" : undefined} />
                <Stat label={t("Mã lỗi / nội bộ")} value={`${n(report.invalid)} / ${n(report.internal)}`} tone={report.invalid ? "warning" : undefined} />
                <Stat label={t("Xung đột")} value={n(report.conflicts)} tone={report.conflicts ? "danger" : undefined} />
                <Stat label={t("Thuốc trong danh mục")} value={n(report.catalog_total)} />
              </div>
              {report.issues.length > 0 && (
                <div className="mt-3 max-h-64 overflow-auto rounded-xl ring-1 ring-line">
                  <table className="w-full text-left text-[12.5px]">
                    <thead className="sticky top-0 bg-tile text-muted">
                      <tr><th className="px-3 py-2">{t("Dòng")}</th><th className="px-3 py-2">{t("Mã vạch")}</th><th className="px-3 py-2">{t("Thuốc trong file")}</th><th className="px-3 py-2">{t("Vấn đề")}</th></tr>
                    </thead>
                    <tbody>
                      {report.issues.slice(0, 100).map((issue, i) => (
                        <tr key={`${issue.row}-${i}`} className="border-t border-line align-top">
                          <td className="px-3 py-2 tabular-nums text-muted">{issue.row}</td>
                          <td className="px-3 py-2 font-mono">{issue.barcode}</td>
                          <td className="px-3 py-2 text-navy">{issue.name ?? "—"}{issue.registration ? <span className="text-muted"> · {issue.registration}</span> : null}</td>
                          <td className="px-3 py-2"><span className="font-semibold text-navy">{t(ISSUE_LABEL[issue.reason])}</span> — <span className="text-muted">{issue.message}</span></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {report.issues.length > 100 && <p className="mt-1 text-[12px] text-muted">{t("Hiển thị 100 vấn đề đầu tiên.")}</p>}
              <div className="mt-3 flex flex-wrap justify-end gap-2">
                <PrimaryButton variant="ghost" size="sm" disabled={busy !== null} onClick={() => { setReport(null); setFile(null); }}>{t("Hủy")}</PrimaryButton>
                <PrimaryButton variant="soft" size="sm" icon={Barcode} loading={busy === "import"} disabled={busy !== null || report.linked === 0} onClick={() => void commit()}>
                  {t("Nhập {count} mã vạch", { count: n(report.linked) })}
                </PrimaryButton>
              </div>
            </div>
          )}
          <Row icon={ScanBarcode} label={t("Tra một mã vạch")} hint={t("Gõ hoặc quét bằng đầu đọc mã vạch USB")}>
            <form className="flex items-center gap-2" onSubmit={(event) => { event.preventDefault(); void find(); }}>
              <TextInput aria-label={t("Mã vạch cần tra")} value={code} onChange={(event) => setCode(event.target.value)} placeholder="893…" className="!h-10 !w-[190px] font-mono" />
              <PrimaryButton type="submit" variant="secondary" size="sm" loading={looking} disabled={!code.trim()}>{t("Tra")}</PrimaryButton>
            </form>
          </Row>
          {lookup && (
            <div className="mt-2" data-testid="barcode-lookup">
              {lookup.medicine ? (
                <div className="flex items-start justify-between gap-3 rounded-2xl bg-tile px-4 py-3">
                  <div className="min-w-0">
                    <p className="text-[14px] font-semibold text-navy">{lookup.medicine.ten_thuoc}</p>
                    <p className="text-[12.5px] text-muted">
                      {lookup.code} · {t("SĐK")} {lookup.medicine.so_dang_ky ?? "—"} · {lookup.link?.match_method === "name" ? t("ghép theo tên + hàm lượng") : t("ghép theo số đăng ký")}
                    </p>
                  </div>
                  <PrimaryButton variant="danger" size="sm" icon={Unlink} onClick={() => setConfirmUnlink(true)}>{t("Gỡ liên kết")}</PrimaryButton>
                </div>
              ) : <Note tone={lookup.status === "not_found" ? "info" : "warning"}>{lookup.message}</Note>}
            </div>
          )}
          <Row icon={Database} label={t("Lần nhập gần nhất")}
            hint={last ? `${formatDateTime(last.created_at)} · ${last.file_name} · ${t("{linked} mã mới, {conflicts} xung đột, {unmatched} cần xem lại", { linked: n(last.linked), conflicts: n(last.conflicts), unmatched: n(last.unmatched) })}` : t("Chưa nhập lần nào")}>
            <span />
          </Row>
          <input ref={fileRef} type="file" accept=".xlsx,.xlsm,.csv" className="hidden" data-testid="barcode-file"
            onChange={(event) => { const picked = event.target.files?.[0]; event.target.value = ""; if (picked) void check(picked); }} />
          <ConfirmDialog
            open={confirmUnlink} danger title={t("Gỡ liên kết mã vạch?")} confirmLabel={t("Gỡ liên kết")} loading={unlinking}
            description={t("Mã {code} sẽ không còn trỏ tới “{name}”. Thuốc trong danh mục giữ nguyên.", { code: lookup?.code ?? "", name: lookup?.medicine?.ten_thuoc ?? "" })}
            onClose={() => setConfirmUnlink(false)} onConfirm={() => void unlink()}
          />
        </>
      )}
    </Section>
  );
}

// ---- AI tra cứu ------------------------------------------------------------------------ //
function AiSection() {
  const t = useT();
  const status = useAiStatus();
  const data = status.data;
  return (
    <Section title={t("AI tra cứu thuốc (Gemini)")}
      hint={t("Khi mã vạch/QR chưa có trong dữ liệu hoặc người dùng xác nhận không có thuốc đúng, máy chủ hỏi Google Gemini (có Google Search). Khóa API chỉ nằm trong server.env trên Mini PC (SMC_GEMINI_API_KEY), không lưu trong ứng dụng.")}
      action={data && (data.configured
        ? <StatusIndicator tone="success" icon={CircleCheck} size="sm">{t("Đã cấu hình")}</StatusIndicator>
        : <StatusIndicator tone="warning" icon={TriangleAlert} size="sm">{t("Chưa cấu hình")}</StatusIndicator>)}>
      {!data ? <LoadingState rows={2} /> : (
        <>
          <Row icon={Sparkles} label={t("Tìm kiếm trên mạng (Google Search)")}
            hint={data.search_available ? t("Sẵn sàng") : t("Chưa khả dụng: khóa API hết hạn mức tìm kiếm — bật thanh toán cho khóa trong Google AI Studio. Trong lúc đó AI vẫn đọc được ảnh quét và mã QR.")}>
            <StatusIndicator tone={data.search_available ? "success" : "warning"} size="sm">{data.search_available ? t("Sẵn sàng") : t("Chưa khả dụng")}</StatusIndicator>
          </Row>
          <Row icon={Search} label={t("Tra mã vạch trên mạng không dùng AI (Tavily)")}
            hint={data.web_search?.configured ? (data.web_search.last_error ?? t("Dùng khi AI không tra được mạng: tìm trang có đúng mã vạch rồi đối chiếu số đăng ký với danh mục")) : t("Chưa cấu hình: thêm SMC_TAVILY_API_KEY vào server.env (đăng ký miễn phí 1.000 lượt/tháng tại tavily.com)")}>
            <StatusIndicator tone={data.web_search?.configured ? "success" : "neutral"} size="sm">{data.web_search?.configured ? t("Sẵn sàng") : t("Chưa cấu hình")}</StatusIndicator>
          </Row>
          <Row icon={Cpu} label={t("Mô hình (theo thứ tự ưu tiên)")} hint={t("Mô hình đầu quá tải thì tự chuyển sang mô hình sau")}>
            <span className="max-w-[340px] truncate text-[13px] font-semibold text-navy">{data.models.join(" → ")}</span>
          </Row>
          {data.last_error && <p className="pt-2 text-[12.5px] text-warning-ink">{data.last_error}</p>}
        </>
      )}
    </Section>
  );
}

// ---- Sao lưu ------------------------------------------------------------------------ //
function BackupSection() {
  const t = useT();
  const client = useQueryClient();
  const backups = useBackups();
  const [busy, setBusy] = useState<string | null>(null);

  const run = async (label: string, action: () => Promise<unknown>, success: string) => {
    setBusy(label);
    try {
      await action();
      toast.success(success);
      await client.invalidateQueries({ queryKey: keys.backups });
    } catch (error) {
      toast.error(t("Không thực hiện được"), errorMessage(error));
    } finally {
      setBusy(null);
    }
  };
  const data = backups.data;
  const items = data?.items ?? [];
  const last = data?.last_automatic;

  return (
    <Section title={t("Sao lưu cơ sở dữ liệu")}
      hint={t("Sao lưu toàn bộ PostgreSQL trên Mini PC bằng pg_dump: danh mục, tủ thuốc, tài khoản, lịch sử quét, thiết bị. Máy chủ tự sao lưu mỗi ngày lúc 02:00.")}
      action={last && (last.ok === false
        ? <StatusIndicator tone="danger" icon={TriangleAlert} size="sm">{t("Lần tự động gần nhất lỗi")}</StatusIndicator>
        : <StatusIndicator tone="success" icon={CircleCheck} size="sm">{t("Tự động: OK")}</StatusIndicator>)}>
      <div className="flex flex-wrap items-center gap-2.5">
        <PrimaryButton icon={HardDrive} loading={busy === "create"} onClick={() => void run("create", () => api.backupCreate(), t("Đã tạo bản sao lưu"))}>{t("Sao lưu ngay")}</PrimaryButton>
      </div>
      {last?.ok === false && last.error && <p className="pt-3 text-[12.5px] text-danger">{last.error}</p>}
      {backups.isLoading ? <div className="pt-4"><LoadingState rows={2} /></div> : items.length === 0 ? (
        <p className="pt-4 text-[13px] text-muted">{t("Chưa có bản sao lưu nào.")}</p>
      ) : (
        <ul className="mt-3 divide-y divide-line">
          {items.slice(0, 8).map((item) => (
            <li key={item.name} className="flex items-center gap-3 py-2.5">
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13.5px] font-semibold text-navy">{item.name}</p>
                <p className="text-[12px] text-muted">{formatDateTime(item.created_at)} · {formatBytes(item.size)} · {item.automatic ? t("Tự động") : t("Thủ công")}</p>
              </div>
              <IconButton icon={Download} label={t("Tải về")} size="sm" variant="ghost" onClick={() => void api.backupDownload(item.name).then((f) => saveBlob(f.blob, item.name)).catch((e) => toast.error(t("Không tải được file"), errorMessage(e)))} />
              <IconButton icon={Trash2} label={t("Xóa")} size="sm" variant="danger" disabled={busy !== null} onClick={() => void run("delete", () => api.backupDelete(item.name), t("Đã xóa bản sao lưu"))} />
            </li>
          ))}
        </ul>
      )}
      {data && (
        <div className="mt-3 space-y-1 break-all text-[12px] text-muted">
          <p>{t("Thư mục sao lưu trên Mini PC")}: {data.directory}{data.copy_directory ? ` · ${t("bản sao thứ hai")}: ${data.copy_directory}` : ""}</p>
          <p>{t("Giữ {count} bản tự động gần nhất.", { count: data.keep_automatic })}</p>
        </div>
      )}
      <div className="mt-4">
        <Note tone="warning">
          {t("Khôi phục ghi đè toàn bộ dữ liệu nên chỉ thực hiện trực tiếp trên Mini PC (không làm từ xa):")}{" "}
          <span className="break-all font-mono text-[12px]">{data?.restore_hint ?? "python -m app.cli backup restore <file>.dump"}</span>
        </Note>
      </div>
    </Section>
  );
}

// ---- Trang ---------------------------------------------------------------------------- //
export function SettingsPage() {
  const t = useT();
  const location = useLocation();
  const navigate = useNavigate();
  usePageHeader(t("Cài đặt"), t("Tùy chỉnh thiết bị và ứng dụng"), `${t("Tủ thuốc thông minh")} / ${t("Cài đặt")}`);
  const query = useSettings();
  const save = useUpdateSettings();
  const device = useDevice().data;
  const health = useHealth().data;
  const ocr = useOcrStatus();
  const voices = useVoices();
  const [draft, setDraft] = useState<Draft>({});
  const [cameras, setCameras] = useState<MediaDeviceInfo[]>([]);
  const [speaking, setSpeaking] = useState(false);
  const stored = query.data?.settings;

  useEffect(() => {
    if (!location.hash) return;
    const timer = window.setTimeout(() => document.getElementById(location.hash.slice(1))?.scrollIntoView({ behavior: "smooth", block: "start" }), 250);
    return () => window.clearTimeout(timer);
  }, [location.hash, query.isSuccess]);

  useEffect(() => {
    navigator.mediaDevices?.enumerateDevices?.().then((list) => setCameras(list.filter((d) => d.kind === "videoinput"))).catch(() => setCameras([]));
    return () => stopSpeaking();
  }, []);

  if (!stored) return <Card padding="lg"><LoadingState rows={6} /></Card>;

  const value = <K extends keyof AppSettings>(key: K): AppSettings[K] => (key in draft ? (draft as unknown as AppSettings)[key] : stored[key]);
  const set = <K extends keyof Draft>(key: K, next: Draft[K]) =>
    setDraft((prev) => {
      const copy = { ...prev, [key]: next };
      if ((stored as unknown as Record<string, unknown>)[key as string] === next) delete (copy as Record<string, unknown>)[key as string];
      return copy;
    });
  const dirtyKeys = Object.keys(draft).length;

  const numbersValid = (["temp_min", "temp_max", "humidity_min", "humidity_max", "expiry_warning_days", "low_stock_threshold", "ocr_det_limit_side_len", "ocr_cpu_threads"] as const)
    .every((key) => Number.isFinite(value(key)));
  const rangeError = value("temp_min") >= value("temp_max") ? t("Nhiệt độ tối thiểu phải nhỏ hơn tối đa.")
    : value("humidity_min") >= value("humidity_max") ? t("Độ ẩm tối thiểu phải nhỏ hơn tối đa.") : null;

  const submit = () => {
    if (!numbersValid) return toast.error(t("Có ô số đang để trống"), t("Hãy nhập đủ giá trị trước khi lưu."));
    if (rangeError) return toast.error(t("Ngưỡng không hợp lệ"), rangeError);
    save.mutate({ ...draft }, { onSuccess: () => setDraft({}) });
  };

  const viVoices = voices.filter(isVietnamese);
  const deps = query.data?.options.ocr_dependencies;
  const ocrData = ocr.data;
  const activeProfile = query.data?.options.ocr_profiles.find((profile) => profile.value === stored.ocr_profile);
  const esp32Chip = device?.state === "connected" ? <StatusIndicator tone="success" size="sm">{t("Đã kết nối")}</StatusIndicator>
    : device?.state === "connecting" ? <StatusIndicator tone="info" size="sm">{t("Đang kết nối")}</StatusIndicator>
    : device?.enabled ? <StatusIndicator tone="warning" size="sm">{t(device.environment.label)}</StatusIndicator>
    : <StatusIndicator tone="neutral" size="sm">{t("Chưa có thiết bị")}</StatusIndicator>;
  const primaryName = typeof device?.device?.name === "string" ? device.device.name : null;

  return (
    <div className="pb-20">
      <div className="columns-2 gap-6 max-xl:columns-1 short:gap-4">
        <Section id="thresholds" title={t("Ngưỡng môi trường")}>
          <div className="flex items-center justify-between gap-4 border-b border-line py-3.5">
            <div className="flex items-center gap-3.5">
              <IconTile icon={Thermometer} tone="info" size="lg" />
              <div><p className="font-display text-[16px] font-bold text-navy">{t("Nhiệt độ")}</p><p className="text-[13px] text-muted">{t("Ngưỡng đặt")}</p></div>
            </div>
            <div className="flex items-center gap-2">
              <NumberInput label={t("Nhiệt độ tối thiểu")} value={value("temp_min")} min={-20} max={60} step={0.5} onChange={(v) => set("temp_min", v)} />
              <span className="text-muted">–</span>
              <NumberInput label={t("Nhiệt độ tối đa")} value={value("temp_max")} min={-20} max={60} step={0.5} suffix="°C" onChange={(v) => set("temp_max", v)} />
            </div>
          </div>
          <div className="flex items-center justify-between gap-4 border-b border-line py-3.5">
            <div className="flex items-center gap-3.5">
              <IconTile icon={Droplet} tone="info" size="lg" />
              <div><p className="font-display text-[16px] font-bold text-navy">{t("Độ ẩm")}</p><p className="text-[13px] text-muted">{t("Ngưỡng đặt")}</p></div>
            </div>
            <div className="flex items-center gap-2">
              <NumberInput label={t("Độ ẩm tối thiểu")} value={value("humidity_min")} min={0} max={100} onChange={(v) => set("humidity_min", v)} />
              <span className="text-muted">–</span>
              <NumberInput label={t("Độ ẩm tối đa")} value={value("humidity_max")} min={0} max={100} suffix="%" onChange={(v) => set("humidity_max", v)} />
            </div>
          </div>
          {rangeError && <p role="alert" className="pt-3 text-[13px] font-medium text-danger">{rangeError}</p>}
          <div className="mt-4"><Note>{t("Giá trị mặc định chỉ là điểm khởi đầu. Hãy đặt ngưỡng theo điều kiện bảo quản in trên bao bì của các thuốc bạn đang giữ.")}</Note></div>
        </Section>

        <Section title={t("Ngưỡng thuốc")}>
          <Row label={t("Cảnh báo trước khi hết hạn")} hint={t("Thuốc còn ít hơn số ngày này được xếp vào “Sắp hết hạn”.")}>
            <NumberInput label={t("Số ngày cảnh báo trước hạn")} value={value("expiry_warning_days")} min={1} max={365} suffix={t("ngày")} onChange={(v) => set("expiry_warning_days", v)} />
          </Row>
          <Row label={t("Ngưỡng số lượng thấp")} hint={t("Cảnh báo khi số lượng còn lại nhỏ hơn hoặc bằng giá trị này.")}>
            <NumberInput label={t("Ngưỡng số lượng thấp")} value={value("low_stock_threshold")} min={0} onChange={(v) => set("low_stock_threshold", v)} />
          </Row>
        </Section>

        <Section id="esp32" title={t("Kết nối thiết bị")} hint={t("ESP32 tự kết nối ra Internet tới máy chủ (WSS qua Tailscale Funnel hoặc Cloudflare Tunnel) — không cần chung Wi-Fi với máy này. Giao thức: docs/ESP32_PROTOCOL.md.")} action={esp32Chip}>
          <Row icon={Wifi} label={primaryName ?? t("Tủ chính")} hint={device?.last_error ?? (device?.last_update ? `${t("Số đo gần nhất")}: ${formatDateTime(device.last_update)}` : undefined)}>
            <PrimaryButton variant="secondary" size="sm" iconRight={ChevronRight} onClick={() => navigate("/admin/devices")}>{t("Quản lý thiết bị")}</PrimaryButton>
          </Row>
          <div className="mt-4"><Note>{t("Thêm thiết bị, lấy token, gửi lệnh (còi, đọc cảm biến…) và theo dõi phản hồi ACK ở Quản trị → Thiết bị. Đổi ngưỡng môi trường ở trên sẽ tự gửi xuống mọi ESP32 hỗ trợ để còi vẫn cảnh báo khi mất Internet.")}</Note></div>
        </Section>

        <CatalogSection />
        <BarcodeSection />
        <AiSection />

        <Section title={t("Camera")}>
          <Row icon={Camera} label={t("Camera mặc định")} hint={cameras.length === 0 ? t("Không tìm thấy camera nào") : cameras.some((c) => c.label) ? undefined : t("Tên camera hiện sau khi cấp quyền ở trang Quét thuốc.")}>
            <Select value={value("camera_device_id") ?? ""} className="!h-10 !w-[260px]" aria-label={t("Camera mặc định")}
              onChange={(event) => set("camera_device_id", event.target.value || null)}>
              <option value="">{t("Theo mặc định của hệ thống")}</option>
              {cameras.map((camera, index) => <option key={camera.deviceId || index} value={camera.deviceId}>{camera.label || `Camera ${index + 1}`}</option>)}
            </Select>
          </Row>
        </Section>

        <Section title={t("Cấu hình OCR")} hint={t("PaddleOCR chạy trên máy chủ Mini PC cho mọi lượt quét (ứng dụng Windows và điện thoại). Engine PaddlePaddle dùng GPU NVIDIA nếu có, không có thì chạy CPU; ONNX Runtime luôn chạy CPU.")}
          action={ocrData && (ocrData.state === "ready" ? <StatusIndicator tone="success" size="sm" icon={CircleCheck}>{t("Sẵn sàng")}</StatusIndicator>
            : ocrData.state === "loading" ? <StatusIndicator tone="info" size="sm" icon={LoaderCircle}>{t("Đang nạp")}</StatusIndicator>
            : ocrData.state === "error" ? <StatusIndicator tone="danger" size="sm" icon={TriangleAlert}>{t("Lỗi")}</StatusIndicator>
            : <StatusIndicator tone="neutral" size="sm">{t("Chưa nạp")}</StatusIndicator>)}>
          <Row icon={Cpu} label={t("Engine suy luận")} hint={value("ocr_engine") === "paddle" && deps && !deps.paddle ? t("Chưa cài PaddlePaddle trên máy chủ.") : undefined}>
            <Select value={value("ocr_engine")} className="!h-10 !w-[330px] max-w-full" aria-label={t("Engine suy luận")} onChange={(event) => set("ocr_engine", event.target.value as AppSettings["ocr_engine"])}>
              <option value="onnxruntime">ONNX Runtime ({t("khuyến nghị cho CPU")})</option>
              <option value="paddle">PaddlePaddle{deps?.paddle_gpu ? " (GPU)" : ""}{deps && !deps.paddle ? ` (${t("chưa cài")})` : ""}</option>
            </Select>
          </Row>
          <Row icon={Zap} label={t("Thiết bị chạy")}
            hint={value("ocr_engine") !== "paddle" ? t("ONNX Runtime luôn chạy trên CPU.") : deps && deps.paddle && !deps.paddle_gpu ? t("PaddlePaddle trên máy chủ là bản CPU.") : undefined}>
            <Select value={value("ocr_engine") === "paddle" ? value("ocr_device") : "cpu"} className="!h-10 !w-[330px] max-w-full" aria-label={t("Thiết bị chạy")}
              disabled={value("ocr_engine") !== "paddle"} onChange={(event) => set("ocr_device", event.target.value as AppSettings["ocr_device"])}>
              <option value="auto">{t("Tự động (GPU nếu có)")}</option>
              <option value="gpu">GPU (NVIDIA CUDA)</option>
              <option value="cpu">CPU</option>
            </Select>
          </Row>
          <Row icon={MonitorCog} label={t("Bộ mô hình")}>
            <Select value={value("ocr_profile")} className="!h-10 !w-[330px] max-w-full" aria-label={t("Bộ mô hình")} onChange={(event) => set("ocr_profile", event.target.value as AppSettings["ocr_profile"])}>
              {query.data?.options.ocr_profiles.map((profile) => <option key={profile.value} value={profile.value}>{profile.label}</option>)}
            </Select>
          </Row>
          <Row label={t("Cạnh dài tối đa khi phát hiện chữ")} hint={t("Lớn hơn đọc được chữ nhỏ nhưng chậm hơn.")}>
            <NumberInput label={t("Cạnh dài tối đa")} value={value("ocr_det_limit_side_len")} min={320} max={2560} step={32} suffix="px" onChange={(v) => set("ocr_det_limit_side_len", v)} />
          </Row>
          <Row label={t("Số luồng CPU")} hint={t("0 = tự chọn theo số nhân của máy.")}>
            <NumberInput label={t("Số luồng CPU")} value={value("ocr_cpu_threads")} min={0} max={64} onChange={(v) => set("ocr_cpu_threads", v)} />
          </Row>
          <Row label={t("Tự thử tiền xử lý khi ảnh khó đọc")} hint={t("Tăng tương phản, xoay, nắn nghiêng — chỉ dùng khi cho kết quả tốt hơn ảnh gốc.")}>
            <Toggle checked={value("ocr_auto_enhance")} onChange={(v) => set("ocr_auto_enhance", v)} label={t("Tự thử tiền xử lý")} />
          </Row>
          <Row label={t("Phân loại hướng dòng chữ")} hint={t("Cần thêm mô hình PP-LCNet; bật nếu hay quét chữ lộn ngược.")}>
            <Toggle checked={value("ocr_use_textline_orientation")} onChange={(v) => set("ocr_use_textline_orientation", v)} label={t("Phân loại hướng dòng chữ")} />
          </Row>
          <Row label={t("Lưu ảnh quét khi xác nhận")} hint={t("Tắt: ảnh chỉ giữ tạm và tự xóa. Bật: lưu một ảnh kèm thuốc trong tủ.")}>
            <Toggle checked={value("ocr_save_scan_images")} onChange={(v) => set("ocr_save_scan_images", v)} label={t("Lưu ảnh quét")} />
          </Row>
          {ocrData && (
            <div className="mt-3 rounded-2xl bg-tile p-4 text-[12.5px] text-muted">
              <p>
                <span className="font-semibold text-navy">PaddleOCR</span> {ocrData.engine.version ?? (ocrData.dependencies.paddleocr ? "" : `(${t("chưa cài")})`)} ·{" "}
                {ocrData.engine.detection_model ?? activeProfile?.detection ?? "—"} + {ocrData.engine.recognition_model ?? activeProfile?.recognition ?? "—"}
              </p>
              {ocrData.engine.device && (
                <p className="mt-1">
                  {t("Đang chạy trên")}:{" "}
                  <span className="font-semibold text-navy">{ocrData.engine.device === "cpu" ? "CPU" : `GPU${ocrData.engine.gpu_name ? ` · ${ocrData.engine.gpu_name}` : ""}`}</span>
                </p>
              )}
              {ocrData.engine.device_note && <p className="mt-1 text-warning-ink">{ocrData.engine.device_note}</p>}
              {ocrData.engine.models_available_offline === false && <p className="mt-1 text-warning-ink">{t("Mô hình chưa có trên máy chủ: lần nạp đầu cần Internet, hoặc chạy scripts/download_ocr_models.py trên Mini PC.")}</p>}
              {ocrData.error && <p className="mt-1 break-words text-danger">{ocrData.error}</p>}
              <PrimaryButton variant="soft" size="sm" className="mt-3" icon={RefreshCw} disabled={ocrData.state === "loading" || dirtyKeys > 0}
                onClick={() => void api.ocrWarmup().then(() => ocr.refetch()).catch((e) => toast.error(t("Không nạp được OCR"), errorMessage(e)))}>
                {t("Nạp mô hình ngay")}
              </PrimaryButton>
            </div>
          )}
        </Section>

        <Section title={t("Thông báo")}>
          <Row label={t("Cảnh báo vượt ngưỡng")}><Toggle checked={value("notify_environment")} onChange={(v) => set("notify_environment", v)} label={t("Cảnh báo vượt ngưỡng")} /></Row>
          <Row label={t("Nhắc uống thuốc")}><Toggle checked={value("notify_reminders")} onChange={(v) => set("notify_reminders", v)} label={t("Nhắc uống thuốc")} /></Row>
          <Row label={t("Thông báo trên Windows")}><Toggle checked={value("notify_windows")} onChange={(v) => set("notify_windows", v)} label={t("Thông báo trên Windows")} /></Row>
          <Row icon={BellRing} label={t("Âm thanh thông báo")}><Toggle checked={value("sound_enabled")} onChange={(v) => set("sound_enabled", v)} label={t("Âm thanh thông báo")} /></Row>
          <Row label={t("Chạy nền ở khay hệ thống")} hint={t("Đóng cửa sổ vẫn nhắc uống thuốc. Thoát hẳn từ biểu tượng ở khay.")}>
            <Toggle checked={value("minimize_to_tray")} onChange={(v) => set("minimize_to_tray", v)} label={t("Chạy nền ở khay hệ thống")} disabled={!window.smc} />
          </Row>
        </Section>

        <Section id="tts" title={t("Giọng đọc")} hint={t("Đọc thông tin thuốc bằng giọng đã cài trên máy (hoạt động offline).")}>
          <Row icon={Volume2} label={t("Bật đọc thông tin thuốc")}><Toggle checked={value("tts_enabled")} onChange={(v) => set("tts_enabled", v)} label={t("Bật đọc thông tin thuốc")} /></Row>
          <Row label={t("Giọng đọc")} hint={!ttsSupported() ? t("Thiết bị không hỗ trợ đọc văn bản") : t("{count} giọng tiếng Việt", { count: viVoices.length })}>
            <Select value={value("tts_voice") ?? ""} className="!h-10 !w-[280px]" aria-label={t("Giọng đọc")} disabled={voices.length === 0} onChange={(event) => set("tts_voice", event.target.value || null)}>
              <option value="">{t("Tự chọn giọng tiếng Việt")}</option>
              {[...viVoices, ...voices.filter((v) => !isVietnamese(v))].map((voice) => <option key={voice.voiceURI} value={voice.voiceURI}>{voice.name} ({voice.lang})</option>)}
            </Select>
          </Row>
          <Row label={t("Tốc độ đọc")} hint={`${value("tts_rate").toFixed(2)}×`}>
            <input type="range" min={0.5} max={2} step={0.05} value={value("tts_rate")} aria-label={t("Tốc độ đọc")} onChange={(event) => set("tts_rate", Number(event.target.value))} className="w-44 accent-[var(--smc-primary)]" />
            <PrimaryButton variant="soft" size="sm" icon={Volume2} disabled={!ttsSupported()}
              onClick={() => {
                if (speaking) { stopSpeaking(); setSpeaking(false); return; }
                const result = speak("Xin chào. Đây là giọng đọc thông tin thuốc của tủ thuốc thông minh.", { voiceUri: value("tts_voice"), rate: value("tts_rate"), onEnd: () => setSpeaking(false) });
                if (result.ok) setSpeaking(true);
                else toast.warning(t("Chưa có giọng đọc tiếng Việt"), t("Xem hướng dẫn bên dưới để cài giọng đọc."));
              }}>
              {speaking ? t("Dừng") : t("Đọc thử")}
            </PrimaryButton>
          </Row>
          {ttsSupported() && viVoices.length === 0 && (
            <div className="mt-3">
              <Note tone="warning">
                {t("Máy chưa có giọng đọc tiếng Việt offline. Trên Windows 10/11: Settings → Time & language → Speech → Manage voices → Add voices → Vietnamese, rồi mở lại ứng dụng. Bạn cũng có thể chọn tạm một giọng khác trong danh sách.")}
              </Note>
            </div>
          )}
        </Section>

        <Section title={t("Giao diện")}>
          <Row icon={Palette} label={t("Chế độ hiển thị")}>
            <Segmented size="sm" value={value("theme")} onChange={(v) => set("theme", v)} options={[{ value: "light", label: t("Sáng") }, { value: "dark", label: t("Tối") }, { value: "system", label: t("Theo hệ thống") }]} />
          </Row>
          <Row icon={Languages} label={t("Ngôn ngữ")} hint={t("Nội dung do hệ thống sinh ra (cảnh báo, lịch sử) luôn là tiếng Việt.")}>
            <Segmented size="sm" value={value("language")} onChange={(v) => set("language", v)} options={[{ value: "vi", label: "Tiếng Việt" }, { value: "en", label: "English" }]} />
          </Row>
          <Row icon={ShieldCheck} label={t("Phiên bản")}><span className="text-sm tabular-nums text-muted">{t("Ứng dụng")} {window.smc?.appVersion ?? "2.0.0"}{health ? ` · ${t("Máy chủ")} ${health.version}` : ""}</span></Row>
          <Row icon={Server} label={t("Máy chủ")}><span className="max-w-[320px] truncate text-sm text-muted">{connectionInfo().baseUrl}</span></Row>
        </Section>

        <BackupSection />
      </div>

      {/* Hành động chính của trang: lưu mọi thay đổi */}
      <div className="fixed bottom-7 right-10 z-30 flex items-center gap-2.5 rounded-[22px] bg-surface/95 p-2 shadow-card ring-1 ring-line/60 backdrop-blur 3xl:right-12">
        {dirtyKeys > 0 && (
          <PrimaryButton variant="secondary" size="lg" onClick={() => setDraft({})}>{t("Hủy thay đổi")}</PrimaryButton>
        )}
        <PrimaryButton size="lg" icon={Check} loading={save.isPending} disabled={dirtyKeys === 0} onClick={submit} data-testid="save-settings">
          {dirtyKeys > 0 ? t("Lưu cài đặt ({count})", { count: dirtyKeys }) : t("Lưu cài đặt")}
        </PrimaryButton>
      </div>
    </div>
  );
}
