"""Nhập danh mục thuốc từ Excel và theo dõi tiến độ."""
from __future__ import annotations

import re
from pathlib import Path

from fastapi import APIRouter, Depends, File, UploadFile
from pydantic import BaseModel, Field

from app.api.deps import bad_request, get_ctx
from app.core.context import AppContext
from app.services import settings_store
from app.services.medicine_matcher.catalog import CatalogRepository

router = APIRouter(prefix="/catalog", tags=["catalog"])
MAX_UPLOAD = 200 * 1024 * 1024


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
