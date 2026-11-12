import { CircleAlert, CircleCheck, Info, TriangleAlert, X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useToastStore, type ToastKind } from "@/stores/toast";

const ICONS = { success: CircleCheck, error: CircleAlert, info: Info, warning: TriangleAlert };
const COLORS: Record<ToastKind, string> = {
  success: "text-success bg-success-soft",
  error: "text-danger bg-danger-soft",
  info: "text-primary bg-primary-soft",
  warning: "text-warning-ink bg-warning-soft",
};

/** Thông báo ngắn ở góc dưới phải. */
export function ToastViewport() {
  const { toasts, dismiss } = useToastStore();
  return (
    <div className="pointer-events-none fixed bottom-6 right-6 z-[60] flex w-[380px] max-w-[calc(100vw-48px)] flex-col gap-3" aria-live="polite">
      <AnimatePresence initial={false}>
        {toasts.map((item) => {
          const Icon = ICONS[item.kind];
          return (
            <motion.div
              key={item.id} layout role={item.kind === "error" ? "alert" : "status"}
              initial={{ opacity: 0, y: 16, scale: 0.97 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, x: 24 }}
              transition={{ duration: 0.22 }}
              className="pointer-events-auto flex items-start gap-3 rounded-2xl bg-surface p-4 shadow-xl ring-1 ring-line/60"
            >
              <span className={`inline-flex size-9 shrink-0 items-center justify-center rounded-xl ${COLORS[item.kind]}`}>
                <Icon size={18} strokeWidth={2} />
              </span>
              <div className="min-w-0 flex-1 pt-0.5">
                <p className="text-sm font-semibold text-navy">{item.title}</p>
                {item.description && <p className="mt-0.5 break-words text-[13px] text-muted">{item.description}</p>}
              </div>
              <button aria-label="Đóng" className="rounded-lg p-1 text-muted hover:bg-tile hover:text-navy" onClick={() => dismiss(item.id)}>
                <X size={15} />
              </button>
            </motion.div>
          );
        })}
      </AnimatePresence>
    </div>
  );
}
