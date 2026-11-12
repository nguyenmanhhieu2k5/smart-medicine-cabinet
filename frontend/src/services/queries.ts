import { keepPreviousData, useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { api, ApiError } from "@/services/api";
import { toast } from "@/stores/toast";
import type { CabinetInput, ReminderInput, SettingsPatch } from "@/types/api";

export const keys = {
  health: ["health"] as const,
  device: ["device"] as const,
  readings: (hours: number) => ["device", "readings", hours] as const,
  alerts: (params: object) => ["alerts", params] as const,
  alertCount: ["alerts", "count"] as const,
  cabinet: (params: object) => ["cabinet", "list", params] as const,
  cabinetSummary: ["cabinet", "summary"] as const,
  cabinetItem: (id: number) => ["cabinet", "item", id] as const,
  medicine: (id: number) => ["medicine", id] as const,
  search: (q: string, limit: number, offset: number) => ["medicine-search", q, limit, offset] as const,
  reminders: ["reminders"] as const,
  schedule: (from: string, to: string) => ["reminders", "schedule", from, to] as const,
  history: (params: object) => ["history", params] as const,
  settings: ["settings"] as const,
  profile: ["profile"] as const,
  catalog: ["catalog"] as const,
  ocrJob: (id: string) => ["ocr", "job", id] as const,
  ocrStatus: ["ocr", "status"] as const,
  backups: ["backups"] as const,
};

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return "Đã xảy ra lỗi không xác định.";
}

function onError(title: string) {
  return (error: unknown) => toast.error(title, errorMessage(error));
}

/** Sau khi tủ thuốc thay đổi: làm mới danh sách, cảnh báo và lịch sử. */
export function invalidateCabinet(client: QueryClient): void {
  for (const key of ["cabinet", "alerts", "history", "reminders"]) void client.invalidateQueries({ queryKey: [key] });
}

// ---- Hệ thống -------------------------------------------------------------- //
export function useHealth() {
  return useQuery({
    queryKey: keys.health,
    queryFn: api.health,
    refetchInterval: (query) => (query.state.data?.status === "ok" && !query.state.data.import_running ? 20_000 : 1500),
    retry: false,
  });
}

export function useDevice() {
  return useQuery({ queryKey: keys.device, queryFn: api.device, refetchInterval: 5000 });
}

export function useReadings(hours: number, enabled = true) {
  return useQuery({ queryKey: keys.readings(hours), queryFn: () => api.deviceReadings(hours), refetchInterval: 60_000, enabled });
}

export function useAlertCount() {
  return useQuery({ queryKey: keys.alertCount, queryFn: api.alertCount, refetchInterval: 15_000 });
}

export function useAlerts(params: { scope?: string; category?: string; severity?: string }) {
  return useQuery({ queryKey: keys.alerts(params), queryFn: () => api.alerts(params), refetchInterval: 15_000, placeholderData: keepPreviousData });
}

export function useAlertActions() {
  const client = useQueryClient();
  const done = () => void client.invalidateQueries({ queryKey: ["alerts"] });
  return {
    update: useMutation({ mutationFn: (v: { id: number; status: "seen" | "acknowledged" }) => api.alertUpdate(v.id, v.status), onSuccess: done, onError: onError("Không cập nhật được cảnh báo") }),
    markAll: useMutation({ mutationFn: (status: "seen" | "acknowledged") => api.alertMarkAll(status), onSuccess: done, onError: onError("Không cập nhật được cảnh báo") }),
  };
}

// ---- Danh mục ---------------------------------------------------------------- //
export function useMedicineSearch(query: string, limit = 20, offset = 0) {
  const q = query.trim();
  return useQuery({
    queryKey: keys.search(q, limit, offset),
    queryFn: ({ signal }) => api.searchMedicines(q, limit, offset, signal),
    enabled: q.length >= 2,
    placeholderData: keepPreviousData,
    staleTime: 60_000,
  });
}

export function useMedicine(id: number | null) {
  return useQuery({ queryKey: keys.medicine(id ?? 0), queryFn: () => api.medicine(id as number), enabled: id !== null });
}

export function useCatalogStatus() {
  return useQuery({
    queryKey: keys.catalog,
    queryFn: api.catalogStatus,
    refetchInterval: (query) => (query.state.data?.progress.running ? 700 : 30_000),
  });
}

// ---- Tủ thuốc ---------------------------------------------------------------- //
export function useCabinet(params: { q?: string; status?: string; sort?: string; page?: number; page_size?: number }) {
  return useQuery({ queryKey: keys.cabinet(params), queryFn: () => api.cabinetList(params), placeholderData: keepPreviousData });
}

