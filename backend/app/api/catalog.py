"""Nhập danh mục thuốc từ Excel và theo dõi tiến độ; dữ liệu mã vạch gắn với danh mục."""
from __future__ import annotations

import re
import tempfile
from dataclasses import asdict
from pathlib import Path

from fastapi import APIRouter, Depends, File, Form, Query, Request, UploadFile
from pydantic import BaseModel, Field

from app.api.deps import bad_request, get_ctx, not_found
from app.auth.deps import client_ip, require
from app.auth.service import Principal, audit
from app.core.context import AppContext
from app.models.catalog import CatalogBarcode
from app.services import settings_store
from app.services.barcode.gs1 import parse_code
from app.services.barcode.importer import BarcodeImporter, BarcodeImportError
from app.services.barcode.lookup import barcode_status, find_medicine
from app.services.medicine_matcher.catalog import CatalogRepository, medicine_summary

router = APIRouter(prefix="/catalog", tags=["catalog"])
MAX_UPLOAD = 200 * 1024 * 1024
MAX_BARCODE_UPLOAD = 30 * 1024 * 1024
manage = require("catalog:manage")


class ImportRequest(BaseModel):
    path: str | None = Field(None, max_length=1000, description="Đường dẫn file .xlsx; bỏ trống để dùng nguồn đã cấu hình")
    force: bool = False


def _status(ctx: AppContext) -> dict:
    with ctx.db.session() as s:
        repo = CatalogRepository(s)
        last = repo.last_import()
        settings = settings_store.load_settings(s)
        default = ctx.settings.find_default_catalog()
        return {
            "count": repo.count(),
            "source_path": settings.catalog_source_path,
            "default_source": str(default) if default else None,
            "last_import": None if last is None else {
                "id": last.id, "file_name": last.file_name, "file_path": last.file_path, "status": last.status,
                "rows_total": last.rows_total, "inserted": last.inserted, "updated": last.updated,
                "unchanged": last.unchanged, "skipped": last.skipped, "removed": last.removed,
                "duplicate_ids": last.duplicate_ids, "message": last.message,
                "started_at": last.started_at.isoformat(),
                "finished_at": last.finished_at.isoformat() if last.finished_at else None,
            },
            "progress": ctx.imports.state(),
        }


@router.get("/status")
def status(ctx: AppContext = Depends(get_ctx)) -> dict:
    return _status(ctx)


def _start(ctx: AppContext, path: Path, force: bool) -> dict:
    if not path.is_file():
        raise bad_request(f"Không tìm thấy file: {path}")
    if path.suffix.lower() not in (".xlsx", ".xlsm"):
        raise bad_request("Chỉ hỗ trợ file Excel .xlsx")
    if not ctx.imports.start(path, force=force):
        raise bad_request("Đang có một lần nhập dữ liệu khác chạy.")
    with ctx.db.session() as s:
        settings_store.save_settings(s, {"catalog_source_path": str(path)})
    return _status(ctx)


@router.post("/import", status_code=202)
def start_import(body: ImportRequest, ctx: AppContext = Depends(get_ctx)) -> dict:
    """Bắt đầu nhập ở nền. Theo dõi tiến độ qua GET /api/catalog/status."""
    if body.path:
        path = Path(body.path).expanduser()
    else:
        with ctx.db.session() as s:
            configured = settings_store.load_settings(s).catalog_source_path
        candidate = Path(configured) if configured and Path(configured).is_file() else ctx.settings.find_default_catalog()
        if candidate is None:
            raise bad_request("Chưa có file Excel nguồn. Hãy chọn file DAV_unique.xlsx từ máy tính.")
        path = candidate
    return _start(ctx, path, body.force)


@router.post("/upload", status_code=202)
async def upload_and_import(file: UploadFile = File(...), ctx: AppContext = Depends(get_ctx)) -> dict:
    """Nhận file Excel tải lên (khi không dùng hộp thoại chọn file của Electron)."""
    name = Path(file.filename or "catalog.xlsx").name
    if not name.lower().endswith((".xlsx", ".xlsm")):
        raise bad_request("Chỉ hỗ trợ file Excel .xlsx")
    safe = re.sub(r"[^A-Za-z0-9._ ()-]", "_", name)
    target_dir = ctx.settings.data_dir / "catalog"
    target_dir.mkdir(parents=True, exist_ok=True)
    target = target_dir / safe
    size = 0
    with open(target, "wb") as out:
        while chunk := await file.read(1 << 20):
            size += len(chunk)
            if size > MAX_UPLOAD:
                out.close()
                target.unlink(missing_ok=True)
                raise bad_request("File quá lớn (tối đa 200 MB).")
            out.write(chunk)
    return _start(ctx, target, force=False)


