@echo off
rem Cai dat moi truong phat trien (goi scripts\setup-windows.ps1).
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\setup-windows.ps1" %*
pause