export function useCabinetSummary() {
  return useQuery({ queryKey: keys.cabinetSummary, queryFn: api.cabinetSummary });
}

export function useCabinetItem(id: number | null) {
  return useQuery({ queryKey: keys.cabinetItem(id ?? 0), queryFn: () => api.cabinetItem(id as number), enabled: id !== null });
}

export function useCabinetMutations() {
  const client = useQueryClient();
  const done = () => invalidateCabinet(client);
  return {
    create: useMutation({ mutationFn: (body: CabinetInput) => api.cabinetCreate(body), onSuccess: done, onError: onError("Không lưu được thuốc") }),
    update: useMutation({ mutationFn: (v: { id: number; body: CabinetInput }) => api.cabinetUpdate(v.id, v.body), onSuccess: done, onError: onError("Không cập nhật được thuốc") }),
    adjust: useMutation({ mutationFn: (v: { id: number; delta: number; reason?: string }) => api.cabinetAdjust(v.id, v.delta, v.reason), onSuccess: done, onError: onError("Không đổi được số lượng") }),
    remove: useMutation({ mutationFn: (id: number) => api.cabinetDelete(id), onSuccess: done, onError: onError("Không xóa được thuốc") }),
  };
}

// ---- Lời nhắc ---------------------------------------------------------------- //
export function useReminders() {
  return useQuery({ queryKey: keys.reminders, queryFn: api.reminders });
}

export function useSchedule(from: string, to: string) {
  return useQuery({ queryKey: keys.schedule(from, to), queryFn: () => api.schedule(from, to), refetchInterval: 60_000, placeholderData: keepPreviousData });
}

export function useReminderMutations() {
  const client = useQueryClient();
  const done = () => {
    for (const key of ["reminders", "history", "cabinet", "alerts"]) void client.invalidateQueries({ queryKey: [key] });
  };
  return {
    create: useMutation({ mutationFn: (body: ReminderInput) => api.reminderCreate(body), onSuccess: done, onError: onError("Không tạo được lời nhắc") }),
    update: useMutation({ mutationFn: (v: { id: number; body: ReminderInput }) => api.reminderUpdate(v.id, v.body), onSuccess: done, onError: onError("Không cập nhật được lời nhắc") }),
    remove: useMutation({ mutationFn: (id: number) => api.reminderDelete(id), onSuccess: done, onError: onError("Không xóa được lời nhắc") }),
    log: useMutation({
      mutationFn: (v: { id: number; scheduled_for: string; status: "taken" | "skipped" | "pending" }) => api.reminderLog(v.id, v.scheduled_for, v.status),
      onSuccess: done,
      onError: onError("Không ghi được trạng thái"),
    }),
  };
}

// ---- Lịch sử ----------------------------------------------------------------- //
export function useHistory(params: { q?: string; group?: string; from?: string; to?: string; page?: number; page_size?: number }) {
  return useQuery({ queryKey: keys.history(params), queryFn: () => api.history(params), placeholderData: keepPreviousData });
}

// ---- Cài đặt, hồ sơ ---------------------------------------------------------- //
export function useSettings() {
  return useQuery({ queryKey: keys.settings, queryFn: api.settings, staleTime: 30_000 });
}

export function useUpdateSettings(silent = false) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: SettingsPatch) => api.settingsUpdate(body),
    onSuccess: () => {
      for (const key of ["settings", "device", "alerts", "cabinet", "ocr"]) void client.invalidateQueries({ queryKey: [key] });
      if (!silent) toast.success("Đã lưu cài đặt");
    },
    onError: onError("Không lưu được cài đặt"),
  });
}

export function useProfile() {
  return useQuery({ queryKey: keys.profile, queryFn: api.profile });
}

export function useOcrStatus(enabled = true) {
  return useQuery({
    queryKey: keys.ocrStatus,
    queryFn: api.ocrStatus,
    enabled,
    refetchInterval: (query) => (query.state.data?.state === "loading" ? 1000 : 20_000),
  });
}

export function useOcrJob(id: string | null) {
  return useQuery({
    queryKey: keys.ocrJob(id ?? ""),
    queryFn: () => api.ocrJob(id as string),
    enabled: Boolean(id),
    retry: false,
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status === "done" || status === "error" || query.state.error ? false : 350;
    },
  });
}

export function useBackups() {
  return useQuery({ queryKey: keys.backups, queryFn: api.backups });
}
