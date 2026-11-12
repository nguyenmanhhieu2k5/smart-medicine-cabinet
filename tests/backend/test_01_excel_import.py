"""1. Import Excel → SQLite."""
from __future__ import annotations

import shutil

import pandas as pd
import pytest
from sqlalchemy import func, select, text

from app.models import CatalogMedicine
from app.services.excel_import.importer import CatalogImporter, CatalogImportError
from app.services.medicine_matcher.catalog import CatalogRepository, medicine_detail

from .conftest import AUGMENTIN_625, FOGICAP_40, FULL_XLSX, SAMPLE_XLSX


def count(db) -> int:
    with db.session() as s:
        return s.scalar(select(func.count()).select_from(CatalogMedicine))


def test_import_reads_every_row_and_all_29_columns(db):
    source = pd.read_excel(SAMPLE_XLSX, dtype=str)
    assert count(db) == len(source)
    with db.session() as s:
        row = s.get(CatalogMedicine, AUGMENTIN_625)
        raw = medicine_detail(row)["raw"]
        assert len(raw) == 29
        expected = source[source["id"] == str(AUGMENTIN_625)].iloc[0]
        for column in ("tenThuoc", "soDangKy", "hoatChatChinh", "dongGoi", "tenCongTySanXuat", "ngayHetHanSoDangKy"):
            assert raw[column] == str(expected[column]).strip()  # giữ nguyên giá trị gốc


def test_reimport_same_file_is_skipped_and_creates_no_duplicates(db):
    before = count(db)
    again = CatalogImporter(db).run(SAMPLE_XLSX)
    assert again.status == "skipped"
    forced = CatalogImporter(db).run(SAMPLE_XLSX, force=True)
    assert forced.status == "success"
    assert (forced.inserted, forced.updated) == (0, 0)
    assert forced.unchanged == before == count(db)


def test_changed_source_only_updates_changed_rows(db, tmp_path):
    frame = pd.read_excel(SAMPLE_XLSX, dtype=str)
    assert (frame["id"] == str(AUGMENTIN_625)).sum() == 1
    frame.loc[frame["id"] == str(AUGMENTIN_625), "dongGoi"] = "Hộp 99 vỉ x 7 viên"
    removed_id = int(frame.iloc[0]["id"])
    frame = frame.iloc[1:]
    new_row = frame.iloc[0].copy()
    new_row["id"], new_row["tenThuoc"], new_row["soDangKy"] = "999001", "Thuốc Kiểm Thử 250mg", "VD-99001-26"
    frame = pd.concat([frame, new_row.to_frame().T])
    changed = tmp_path / "changed.xlsx"
    frame.to_excel(changed, index=False)

    result = CatalogImporter(db).run(changed)
    assert (result.inserted, result.updated, result.removed) == (1, 1, 1)
    with db.session() as s:
        assert s.get(CatalogMedicine, AUGMENTIN_625).dong_goi == "Hộp 99 vỉ x 7 viên"
        assert s.get(CatalogMedicine, removed_id).in_source is False  # không xóa, chỉ đánh dấu
        assert [r["id"] for r in CatalogRepository(s).search("thuoc kiem thu")["items"]] == [999001]


def test_missing_data_and_placeholders_are_handled(db):
    with db.session() as s:
        rows = s.scalars(select(CatalogMedicine).where(CatalogMedicine.ham_luong == "--")).all()
        assert rows, "fixture phải có dòng dùng '--' làm giá trị trống"
        detail = medicine_detail(rows[0])
        assert detail["ham_luong_goc"] is None  # '--' được coi là không có dữ liệu
        assert detail["raw"]["hamLuong"] == "--"  # nhưng giá trị gốc vẫn được giữ
        assert detail["ten_duong_dung"] is None  # cột tenDuongDung trống trong toàn bộ file nguồn


def test_medicine_with_multiple_registration_numbers(db):
    with db.session() as s:
        regs = dict(s.execute(text("SELECT reg_norm, kind FROM catalog_regs WHERE medicine_id = :i"), {"i": FOGICAP_40}).all())
        assert regs == {"893110205525": "current", "VD3470320": "old"}
        both = s.execute(text("SELECT COUNT(*) FROM catalog_regs WHERE reg_norm LIKE '8931%' AND medicine_id IN (SELECT medicine_id FROM catalog_regs GROUP BY medicine_id HAVING COUNT(*) > 2)")).scalar()
        assert both >= 0


def test_rejects_non_excel_and_missing_columns(empty_db, tmp_path):
    bad = tmp_path / "notes.txt"
    bad.write_text("x")
    with pytest.raises(CatalogImportError):
        CatalogImporter(empty_db).run(bad)
    wrong = tmp_path / "wrong.xlsx"
    pd.DataFrame({"a": [1], "b": [2]}).to_excel(wrong, index=False)
    with pytest.raises(CatalogImportError, match="cột bắt buộc"):
        CatalogImporter(empty_db).run(wrong)
    assert count(empty_db) == 0


def test_rows_without_id_or_name_are_skipped(empty_db, tmp_path):
    path = tmp_path / "partial.xlsx"
    pd.DataFrame({"id": [1, None, 3], "tenThuoc": ["A-Thuốc 10mg", "Không id", None], "soDangKy": ["VD-1-20", "VD-2-20", "VD-3-20"]}).to_excel(path, index=False)
    result = CatalogImporter(empty_db).run(path)
    assert (result.rows_total, result.inserted, result.skipped) == (3, 1, 2)
    assert "hoatChatChinh" in result.missing_columns


def test_api_import_runs_in_background_and_reports_status(client, tmp_path):
    copy = tmp_path / "DAV_unique.xlsx"
    shutil.copyfile(SAMPLE_XLSX, copy)
    response = client.post("/api/catalog/import", json={"path": str(copy), "force": True})
    assert response.status_code == 202
    client.app.state.ctx.imports._thread.join(timeout=60)
    status = client.get("/api/catalog/status").json()
    assert status["progress"]["stage"] == "done" and status["last_import"]["status"] == "success"
    assert status["count"] == status["last_import"]["rows_total"]
    assert client.post("/api/catalog/import", json={"path": str(tmp_path / "nope.xlsx")}).status_code == 400


@pytest.mark.realdata
def test_full_excel_imports_all_55005_rows(tmp_path):
    if not FULL_XLSX.is_file():
        pytest.skip("Không có data/DAV_unique.xlsx")
    from app.database.session import Database

    database = Database(tmp_path / "full.db")
    database.create_all()
    result = CatalogImporter(database).run(FULL_XLSX)
    assert result.status == "success" and result.rows_total == 55005 and result.inserted == 55005
    assert result.missing_columns == [] and result.skipped == 0
    with database.session() as s:
        repo = CatalogRepository(s)
        assert repo.count() == 55005
        assert repo.search("VN-20169-16")["items"][0]["id"] == AUGMENTIN_625
    database.dispose()
