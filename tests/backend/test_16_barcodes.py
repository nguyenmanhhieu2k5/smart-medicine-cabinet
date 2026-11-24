"""Mã vạch: đọc chuẩn GS1, nhập liên kết mã vạch → danh mục DAV từ file nhà thuốc, tra cứu ở hai kênh.

Danh mục mẫu (tests/fixtures/catalog_sample.xlsx) có sẵn các ca khó lấy từ dữ liệu thật:
- 893110039224 ứng với 2 thuốc khác tên (Cao khô ngải cứu / Atilair sac) → phân định bằng tên;
- VN-19068-15 ứng với 2 bản ghi "Efferalgan" giống hệt → không phân định được → báo lại;
- "Augmentin 625mg tablets" có 2 số đăng ký → chỉ có tên thì không được đoán.
"""
from __future__ import annotations

import io
from datetime import date

import pytest
from openpyxl import Workbook
from sqlalchemy import func, select

from app.core import clock
from app.models import AuditLog, BarcodeImport, CatalogBarcode, ScanHistory
from app.services.barcode.gs1 import GS, check_digit, parse_code, parse_gs1_date, split_codes
from app.services.barcode.importer import (
    BarcodeImporter, BarcodeImportError, Candidate, SourceRow, _pick, detect_columns, maker_tokens, same_maker,
)

from .conftest import AUGMENTIN_1G, AUGMENTIN_625, FOGICAP_40

ATILAIR = 19924


def ean(body12: str) -> str:
    return body12 + str(check_digit(body12))


A, B, C, D = ean("893520601012"), ean("893520601013"), ean("893520601014"), ean("893520601015")
E, F, G, H = ean("893520601016"), ean("893520601017"), ean("893520601018"), ean("893520601019")
I = ean("893520601020")  # noqa: E741 — mã dùng cho ca xung đột trong cùng file
INTERNAL = ean("200000000001")


# --------------------------------------------------------------------------- #
# Chuẩn GS1
# --------------------------------------------------------------------------- #
class TestGs1:
    def test_ean13_valid_and_canonical(self):
        p = parse_code(A)
        assert p.kind == "gtin" and p.gtin == "0" + A and p.display == A

    def test_wrong_check_digit_is_invalid(self):
        bad = A[:-1] + str((int(A[-1]) + 1) % 10)
        assert parse_code(bad).kind == "invalid"

    def test_upc_and_lost_leading_zero_map_to_same_gtin(self):
        # Excel lưu mã dạng số làm mất số 0 đầu của EAN-13 "0036000291452" → còn 12 số (UPC-A) — vẫn cùng GTIN.
        assert parse_code("0036000291452").gtin == parse_code("036000291452").gtin == "00036000291452"

    def test_upce_expands(self):
        assert parse_code("04252614").gtin == parse_code("042100005264").gtin

    def test_internal_store_code(self):
        p = parse_code(INTERNAL)
        assert p.kind == "internal" and "nội bộ" in p.message

    def test_datamatrix_raw_with_group_separator(self):
        gtin14 = "0" + A
        p = parse_code(f"]d201{gtin14}17270100" + f"10LOT42{GS}21SER-1")
        assert (p.kind, p.gtin, p.expiry, p.lot, p.serial) == ("gtin", gtin14, date(2027, 1, 31), "LOT42", "SER-1")

    def test_human_readable_element_string(self):
        p = parse_code(f"(01)0{A}(17)271231(10)A1")
        assert p.gtin == "0" + A and p.expiry == date(2027, 12, 31) and p.lot == "A1"

    def test_gs1_digital_link_qr(self):
        p = parse_code(f"https://id.gs1.org/01/0{A}/10/AB12?17=270630")
        assert p.gtin == "0" + A and p.lot == "AB12" and p.expiry == date(2027, 6, 30)

    def test_plain_qr_url_is_not_a_product_code(self):
        assert parse_code("https://example.com/khuyen-mai").kind == "invalid"

    def test_gs1_date(self):
        assert parse_gs1_date("270200") == date(2027, 2, 28)
        assert parse_gs1_date("271301") is None

    def test_split_cells_from_excel(self):
        assert split_codes(8935206010120) == ["8935206010120"]
        assert split_codes(8935206010120.0) == ["8935206010120"]
        assert split_codes(f"{A}; {B}") == [A, B]
        assert split_codes(None) == [] and split_codes("") == []
        assert split_codes("8.93521E+12") == ["8.93521E+12"]