# --------------------------------------------------------------------------- #
# Mã vạch → thuốc trong danh mục (nhập từ file Excel/CSV của nhà thuốc)
# --------------------------------------------------------------------------- #
@router.get("/barcodes/status")
def barcodes_status(ctx: AppContext = Depends(get_ctx)) -> dict:
    with ctx.db.session() as s:
        return barcode_status(s)


@router.post("/barcodes/import")
async def barcodes_import(
    request: Request,
    file: UploadFile = File(..., description="Excel .xlsx hoặc .csv có cột Mã vạch + Số đăng ký/Tên thuốc"),
    dry_run: bool = Form(True, description="true = chỉ kiểm tra và báo cáo, không ghi gì"),
    ctx: AppContext = Depends(get_ctx),
    principal: Principal = Depends(manage),
) -> dict:
    """Ghép từng mã vạch với thuốc ĐÃ CÓ trong danh mục; không tạo thuốc mới, không ghi đè liên kết sẵn có."""
    name = Path(file.filename or "barcodes.xlsx").name
    suffix = Path(name).suffix.lower()
    if suffix not in (".xlsx", ".xlsm", ".csv", ".txt", ".xls"):
        raise bad_request("Chỉ hỗ trợ file Excel .xlsx hoặc .csv.")
    ctx.settings.data_dir.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=ctx.settings.data_dir) as tmp:
        target = Path(tmp) / f"upload{suffix}"
        size = 0
        with open(target, "wb") as out:
            while chunk := await file.read(1 << 20):
                size += len(chunk)
                if size > MAX_BARCODE_UPLOAD:
                    raise bad_request("File quá lớn (tối đa 30 MB).")
                out.write(chunk)
        try:
            report = BarcodeImporter(ctx.db).run(target, file_name=name, dry_run=dry_run, started_by=principal.email)
        except BarcodeImportError as exc:
            raise bad_request(str(exc)) from exc
    data = asdict(report)
    if not dry_run:
        with ctx.db.session() as s:
            audit(s, "catalog.barcode_import", channel="admin", user_id=principal.user_id, actor=principal.email,
                  resource_type="barcode_import", resource_id=str(report.import_id), ip=client_ip(request),
                  detail={k: data[k] for k in ("file_name", "rows_total", "linked", "unchanged", "conflicts", "unmatched", "ambiguous", "invalid")})
    return data


@router.get("/barcodes/lookup")
def barcodes_lookup(code: str = Query(..., min_length=1, max_length=400), ctx: AppContext = Depends(get_ctx)) -> dict:
    parsed = parse_code(code)
    out: dict = {"status": parsed.kind, "code": parsed.display, "gtin": parsed.gtin, "message": parsed.message,
                 "medicine": None, "link": None}
    if parsed.kind != "gtin" or parsed.gtin is None:
        return out
    with ctx.db.session() as s:
        found = find_medicine(s, parsed.gtin)
        if found is None:
            out.update(status="not_found", message=f"Mã vạch {parsed.display} chưa có trong dữ liệu.")
            return out
        link, row = found
        out.update(status="found", medicine=medicine_summary(row), link={
            "source": link.source, "match_method": link.match_method, "unit": link.unit, "import_id": link.import_id,
        })
    return out


@router.delete("/barcodes/{gtin}")
def barcodes_delete(gtin: str, request: Request, ctx: AppContext = Depends(get_ctx), principal: Principal = Depends(manage)) -> dict:
    """Gỡ một liên kết sai (thuốc trong danh mục giữ nguyên)."""
    parsed = parse_code(gtin)
    key = parsed.gtin if parsed.gtin else gtin
    with ctx.db.session() as s:
        link = s.get(CatalogBarcode, key)
        if link is None:
            raise not_found("Không có liên kết cho mã vạch này.")
        medicine_id = link.medicine_id
        s.delete(link)
        audit(s, "catalog.barcode_delete", channel="admin", user_id=principal.user_id, actor=principal.email,
              resource_type="barcode", resource_id=key, ip=client_ip(request), detail={"medicine_id": medicine_id})
    return {"deleted": True, "gtin": key}
