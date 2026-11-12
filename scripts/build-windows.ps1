<#
.SYNOPSIS
  Tạo bản cài đặt Windows (NSIS .exe) cho "Tủ thuốc thông minh".

.DESCRIPTION
  1. Cài đặt môi trường (scripts\setup-windows.ps1)          — bỏ qua bằng -SkipSetup
  2. Chạy kiểm thử backend (pytest) và giao diện (vitest)     — bỏ qua bằng -SkipTests
  3. Build giao diện (Vite)  ->  frontend\dist
  4. Đóng gói backend (PyInstaller)  ->  backend\dist\smc-backend\smc-backend.exe
  5. Kiểm tra đủ thành phần (backend, Excel, mô hình OCR, biểu tượng)
  6. electron-builder + NSIS  ->  release\SmartMedicineCabinet-Setup-<phiên bản>.exe

  Lần đầu, electron-builder tải NSIS và công cụ chỉnh file .exe từ GitHub (cần Internet).
  Bản cài đặt không có chữ ký số nên Windows SmartScreen sẽ cảnh báo khi chạy lần đầu
  ("More info" -> "Run anyway").

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\build-windows.ps1

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\build-windows.ps1 -SkipSetup -SkipTests

.NOTES
  Script này đã được kiểm tra cú pháp bằng PowerShell 7 trên Linux, nhưng CHƯA được chạy trên Windows thật
  trong quá trình phát triển. Nếu gặp lỗi "A required privilege is not held by the client" khi electron-builder
  giải nén công cụ, hãy bật Developer Mode của Windows hoặc mở PowerShell bằng "Run as administrator".
#>
[CmdletBinding()]
param(
  [string]$Python = "",
  [switch]$SkipSetup,
  [switch]$SkipTests,
  # Chỉ tạo thư mục chạy thử release\win-unpacked, không tạo file cài đặt
  [switch]$DirOnly
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

$Root = Split-Path -Parent $PSScriptRoot
$OnWindows = ($PSVersionTable.PSVersion.Major -lt 6) -or $IsWindows
$started = Get-Date

function Write-Step([string]$Text) { Write-Host "`n==> $Text" -ForegroundColor Cyan }
function Invoke-Checked {
  param([string]$File, [string[]]$Arguments = @(), [string]$WorkingDirectory = $Root)
  Push-Location $WorkingDirectory
  try {
    & $File @Arguments
    if ($LASTEXITCODE -ne 0) { throw "Lệnh lỗi (mã $LASTEXITCODE): $File $($Arguments -join ' ')" }
  }
  finally { Pop-Location }
}

if (-not $OnWindows) {
  Write-Host "Cảnh báo: không phải Windows. PyInstaller không biên dịch chéo nên sẽ không tạo được smc-backend.exe;" -ForegroundColor Yellow
  Write-Host "          dùng 'npm run pack' để tạo bản chạy thử cho hệ điều hành hiện tại." -ForegroundColor Yellow
}

if (-not $SkipSetup) {
  Write-Step "1/6 Cài đặt môi trường"
  $setupArguments = @{}
  if ($Python) { $setupArguments["Python"] = $Python }
  & (Join-Path $PSScriptRoot "setup-windows.ps1") @setupArguments
}

if (-not $SkipTests) {
  Write-Step "2/6 Kiểm thử"
  Invoke-Checked -File "npm" -Arguments @("run", "test:backend")
  Invoke-Checked -File "npm" -Arguments @("run", "test:frontend")
}

Write-Step "3/6 Build giao diện"
Invoke-Checked -File "npm" -Arguments @("run", "build:frontend")

Write-Step "4/6 Đóng gói backend (PyInstaller)"
Invoke-Checked -File "npm" -Arguments @("run", "build:backend")

Write-Step "5/6 Kiểm tra thành phần"
Invoke-Checked -File "npm" -Arguments @("run", "check:resources")

Write-Step "6/6 Tạo bản cài đặt (electron-builder)"
if ($DirOnly) { Invoke-Checked -File "npx" -Arguments @("electron-builder", "--win", "--x64", "--dir") }
else { Invoke-Checked -File "npx" -Arguments @("electron-builder", "--win", "nsis", "--x64") }

$release = Join-Path $Root "release"
$minutes = [math]::Round(((Get-Date) - $started).TotalMinutes, 1)
Write-Host "`nXong sau $minutes phút." -ForegroundColor Green
if (Test-Path $release) {
  Get-ChildItem $release -Filter "*.exe" | ForEach-Object {
    Write-Host ("  {0}  ({1} MB)" -f $_.FullName, [math]::Round($_.Length / 1MB, 1)) -ForegroundColor Green
  }
  $unpacked = Join-Path $release "win-unpacked"
  if (Test-Path $unpacked) { Write-Host "  Bản chạy thử không cần cài: $unpacked\SmartMedicineCabinet.exe" }
}
Write-Host "Kiểm tra bản đóng gói:  npm run test:desktop:packed"