def test_detect_columns_vietnamese_and_english():
    assert detect_columns(["STT", "Mã vạch", "Tên hàng hóa", "Hàm lượng", "Số ĐK", "ĐVT"]) == {
        "barcode": 1, "name": 2, "strength": 3, "registration": 4, "unit": 5}
    cols = detect_columns(["Barcode (EAN-13)", "Product name", "Registration number", "Manufacturer"])
    assert cols == {"barcode": 0, "name": 1, "registration": 2, "manufacturer": 3}
    # "Ngày sản xuất", "Nước sản xuất", "NSX" không phải cột hãng sản xuất.
    assert "manufacturer" not in detect_columns(["Mã vạch", "Tên thuốc", "Ngày sản xuất", "Nước sản xuất", "NSX"])
    assert detect_columns(["Mã vạch", "Tên thuốc", "Hãng sản xuất"])["manufacturer"] == 2


def test_same_maker_ignores_legal_suffixes_but_not_different_companies():
    # Hai cách ghi của cùng hãng trong danh mục DAV thật (M-M-R II, id 48504 và 53580).
    a = maker_tokens("Nhà sản xuất: Merck Sharp & Dohme Corp; Cơ sở sản xuất dung môi: Jubilant HollisterStier LLC")
    b = maker_tokens("Cơ sở sản xuất và đóng gói cấp 1: Merck Sharp & Dohme LLC; Cơ sở đóng gói cấp 2: Merck Sharp Dohme B.V.")
    assert same_maker(a, b)
    # Cefradine 1g, cùng số đăng ký VN-19087-15 nhưng hai công ty khác nhau (id 33778 và 34630).
    assert not same_maker(maker_tokens("Shandong Lukang Pharmaceutical Co., Ltd."),
                          maker_tokens("Công ty TNHH Dược phẩm Hiệp Thuận Thành"))
    assert same_maker(maker_tokens("Công ty cổ phần dược phẩm Tipharco"), maker_tokens("CTCP Dược phẩm TIPHARCO"))


def _cand(mid: int, maker: str, valid: bool) -> Candidate:
    return Candidate(mid, "Cefradine for injection 1g", "cefradine for injection 1g", "cefradine", {"1g"}, valid, maker_tokens(maker))


def test_pick_never_guesses_between_different_manufacturers():
    row = SourceRow(row=2, codes=[A], registration="VN-19087-15", name="Cefradine for injection 1g", strength=None, unit=None)
    pool = [_cand(33778, "Shandong Lukang Pharmaceutical Co., Ltd.", False), _cand(34630, "Công ty TNHH Dược phẩm Hiệp Thuận Thành", True)]
    assert _pick(pool, row) == (None, 2)
    # Cùng hãng (đăng ký lại) → lấy bản còn hiệu lực.
    same = [_cand(28550, "Chinoin Pharmaceutical and Chemical Works Private Co. Ltd.", False),
            _cand(53707, "Chinoin Pharmaceutical and Chemical Works Private Co. Ltd.", True)]
    assert _pick(same, row)[0].id == 53707
    # File có cột hãng sản xuất → phân định được cả khi khác hãng.
    row.manufacturer = "Shandong Lukang"
    assert _pick(pool, row)[0].id == 33778


# --------------------------------------------------------------------------- #
# Nhập file của nhà thuốc
# --------------------------------------------------------------------------- #
def pharmacy_xlsx(rows: list[list[object]], header: list[str] | None = None) -> bytes:
    wb = Workbook()
    ws = wb.active
    ws.append(["DANH MỤC HÀNG HÓA — NHÀ THUỐC MẪU"])  # dòng tiêu đề trước bảng, như file xuất từ phần mềm
    ws.append([])
    ws.append(header or ["STT", "Mã vạch", "Tên hàng hóa", "Hàm lượng", "Số ĐK", "ĐVT"])
    for i, r in enumerate(rows, start=1):
        ws.append([i, *r])
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


ROWS: list[list[object]] = [
    [int(A), "Augmentin 625mg tablets", None, "vn-20169-16", "Hộp"],  # số ĐK viết thường → 34382
    [f"{B}; {C}", "Fogicap 40", None, "VD-34703-20", "Hộp"],  # SỐ ĐK CŨ, 2 mã trong một ô → 52211
    [D, "Atilair sac", None, "893110039224", "Hộp"],  # số ĐK trùng 2 thuốc → phân định bằng tên → 19924
    [E, "Efferalgan", None, "VN-19068-15", "Hộp"],  # 2 bản ghi giống hệt → không đoán
    [F, "Augmentin 1g", None, None, "Hộp"],  # không có số ĐK, tên khớp duy nhất → 34381 (theo tên)
    [G, "Augmentin 625mg tablets", None, None, "Hộp"],  # chỉ có tên, 2 số ĐK → không đoán
    [H, "Thuốc không có trong danh mục", None, "VD-99999-99", "Hộp"],
    [A[:-1] + str((int(A[-1]) + 1) % 10), "Augmentin 1g", None, "VN-20517-17", "Hộp"],  # sai số kiểm tra
    [INTERNAL, "Augmentin 1g", None, "VN-20517-17", "Vỉ"],  # mã nội bộ của nhà thuốc
    [I, "Augmentin 1g", None, "VN-20517-17", "Hộp"],  # cùng mã I…
    [I, "Fogicap 40", None, "893110205525", "Hộp"],  # …gắn 2 thuốc khác nhau → bỏ cả hai
    [None, "Paracetamol 500mg", None, None, "Hộp"],  # dòng không có mã vạch
]


