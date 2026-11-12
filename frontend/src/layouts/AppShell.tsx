import { AnimatePresence, motion } from "motion/react";
import { Outlet, useLocation } from "react-router-dom";
import { CatalogSearchModal } from "@/components/CatalogSearchModal";
import { Sidebar } from "@/components/Sidebar";
import { ToastViewport } from "@/components/Toast";
import { Topbar } from "@/components/Topbar";
import { useNotificationPump, useThemeAndLanguage } from "@/hooks/useAppEffects";
import { useHealth } from "@/services/queries";

/**
 * Khung ứng dụng dùng chung: Sidebar trái + Topbar trên + vùng nội dung cuộn.
 * Sidebar và Topbar chỉ được dựng MỘT lần ở đây nên không thể lệch giữa các trang.
 */
export function AppShell() {
  const location = useLocation();
  const health = useHealth();
  useThemeAndLanguage();
  useNotificationPump(health.data?.status === "ok");
  // Trang con của cùng một mục (vd /scan → /scan/result) không cần hiệu ứng chuyển trang riêng.
  const section = location.pathname.split("/").slice(0, 3).join("/");

  return (
    <div className="app-backdrop flex h-full w-full overflow-hidden text-navy">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar />
        <main data-testid="page-content" className="scroll-area min-h-0 flex-1 overflow-y-auto px-10 pb-10 3xl:px-12">
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={section}
              initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
              transition={{ duration: 0.2, ease: "easeOut" }}
              className="mx-auto w-full max-w-[1680px]"
            >
              <Outlet />
            </motion.div>
          </AnimatePresence>
        </main>
      </div>
      <CatalogSearchModal />
      <ToastViewport />
    </div>
  );
}
