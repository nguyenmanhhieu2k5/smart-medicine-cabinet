"""Chạy backend: ``python -m app.run`` (hoặc file thực thi đã đóng gói)."""
from __future__ import annotations

import logging
import multiprocessing
import sys


def main() -> None:
    multiprocessing.freeze_support()
    import uvicorn

    from app.core.config import load_settings, loopback_host
    from app.core.parent_watch import start_parent_watch
    from app.main import create_app

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s", stream=sys.stderr)
    settings = load_settings()
    start_parent_watch()  # tự thoát nếu ứng dụng desktop bị tắt đột ngột (SMC_PARENT_PID)
    app = create_app(settings)
    # Chỉ lắng nghe trên địa chỉ cục bộ.
    uvicorn.run(app, host=loopback_host(settings.host), port=settings.port, log_level="warning", access_log=False)


if __name__ == "__main__":
    main()