@pytest.fixture
def pharmacy_file(tmp_path):
    path = tmp_path / "danh_muc_nha_thuoc.xlsx"
    path.write_bytes(pharmacy_xlsx(ROWS))
    return path


def _count(db, model) -> int:
    with db.session() as s:
        return s.scalar(select(func.count()).select_from(model))


def test_dry_run_reports_everything_and_writes_nothing(db, pharmacy_file):
    r = BarcodeImporter(db).run(pharmacy_file, dry_run=True)
    assert r.columns == {"barcode": "Mã vạch", "name": "Tên hàng hóa", "strength": "Hàm lượng", "registration": "Số ĐK", "unit": "ĐVT"}
    assert (r.rows_total, r.rows_with_barcode) == (12, 11)
    assert (r.matched_rows, r.by_registration, r.by_name) == (8, 7, 1)
    assert (r.ambiguous, r.unmatched, r.invalid, r.internal, r.conflicts) == (2, 1, 1, 1, 1)
    assert r.linked == 5  # A, B, C, D, F
    reasons = {(i["row"], i["reason"]) for i in r.issues}
    assert {(7, "ambiguous"), (9, "ambiguous"), (10, "unmatched"), (11, "invalid"), (12, "internal"), (14, "conflict")} <= reasons
    assert any("55" not in i["message"] and "không có trong danh mục" in i["message"] for i in r.issues if i["reason"] == "unmatched")
    assert _count(db, CatalogBarcode) == 0 and _count(db, BarcodeImport) == 0


def test_commit_links_only_existing_catalog_medicines(db, pharmacy_file):
    r = BarcodeImporter(db).run(pharmacy_file, dry_run=False, started_by="admin@example.com")
    assert r.linked == 5 and r.import_id
    with db.session() as s:
        links = {b.gtin: (b.medicine_id, b.match_method, b.unit) for b in s.scalars(select(CatalogBarcode))}
        rec = s.get(BarcodeImport, r.import_id)
        assert (rec.linked, rec.started_by) == (5, "admin@example.com")
    assert links == {
        "0" + A: (AUGMENTIN_625, "registration", "Hộp"),
        "0" + B: (FOGICAP_40, "registration", "Hộp"),
        "0" + C: (FOGICAP_40, "registration", "Hộp"),
        "0" + D: (ATILAIR, "registration", "Hộp"),
        "0" + F: (AUGMENTIN_1G, "name", "Hộp"),
    }
    # Chạy lại: không nhân đôi.
    again = BarcodeImporter(db).run(pharmacy_file, dry_run=False)
    assert (again.linked, again.unchanged) == (0, 5)
    assert _count(db, CatalogBarcode) == 5


def test_existing_link_is_never_overwritten(db, pharmacy_file, tmp_path):
    BarcodeImporter(db).run(pharmacy_file, dry_run=False)
    other = tmp_path / "nha_thuoc_khac.xlsx"
    other.write_bytes(pharmacy_xlsx([[A, "Augmentin 1g", None, "VN-20517-17", "Hộp"]]))
    r = BarcodeImporter(db).run(other, dry_run=False)
    assert (r.linked, r.conflicts) == (0, 1)
    assert "đã gắn với thuốc khác" in r.issues[0]["message"]
    with db.session() as s:
        assert s.get(CatalogBarcode, "0" + A).medicine_id == AUGMENTIN_625


def test_csv_with_english_headers(db, tmp_path):
    path = tmp_path / "export.csv"
    path.write_text(f"Barcode;Product name;Registration number\n{A};Augmentin 625mg tablets;VN-20169-16\n", encoding="utf-8-sig")
    r = BarcodeImporter(db).run(path, dry_run=True)
    assert (r.matched_rows, r.linked) == (1, 1)


def test_excel_scientific_notation_is_explained(db, tmp_path):
    path = tmp_path / "hong.xlsx"
    path.write_bytes(pharmacy_xlsx([["8.93521E+12", "Augmentin 1g", None, "VN-20517-17", "Hộp"]]))
    r = BarcodeImporter(db).run(path, dry_run=True)
    assert r.invalid == 1 and "Text" in r.issues[0]["message"]


