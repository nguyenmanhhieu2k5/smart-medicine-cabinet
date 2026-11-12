"""Chạy import Excel ở luồng nền và giữ tiến độ để giao diện hỏi định kỳ."""
from __future__ import annotations

import logging
import threading
from pathlib import Path
from typing import Any

from app.database.session import Database
from app.services import history
from app.services.alerts import engine as alert_engine
from app.services.excel_import.importer import CatalogImporter, CatalogImportError, ImportProgress

log = logging.getLogger("smc.import")


class ImportManager:
    def __init__(self, db: Database):
        self.db = db
        self._lock = threading.Lock()
        self._thread: threading.Thread | None = None
        self._progress = ImportProgress()
        self._last_result: dict[str, Any] | None = None
        self._file: str | None = None

    def is_running(self) -> bool:
        return self._thread is not None and self._thread.is_alive()

    def start(self, path: Path, force: bool = False) -> bool:
        """Bắt đầu import; trả về False nếu đang có một lần import khác."""
        with self._lock:
            if self.is_running():
                return False
            self._progress = ImportProgress(stage="hashing", message="Đang kiểm tra file nguồn")
            self._file = str(path)
            self._thread = threading.Thread(target=self._run, args=(Path(path), force), name="catalog-import", daemon=True)
            self._thread.start()
            return True

    def run_blocking(self, path: Path, force: bool = False) -> dict[str, Any]:
        self._run(Path(path), force)
        return self._last_result or {}

    def _on_progress(self, progress: ImportProgress) -> None:
        self._progress = ImportProgress(
            stage=progress.stage, rows_read=progress.rows_read,
            rows_total=progress.rows_total, message=progress.message,
        )

    def _run(self, path: Path, force: bool) -> None:
        try:
            result = CatalogImporter(self.db).run(path, force=force, progress_cb=self._on_progress)
            self._last_result = result.to_dict()
            with self.db.session() as s:
                if result.status == "success":
                    history.record(s, "system", "catalog_import", "Nhập danh mục thuốc", result.message, result.to_dict())
                alert_engine.resolve_system(s, "catalog_missing")
        except CatalogImportError as exc:
            self._progress = ImportProgress(stage="failed", message=str(exc))
            self._last_result = {"status": "failed", "file_name": path.name, "message": str(exc)}
        except Exception as exc:  # pragma: no cover - phòng lỗi bất ngờ
            log.exception("Import thất bại")
            self._progress = ImportProgress(stage="failed", message=f"Lỗi không mong muốn: {exc}")
            self._last_result = {"status": "failed", "file_name": path.name, "message": str(exc)}

    def state(self) -> dict[str, Any]:
        p = self._progress
        return {
            "running": self.is_running(),
            "stage": p.stage,
            "rows_read": p.rows_read,
            "rows_total": p.rows_total,
            "percent": p.percent,
            "message": p.message,
            "file": self._file,
            "last_result": self._last_result,
        }
