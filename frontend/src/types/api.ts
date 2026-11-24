import type { AccountInfo } from "@/types/desktop";

// Kiểu dữ liệu khớp với JSON của backend (backend/app/api).

export interface MedicineSummary {
  id: number;
  ten_thuoc: string;
  hoat_chat_chinh: string | null;
  ham_luong: string | null;
  ham_luong_source: "hamLuong" | "hoatChatChinh" | "tenThuoc" | null;
  dang_bao_che: string | null;
  so_dang_ky: string | null;
  ten_cong_ty_san_xuat: string | null;
  nuoc_san_xuat: string | null;
  dong_goi: string | null;
  registration_status: { code: "valid" | "expired" | "withdrawn" | "unknown"; label: string };
  in_source: boolean;
}

export interface MedicineDetail extends MedicineSummary {
  so_dang_ky_cu: string | null;
  ham_luong_goc: string | null;
  ten_duong_dung: string | null;
  tieu_chuan: string | null;
  tuoi_tho: string | null;
  shelf_life_months: number | null;
  ngay_cap_so_dang_ky: string | null;
  ngay_gia_han_so_dang_ky: string | null;
  ngay_het_han_so_dang_ky: string | null;
  so_quyet_dinh: string | null;
  dot_cap: string | null;
  ten_cong_ty_dang_ky: string | null;
  dia_chi_dang_ky: string | null;
  nuoc_dang_ky: string | null;
  dia_chi_san_xuat: string | null;
  phan_loai_thuoc_enum: string | null;
  raw: Record<string, string | boolean | number | null>;
  in_cabinet_count?: number;
}

export interface SearchResult {
  items: MedicineSummary[];
  total: number;
  query: string;
  mode: "empty" | "text" | "registration" | "relaxed" | "fuzzy";
  catalog_count: number;
}

export type ExpiryStatus = "ok" | "expiring" | "expired" | "unknown";

export interface CabinetItem {
  id: number;
  catalog_id: number | null;
  name: string;
  ingredient: string | null;
  strength: string | null;
  dosage_form: string | null;
  registration_no: string | null;
  manufacturer: string | null;
  quantity: number;
  quantity_text: string;
  unit: string;
  expiry_date: string | null;
  expiry_source: "manual" | "ocr_confirmed" | null;
  expiry_status: ExpiryStatus;
  expiry_status_label: string;
  days_left: number | null;
  lot_number: string | null;
  low_stock_threshold: number | null;
  low_stock: boolean;
  location: string | null;
  note: string | null;
  has_image: boolean;
  source: "scan" | "manual";
  created_at: string;
  updated_at: string;
  catalog?: MedicineDetail | null;
}

export type CabinetFilter = "all" | ExpiryStatus | "low_stock";

export interface CabinetList {
  items: CabinetItem[];
  total: number;
  page: number;
  page_size: number;
  pages: number;
  counts: Record<CabinetFilter, number>;
}

export interface CabinetInput {
  catalog_id?: number | null;
  name?: string | null;
  ingredient?: string | null;
  strength?: string | null;
  dosage_form?: string | null;
  registration_no?: string | null;
  manufacturer?: string | null;
  quantity?: number;
  unit?: string | null;
  expiry_date?: string | null;
  expiry_source?: "manual" | "ocr_confirmed" | null;
  lot_number?: string | null;
  low_stock_threshold?: number | null;
  location?: string | null;
  note?: string | null;
  scan_job_id?: string | null;
}

export type ComponentStatus = "match" | "partial" | "conflict" | "not_observed" | "no_data";

export interface MatchComponent {
  key: "registration" | "name" | "strength" | "ingredient" | "form" | "manufacturer";
  label: string;
  status: ComponentStatus;
  value: number | null;
  weight: number;
  detail: string;
}

export interface MatchCandidate {
  medicine: MedicineSummary;
  score: number;
  level: "high" | "medium" | "low";
  level_label: string;
  components: MatchComponent[];
  flags: string[];
}

