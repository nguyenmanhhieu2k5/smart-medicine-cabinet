"""Sao lưu PostgreSQL (kênh Admin). Khôi phục chỉ thực hiện trên Mini PC bằng dòng lệnh."""
from __future__ import annotations

import asyncio

from fastapi import APIRouter, Depends, Request
from fastapi.responses import FileResponse

from app.api.deps import bad_request, get_ctx
from app.auth.deps import client_ip, require
from app.auth.service import Principal, audit
from app.core.context import AppContext
from app.services import backup, history

router = APIRouter(prefix="/backup", tags=["backup"])
manage = require("backup:manage")

RESTORE_HINT = (
    "Khôi phục trên Mini PC: dừng dịch vụ SmartMedicineServer rồi chạy "
    "backend\\.venv\\Scripts\\python -m app.cli backup restore <tên-file>.dump"
)


@router.get("")
def list_backups(ctx: AppContext = Depends(get_ctx), _: Principal = Depends(manage)) -> dict:
    return {
        "items": backup.list_backups(ctx.settings.backups_dir),
        "directory": str(ctx.settings.backups_dir),
        "copy_directory": str(ctx.settings.backup_copy_dir) if ctx.settings.backup_copy_dir else None,
        "keep_automatic": ctx.settings.backup_keep,
        "last_automatic": ctx.last_backup,
        "restore_hint": RESTORE_HINT,
    }


@router.post("", status_code=201)
async def create(request: Request, ctx: AppContext = Depends(get_ctx), principal: Principal = Depends(manage)) -> dict:
    try:
        info = await asyncio.to_thread(ctx.run_backup, "manual")
    except backup.BackupError as exc:
        raise bad_request(str(exc)) from exc
    with ctx.db.session() as s:
        history.record(s, "system", "backup_created", "Sao lưu dữ liệu", info["name"])
        audit(s, "backup.create", channel="admin", user_id=principal.user_id, actor=principal.email,
              resource_type="backup", resource_id=info["name"], ip=client_ip(request), detail={"size": info["size"]})
    return info


@router.get("/{name}/download")
def download(name: str, request: Request, ctx: AppContext = Depends(get_ctx), principal: Principal = Depends(manage)) -> FileResponse:
    try:
        path = backup.resolve_backup(ctx.settings.backups_dir, name)
    except backup.BackupError as exc:
        raise bad_request(str(exc)) from exc
    with ctx.db.session() as s:
        audit(s, "backup.download", channel="admin", user_id=principal.user_id, actor=principal.email,
              resource_type="backup", resource_id=name, ip=client_ip(request))
    return FileResponse(path, media_type="application/octet-stream", filename=path.name)


@router.delete("/{name}")
def delete(name: str, request: Request, ctx: AppContext = Depends(get_ctx), principal: Principal = Depends(manage)) -> dict:
    try:
        backup.resolve_backup(ctx.settings.backups_dir, name).unlink()
    except backup.BackupError as exc:
        raise bad_request(str(exc)) from exc
    with ctx.db.session() as s:
        audit(s, "backup.delete", channel="admin", user_id=principal.user_id, actor=principal.email,
              resource_type="backup", resource_id=name, ip=client_ip(request))
    return {"deleted": True}
