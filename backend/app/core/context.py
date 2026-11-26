"""Ngữ cảnh dùng chung cho hai bộ API (Public + Admin) trong cùng một tiến trình máy chủ.

Một tiến trình duy nhất giữ: kết nối PostgreSQL, mô hình OCR (nạp một lần lên GPU), hub thiết bị,
bộ giới hạn tần suất. Tác vụ nền chỉ khởi động một lần dù có hai cổng HTTP.
"""
from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Callable

from app.auth.mailer import SmtpMailer
from app.auth.ratelimit import RateLimiter
from app.auth.service import AuthService
from app.core import clock
from app.core.config import Settings
from app.database import migrate
from app.database.session import Database, DatabaseError
from app.iot.hub import DeviceHub
from app.services import backup, settings_store
from app.services.alerts import engine as alert_engine
from app.services.excel_import.manager import ImportManager
from app.services.medicine_matcher.catalog import CatalogRepository
from app.services.ai.medicine import AiMedicineService
from app.services.ocr.service import OcrService
from app.services.guest import GuestQuota
from app.services.tts import TtsService

log = logging.getLogger("smc")
MEDICINE_ALERT_INTERVAL = 15 * 60  # giây
HOUSEKEEPING_INTERVAL = 60 * 60
BACKUP_HOUR = 2  # sao lưu tự động lúc 02:00 hằng ngày


