"""Thuốc trong tủ — dữ liệu người dùng thực sự thêm vào (tách biệt với danh mục)."""
from __future__ import annotations

import csv
import io
import shutil

from fastapi import APIRouter, Depends, Query, Response
from fastapi.responses import FileResponse
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.deps import bad_request, get_ctx, not_found
from app.core import clock
from app.core.context import AppContext
from app.models import CabinetItem, Reminder
from app.schemas.cabinet import CabinetCreate, CabinetUpdate, QuantityAdjust
from app.services import history, settings_store
from app.services.alerts import engine as alert_engine
from app.services.cabinet import format_quantity, serialize_item
from app.services.medicine_matcher.catalog import CatalogRepository, medicine_detail, strength_display
from app.services.medicine_matcher.normalize import clean_cell, normalize_text

router = APIRouter(prefix="/cabinet", tags=["cabinet"])

STATUS_FILTERS = ("all", "ok", "expiring", "expired", "unknown", "low_stock")
FIELD_LABELS = {
    "name": "tên thuốc", "ingredient": "hoạt chất", "strength": "hàm lượng", "dosage_form": "dạng bào chế",
    "registration_no": "số đăng ký", "manufacturer": "nhà sản xuất", "unit": "đơn vị", "expiry_date": "hạn dùng",
    "lot_number": "số lô", "low_stock_threshold": "ngưỡng sắp hết", "location": "vị trí", "note": "ghi chú",
    "quantity": "số lượng",
}


def _serialize_all(s: Session, items: list[CabinetItem]) -> list[dict]:
    settings = settings_store.load_settings(s)
    return [serialize_item(i, settings.expiry_warning_days, settings.low_stock_threshold) for i in items]


def _counts(rows: list[dict]) -> dict:
    counts = {key: 0 for key in STATUS_FILTERS}
    counts["all"] = len(rows)
    for row in rows:
        counts[row["expiry_status"]] += 1
        if row["low_stock"]:
            counts["low_stock"] += 1
    return counts


def _filtered(rows: list[dict], q: str, status: str, sort: str) -> list[dict]:
    needle = normalize_text(q)
    if needle:
        rows = [
            r for r in rows
            if needle in normalize_text(" ".join(filter(None, [r["name"], r["ingredient"], r["strength"], r["registration_no"]])))
        ]
    if status == "low_stock":
        rows = [r for r in rows if r["low_stock"]]
    elif status != "all":
        rows = [r for r in rows if r["expiry_status"] == status]
    far = "9999-12-31"
    if sort == "expiry":
        rows.sort(key=lambda r: (r["expiry_date"] or far, normalize_text(r["name"])))
    elif sort == "quantity":
        rows.sort(key=lambda r: (r["quantity"], normalize_text(r["name"])))
    elif sort == "recent":
        rows.sort(key=lambda r: r["created_at"], reverse=True)
    else:
        rows.sort(key=lambda r: normalize_text(r["name"]))
    return rows


