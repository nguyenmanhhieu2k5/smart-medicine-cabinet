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

export type HistoryGroup = "scan" | "cabinet" | "reminder" | "alert" | "system";

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
  mode: "http" | "websocket";
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
  esp32_enabled: boolean;
  esp32_mode: "http" | "websocket";
  esp32_host: string;
  esp32_port: number;
  esp32_path: string;
  esp32_poll_seconds: number;
  esp32_timeout_seconds: number;
  esp32_stale_seconds: number;
  esp32_token_set: boolean;
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

export type SettingsPatch = Partial<Omit<AppSettings, "esp32_token_set" | "profile_avatar">> & { esp32_token?: string | null };

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
  has_avatar: boolean;
  auth: { provider: "local" | "supabase"; configured: boolean; signed_in: boolean; email: string | null; user_id: string | null };
}

export interface BackupInfo {
  name: string;
  size: number;
  created_at: string;
}

export interface PendingNotifications {
  items: { kind: "reminder" | "alert"; title: string; body: string; route: string; severity?: Severity }[];
  windows_notifications: boolean;
  sound: boolean;
  unhandled_alerts: number;
}