export interface MatchResult {
  status: "confident" | "uncertain" | "no_match" | "no_text" | "no_catalog";
  message: string;
  reasons: string[];
  evidence: {
    lines: string[];
    registration_numbers: { text: string; in_catalog: boolean }[];
    strengths: string[];
    dosage_form: string | null;
    name_guess: string | null;
    ingredients: string[];
    search_hint: string | null;
  };
  candidates: MatchCandidate[];
}

export interface OcrLine {
  text: string;
  score: number | null;
  box: [number, number, number, number] | null;
}

export interface OcrJob {
  id: string;
  source: "camera" | "upload";
  status: "queued" | "preprocessing" | "recognizing" | "matching" | "done" | "error";
  progress: number;
  message: string;
  created_at: string;
  finished_at: string | null;
  has_image: boolean;
  error: string | null;
  result: {
    ocr: {
      lines: OcrLine[];
      line_count: number;
      mean_score: number;
      preprocess: string;
      preprocess_label: string;
      attempts: { variant: string; lines: number; quality: number; mean_score: number; elapsed_ms: number }[];
      engine: Record<string, unknown>;
    };
    image: { width: number; height: number; sharpness: number; brightness: number };
    expiry_suggestion: { date: string; precision: "day" | "month"; text: string; needs_confirmation: boolean } | null;
    match: MatchResult;
    elapsed_ms: number;
  } | null;
}

export interface OcrDependencies {
  paddleocr: boolean;
  onnxruntime: boolean;
  paddle: boolean;
  /** Đã cài bản paddlepaddle-gpu (có CUDA). */
  paddle_gpu?: boolean;
}

export interface OcrStatus {
  state: "not_loaded" | "loading" | "ready" | "error" | "disabled";
  error: string | null;
  dependencies: OcrDependencies;
  engine: {
    library?: string;
    version?: string | null;
    engine?: string;
    profile?: string;
    detection_model?: string;
    recognition_model?: string;
    device_requested?: AppSettings["ocr_device"];
    /** Thiết bị thật sự dùng sau khi nạp: "gpu:0" | "cpu" (null khi chưa nạp). */
    device?: string | null;
    gpu_name?: string | null;
    device_note?: string | null;
    loaded?: boolean;
    load_seconds?: number | null;
    models_available_offline?: boolean;
  };
  queue_size: number;
}

export interface Reminder {
  id: number;
  cabinet_item_id: number | null;
  medicine_name: string;
  dose_text: string | null;
  dose_quantity: number | null;
  times: string[];
  frequency: "daily" | "weekly" | "interval";
  frequency_label: string;
  days_of_week: number[];
  interval_days: number;
  start_date: string;
  end_date: string | null;
  enabled: boolean;
  note: string | null;
  created_at: string;
  updated_at: string;
}

export interface ReminderInput {
  cabinet_item_id?: number | null;
  medicine_name?: string | null;
  dose_text?: string | null;
  dose_quantity?: number | null;
  times?: string[];
  frequency?: "daily" | "weekly" | "interval";
  days_of_week?: number[];
  interval_days?: number;
  start_date?: string;
  end_date?: string | null;
  enabled?: boolean;
  note?: string | null;
}

export type OccurrenceStatus = "upcoming" | "due" | "missed" | "taken" | "skipped" | "disabled";

export interface Occurrence {
  reminder_id: number;
  medicine_name: string;
  dose_text: string | null;
  cabinet_item_id: number | null;
  date: string;
  time: string;
  scheduled_for: string;
  status: OccurrenceStatus;
  enabled: boolean;
  acted_at: string | null;
}

export interface Schedule {
  from: string;
  to: string;
  today: string;
  items: Occurrence[];
}

export type Severity = "normal" | "info" | "warning" | "danger";
export type AlertCategory = "environment" | "medicine" | "system";

export interface AlertItem {
  id: number;
  category: AlertCategory;
  category_label: string;
  type: string;
  severity: Severity;
  severity_label: string;
  title: string;
  message: string;
  status: "active" | "seen" | "acknowledged" | "resolved";
  status_label: string;
  data: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
}

export interface AlertList {
  items: AlertItem[];
  unhandled: number;
  open: number;
  by_category: Record<AlertCategory, number>;
}

export type HistoryGroup = "scan" | "cabinet" | "reminder" | "alert" | "system" | "device";

