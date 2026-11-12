import { Bell, CalendarDays, Settings, User } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { IconButton } from "@/components/Button";
import { PageHeader } from "@/components/PageHeader";
import { useClock } from "@/hooks/useClock";
import { useLanguageStore, useT } from "@/i18n";
import { pad, weekdayDate } from "@/services/format";
import { useAlertCount } from "@/services/queries";

/** Thanh trên cùng — giống hệt nhau ở mọi trang: tiêu đề, ngày giờ, 3 nút nhanh. */
export function Topbar() {
  const t = useT();
  const navigate = useNavigate();
  const now = useClock();
  const language = useLanguageStore((state) => state.language);
  const alerts = useAlertCount();
  return (
    <header data-testid="topbar" className="flex h-[132px] shrink-0 items-center justify-between gap-6 px-10 short:h-[104px] 3xl:px-12">
      <PageHeader />
      <div className="flex shrink-0 items-center gap-3">
        <div className="flex h-[52px] items-center gap-3 rounded-2xl bg-surface px-5 shadow-card ring-1 ring-line/40" aria-label={t("Ngày giờ hiện tại")}>
          <CalendarDays size={20} strokeWidth={1.8} className="text-navy" />
          <div className="leading-tight">
            <p className="text-[11.5px] text-muted">{weekdayDate(now, language)}</p>
            <p className="font-display text-[17px] font-bold tabular-nums text-navy">{pad(now.getHours())}:{pad(now.getMinutes())}</p>
          </div>
        </div>
        <IconButton icon={Bell} label={t("Cảnh báo")} variant="surface" size="lg" badge={alerts.data?.unhandled} onClick={() => navigate("/alerts")} />
        <IconButton icon={Settings} label={t("Cài đặt")} variant="surface" size="lg" onClick={() => navigate("/settings")} />
        <IconButton icon={User} label={t("Hồ sơ")} variant="surface" size="lg" onClick={() => navigate("/profile")} />
      </div>
    </header>
  );
}
