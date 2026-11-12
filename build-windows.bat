@echo off
rem Tao ban cai dat Windows (goi scripts\build-windows.ps1). Them tham so neu can, vi du: build-windows.bat -SkipTests
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\build-windows.ps1" %*
if errorlevel 1 (
  echo.
  echo BUILD THAT BAI - xem thong bao loi o tren.
)
pause
