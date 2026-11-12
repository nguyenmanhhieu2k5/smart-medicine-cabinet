import clsx from "clsx";
import {
  Activity, Bell, CalendarDays, CircleAlert, CircleCheck, Clock, House, LoaderCircle, Package, Pill, ScanLine, Settings, User,
  type LucideIcon,
} from "lucide-react";
import { NavLink } from "react-router-dom";
import { useLanguageStore, useT } from "@/i18n";
import { formatNumber } from "@/services/format";
import { useAlertCount, useHealth } from "@/services/queries";

interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  end?: boolean;
}

export const MAIN_NAV: NavItem[] = [
  { to: "/", label: "Trang chủ", icon: House, end: true },
  { to: "/scan", label: "Quét thuốc", icon: ScanLine },
  { to: "/cabinet", label: "Thuốc trong tủ", icon: Package },
  { to: "/expiry", label: "Hạn dùng", icon: CalendarDays },
  { to: "/reminders", label: "Nhắc uống thuốc", icon: Clock },
  { to: "/alerts", label: "Cảnh báo", icon: Bell },
  { to: "/history", label: "Lịch sử", icon: Activity },
];
export const FOOTER_NAV: NavItem[] = [
  { to: "/profile", label: "Hồ sơ", icon: User },
  { to: "/settings", label: "Cài đặt", icon: Settings },
];

function NavRow({ item, badge }: { item: NavItem; badge?: number }) {
  const t = useT();
  return (
    <NavLink
      to={item.to} end={item.end}
      className={({ isActive }) =>
        clsx(
          "group relative flex h-[55px] items-center gap-3.5 rounded-2xl pl-5 pr-4 text-[16px] transition-colors duration-150 short:h-11 short:text-[15px]",
          isActive ? "bg-primary-soft font-semibold text-primary" : "font-medium text-muted hover:bg-tile hover:text-navy",
        )
      }
    >
      {({ isActive }) => (
        <>
          {isActive && <span className="absolute left-0 top-1/2 h-6 w-[3px] -translate-y-1/2 rounded-r-full bg-primary" aria-hidden />}
          <item.icon size={22} strokeWidth={1.7} className="shrink-0" />
          <span className="truncate">{t(item.label)}</span>
          {badge !== undefined && (
            <span
              className={clsx(
                "ml-auto flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 text-[11px] font-bold tabular-nums",
                badge > 0 ? "bg-danger text-white" : "bg-success-soft text-success",
              )}
              aria-label={badge > 0 ? t("{count} cảnh báo chưa xử lý", { count: badge }) : t("Không có cảnh báo")}
            >
              {badge > 99 ? "99+" : badge}
            </span>
          )}
        </>
      )}
    </NavLink>
  );
}

/** Thanh điều hướng cố định bên trái — không đổi vị trí/kích thước giữa các trang. */
export function Sidebar() {
  const t = useT();
  const language = useLanguageStore((state) => state.language);
  const alerts = useAlertCount();
  const health = useHealth();
  const version = window.smc?.appVersion ?? health.data?.version ?? "1.0.0";

  let StatusIcon: LucideIcon = LoaderCircle;
  let statusText = t("Đang khởi động dịch vụ…");
  let statusClass = "text-muted";
  let spin = true;
  if (health.data?.status === "ok") {
    StatusIcon = CircleCheck;
    statusText = health.data.import_running ? t("Đang nhập danh mục…") : t("Hệ thống sẵn sàng");
    statusClass = "text-success";
    spin = false;
  } else if (health.isError && health.failureCount > 8) {
    StatusIcon = CircleAlert;
    statusText = t("Mất kết nối dịch vụ nền");
    statusClass = "text-danger";
    spin = false;
  }

  return (
    <aside data-testid="sidebar" className="flex h-full w-[256px] shrink-0 flex-col border-r border-line bg-surface/70 px-[18px] pb-6 pt-[43px] short:pt-6 max-xl:w-[228px]">
      <div className="mb-[58px] flex items-center gap-3 px-3.5 short:mb-6">
        <span className="btn-gradient inline-flex size-[50px] shrink-0 items-center justify-center rounded-2xl text-white shadow-button">
          <Pill size={26} strokeWidth={1.9} />
        </span>
        <span className="font-display text-[18px] font-extrabold leading-[1.2] text-navy">
          {t("Tủ thuốc")}<br />{t("thông minh")}
        </span>
      </div>

      <nav className="flex flex-col gap-1 short:gap-0.5" aria-label={t("Điều hướng chính")}>
        {MAIN_NAV.map((item) => (
          <NavRow key={item.to} item={item} badge={item.to === "/alerts" ? (alerts.data?.unhandled ?? 0) : undefined} />
        ))}
      </nav>

      <div className="my-5 h-px bg-line short:my-3" />

      <nav className="flex flex-col gap-1 short:gap-0.5" aria-label={t("Tài khoản và cài đặt")}>
        {FOOTER_NAV.map((item) => <NavRow key={item.to} item={item} />)}
      </nav>

      <div className="mt-auto border-t border-line px-3.5 pt-5 short:pt-3">
        <p className={clsx("flex items-center gap-2 text-[12.5px] font-semibold", statusClass)}>
          <StatusIcon size={17} strokeWidth={2} className={spin ? "animate-spin" : undefined} />
          {statusText}
        </p>
        <p className="mt-2.5 text-[12px] leading-relaxed text-muted short:mt-1.5">
          {health.data
            ? health.data.catalog_count > 0
              ? t("Danh mục: {count} thuốc", { count: formatNumber(health.data.catalog_count, language) })
              : t("Chưa có danh mục thuốc")
            : t("Đang kiểm tra dữ liệu")}
          <br />
          PC Edition • v{version}
        </p>
      </div>
    </aside>
  );
}