export interface HistoryEvent {
  id: number;
  group: HistoryGroup;
  group_label: string;
  type: string;
  title: string;
  description: string | null;
  data: Record<string, unknown> | null;
  has_image: boolean;
  created_at: string;
}

export interface HistoryList {
  items: HistoryEvent[];
  total: number;
  page: number;
  page_size: number;
  pages: number;
}

export interface DeviceStatus {
  enabled: boolean;
  configured: boolean;
  mode: "wss";
  device_id: string | null;
  state: "disabled" | "connecting" | "connected" | "stale" | "disconnected";
  temperature: number | null;
  humidity: number | null;
  last_update: string | null;
  last_attempt: string | null;
  last_error: string | null;
  simulated: boolean;
  capabilities: string[];
  device: Record<string, unknown>;
  ever_connected: boolean;
  address: string | null;
  environment: {
    code: "not_configured" | "disconnected" | "no_data" | "out_of_range" | "normal";
    label: string;
    temperature: "high" | "low" | "normal" | null;
    humidity: "high" | "low" | "normal" | null;
  };
  thresholds: { temp_min: number; temp_max: number; humidity_min: number; humidity_max: number };
  unhandled_alerts: number;
}

export interface SensorPoint {
  recorded_at: string;
  temperature: number | null;
  humidity: number | null;
  simulated: boolean;
}

export interface AppSettings {
  camera_device_id: string | null;
  temp_min: number;
  temp_max: number;
  humidity_min: number;
  humidity_max: number;
  expiry_warning_days: number;
  low_stock_threshold: number;
  ocr_engine: "onnxruntime" | "paddle";
  ocr_profile: "v6_small" | "v6_tiny" | "v6_medium" | "v5_latin";
  ocr_device: "auto" | "gpu" | "cpu";
  ocr_det_limit_side_len: number;
  ocr_auto_enhance: boolean;
  ocr_use_textline_orientation: boolean;
  ocr_cpu_threads: number;
  ocr_save_scan_images: boolean;
  notify_environment: boolean;
  notify_reminders: boolean;
  notify_windows: boolean;
  sound_enabled: boolean;
  minimize_to_tray: boolean;
  tts_enabled: boolean;
  tts_voice: string | null;
  tts_rate: number;
  theme: "light" | "dark" | "system";
  language: "vi" | "en";
  catalog_source_path: string | null;
  profile_name: string;
  profile_email: string;
  profile_role: string;
  profile_avatar: string | null;
}

export type SettingsPatch = Partial<Omit<AppSettings, "profile_avatar">>;

export interface SettingsResponse {
  settings: AppSettings;
  options: {
    ocr_profiles: { value: AppSettings["ocr_profile"]; label: string; detection: string; recognition: string }[];
    ocr_dependencies: OcrDependencies;
  };
  paths: { data_dir: string; database: string; backups: string };
}

export interface CatalogStatus {
  count: number;
  source_path: string | null;
  default_source: string | null;
  last_import: {
    id: number;
    file_name: string;
    file_path: string;
    status: "running" | "success" | "failed" | "skipped";
    rows_total: number;
    inserted: number;
    updated: number;
    unchanged: number;
    skipped: number;
    removed: number;
    duplicate_ids: number;
    message: string | null;
    started_at: string;
    finished_at: string | null;
  } | null;
  progress: {
    running: boolean;
    stage: "idle" | "hashing" | "reading" | "indexing" | "done" | "failed" | "skipped";
    rows_read: number;
    rows_total: number | null;
    percent: number | null;
    message: string;
    file: string | null;
    last_result: { status: string; message: string } | null;
  };
}

export interface Health {
  status: "ok" | "degraded";
  version: string;
  time: string;
  database: "ok" | "error";
  catalog_count: number;
  ocr: OcrStatus["state"];
  import_running: boolean;
}

export interface Profile {
  name: string;
  email: string;
  role: string;
  phone: string | null;
  has_avatar: boolean;
  account: AccountInfo;
  auth: { provider: "server"; configured: boolean; signed_in: boolean; email: string | null; user_id: string | null };
}

export interface BackupInfo {
  name: string;
  size: number;
  created_at: string;
  label: string;
  automatic: boolean;
}

