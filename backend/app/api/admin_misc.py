"""Kênh Admin: nhật ký kiểm toán, lịch sử quét của mọi tài khoản, trạng thái máy chủ Cloud."""
from __future__ import annotations

import shutil
import subprocess
import sys
import uuid
from datetime import datetime

from fastapi import APIRouter, Depends, Query
from sqlalchemy import func, or_, select

from app import __version__
from app.api.deps import get_ctx
from app.auth.deps import require
from app.auth.service import Principal
from app.core import clock
from app.core.context import AppContext
from app.database.session import iso_local
from app.models import AuditLog, Device, ScanHistory, User
from app.services.medicine_matcher.catalog import CatalogRepository
from app.services.medicine_matcher.normalize import normalize_text

router = APIRouter(tags=["admin"])


@router.get("/admin/audit")
def audit_logs(
    q: str = Query("", max_length=120), action: str | None = Query(None, max_length=64),
    success: bool | None = None, limit: int = Query(50, ge=1, le=500), offset: int = Query(0, ge=0),
    ctx: AppContext = Depends(get_ctx), _: Principal = Depends(require("audit:read")),
) -> dict:
    with ctx.db.session() as s:
        stmt = select(AuditLog)
        if q.strip():
            like = f"%{q.strip().lower()}%"
            stmt = stmt.where(or_(func.lower(AuditLog.actor).like(like), func.lower(AuditLog.action).like(like),
                                  AuditLog.resource_id.like(like)))
        if action:
            stmt = stmt.where(AuditLog.action == action)
        if success is not None:
            stmt = stmt.where(AuditLog.success.is_(success))
        total = s.scalar(select(func.count()).select_from(stmt.subquery())) or 0
        rows = s.scalars(stmt.order_by(AuditLog.created_at.desc(), AuditLog.id.desc()).limit(limit).offset(offset)).all()
        return {
            "total": total,
            "items": [{
                "id": r.id, "created_at": iso_local(r.created_at), "actor": r.actor, "channel": r.channel, "action": r.action,
                "resource_type": r.resource_type, "resource_id": r.resource_id, "success": r.success, "ip": r.ip, "detail": r.detail,
            } for r in rows],
        }


@router.get("/admin/scans")
def all_scans(
    q: str = Query("", max_length=120), user_id: uuid.UUID | None = None,
    limit: int = Query(50, ge=1, le=200), offset: int = Query(0, ge=0),
    ctx: AppContext = Depends(get_ctx), _: Principal = Depends(require("scan:read_all")),
) -> dict:
    with ctx.db.session() as s:
        stmt = select(ScanHistory, User.email).join(User, User.id == ScanHistory.user_id)
        if q.strip():
            stmt = stmt.where(ScanHistory.search_text.like(f"%{normalize_text(q)}%"))
        if user_id:
            stmt = stmt.where(ScanHistory.user_id == user_id)
        total = s.scalar(select(func.count()).select_from(stmt.subquery())) or 0
        rows = s.execute(stmt.order_by(ScanHistory.created_at.desc()).limit(limit).offset(offset)).all()
        return {
            "total": total,
            "items": [{
                "id": str(h.id), "job_id": str(h.job_id) if h.job_id else None, "user_email": email, "status": h.status,
                "title": h.title, "subtitle": h.subtitle, "candidate_count": h.candidate_count,
                "top_medicine_id": h.top_medicine_id, "created_at": iso_local(h.created_at),
            } for h, email in rows],
        }


def _service_state(name: str) -> str | None:
    """Trạng thái dịch vụ Windows (cloudflared, Tailscale, PostgreSQL) — None nếu không xác định được."""
    if sys.platform != "win32":
        return None
    try:
        out = subprocess.run(["sc", "query", name], capture_output=True, text=True, timeout=5).stdout
    except (OSError, subprocess.TimeoutExpired):
        return None
    if "RUNNING" in out:
        return "running"
    if "STOPPED" in out:
        return "stopped"
    if "1060" in out:  # dịch vụ không tồn tại
        return "not_installed"
    return "unknown"


@router.get("/admin/system")
def system_status(ctx: AppContext = Depends(get_ctx), _: Principal = Depends(require("system:read"))) -> dict:
    import psutil

    db_ok = ctx.db.check()
    db_info: dict = {"ok": db_ok, "url": ctx.db.display_url}
    if db_ok:
        try:
            db_info |= ctx.db.server_info()
            with ctx.db.session() as s:
                db_info["catalog_count"] = CatalogRepository(s).count()
                db_info["users"] = s.scalar(select(func.count()).select_from(User)) or 0
                db_info["devices"] = s.scalar(select(func.count()).select_from(Device)) or 0
            db_info["schema_revision"] = ctx.db.schema_revision()
        except Exception as exc:  # noqa: BLE001
            db_info["error"] = str(exc)
    disk = shutil.disk_usage(ctx.settings.data_dir)
    vm = psutil.virtual_memory()
    online = [str(d) for d in list(ctx.devices._live)]  # noqa: SLF001
    return {
        "version": __version__,
        "time": iso_local(clock.now()),
        "uptime_seconds": int((clock.now() - ctx.started_at).total_seconds()),
        "database": db_info,
        "ocr": ctx.ocr.status(),
        "devices": {"online": online, "online_count": len(online)},
        "host": {
            "cpu_percent": psutil.cpu_percent(interval=0.2),
            "cpu_count": psutil.cpu_count(),
            "memory_total": vm.total, "memory_used": vm.used, "memory_percent": vm.percent,
            "disk_total": disk.total, "disk_free": disk.free, "disk_percent": round(100 * (disk.total - disk.free) / disk.total, 1),
            "boot_time": iso_local(datetime.fromtimestamp(psutil.boot_time())),
        },
        "services": {
            "postgresql": _service_state("postgresql-x64-17"),
            "cloudflared": _service_state("cloudflared"),
            "tailscale": _service_state("Tailscale"),
            "server": _service_state("SmartMedicineServer"),
        },
        "backup": {"last": ctx.last_backup, "directory": str(ctx.settings.backups_dir)},
        "public_base_url": ctx.settings.public_base_url,
    }
