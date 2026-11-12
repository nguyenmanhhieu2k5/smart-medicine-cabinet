"""Gom các dịch vụ dùng chung của ứng dụng vào một ngữ cảnh."""
from __future__ import annotations

from pathlib import Path
from typing import Any, Callable

from app.core.config import Settings
from app.database.session import Database
from app.services.auth import SupabaseAuth
from app.services.esp32.adapter import create_adapter
from app.services.esp32.monitor import DeviceMonitor
from app.services.excel_import.manager import ImportManager
from app.services.ocr.service import OcrService


class AppContext:
    def __init__(
        self,
        settings: Settings,
        ocr_engine_factory: Callable[..., Any] | None = None,
        device_adapter_factory: Callable[..., Any] | None = None,
    ):
        settings.ensure_dirs()
        self.settings = settings
        self.db = Database(settings.db_path)
        self.db.create_all()
        self.imports = ImportManager(self.db)
        model_roots: list[Path] = [p for p in (settings.ocr_model_dir, settings.data_dir / "ocr_models") if p]
        self.ocr = OcrService(
            self.db,
            uploads_dir=settings.uploads_dir,
            cache_dir=settings.data_dir / "paddlex",
            model_roots=model_roots,
            engine_factory=ocr_engine_factory,
            enabled=settings.ocr_engine != "disabled",
        )
        self.device = DeviceMonitor(self.db, device_adapter_factory or create_adapter)
        self.auth = SupabaseAuth(settings.supabase_url, settings.supabase_anon_key)

    def close(self) -> None:
        self.ocr.shutdown()
        self.db.dispose()