export interface BackupList {
  items: BackupInfo[];
  directory: string;
  copy_directory: string | null;
  keep_automatic: number;
  last_automatic: (Partial<BackupInfo> & { ok?: boolean; error?: string | null; at?: string }) | null;
  restore_hint: string;
}

// ------------------------------------------------------------------ //
// Quản trị: tài khoản, nhật ký, máy chủ
// ------------------------------------------------------------------ //
export type RoleCode = "ADMIN" | "SCANNER";

export interface AdminUser extends AccountInfo {
  active_sessions?: number;
}

export interface UserList {
  items: AdminUser[];
  total: number;
  limit: number;
  offset: number;
}

export interface UserSessionInfo {
  id: string;
  audience: "admin" | "scanner";
  client: string | null;
  ip: string | null;
  user_agent: string | null;
  created_at: string;
  last_used_at: string;
}

export interface UserCreateInput {
  email: string;
  password: string;
  full_name: string;
  phone?: string | null;
  role: RoleCode;
}

export interface UserPatchInput {
  full_name?: string;
  phone?: string | null;
  role?: RoleCode;
  is_active?: boolean;
}

export interface AuditEntry {
  id: number;
  created_at: string;
  actor: string | null;
  channel: string;
  action: string;
  resource_type: string | null;
  resource_id: string | null;
  success: boolean;
  ip: string | null;
  detail: Record<string, unknown> | null;
}

export interface AdminScan {
  id: string;
  job_id: string | null;
  user_email: string;
  status: string;
  title: string;
  subtitle: string | null;
  candidate_count: number;
  top_medicine_id: number | null;
  created_at: string;
}

export type ServiceState = "running" | "stopped" | "not_installed" | "unknown" | null;

export interface SystemStatus {
  version: string;
  time: string;
  uptime_seconds: number;
  database: {
    ok: boolean;
    url: string;
    version?: string;
    size_bytes?: number;
    catalog_count?: number;
    users?: number;
    devices?: number;
    schema_revision?: string | null;
    error?: string;
    [key: string]: unknown;
  };
  ocr: OcrStatus;
  devices: { online: string[]; online_count: number };
  host: {
    cpu_percent: number;
    cpu_count: number;
    memory_total: number;
    memory_used: number;
    memory_percent: number;
    disk_total: number;
    disk_free: number;
    disk_percent: number;
    boot_time: string;
  };
  services: Record<"postgresql" | "cloudflared" | "tailscale" | "server", ServiceState>;
  backup: { last: (Partial<BackupInfo> & { ok?: boolean; error?: string | null; at?: string }) | null; directory: string };
  public_base_url: string | null;
}

// ------------------------------------------------------------------ //
// Thiết bị ESP32 + lệnh điều khiển qua Internet
// ------------------------------------------------------------------ //
export interface DeviceInfo {
  id: string;
  name: string;
  token_hint: string;
  firmware: string | null;
  capabilities: string[];
  supported_actions: string[];
  is_active: boolean;
  is_primary: boolean;
  online: boolean;
  last_seen_at: string | null;
  last_ip: string | null;
  last_state: Record<string, unknown> | null;
  note: string | null;
  created_at: string;
}

export interface DeviceConnection {
  websocket_url: string | null;
  public_base_url: string | null;
  note: string | null;
}

export interface DeviceList {
  items: DeviceInfo[];
  connection: DeviceConnection;
}

export interface DeviceTokenResult {
  device: DeviceInfo;
  /** Token thiết bị — chỉ hiển thị MỘT lần, máy chủ chỉ lưu băm SHA-256. */
  token: string;
  connection: DeviceConnection;
}

export type CommandStatus = "pending" | "sent" | "acknowledged" | "applied" | "failed" | "timed_out" | "cancelled";

export interface CommandAck {
  status: "received" | "applied" | "failed";
  message: string | null;
  payload: Record<string, unknown> | null;
  received_at: string;
}

