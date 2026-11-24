import { Navigate, useNavigate, useParams } from "react-router-dom";
import { Segmented } from "@/components/Form";
import { useT } from "@/i18n";
import { AuditTab, ScansTab } from "@/pages/admin/ActivityTabs";
import { DevicesTab } from "@/pages/admin/DevicesTab";
import { SystemTab } from "@/pages/admin/SystemTab";
import { UsersTab } from "@/pages/admin/UsersTab";
import { usePageHeader } from "@/stores/page";

const TABS = ["devices", "users", "scans", "audit", "system"] as const;
type Tab = (typeof TABS)[number];

/** Quản trị (chỉ có ở ứng dụng Windows — kênh Admin qua Tailscale). */
export function AdminPage() {
  const t = useT();
  const navigate = useNavigate();
  const { tab } = useParams<{ tab: string }>();
  usePageHeader(t("Quản trị"), t("Thiết bị, tài khoản, nhật ký và máy chủ"), `${t("Tủ thuốc thông minh")} / ${t("Quản trị")}`);
  if (!TABS.includes(tab as Tab)) return <Navigate to="/admin/devices" replace />;
  const current = tab as Tab;

  return (
    <div className="pb-10">
      <Segmented className="mb-6 short:mb-4" value={current} onChange={(next) => navigate(`/admin/${next}`)}
        options={[
          { value: "devices", label: t("Thiết bị") },
          { value: "users", label: t("Tài khoản") },
          { value: "scans", label: t("Lượt quét") },
          { value: "audit", label: t("Nhật ký") },
          { value: "system", label: t("Máy chủ") },
        ]} />
      {current === "devices" && <DevicesTab />}
      {current === "users" && <UsersTab />}
      {current === "scans" && <ScansTab />}
      {current === "audit" && <AuditTab />}
      {current === "system" && <SystemTab />}
    </div>
  );
}
