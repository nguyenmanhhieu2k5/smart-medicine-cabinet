import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { HashRouter, Navigate, Route, Routes } from "react-router-dom";
import { BackendGate } from "@/components/BackendGate";
import { AppShell } from "@/layouts/AppShell";
import { AlertsPage } from "@/pages/AlertsPage";
import { CabinetPage } from "@/pages/CabinetPage";
import { ExpiryPage } from "@/pages/ExpiryPage";
import { HistoryPage } from "@/pages/HistoryPage";
import { HomePage } from "@/pages/HomePage";
import { MedicineDetailPage } from "@/pages/MedicineDetailPage";
import { ProfilePage } from "@/pages/ProfilePage";
import { RemindersPage } from "@/pages/RemindersPage";
import { ScanPage } from "@/pages/ScanPage";
import { ScanResultPage } from "@/pages/ScanResultPage";
import { SettingsPage } from "@/pages/SettingsPage";

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false, staleTime: 5000 } },
});

export function AppRoutes() {
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<HomePage />} />
        <Route path="scan" element={<ScanPage />} />
        <Route path="scan/result/:jobId" element={<ScanResultPage />} />
        <Route path="cabinet" element={<CabinetPage />} />
        <Route path="cabinet/:itemId" element={<MedicineDetailPage source="cabinet" />} />
        <Route path="medicines/:medicineId" element={<MedicineDetailPage source="catalog" />} />
        <Route path="expiry" element={<ExpiryPage />} />
        <Route path="reminders" element={<RemindersPage />} />
        <Route path="alerts" element={<AlertsPage />} />
        <Route path="history" element={<HistoryPage />} />
        <Route path="profile" element={<ProfilePage />} />
        <Route path="settings" element={<SettingsPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      {/* HashRouter: chạy được cả khi Electron nạp bằng file:// */}
      <BackendGate>
        <HashRouter>
          <AppRoutes />
        </HashRouter>
      </BackendGate>
    </QueryClientProvider>
  );
}
