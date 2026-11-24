/**
 * Chuyển thông tin thuốc (dữ liệu DAV, viết tắt kiểu dược) thành câu tiếng Việt để bộ đọc của máy đọc tự nhiên:
 * "500.000 IU" → "500000 đơn vị quốc tế", "0,6g/300ml" → "0,6 gam trong 300 mi li lít",
 * "Hộp 3 vỉ x 10 viên" → "Hộp 3 vỉ, mỗi vỉ 10 viên", số đăng ký đọc từng chữ số.
 */
import type { MedicineDetail } from "@/api/types";

const UNIT_WORDS: Record<string, string> = {
  mcg: "mi crô gam", "µg": "mi crô gam", "μg": "mi crô gam", mg: "mi li gam", kg: "ki lô gam", g: "gam",
  mmol: "mi li mol", ml: "mi li lít", l: "lít", "i.u.": "đơn vị quốc tế", iu: "đơn vị quốc tế", ui: "đơn vị quốc tế",
};
const UNIT = "mcg|µg|μg|mg|kg|mmol|ml|g|l|i\\.u\\.|iu|ui";
// Sau đơn vị không được là chữ cái (để "1 lọ", "2 lần" không bị hiểu là "l").
const NOT_LETTER = "(?![a-zà-ỹđ])";
const unitWord = (u: string) => UNIT_WORDS[u.toLowerCase()] ?? u;

/** Chuẩn hoá chữ viết tắt/đơn vị/số trong một trường thông tin thuốc. */
export function speakableText(raw: string | null | undefined): string {
  let s = (raw ?? "").trim();
  if (!s) return "";
  // Máy chủ cắt chuỗi quá dài kèm "…" (hàm lượng > 90 ký tự): bỏ luôn chữ/số bị cắt dở ("Kali c…", "1,…")
  // — đọc "1" thay cho "1,7 mg" là sai thông tin.
  s = s.replace(/\s*(?:[^\s,;()]|\d,)*(?:…|\.\.\.)$/u, "");
  // Chú thích kỹ thuật không cần đọc: w/v, w/w, kl/kl (có hoặc không có ngoặc), "(mcg)" lặp lại đơn vị…
  s = s.replace(/\b(?:w\/v|w\/w|v\/v|kl\/kl|kl\/tt|tt\/tt)\b/giu, " ");
  s = s.replace(/\(\s*(?:mcg|µg)\s*\)/giu, " ");
  // Dấu chấm phân cách hàng nghìn (500.000) — trừ khi phần nguyên là 0 (0.125 là số thập phân).
  s = s.replace(/(\d+)((?:\.\d{3})+)(?![\d.])/g, (m, int: string, rest: string) => (/^0+$/.test(int) ? m : int + rest.replace(/\./g, "")));
  s = s.replace(/(\d)\.(\d)/g, "$1,$2"); // thập phân kiểu Việt: 0,5
  s = s.replace(/(^|[^\d,])0+(?=\d)/g, "$1"); // "01 vỉ" → "1 vỉ" (giữ 0,05)
  // Dấu "/": "100mg/5ml" → "trong 5 ml"; "20mg/ml" → "mỗi ml"; còn lại (tên/thành phần ghép) → ngắt nghỉ.
  s = s.replace(new RegExp(`\\s*\\/\\s*(?=\\d+(?:,\\d+)?\\s*(?:ml|g|l)${NOT_LETTER})`, "giu"), " trong ");
  s = s.replace(new RegExp(`\\s*\\/\\s*(?=(?:${UNIT}|liều|viên|gói|ống|lọ)${NOT_LETTER})`, "giu"), " mỗi ");
  s = s.replace(/\s*\/\s*/g, ", ");
  // Đơn vị sau số, và sau "mỗi"/"trong".
  s = s.replace(new RegExp(`(\\d)\\s*(${UNIT})${NOT_LETTER}`, "giu"), (_m, d: string, u: string) => `${d} ${unitWord(u)}`);
  s = s.replace(new RegExp(`(mỗi|trong)\\s+(${UNIT})${NOT_LETTER}`, "giu"), (_m, w: string, u: string) => `${w} ${unitWord(u)}`);
  s = s.replace(/\s*%/g, " phần trăm");
  s = s.replace(/\s*\+\s*/g, " và ");
  s = s.replace(/\s*;\s*/g, ", ");
  s = s.replace(/([A-Za-z0-9])-(?=[A-Za-z0-9])/g, "$1 "); // "Majegra-100" → "Majegra 100"
  s = s.replace(/\s*[()[\]]\s*/g, ", "); // ngoặc → chỗ ngắt nghỉ
  s = s.replace(/\s+/g, " ").replace(/\s+([,.])/g, "$1").replace(/,(?:\s*,)+/g, ",");
  // Dấu phẩy ngắt câu luôn có khoảng trắng sau; dấu phẩy thập phân (0,5) giữ nguyên.
  s = s.replace(/,(?=[^\s\d])/g, ", ").replace(/(\D),(?=\d)/g, "$1, ");
  return s.trim().replace(/^[,;\s]+|[,;\s]+$/g, "");
}

