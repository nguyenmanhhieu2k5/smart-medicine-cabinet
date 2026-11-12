"""Điểm vào của file thực thi backend (PyInstaller).

Khi phát triển dùng ``python -m app.run``; bản đóng gói chạy ``smc-backend.exe`` do Electron khởi động.
"""
from app.run import main

if __name__ == "__main__":
    main()
