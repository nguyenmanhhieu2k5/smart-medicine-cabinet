import type { MedicineDetail } from "@/api/types";
import { medicineSpeechText, speakablePackaging, speakableText, spellCode } from "./medicineSpeech";

describe("Chuẩn hoá chữ để đọc (mẫu lấy từ dữ liệu DAV thật)", () => {
  it.each([
    ["500mg", "500 mi li gam"],
    ["10 mg", "10 mi li gam"],
    ["875mg/125mg", "875 mi li gam, 125 mi li gam"],
    ["20mg/ml", "20 mi li gam mỗi mi li lít"],
    ["Ibuprofen 100mg/5ml", "Ibuprofen 100 mi li gam trong 5 mi li lít"],
    ["0,6g/300ml", "0,6 gam trong 300 mi li lít"],
    ["10mg/10ml", "10 mi li gam trong 10 mi li lít"],
    ["1mg/1g (0,1 % (w/w))", "1 mi li gam trong 1 gam, 0,1 phần trăm"],
    ["(5% kl/kl) 1,5g/30g", "5 phần trăm, 1,5 gam trong 30 gam"],
    ["0,0568% (w/w) (tương đương clobetasol 0,05%)", "0,0568 phần trăm, tương đương clobetasol 0,05 phần trăm"],
    ["100µg (mcg)", "100 mi crô gam"],
    ["5% (w/v)", "5 phần trăm"],
    ["500.000 IU", "500000 đơn vị quốc tế"],
    ["20 IU/ml", "20 đơn vị quốc tế mỗi mi li lít"],
    ["Oxytocin Panpharma 10 i.u./ml Solution for injection", "Oxytocin Panpharma 10 đơn vị quốc tế mỗi mi li lít Solution for injection"],
    ["0.125mg", "0,125 mi li gam"],
    ["0,0568% (w/w)", "0,0568 phần trăm"],
    ["Majegra-100", "Majegra 100"],
    ["Betamethasone/Dexchlorpheniramine maleate", "Betamethasone, Dexchlorpheniramine maleate"],
    ["Paracetamol + Cafein", "Paracetamol và Cafein"],
    ["Amoxicillin; Acid clavulanic", "Amoxicillin, Acid clavulanic"],
    ["Nafarein 50 mg/g", "Nafarein 50 mi li gam mỗi gam"],
    [null, ""],
  ])("%s → %s", (raw, expected) => {
    expect(speakableText(raw)).toBe(expected);
  });

  it("không nhầm chữ thường thành đơn vị", () => {
    expect(speakableText("Hộp 1 lọ")).toBe("Hộp 1 lọ");
    expect(speakableText("Uống 2 lần")).toBe("Uống 2 lần");
    expect(speakableText("Hộp 1 Lọ")).toBe("Hộp 1 Lọ");
  });
});

describe("Đóng gói", () => {
  it.each([
    ["Hộp 3 vỉ x 10 viên", "Hộp 3 vỉ, mỗi vỉ 10 viên"],
    ["01 vỉ x 01 viên", "1 vỉ, mỗi vỉ 1 viên"],
    ["Hộp 10 ống x 1ml", "Hộp 10 ống, mỗi ống 1 mi li lít"],
    ["Hộp 1 tuýp x 30 gam", "Hộp 1 tuýp, mỗi tuýp 30 gam"],
    ["Hộp  3  x 10 viên", "Hộp 3 nhân 10 viên"],
    ["Hộp 30 viên", "Hộp 30 viên"],
    ["Hộp 1 tuýp 15g; Hộp 1 tuýp 30g", "Hộp 1 tuýp 15 gam, và các quy cách khác"],
    ["Hộp 3 vỉ x 10 viên, hộp 6 vỉ x 10 viên", "Hộp 3 vỉ, mỗi vỉ 10 viên, và các quy cách khác"],
  ])("%s → %s", (raw, expected) => {
    expect(speakablePackaging(raw)).toBe(expected);
  });
});