const CONTAINERS = "vỉ|lọ|ống|gói|chai|tuýp|túi|hộp|bút|bơm tiêm|can|thùng";

/** Đóng gói: chỉ đọc quy cách đầu tiên (dữ liệu có khi liệt kê hàng chục quy cách). */
export function speakablePackaging(raw: string | null | undefined): string {
  const all = (raw ?? "").trim();
  if (!all) return "";
  const options = all.split(/[;,]/).map((p) => p.trim()).filter(Boolean);
  let first = options[0] ?? "";
  first = first.replace(new RegExp(`(\\d+)\\s*(${CONTAINERS})\\s*[x×]\\s*`, "giu"), (_m, n: string, c: string) => `${n} ${c}, mỗi ${c.toLowerCase()} `);
  first = first.replace(/\s+[x×]\s+/giu, " nhân ");
  const text = speakableText(first);
  return options.length > 1 ? `${text}, và các quy cách khác` : text;
}

/** Số đăng ký: đọc từng ký tự ("890114134326" → "8 9 0, 1 1 4, …"; "VD-12345-22" → "V D, 1 2 3 4 5, 2 2"). */
export function spellCode(raw: string | null | undefined): string {
  const tokens = (raw ?? "").trim().split(/[-\s/._]+/).filter(Boolean);
  const groups: string[] = [];
  for (const token of tokens) {
    // Chỉ chia nhóm 3 cho dãy số dài (số đăng ký 12 chữ số); dãy ngắn đọc liền một hơi.
    if (/^\d{9,}$/.test(token)) {
      for (let i = 0; i < token.length; i += 3) groups.push(token.slice(i, i + 3).split("").join(" "));
    } else {
      groups.push(token.split("").join(" "));
    }
  }
  return groups.join(", ");
}

/** "2027-01-31" → "ngày 31 tháng 1 năm 2027". */
export function speakableDate(iso: string | null | undefined): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso ?? "");
  return m ? `ngày ${Number(m[3])} tháng ${Number(m[2])} năm ${m[1]}` : "";
}

/** Thông tin riêng của hộp đang cầm (đọc từ mã 2D DataMatrix): hạn dùng, số lô. */
export interface BoxInfo {
  expiry?: string | null;
  lot?: string | null;
}

/** Toàn bộ nội dung đọc cho màn Chi tiết thuốc — đúng các thông tin đang hiện trên màn hình. */
export function medicineSpeechText(d: MedicineDetail, box: BoxInfo = {}): string {
  const sentences: string[] = [`Tên thuốc: ${speakableText(d.ten_thuoc)}.`];
  const add = (label: string, value: string) => {
    if (value) sentences.push(`${label}: ${value}.`);
  };
  // Hạn dùng của chính hộp thuốc quan trọng nhất với người dùng → đọc ngay sau tên.
  add("Hạn dùng của hộp này", speakableDate(box.expiry));
  add("Số lô", spellCode(box.lot));
  const activeIngredient = speakableText(d.hoat_chat_chinh);
  let strength = speakableText(d.ham_luong);
  // Hàm lượng ghi đủ thành phần thường trùng với hoạt chất — không đọc hai lần cùng một đoạn dài.
  if (strength.length >= 15 && activeIngredient.toLowerCase().includes(strength.toLowerCase())) strength = "";
  add("Hàm lượng", strength);
  add("Dạng bào chế", speakableText(d.dang_bao_che));
  add("Hoạt chất chính", activeIngredient);
  add("Đóng gói", speakablePackaging(d.dong_goi));
  add("Số đăng ký", spellCode(d.so_dang_ky));
  if (d.registration_status?.label && d.registration_status.code !== "unknown") sentences.push(`${d.registration_status.label}.`);
  const maker = speakableText(d.ten_cong_ty_san_xuat);
  const registrant = speakableText(d.ten_cong_ty_dang_ky);
  const country = speakableText(d.nuoc_san_xuat);
  if (maker) sentences.push(`Sản xuất bởi ${maker}${country ? `, ${country}` : ""}.`);
  else if (country) add("Nước sản xuất", country);
  if (registrant && registrant.toLowerCase() !== maker.toLowerCase()) add("Công ty đăng ký", registrant);
  sentences.push("Đọc kỹ hướng dẫn sử dụng trước khi dùng.");
  return sentences.join(" ");
}