export interface DeviceCommand {
  id: string;
  device_id: string;
  action: string;
  action_label: string;
  payload: Record<string, unknown>;
  status: CommandStatus;
  created_at: string;
  expires_at: string;
  sent_at: string | null;
  acknowledged_at: string | null;
  completed_at: string | null;
  attempts: number;
  error: string | null;
  result: Record<string, unknown> | null;
  final: boolean;
  delivered?: boolean;
  note?: string;
  acks?: CommandAck[];
}

export interface ActionSpec {
  action: string;
  label: string;
  schema: Record<string, unknown>;
}

export interface PendingNotifications {
  items: { kind: "reminder" | "alert"; title: string; body: string; route: string; severity?: Severity }[];
  windows_notifications: boolean;
  sound: boolean;
  unhandled_alerts: number;
}

// ---- Mã vạch → thuốc trong danh mục ---------------------------------------------------- //
export type BarcodeIssueReason = "ambiguous" | "unmatched" | "invalid" | "internal" | "conflict";

export interface BarcodeImportReport {
  dry_run: boolean;
  file_name: string;
  sheet: string;
  columns: Partial<Record<"barcode" | "registration" | "name" | "strength" | "unit" | "manufacturer", string>>;
  catalog_total: number;
  rows_total: number;
  rows_with_barcode: number;
  codes_total: number;
  matched_rows: number;
  by_registration: number;
  by_name: number;
  linked: number;
  unchanged: number;
  conflicts: number;
  ambiguous: number;
  unmatched: number;
  invalid: number;
  internal: number;
  import_id: number | null;
  issues: { row: number; barcode: string; registration: string | null; name: string | null; reason: BarcodeIssueReason; message: string }[];
  samples: { row: number; barcode: string; medicine_id: number; medicine_name: string; method: "registration" | "name" }[];
}

export interface BarcodeStatus {
  barcodes: number;
  medicines_with_barcode: number;
  catalog_total: number;
  last_import: {
    id: number; file_name: string; rows_total: number; linked: number; unchanged: number; conflicts: number;
    unmatched: number; invalid: number; started_by: string | null; created_at: string;
  } | null;
}

export interface BarcodeLookup {
  status: "found" | "not_found" | "invalid" | "internal" | "gtin";
  code: string;
  gtin: string | null;
  message: string;
  medicine: MedicineSummary | null;
  link: { source: "excel" | "csdlduoc"; match_method: "registration" | "name"; unit: string | null; import_id: number | null } | null;
}

// ---- AI tra cứu trên mạng (Gemini + Google Search; khóa chỉ nằm trên máy chủ) ---------------- //
export interface AiMedicineInfo {
  found: boolean;
  ten_thuoc: string | null;
  hoat_chat: string | null;
  ham_luong: string | null;
  dang_bao_che: string | null;
  quy_cach: string | null;
  so_dang_ky: string | null;
  nha_san_xuat: string | null;
  nuoc_san_xuat: string | null;
  do_tin_cay: "cao" | "trung_binh" | "thap";
  ghi_chu: string | null;
}

export interface AiLookupResult {
  status: "found" | "not_found" | "unavailable" | "not_configured";
  kind: "barcode" | "qr" | "scan";
  /** web: AI + Google Search; offline: AI chỉ đọc ảnh/mã; search: tìm kiếm web (Tavily) không AI; text: đọc số đăng ký trong mã. */
  mode: "web" | "offline" | "search" | "text" | null;
  model: string | null;
  cached: boolean;
  elapsed_ms: number;
  result: AiMedicineInfo | null;
  sources: { title: string; url: string }[];
  catalog_matches: (MedicineSummary & { match_by: "registration" | "name" })[];
  message: string;
  reason: string | null;
  notice: string;
}

export interface AiStatus {
  /** Nguồn tra cứu trên mạng (SMC_LOOKUP_PROVIDER): chỉ Tavily (không AI) | Gemini trước rồi Tavily | chỉ Gemini. */
  provider?: "tavily" | "auto" | "gemini";
  /** Đã có khóa Gemini trong server.env (kể cả khi đang không dùng). */
  configured: boolean;
  models: string[];
  search_available: boolean;
  last_error: string | null;
  /** Tra mã vạch trên mạng không dùng AI (Tavily). */
  web_search?: { provider: string; configured: boolean; last_error: string | null };
}
