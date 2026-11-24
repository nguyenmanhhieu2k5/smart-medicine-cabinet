"""Tương thích lệnh cũ ``python -m app.run`` → chạy máy chủ hai cổng (xem app/server.py)."""
from __future__ import annotations

from app.server import main

if __name__ == "__main__":
    main()
