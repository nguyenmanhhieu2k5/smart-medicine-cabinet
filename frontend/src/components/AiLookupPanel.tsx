import { BadgeCheck, ChevronRight, ExternalLink, Globe, LoaderCircle, Pill, ShieldAlert, Sparkles } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { PrimaryButton } from "@/components/Button";
import { Card } from "@/components/Card";
import { InfoRows } from "@/components/MedicineBits";
import { IconTile, StatusIndicator } from "@/components/StatusIndicator";
import { useT } from "@/i18n";
import { api } from "@/services/api";
import { errorMessage } from "@/services/queries";
import type { AiLookupResult } from "@/types/api";

const CONFIDENCE = {
  cao: { label: "Độ tin cậy: Cao", tone: "success" },
  trung_binh: { label: "Độ tin cậy: Trung bình", tone: "warning" },
  thap: { label: "Độ tin cậy: Thấp", tone: "danger" },
} as const;

/**
 * "Không có thuốc đúng? Tìm trên mạng bằng AI" — chỉ chạy khi người dùng bấm (xác nhận không có kết quả đúng).
 * Máy chủ gọi Gemini + Google Search với ảnh và chữ OCR của lượt quét; kết quả chỉ để tham khảo, không tự vào tủ thuốc.
 */
export function AiLookupPanel({ jobId }: { jobId: string }) {
  const t = useT();
  const [state, setState] = useState<"idle" | "loading" | "done">("idle");
  const [data, setData] = useState<AiLookupResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const started = useRef(0);

  useEffect(() => {
    if (state !== "loading") return;
    const timer = window.setInterval(() => setElapsed(Math.floor((Date.now() - started.current) / 1000)), 1000);
    return () => window.clearInterval(timer);
  }, [state]);

  const run = async () => {
    started.current = Date.now();
    setElapsed(0);
    setState("loading");
    setError(null);
    try {
      setData(await api.aiScan(jobId));
    } catch (e) {
      setError(errorMessage(e));
      setData(null);
    } finally {
      setState("done");
    }
  };

  const info = data?.result;
  const confidence = info ? CONFIDENCE[info.do_tin_cay] ?? CONFIDENCE.thap : null;
  return (
    <Card padding="lg" data-testid="ai-panel">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <IconTile icon={Sparkles} tone="info" />
          <div>
            <h2 className="font-display text-[19px] font-bold text-navy">{t("Không có thuốc đúng? Tìm trên mạng bằng AI")}</h2>
            <p className="mt-0.5 text-[13px] text-muted">{t("Gemini đọc ảnh vừa quét và tra cứu trên Internet. Kết quả chỉ để tham khảo, không tự lưu vào tủ.")}</p>
          </div>
        </div>
        <PrimaryButton variant={state === "idle" ? "primary" : "secondary"} icon={state === "loading" ? LoaderCircle : Sparkles} loading={state === "loading"}
          onClick={() => void run()}>
          {state === "idle" ? t("Tìm bằng AI") : t("Tìm lại")}
        </PrimaryButton>
      </div>

      {state === "loading" && (
        <div className="mt-5 flex items-center gap-3 rounded-2xl bg-scan-panel px-4 py-3.5 text-[14px] font-medium text-primary" role="status">
          <LoaderCircle size={18} className="animate-spin" />
          {t("AI đang tìm thông tin thuốc… {seconds} giây (thường 5–20 giây)", { seconds: elapsed })}
        </div>
      )}

      {state === "done" && (error || !data || data.status === "unavailable" || data.status === "not_configured") && (
        <div role="alert" className="mt-5 flex gap-3 rounded-2xl bg-warning-soft px-4 py-3.5 text-[14px] text-warning-ink">
          <ShieldAlert size={20} className="mt-0.5 shrink-0" />
          <span>{error ?? data?.message}</span>
        </div>
      )}

      {state === "done" && data?.status === "not_found" && (
        <p className="mt-5 rounded-2xl bg-tile px-4 py-3.5 text-[14px] text-muted">{data.message}</p>
      )}

      {state === "done" && data?.status === "found" && info && (
        <div className="mt-5 grid gap-6 xl:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]" data-testid="ai-result">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <StatusIndicator tone="info" size="sm" icon={data.mode === "web" ? Globe : Sparkles}>
                {t({ web: "AI · đã tra trên mạng", offline: "AI · chỉ đọc ảnh (chưa tra được mạng)", search: "Tra trên mạng · không dùng AI", text: "Đọc từ nội dung mã · không dùng AI" }[data.mode ?? "web"])}
              </StatusIndicator>
              {confidence && <StatusIndicator tone={confidence.tone} size="sm">{t(confidence.label)}</StatusIndicator>}
              {data.model && <span className="text-[12px] text-muted">{data.model}{data.cached ? ` · ${t("kết quả đã lưu")}` : ""}</span>}
            </div>
            <h3 className="mt-3 font-display text-[24px] font-extrabold text-navy">{info.ten_thuoc}</h3>
            <div className="mt-3">
              <InfoRows rows={[
                { label: t("Hoạt chất"), value: info.hoat_chat },
                { label: t("Hàm lượng"), value: info.ham_luong },
                { label: t("Dạng bào chế"), value: info.dang_bao_che },
                { label: t("Quy cách"), value: info.quy_cach },
                { label: t("Số đăng ký"), value: info.so_dang_ky },
                { label: t("Nhà sản xuất"), value: [info.nha_san_xuat, info.nuoc_san_xuat].filter(Boolean).join(" · ") || null },
                ...(info.ghi_chu ? [{ label: t("Ghi chú của AI"), value: info.ghi_chu }] : []),
              ]} />
            </div>
          </div>
          <div className="space-y-4">
            {data.catalog_matches.length > 0 && (
              <div>
                <p className="mb-2 text-[13px] font-semibold text-muted">{t("Trong danh mục thuốc")}</p>
                <div className="space-y-2">
                  {data.catalog_matches.map((m) => (
                    <Link key={m.id} to={`/medicines/${m.id}?scan=${jobId}`} className="flex items-center gap-3 rounded-2xl bg-tile px-4 py-3 transition-colors hover:bg-primary-soft">
                      <IconTile icon={m.match_by === "registration" ? BadgeCheck : Pill} tone={m.match_by === "registration" ? "success" : "info"} size="sm" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[14.5px] font-semibold text-navy">{m.ten_thuoc}</span>
                        <span className="block text-[12.5px] text-muted">
                          {m.match_by === "registration" ? t("Khớp số đăng ký") : t("Gợi ý theo tên")}{m.so_dang_ky ? ` · ${m.so_dang_ky}` : ""}
                        </span>
                      </span>
                      <ChevronRight size={18} className="text-muted" />
                    </Link>
                  ))}
                </div>
              </div>
            )}
            {data.sources.length > 0 && (
              <div>
                <p className="mb-2 text-[13px] font-semibold text-muted">{t("Nguồn tham khảo")}</p>
                <div className="flex flex-wrap gap-2">
                  {data.sources.map((s) => (
                    <a key={s.url} href={s.url} target="_blank" rel="noreferrer"
                      className="inline-flex max-w-full items-center gap-1.5 rounded-full bg-primary-soft px-3 py-1.5 text-[12.5px] font-semibold text-primary hover:underline">
                      <Globe size={13} /> <span className="truncate">{s.title}</span> <ExternalLink size={12} />
                    </a>
                  ))}
                </div>
              </div>
            )}
            <div className="flex gap-3 rounded-2xl bg-warning-soft px-4 py-3.5 text-[13px] text-warning-ink">
              <ShieldAlert size={18} className="mt-0.5 shrink-0" />
              <span>{data.notice}</span>
            </div>
          </div>
        </div>
      )}
    </Card>
  );
}
