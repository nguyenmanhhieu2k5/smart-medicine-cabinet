"""3. Tìm theo tên · 4. theo hoạt chất · 5. theo số đăng ký."""
from __future__ import annotations

from app.services.medicine_matcher.catalog import CatalogRepository
from app.services.medicine_matcher.normalize import normalize_text

from .conftest import AUGMENTIN_625, FOGICAP_40


def search(db, query, **kwargs):
    with db.session() as s:
        return CatalogRepository(s).search(query, **kwargs)


def test_search_by_name_ignores_case_accents_and_punctuation(db):
    for query in ("augmentin", "AUGMENTIN", "Augmentin-625mg", "  augmentin  625 MG "):
        items = search(db, query)["items"]
        assert items and all("augmentin" in normalize_text(i["ten_thuoc"]) for i in items[:3]), query


def test_search_by_name_and_strength_ranks_matching_strength_first(db):
    items = search(db, "paracetamol 500mg", limit=5)["items"]
    assert len(items) == 5
    for item in items:
        assert "paracetamol" in normalize_text(item["ten_thuoc"] + " " + (item["hoat_chat_chinh"] or ""))
        assert "500" in (item["ham_luong"] or "") + item["ten_thuoc"]


def test_search_by_prefix_while_typing(db):
    items = search(db, "augmen")["items"]
    assert items and normalize_text(items[0]["ten_thuoc"]).startswith("augmentin")


def test_search_by_active_ingredient(db):
    items = search(db, "acid clavulanic", limit=10)["items"]
    assert items
    assert all("clavulan" in normalize_text(i["hoat_chat_chinh"] or "") + normalize_text(i["ten_thuoc"]) for i in items)
    brand_names = {normalize_text(i["ten_thuoc"]).split()[0] for i in items}
    assert brand_names & {"augmentin", "klamentin", "taromentin"}  # tìm ra biệt dược từ tên hoạt chất


def test_search_by_registration_number_exact_and_formatting_variants(db):
    for query in ("VN-20169-16", "vn 20169 16", "VN2016916", "SĐK: VN-20169-16"):
        result = search(db, query)
        assert result["mode"] == "registration", query
        assert result["items"][0]["id"] == AUGMENTIN_625, query


def test_search_by_old_and_new_registration_number_reach_same_medicine(db):
    assert search(db, "893110205525")["items"][0]["id"] == FOGICAP_40
    assert search(db, "VD-34703-20")["items"][0]["id"] == FOGICAP_40


def test_search_tolerates_typos(db):
    result = search(db, "parcetamol")
    assert result["mode"] == "fuzzy"
    assert "paracetamol" in normalize_text(result["items"][0]["ten_thuoc"])


def test_search_pagination_and_empty_query(db):
    first = search(db, "paracetamol", limit=5, offset=0)
    second = search(db, "paracetamol", limit=5, offset=5)
    assert first["total"] > 10
    assert {i["id"] for i in first["items"]}.isdisjoint({i["id"] for i in second["items"]})
    assert search(db, "   ") == {"items": [], "total": 0, "query": "   ", "mode": "empty"}
    assert search(db, "zzzzqqqq khong ton tai")["items"] == []


def test_search_api_and_detail_keep_registration_expiry_separate_from_package_expiry(client):
    response = client.get("/api/medicines/search", params={"q": "augmentin 625"})
    assert response.status_code == 200
    body = response.json()
    assert body["catalog_count"] > 0 and body["items"]
    detail = client.get(f"/api/medicines/{AUGMENTIN_625}").json()
    assert detail["ten_thuoc"] == "Augmentin 625mg tablets"
    assert detail["ngay_het_han_so_dang_ky"] and detail["registration_status"]["code"] in ("valid", "expired", "withdrawn", "unknown")
    assert "expiry_date" not in detail  # hạn dùng thực tế chỉ tồn tại ở thuốc trong tủ
    assert client.get("/api/medicines/123456789").status_code == 404
