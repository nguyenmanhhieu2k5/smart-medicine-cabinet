"""Sao lưu và khôi phục dữ liệu người dùng."""
from __future__ import annotations

import re
from pathlib import Path

from fastapi import APIRouter, Depends, File, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from app.api.deps import bad_request, get_ctx
from app.core.context import AppContext
from app.services import backup, history, settings_store

router = APIRouter(prefix="/backup", tags=["backup"])


class RestoreRequest(BaseModel):
    name: str = Field(..., max_length=120)


@router.get("")
def list_backups(ctx: AppContext = Depends(get_ctx)) -> dict:
    return {"items": backup.list_backups(ctx.settings.backups_dir), "directory": str(ctx.settings.backups_dir)}


@router.post("", status_code=201)
def create(ctx: AppContext = Depends(get_ctx)) -> dict:
    try:
        info = backup.create_backup(ctx.db, ctx.settings.backups_dir)
    except backup.BackupError as exc:
        raise bad_request(str(exc)) from exc
    with ctx.db.session() as s:
        history.record(s, "system", "backup_created", "Sao lưu dữ liệu", info["name"])
    return info


@router.get("/{name}/download")
def download(name: str, ctx: AppContext = Depends(get_ctx)) -> FileResponse:
    try:
        path = backup.resolve_backup(ctx.settings.backups_dir, name)
    except backup.BackupError as exc:
        raise bad_request(str(exc)) from exc
    return FileResponse(path, media_type="application/octet-stream", filename=path.name)


@router.delete("/{name}")
def delete(name: str, ctx: AppContext = Depends(get_ctx)) -> dict:
    try:
        backup.resolve_backup(ctx.settings.backups_dir, name).unlink()
    except backup.BackupError as exc:
        raise bad_request(str(exc)) from exc
    return {"deleted": True}


async def _after_restore(ctx: AppContext, result: dict, source: str) -> dict:
    with ctx.db.session() as s:
        settings = settings_store.load_settings(s)
        history.record(s, "system", "backup_restored", "Khôi phục dữ liệu", source, result)
    await ctx.device.configure(settings)
    return result


@router.post("/restore")
async def restore(body: RestoreRequest, ctx: AppContext = Depends(get_ctx)) -> dict:
    try:
        path = backup.resolve_backup(ctx.settings.backups_dir, body.name)
        result = backup.restore_backup(ctx.db, ctx.settings.backups_dir, path)
    except backup.BackupError as exc:
        raise bad_request(str(exc)) from exc
    return await _after_restore(ctx, result, body.name)


@router.post("/restore-upload")
async def restore_upload(file: UploadFile = File(...), ctx: AppContext = Depends(get_ctx)) -> dict:
    name = re.sub(r"[^A-Za-z0-9_.-]", "_", Path(file.filename or "upload.smcbak").name)
    if not name.endswith(".smcbak"):
        raise bad_request("Hãy chọn file sao lưu có đuôi .smcbak")
    data = await file.read(100 * 1024 * 1024 + 1)
    if len(data) > 100 * 1024 * 1024:
        raise bad_request("File sao lưu quá lớn.")
    ctx.settings.backups_dir.mkdir(parents=True, exist_ok=True)
    target = ctx.settings.backups_dir / f"nhap-{name}"
    target.write_bytes(data)
    try:
        result = backup.restore_backup(ctx.db, ctx.settings.backups_dir, target)
    except backup.BackupError as exc:
        target.unlink(missing_ok=True)
        raise bad_request(str(exc)) from exc
    return await _after_restore(ctx, result, name)