describe("Số đăng ký đọc từng ký tự", () => {
  it.each([
    ["890114134326", "8 9 0, 1 1 4, 1 3 4, 3 2 6"],
    ["VD-12345-22", "V D, 1 2 3 4 5, 2 2"],
    ["VN-20169-16", "V N, 2 0 1 6 9, 1 6"],
    ["VN-1234", "V N, 1 2 3 4"],
  ])("%s → %s", (raw, expected) => {
    expect(spellCode(raw)).toBe(expected);
  });
});

describe("Nội dung đọc của màn Chi tiết thuốc", () => {
  const base: MedicineDetail = {
    id: 1, ten_thuoc: "Paracetamol 500", hoat_chat_chinh: "Paracetamol", ham_luong: "500mg", dang_bao_che: "Viên nén",
    so_dang_ky: "893110103026", dong_goi: "Hộp 10 vỉ x 10 viên", ten_cong_ty_san_xuat: "Công ty Dược Hậu Giang",
    ten_cong_ty_dang_ky: "Công ty Dược Hậu Giang", nuoc_san_xuat: "Việt Nam",
    registration_status: { code: "valid", label: "Số đăng ký còn hiệu lực" }, source: "DAV_unique", read_only: true,
  };

  it("đọc đủ thông tin đang hiện, theo thứ tự dễ nghe", () => {
    expect(medicineSpeechText(base)).toBe(
      "Tên thuốc: Paracetamol 500. Hàm lượng: 500 mi li gam. Dạng bào chế: Viên nén. Hoạt chất chính: Paracetamol. "
        + "Đóng gói: Hộp 10 vỉ, mỗi vỉ 10 viên. Số đăng ký: 8 9 3, 1 1 0, 1 0 3, 0 2 6. Số đăng ký còn hiệu lực. "
        + "Sản xuất bởi Công ty Dược Hậu Giang, Việt Nam. Đọc kỹ hướng dẫn sử dụng trước khi dùng.",
    );
  });

  it("quét mã 2D có hạn dùng và số lô → đọc ngay sau tên thuốc", () => {
    const text = medicineSpeechText(base, { expiry: "2027-01-31", lot: "LOT42" });
    expect(text).toMatch(/^Tên thuốc: Paracetamol 500\. Hạn dùng của hộp này: ngày 31 tháng 1 năm 2027\. Số lô: L O T 4 2\. Hàm lượng/);
    expect(medicineSpeechText(base)).not.toContain("Hạn dùng");
  });

  it("bỏ qua trường trống; đọc công ty đăng ký khi khác công ty sản xuất", () => {
    const text = medicineSpeechText({
      ...base, ham_luong: null, dong_goi: null, registration_status: { code: "unknown", label: "Không có thông tin" },
      ten_cong_ty_dang_ky: "Công ty ABC",
    });
    expect(text).not.toContain("Hàm lượng");
    expect(text).not.toContain("Đóng gói");
    expect(text).not.toContain("Không có thông tin");
    expect(text).toContain("Công ty đăng ký: Công ty ABC.");
  });

  it("hàm lượng bị máy chủ cắt (…) và trùng hoạt chất → chỉ đọc hoạt chất, không đọc chữ cắt dở", () => {
    const text = medicineSpeechText({
      ...base,
      hoat_chat_chinh: "Amoxicillin (dưới dạng Amoxicillin trihydrate) 500mg; Acid clavulanic (dưới dạng Kali clavulanate) 125mg",
      ham_luong: "Amoxicillin (dưới dạng Amoxicillin trihydrate) 500mg; Acid clavulanic (dưới dạng Kali c…",
    });
    expect(text).not.toContain("Hàm lượng");
    expect(text).not.toContain("…");
    expect(text).toContain("Hoạt chất chính: Amoxicillin, dưới dạng Amoxicillin trihydrate, 500 mi li gam, Acid clavulanic, dưới dạng Kali clavulanate, 125 mi li gam.");
    expect(speakableText("Vitamin A 5000 IU; Vitamin D3 400 IU; Vitamin E 10 mg; Vitamin C 60 mg; Vitamin B1 1,5 mg; Vitamin B2 1,…"))
      .toBe("Vitamin A 5000 đơn vị quốc tế, Vitamin D3 400 đơn vị quốc tế, Vitamin E 10 mi li gam, Vitamin C 60 mi li gam, Vitamin B1 1,5 mi li gam, Vitamin B2");
  });
});
