"""Tra mã vạch → thuốc trong danh mục, và thống kê dữ liệu mã vạch."""
from __future__ import annotations

from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.database.session import iso_local
from app.models.catalog import BarcodeImport, CatalogBarcode, CatalogMedicine
from app.services.barcode.gs1 import ParsedCode


def find_medicine(s: Session, gtin: str) -> tuple[CatalogBarcode, CatalogMedicine] | None:
    row = s.execute(
        select(CatalogBarcode, CatalogMedicine).join(CatalogMedicine, CatalogMedicine.id == CatalogBarcode.medicine_id)
        .where(CatalogBarcode.gtin == gtin)
    ).first()
    return (row[0], row[1]) if row else None


def gs1_extra(parsed: ParsedCode) -> dict[str, Any] | None:
    """Thông tin riêng của hộp thuốc đọc được từ mã 2D (không cần CSDL)."""
    if not (parsed.expiry or parsed.lot or parsed.serial):
        return None
    return {"expiry": parsed.expiry.isoformat() if parsed.expiry else None, "lot": parsed.lot, "serial": parsed.serial}


def barcode_status(s: Session) -> dict[str, Any]:
    total = s.scalar(select(func.count()).select_from(CatalogBarcode)) or 0
    medicines = s.scalar(select(func.count(func.distinct(CatalogBarcode.medicine_id)))) or 0
    catalog = s.scalar(select(func.count()).select_from(CatalogMedicine)) or 0
    last = s.scalars(select(BarcodeImport).order_by(BarcodeImport.id.desc()).limit(1)).first()
    return {
        "barcodes": total,
        "medicines_with_barcode": medicines,
        "catalog_total": catalog,
        "last_import": None if last is None else {
            "id": last.id, "file_name": last.file_name, "rows_total": last.rows_total, "linked": last.linked,
            "unchanged": last.unchanged, "conflicts": last.conflicts, "unmatched": last.unmatched, "invalid": last.invalid,
            "started_by": last.started_by, "created_at": iso_local(last.created_at),
        },
    }
