import clsx from "clsx";
import { X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { IconButton, PrimaryButton } from "@/components/Button";
import { useT } from "@/i18n";

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  size?: "sm" | "md" | "lg" | "xl";
  footer?: ReactNode;
  children: ReactNode;
}

const WIDTHS = { sm: "max-w-md", md: "max-w-xl", lg: "max-w-3xl", xl: "max-w-5xl" };

/** Hộp thoại giữa màn hình: đóng bằng Esc/nền mờ, giữ tiêu điểm bên trong. */
export function Modal({ open, onClose, title, description, size = "md", footer, children }: ModalProps) {
  const t = useT();
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
      }
      if (event.key === "Tab" && panelRef.current) {
        const focusable = panelRef.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        );
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", onKey);
    const timer = window.setTimeout(() => {
      const target = panelRef.current?.querySelector<HTMLElement>("[data-autofocus], input, select, textarea");
      (target ?? panelRef.current)?.focus();
    }, 40);
    return () => {
      document.removeEventListener("keydown", onKey);
      window.clearTimeout(timer);
      previous?.focus?.();
    };
  }, [open, onClose]);

  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-50 flex items-center justify-center p-6"
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.18 }}
        >
          <div className="absolute inset-0 bg-[#0b1226]/45" onClick={onClose} aria-hidden />
          <motion.div
            ref={panelRef}
            role="dialog" aria-modal="true" aria-label={title} tabIndex={-1}
            className={clsx("relative flex max-h-[calc(100vh-48px)] w-full flex-col rounded-card bg-surface shadow-2xl ring-1 ring-line/50 outline-none", WIDTHS[size])}
            initial={{ opacity: 0, y: 14, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 8, scale: 0.98 }}
            transition={{ duration: 0.2, ease: [0.2, 0.8, 0.2, 1] }}
          >
            <div className="flex items-start justify-between gap-4 px-7 pb-1 pt-6">
              <div className="min-w-0">
                <h2 className="font-display text-xl font-bold text-navy">{title}</h2>
                {description && <p className="mt-1 text-sm text-muted">{description}</p>}
              </div>
              <IconButton icon={X} label={t("Đóng")} variant="ghost" size="sm" onClick={onClose} />
            </div>
            <div className="scroll-area min-h-0 flex-1 overflow-y-auto px-7 py-5">{children}</div>
            {footer && <div className="flex items-center justify-end gap-3 border-t border-line px-7 py-4">{footer}</div>}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  description: string;
  confirmLabel?: string;
  danger?: boolean;
  loading?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}

/** Hộp xác nhận cho thao tác không hoàn tác được (xóa thuốc, xóa lịch sử, khôi phục…). */
export function ConfirmDialog({ open, title, description, confirmLabel, danger = false, loading = false, onConfirm, onClose }: ConfirmDialogProps) {
  const t = useT();
  return (
    <Modal
      open={open} onClose={onClose} title={title} size="sm"
      footer={
        <>
          <PrimaryButton variant="secondary" onClick={onClose}>{t("Hủy")}</PrimaryButton>
          <PrimaryButton variant={danger ? "danger" : "primary"} loading={loading} onClick={onConfirm} data-autofocus>
            {confirmLabel ?? t("Xác nhận")}
          </PrimaryButton>
        </>
      }
    >
      <p className="text-sm leading-relaxed text-muted">{description}</p>
    </Modal>
  );
}