@router.get("/medicines")
def list_items(
    q: str = Query("", max_length=200),
    status: str = Query("all", pattern="^(all|ok|expiring|expired|unknown|low_stock)$"),
    sort: str = Query("name", pattern="^(name|expiry|quantity|recent)$"),
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=200),
    ctx: AppContext = Depends(get_ctx),
) -> dict:
    with ctx.db.session() as s:
        rows = _serialize_all(s, list(s.scalars(select(CabinetItem)).all()))
        counts = _counts(rows)
        rows = _filtered(rows, q, status, sort)
        total = len(rows)
        start = (page - 1) * page_size
        return {
            "items": rows[start : start + page_size],
            "total": total,
            "page": page,
            "page_size": page_size,
            "pages": max(1, -(-total // page_size)),
            "counts": counts,
        }


@router.get("/summary")
def summary(ctx: AppContext = Depends(get_ctx)) -> dict:
    with ctx.db.session() as s:
        settings = settings_store.load_settings(s)
        rows = _serialize_all(s, list(s.scalars(select(CabinetItem)).all()))
        return {"counts": _counts(rows), "expiry_warning_days": settings.expiry_warning_days}


@router.get("/export")
def export(
    format: str = Query("xlsx", pattern="^(csv|xlsx)$"),
    status: str = Query("all", pattern="^(all|ok|expiring|expired|unknown|low_stock)$"),
    ctx: AppContext = Depends(get_ctx),
) -> Response:
    with ctx.db.session() as s:
        rows = _filtered(_serialize_all(s, list(s.scalars(select(CabinetItem)).all())), "", status, "name")
    header = ["Tên thuốc", "Hoạt chất", "Hàm lượng", "Dạng bào chế", "Số đăng ký", "Nhà sản xuất", "Số lượng",
              "Đơn vị", "Hạn dùng", "Tình trạng", "Số lô", "Vị trí", "Ghi chú"]
    table = [
        [r["name"], r["ingredient"], r["strength"], r["dosage_form"], r["registration_no"], r["manufacturer"],
         r["quantity"], r["unit"], r["expiry_date"], r["expiry_status_label"], r["lot_number"], r["location"], r["note"]]
        for r in rows
    ]
    stamp = clock.now().strftime("%Y%m%d-%H%M")
    if format == "csv":
        buffer = io.StringIO()
        writer = csv.writer(buffer)
        writer.writerow(header)
        writer.writerows(table)
        return Response(
            content=("﻿" + buffer.getvalue()).encode("utf-8"),
            media_type="text/csv; charset=utf-8",
            headers={"Content-Disposition": f'attachment; filename="thuoc-trong-tu-{stamp}.csv"'},
        )
    from openpyxl import Workbook
    from openpyxl.styles import Font

    wb = Workbook()
    ws = wb.active
    ws.title = "Thuốc trong tủ"
    ws.append(header)
    for cell in ws[1]:
        cell.font = Font(bold=True)
    for line in table:
        ws.append(line)
    for column, width in zip("ABCDEFGHIJKLM", (34, 34, 18, 22, 18, 34, 10, 10, 14, 16, 14, 18, 30)):
        ws.column_dimensions[column].width = width
    ws.freeze_panes = "A2"
    out = io.BytesIO()
    wb.save(out)
    return Response(
        content=out.getvalue(),
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f'attachment; filename="thuoc-trong-tu-{stamp}.xlsx"'},
    )


@router.post("/medicines", status_code=201)
def create_item(body: CabinetCreate, ctx: AppContext = Depends(get_ctx)) -> dict:
    now = clock.now()
    with ctx.db.session() as s:
        settings = settings_store.load_settings(s)
        fields = body.model_dump(exclude={"catalog_id", "scan_job_id", "quantity"})
        if body.catalog_id is not None:
            row = CatalogRepository(s).get(body.catalog_id)
            if row is None:
                raise not_found("Thuốc được chọn không còn trong danh mục.")
            strength, _ = strength_display(row)
            # Thông tin nhận diện lấy từ danh mục; người dùng không cần gõ lại.
            fields.update(
                name=clean_cell(row.ten_thuoc) or row.ten_thuoc,
                ingredient=fields.get("ingredient") or clean_cell(row.hoat_chat_chinh),
                strength=fields.get("strength") or strength,
                dosage_form=fields.get("dosage_form") or clean_cell(row.dang_bao_che),
                registration_no=clean_cell(row.so_dang_ky),
                manufacturer=clean_cell(row.ten_cong_ty_san_xuat),
            )
        if not fields.get("name"):
            raise bad_request("Cần nhập tên thuốc hoặc chọn một thuốc trong danh mục.")
        if fields.get("expiry_date") and not fields.get("expiry_source"):
            fields["expiry_source"] = "manual"
        if not fields.get("expiry_date"):
            fields["expiry_source"] = None
        fields["unit"] = fields.get("unit") or "viên"

        job = ctx.ocr.get(body.scan_job_id) if body.scan_job_id else None
        item = CabinetItem(
            catalog_id=body.catalog_id, quantity=body.quantity, source="scan" if job else "manual",
            created_at=now, updated_at=now, **fields,
        )
        s.add(item)
        s.flush()
        if job is not None and job.image_path and job.image_path.exists() and settings.ocr_save_scan_images:
            target = ctx.settings.images_dir / f"cabinet_{item.id}.jpg"
            shutil.copyfile(job.image_path, target)
            item.image_path = str(target)
        if job is not None:
            history.record(
                s, "scan", "scan_confirmed", "Xác nhận kết quả quét", f"Người dùng xác nhận: {item.name}",
                {"job_id": job.id, "cabinet_item_id": item.id, "catalog_id": item.catalog_id},
            )
        history.record(
            s, "cabinet", "cabinet_add", "Thêm thuốc",
            f"Đã lưu {item.name} ({format_quantity(item.quantity)} {item.unit})",
            {"cabinet_item_id": item.id, "catalog_id": item.catalog_id, "quantity": item.quantity},
        )
        alert_engine.evaluate_medicines(s, settings)
        return serialize_item(item, settings.expiry_warning_days, settings.low_stock_threshold)


def _get(s: Session, item_id: int) -> CabinetItem:
    item = s.get(CabinetItem, item_id)
    if item is None:
        raise not_found("Không tìm thấy thuốc này trong tủ.")
    return item


@router.get("/medicines/{item_id}")
def get_item(item_id: int, ctx: AppContext = Depends(get_ctx)) -> dict:
    with ctx.db.session() as s:
        item = _get(s, item_id)
        settings = settings_store.load_settings(s)
        data = serialize_item(item, settings.expiry_warning_days, settings.low_stock_threshold)
        catalog = CatalogRepository(s).get(item.catalog_id) if item.catalog_id is not None else None
        data["catalog"] = medicine_detail(catalog) if catalog is not None else None
        return data


@router.get("/medicines/{item_id}/image")
def get_item_image(item_id: int, ctx: AppContext = Depends(get_ctx)) -> FileResponse:
    with ctx.db.session() as s:
        item = _get(s, item_id)
        path = item.image_path
    if not path:
        raise not_found("Thuốc này không có ảnh.")
    from pathlib import Path

    file = Path(path)
    if not file.is_file() or file.resolve().parent != ctx.settings.images_dir.resolve():
        raise not_found("Ảnh không còn.")
    return FileResponse(file, media_type="image/jpeg", headers={"Cache-Control": "no-store"})


@router.patch("/medicines/{item_id}")
def update_item(item_id: int, body: CabinetUpdate, ctx: AppContext = Depends(get_ctx)) -> dict:
    changes = body.model_dump(exclude_unset=True)
    with ctx.db.session() as s:
        item = _get(s, item_id)
        settings = settings_store.load_settings(s)
        if "name" in changes and not changes["name"]:
            raise bad_request("Tên thuốc không được để trống.")
        if "unit" in changes and not changes["unit"]:
            changes["unit"] = "viên"
        if "expiry_date" in changes:
            if changes["expiry_date"] is None:
                changes["expiry_source"] = None
            elif "expiry_source" not in changes or changes["expiry_source"] is None:
                changes["expiry_source"] = "manual"
        changed: list[str] = []
        old_quantity = item.quantity
        for key, value in changes.items():
            if getattr(item, key) != value:
                setattr(item, key, value)
                if key != "expiry_source":
                    changed.append(key)
        if changed:
            item.updated_at = clock.now()
            only_quantity = changed == ["quantity"]
            if "quantity" in changed:
                history.record(
                    s, "cabinet", "quantity_change", "Thay đổi số lượng",
                    f"{item.name}: {format_quantity(old_quantity)} → {format_quantity(item.quantity)} {item.unit}",
                    {"cabinet_item_id": item.id, "from": old_quantity, "to": item.quantity},
                )
            if not only_quantity:
                labels = ", ".join(FIELD_LABELS.get(c, c) for c in changed if c != "quantity")
                history.record(
                    s, "cabinet", "cabinet_update", "Cập nhật", f"Đã cập nhật {labels} của {item.name}",
                    {"cabinet_item_id": item.id, "fields": changed},
                )
            alert_engine.evaluate_medicines(s, settings)
        return serialize_item(item, settings.expiry_warning_days, settings.low_stock_threshold)


@router.post("/medicines/{item_id}/adjust")
def adjust_quantity(item_id: int, body: QuantityAdjust, ctx: AppContext = Depends(get_ctx)) -> dict:
    with ctx.db.session() as s:
        item = _get(s, item_id)
        settings = settings_store.load_settings(s)
        new_quantity = item.quantity + body.delta
        if new_quantity < 0:
            raise bad_request(f"Số lượng không thể âm (hiện còn {format_quantity(item.quantity)} {item.unit}).")
        if body.delta != 0:
            old = item.quantity
            item.quantity = round(new_quantity, 3)
            item.updated_at = clock.now()
            history.record(
                s, "cabinet", "quantity_change", "Thay đổi số lượng",
                f"{item.name}: {format_quantity(old)} → {format_quantity(item.quantity)} {item.unit}"
                + (f" ({body.reason})" if body.reason else ""),
                {"cabinet_item_id": item.id, "from": old, "to": item.quantity, "reason": body.reason},
            )
            alert_engine.evaluate_medicines(s, settings)
        return serialize_item(item, settings.expiry_warning_days, settings.low_stock_threshold)


@router.delete("/medicines/{item_id}")
def delete_item(item_id: int, ctx: AppContext = Depends(get_ctx)) -> dict:
    with ctx.db.session() as s:
        item = _get(s, item_id)
        settings = settings_store.load_settings(s)
        name, image = item.name, item.image_path
        # Lời nhắc vẫn được giữ lại (theo tên) nhưng không còn liên kết tới thuốc đã xóa.
        for reminder in s.scalars(select(Reminder).where(Reminder.cabinet_item_id == item.id)).all():
            reminder.cabinet_item_id = None
        s.delete(item)
        s.flush()
        history.record(s, "cabinet", "cabinet_delete", "Xóa thuốc", f"Đã xóa {name} khỏi tủ", {"cabinet_item_id": item_id})
        alert_engine.evaluate_medicines(s, settings)
    if image:
        from pathlib import Path

        try:
            Path(image).unlink(missing_ok=True)
        except OSError:
            pass
    return {"deleted": True, "id": item_id}
