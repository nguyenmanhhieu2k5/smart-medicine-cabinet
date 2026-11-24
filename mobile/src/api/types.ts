/** Kiểu dữ liệu của API công khai /api/v1 (backend/app/api/public.py). */

export interface AppConfig {
  registration_enabled: boolean;
  password_reset_enabled: boolean;
  providers: { password: boolean; google: boolean; apple: boolean; phone: boolean };
  max_upload_mb: number;
  ocr_timeout_seconds: number;
  max_candidates: number;
  server_version: string;
}

export interface UserPreferences {
  vibrate_on_scan?: boolean;
  image_quality?: "high" | "standard";
  [key: string]: unknown;
}

export interface User {
  id: string;
  email: string;
  full_name: string;
  phone: string | null;
  /** Trên ứng dụng di động luôn là SCANNER (kể cả tài khoản quản trị). */
  role: "SCANNER";
  role_name: string;
  account_role?: string;
  permissions: string[];
  created_at: string | null;
  last_login_at: string | null;
  preferences?: UserPreferences;
  scan_count?: number;
}

export interface TokenResponse {
  access_token: string;
  token_type: "bearer";
  expires_in: number;
  refresh_token: string;
  user: User;
}

export interface MedicineSummary {
  id: number;
  ten_thuoc: string;
  hoat_chat_chinh: string | null;
  ham_luong: string | null;
  dang_bao_che: string | null;
  so_dang_ky: string | null;
  ten_cong_ty_san_xuat?: string | null;
  nuoc_san_xuat?: string | null;
  dong_goi?: string | null;
  registration_status?: { code: string; label: string } | null;
}

export interface MedicineDetail extends MedicineSummary {
  ten_cong_ty_dang_ky?: string | null;
  nuoc_dang_ky?: string | null;
  ten_duong_dung?: string | null;
  tuoi_tho?: string | null;
  ngay_het_han_so_dang_ky?: string | null;
  source: string;
  read_only: true;
}

export type CandidateLevel = "high" | "medium" | "low";

export interface Candidate {
  rank: number;
  medicine: MedicineSummary;
  score: number;
  level: CandidateLevel;
  level_label: string;
}

export type MatchStatus = "confident" | "uncertain" | "no_text" | "no_match" | "no_catalog";
export type JobStatus = "queued" | "preprocessing" | "recognizing" | "matching" | "done" | "error" | "cancelled";

export interface ScanStage {
  key: "image" | "ocr" | "lookup" | "summary";
  label: string;
  state: "done" | "active" | "pending" | "failed";
}

export interface ScanJob {
  id: string;
  status: JobStatus;
  progress: number;
  message: string;
  stages: ScanStage[] | null;
  created_at: string;
  finished_at: string | null;
  error: string | null;
  history_id?: string | null;
  result: {
    match: { status: MatchStatus; message: string; reasons: string[]; candidates: Candidate[] };
    ocr_text: string[];
    expiry_suggestion: unknown;
    elapsed_ms: number;
  } | null;
}

export type HistoryStatus = "confident" | "uncertain" | "no_text" | "no_match" | "no_catalog" | "failed" | "cancelled";

export interface HistoryItem {
  id: string;
  job_id: string | null;
  status: HistoryStatus;
  title: string;
  subtitle: string | null;
  candidate_count: number;
  top_medicine_id: number | null;
  selected_medicine_id: number | null;
  created_at: string;
  has_thumbnail: boolean;
}

export interface HistoryPage {
  items: HistoryItem[];
  has_more: boolean;
  next_before: string | null;
}

export type HistoryFilter = "all" | "found" | "multiple" | "unrecognized" | "failed";

/** Kết quả tra mã vạch (POST /barcodes/lookup). `gs1` = hạn dùng/số lô đọc từ mã 2D DataMatrix (nếu có). */
export interface BarcodeResult {
  status: "found" | "not_found" | "invalid" | "internal";
  code: string;
  gtin: string | null;
  gs1: { expiry: string | null; lot: string | null; serial: string | null } | null;
  medicine: MedicineSummary | null;
  history_id: string | null;
  message: string;
}

/** Thông tin thuốc do AI (Gemini + Google Search) tổng hợp — chỉ thông tin nhận dạng, không có liều dùng. */
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
  /** web: AI đã tra trên mạng; offline: AI chỉ đọc ảnh/nội dung mã; search: tìm kiếm web (Tavily) không dùng AI; text: đọc số đăng ký trong mã. */
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

/** Thuốc trong tủ — tài khoản Scanner chỉ xem và sửa ngày hết hạn (không thêm/xóa/sửa gì khác). */
export type ExpiryStatus = "ok" | "expiring" | "expired" | "unknown";

export interface CabinetMedicine {
  id: number;
  catalog_id: number | null;
  name: string;
  ingredient: string | null;
  strength: string | null;
  dosage_form: string | null;
  registration_no: string | null;
  manufacturer: string | null;
  quantity_text: string;
  expiry_date: string | null;
  expiry_source: string | null;
  expiry_status: ExpiryStatus;
  expiry_status_label: string;
  days_left: number | null;
  lot_number: string | null;
  updated_at: string;
}

export interface CabinetList {
  items: CabinetMedicine[];
  total: number;
  counts: Record<"all" | ExpiryStatus | "low_stock", number>;
}