def test_file_without_barcode_column(db, tmp_path):
    path = tmp_path / "thieu_cot.xlsx"
    path.write_bytes(pharmacy_xlsx([["Augmentin 1g", "VN-20517-17"]], header=["Tên thuốc", "Số đăng ký"]))
    with pytest.raises(BarcodeImportError, match="cột mã vạch"):
        BarcodeImporter(db).run(path)


# --------------------------------------------------------------------------- #
# API
# --------------------------------------------------------------------------- #
XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"


def test_admin_api_import_lookup_delete(client, ctx):
    content = pharmacy_xlsx(ROWS)
    preview = client.post("/api/catalog/barcodes/import", files={"file": ("ds.xlsx", content, XLSX)}, data={"dry_run": "true"})
    assert preview.status_code == 200, preview.text
    assert preview.json()["linked"] == 5 and preview.json()["dry_run"] is True
    assert client.get("/api/catalog/barcodes/status").json()["barcodes"] == 0

    done = client.post("/api/catalog/barcodes/import", files={"file": ("ds.xlsx", content, XLSX)}, data={"dry_run": "false"})
    assert done.status_code == 200 and done.json()["linked"] == 5
    status = client.get("/api/catalog/barcodes/status").json()
    assert (status["barcodes"], status["medicines_with_barcode"], status["catalog_total"]) == (5, 4, 799)
    assert status["last_import"]["file_name"] == "ds.xlsx"

    found = client.get("/api/catalog/barcodes/lookup", params={"code": A}).json()
    assert found["status"] == "found" and found["medicine"]["id"] == AUGMENTIN_625 and found["link"]["match_method"] == "registration"
    assert client.delete(f"/api/catalog/barcodes/{A}").json() == {"deleted": True, "gtin": "0" + A}
    assert client.get("/api/catalog/barcodes/lookup", params={"code": A}).json()["status"] == "not_found"
    assert client.delete(f"/api/catalog/barcodes/{A}").status_code == 404
    with ctx.db.session() as s:
        actions = set(s.scalars(select(AuditLog.action)))
    assert {"catalog.barcode_import", "catalog.barcode_delete"} <= actions


def test_admin_api_rejects_unknown_file_type(client):
    r = client.post("/api/catalog/barcodes/import", files={"file": ("ds.pdf", b"%PDF", "application/pdf")})
    assert r.status_code == 400


def _link(ctx, code: str, medicine_id: int) -> None:
    with ctx.db.session() as s:
        s.add(CatalogBarcode(gtin=parse_code(code).gtin, medicine_id=medicine_id, source="excel", match_method="registration",
                             created_at=clock.now()))


def test_public_lookup_found_records_history(public_client, scanner, ctx):
    headers, _ = scanner
    _link(ctx, A, AUGMENTIN_625)
    r = public_client.post("/api/v1/barcodes/lookup", json={"code": f"]d201{'0' + A}17270100" + "10LOT42"}, headers=headers)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["status"] == "found" and body["medicine"]["id"] == AUGMENTIN_625 and body["code"] == A
    assert body["gs1"] == {"expiry": "2027-01-31", "lot": "LOT42", "serial": None}
    items = public_client.get("/api/v1/history", headers=headers).json()["items"]
    assert items[0]["id"] == body["history_id"] and items[0]["title"] == "Augmentin 625mg tablets"
    assert items[0]["subtitle"] == f"Quét mã vạch {A}" and items[0]["has_thumbnail"] is False
    detail = public_client.get(f"/api/v1/history/{body['history_id']}", headers=headers).json()
    assert detail["scan"] is None and detail["item"]["top_medicine_id"] == AUGMENTIN_625


def test_public_lookup_not_found_and_invalid(public_client, scanner, ctx):
    headers, _ = scanner
    nf = public_client.post("/api/v1/barcodes/lookup", json={"code": B}, headers=headers).json()
    assert nf["status"] == "not_found" and "chụp mặt hộp" in nf["message"] and nf["medicine"] is None
    assert public_client.post("/api/v1/barcodes/lookup", json={"code": "https://example.com"}, headers=headers).json()["status"] == "invalid"
    assert public_client.post("/api/v1/barcodes/lookup", json={"code": INTERNAL}, headers=headers).json()["status"] == "internal"
    with ctx.db.session() as s:
        assert s.scalar(select(func.count()).select_from(ScanHistory)) == 0


def test_public_lookup_requires_login_and_has_no_admin_routes(public_client, scanner):
    headers, _ = scanner
    assert public_client.post("/api/v1/barcodes/lookup", json={"code": A}).status_code == 401
    for method, path in (("post", "/api/v1/barcodes/import"), ("post", "/api/catalog/barcodes/import"),
                         ("get", "/api/catalog/barcodes/status"), ("delete", f"/api/v1/barcodes/{A}")):
        assert getattr(public_client, method)(path, headers=headers).status_code in (404, 405)
