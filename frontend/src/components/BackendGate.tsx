import { FolderOpen, LoaderCircle, RotateCw, TriangleAlert } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { PrimaryButton } from "@/components/Button";
import { useT } from "@/i18n";
import { initBackend } from "@/services/api";
import type { BackendInfo } from "@/types/desktop";

type GateState = { phase: "waiting" } | { phase: "ready" } | { phase: "error"; info: BackendInfo | null; message: string };

/**
 * Cổng khởi động cho bản desktop: chờ dịch vụ nền (FastAPI) do Electron khởi chạy.
 * - đang chờ  -> màn hình "Đang khởi động…"
 * - lỗi       -> nêu rõ lỗi + đường dẫn nhật ký + nút khởi động lại (không giả vờ là đã chạy)
 * Khi mở bằng trình duyệt (phát triển) thì không có cổng này.
 */
export function BackendGate({ children }: { children: ReactNode }) {
  const t = useT();
  const [state, setState] = useState<GateState>(() => (window.smc ? { phase: "waiting" } : { phase: "ready" }));

  useEffect(() => {
    if (!window.smc) return;
    let cancelled = false;
    initBackend()
      .then((info) => {
        if (cancelled) return;
        if (!info || info.state === "ready") setState({ phase: "ready" });
        else setState({ phase: "error", info, message: info.error || t("Dịch vụ nền không phản hồi.") });
      })
      .catch((error: unknown) => {
        if (!cancelled) setState({ phase: "error", info: null, message: error instanceof Error ? error.message : String(error) });
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- chỉ chạy một lần khi mở ứng dụng
  }, []);

  if (state.phase === "ready") return <>{children}</>;

  return (
    <div className="app-backdrop flex h-screen w-screen items-center justify-center p-8" data-testid="backend-gate">
      <div className="flex w-full max-w-[520px] flex-col items-center rounded-card bg-surface px-10 py-12 text-center shadow-card ring-1 ring-line">
        <img src="./favicon.svg" alt="" className="mb-6 size-[72px] rounded-[20px] shadow-button" />
        <p className="font-display text-[22px] font-extrabold tracking-tight text-navy">{t("Tủ thuốc thông minh")}</p>
        <p className="mt-0.5 text-[11px] font-semibold uppercase tracking-[0.2em] text-muted">Smart Medicine Cabinet</p>

        {state.phase === "waiting" ? (
          <div className="mt-9 flex flex-col items-center gap-3" role="status">
            <LoaderCircle size={26} className="animate-spin text-primary" />
            <p className="text-sm font-medium text-navy">{t("Đang khởi động dịch vụ nền…")}</p>
            <p className="max-w-sm text-[13px] text-muted">{t("Cơ sở dữ liệu thuốc và bộ nhận diện chữ chạy ngay trên máy này, không cần Internet.")}</p>
          </div>
        ) : (
          <div className="mt-8 flex w-full flex-col items-center" role="alert">
            <span className="mb-3 inline-flex size-12 items-center justify-center rounded-2xl bg-danger-soft text-danger">
              <TriangleAlert size={24} />
            </span>
            <p className="font-display text-[17px] font-bold text-navy">{t("Không khởi động được dịch vụ nền")}</p>
            <p className="mt-2 break-words text-[13.5px] text-muted">{state.message}</p>
            {state.info?.logFile && (
              <p className="mt-3 w-full break-all rounded-xl bg-tile px-3 py-2 text-left font-mono text-[12px] text-muted">{state.info.logFile}</p>
            )}
            <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
              <PrimaryButton icon={RotateCw} onClick={() => void window.smc?.relaunch()}>{t("Khởi động lại ứng dụng")}</PrimaryButton>
              <PrimaryButton variant="secondary" icon={FolderOpen} onClick={() => void window.smc?.openLogFolder()}>{t("Mở thư mục nhật ký")}</PrimaryButton>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