class AppContext:
    def __init__(
        self,
        settings: Settings,
        ocr_engine_factory: Callable[..., Any] | None = None,
        mailer: Any = None,
        limiter: RateLimiter | None = None,
    ):
        if not settings.database_url:
            raise DatabaseError(
                "Thiếu DATABASE_URL. Chạy deploy\\postgres\\setup-postgres.ps1 để tạo CSDL trên Mini PC "
                "(kết quả ghi vào server.env)."
            )
        settings.ensure_dirs()
        self.settings = settings
        self.db = Database(settings.database_url)
        self.limiter = limiter or RateLimiter()
        if mailer is None and settings.smtp.configured:
            mailer = SmtpMailer(settings.smtp)
        self.auth = AuthService(self.db, settings, self.limiter, mailer)
        self.imports = ImportManager(self.db)
        model_roots: list[Path] = [p for p in (settings.ocr_model_dir, settings.data_dir / "ocr_models") if p]
        self.ocr = OcrService(
            self.db,
            uploads_dir=settings.uploads_dir,
            cache_dir=settings.data_dir / "paddlex",
            model_roots=model_roots,
            engine_factory=ocr_engine_factory,
            enabled=settings.ocr_engine != "disabled",
            scans_dir=settings.scans_dir,
            max_queue=settings.max_ocr_queue,
            max_active_per_user=settings.max_active_scans_per_user,
        )
        self.devices = DeviceHub(self.db, settings)
        self.ai = AiMedicineService(self.db, settings)
        self.tts = TtsService(settings)
        self.guests = GuestQuota(self.db, settings, self.limiter)
        self.started_at = clock.now()
        self._tasks: list[asyncio.Task] = []
        self._running = False
        self.last_backup: dict[str, Any] | None = None

    # ------------------------------------------------------------------ #
    def check_schema(self) -> None:
        current, head = self.db.schema_revision(), migrate.head_revision()
        if current != head:
            raise DatabaseError(
                f"Lược đồ CSDL chưa cập nhật (hiện tại {current or 'trống'}, cần {head}). "
                "Chạy: python -m app.cli db upgrade"
            )

    def startup_checks(self) -> None:
        """Kiểm tra CSDL, danh mục; tự nhập file Excel đi kèm khi danh mục còn trống."""
        if not self.db.check():
            raise DatabaseError(f"Không kết nối được PostgreSQL ({self.db.display_url}).")
        self.check_schema()
        with self.db.session() as s:
            alert_engine.resolve_system(s, "database_error")
            settings = settings_store.load_settings(s)
            count = CatalogRepository(s).count()
            alert_engine.evaluate_medicines(s, settings)
            default = self.settings.find_default_catalog()
            if count == 0 and default is None:
                alert_engine.raise_system(s, "catalog_missing", "Hãy tải lên file DAV_unique.xlsx trong Cài đặt → Dữ liệu thuốc.")
        if count == 0 and default is not None and self.settings.start_background_tasks:
            log.info("Danh mục trống — tự nhập %s", default)
            self.imports.start(default)
        self.ocr.purge_orphan_uploads()

    async def startup(self) -> None:
        if self._running:
            return
        self._running = True
        await asyncio.to_thread(self.startup_checks)
        if self.settings.start_background_tasks:
            self.devices.start()
            self._tasks += [
                asyncio.create_task(self._medicine_alert_loop(), name="medicine-alerts"),
                asyncio.create_task(self._housekeeping_loop(), name="housekeeping"),
                asyncio.create_task(self._backup_loop(), name="daily-backup"),
            ]
            if self.settings.ocr_engine != "disabled":
                self.ocr.warmup()  # nạp mô hình ngay để lượt quét đầu tiên không phải chờ
            self.tts.warmup()  # nạp giọng đọc ở nền (~1–2 giây) để lần bấm “Đọc” đầu tiên không phải chờ

    async def shutdown(self) -> None:
        for task in self._tasks:
            task.cancel()
        for task in self._tasks:
            try:
                await task
            except (asyncio.CancelledError, Exception):  # noqa: BLE001
                pass
        self._tasks.clear()
        await self.devices.stop()
        self.close()

    def close(self) -> None:
        self.ocr.shutdown()
        self.ai.close()
        self.db.dispose()
        self._running = False

    # ---- tác vụ nền ------------------------------------------------------ #
    async def _medicine_alert_loop(self) -> None:
        while True:
            await asyncio.sleep(MEDICINE_ALERT_INTERVAL)
            try:
                def _evaluate() -> None:
                    with self.db.session() as s:
                        alert_engine.evaluate_medicines(s, settings_store.load_settings(s))

                await asyncio.to_thread(_evaluate)
            except Exception:  # noqa: BLE001
                log.exception("Không đánh giá được cảnh báo thuốc")

    def housekeeping(self) -> dict[str, int]:
        with self.db.session() as s:
            sessions = self.auth.prune_sessions(s)
        scans = self.ocr.cleanup_old_scans(self.settings.scan_image_retention_days)
        return {"sessions": sessions, "scan_images": scans}

    async def _housekeeping_loop(self) -> None:
        while True:
            try:
                await asyncio.to_thread(self.housekeeping)
            except Exception:  # noqa: BLE001
                log.exception("Lỗi dọn dẹp định kỳ")
            await asyncio.sleep(HOUSEKEEPING_INTERVAL)

    def run_backup(self, label: str = "manual") -> dict[str, Any]:
        info = backup.create_backup(
            self.settings.database_url, self.settings.backups_dir, label=label, pg_bin=self.settings.pg_bin_dir,
            copy_dir=self.settings.backup_copy_dir, keep_auto=self.settings.backup_keep,
        )
        self.last_backup = {**info, "ok": True}
        return info

    async def _backup_loop(self) -> None:
        while True:
            now = clock.now()
            target = now.replace(hour=BACKUP_HOUR, minute=0, second=0)
            if target <= now:
                target += timedelta(days=1)
            await asyncio.sleep(max(60.0, (target - now).total_seconds()))
            try:
                info = await asyncio.to_thread(self.run_backup, "auto")
                log.info("Sao lưu tự động: %s (%d byte)", info["name"], info["size"])
            except Exception as exc:  # noqa: BLE001
                self.last_backup = {"ok": False, "error": str(exc), "at": datetime.now().isoformat()}
                log.exception("Sao lưu tự động thất bại")
