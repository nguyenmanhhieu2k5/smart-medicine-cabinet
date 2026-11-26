<#
.SYNOPSIS
  Bật TRANG WEB quét thuốc trên máy chủ Mini PC (cổng Public 8000, cùng địa chỉ với API /api/v1).

.DESCRIPTION
  Trang web là bản web của ứng dụng điện thoại (mobile/dist-web). Khách chưa đăng nhập được quét thử
  -GuestScans lần (mặc định 5), từ lần tiếp theo phải đăng nhập; đăng nhập rồi dùng như ứng dụng điện thoại.

  Script ghi vào server.env:
    SMC_WEB_DIR      = thư mục bản build trang web
    SMC_GUEST_SCANS  = số lượt quét thử của khách (0 = phải đăng nhập ngay)
  rồi nhắc khởi động lại dịch vụ. Sau đó trang web có ở:
    - địa chỉ Tailscale Funnel hiện tại (ví dụ https://<máy>.<tailnet>.ts.net:8443/) — dùng thử ngay;
    - tên miền riêng (ví dụ https://tuthuoc.id.vn) sau khi tạo Cloudflare Tunnel trỏ tên miền về http://127.0.0.1:8000
      (deploy\cloudflare\setup-cloudflared.ps1 — xem docs/DEPLOYMENT.md mục 6C).

  Cập nhật trang web về sau: npm --prefix mobile run export:web (không cần khởi động lại dịch vụ).

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File deploy\web\enable-web.ps1
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File deploy\web\enable-web.ps1 -GuestScans 0
#>
[CmdletBinding()]
param(
  [string]$WebDir = "",
  [ValidateRange(0, 100)][int]$GuestScans = 5,
  [string]$EnvFile = "$env:ProgramData\SmartMedicineCabinet\server\server.env",
  [int]$PublicPort = 8000
)
$ErrorActionPreference = "Stop"
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

$repo = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
if (-not $WebDir) { $WebDir = Join-Path $repo "mobile\dist-web" }
$WebDir = [System.IO.Path]::GetFullPath($WebDir)
if (-not (Test-Path (Join-Path $WebDir "index.html"))) {
  throw "Chưa có bản build trang web ở $WebDir. Chạy trước: npm --prefix mobile run export:web"
}
if (-not (Test-Path (Join-Path $WebDir "zxing_reader.wasm"))) {
  Write-Host "Cảnh báo: thiếu zxing_reader.wasm — quét mã vạch trên trình duyệt không có BarcodeDetector sẽ không chạy. Build lại bằng npm --prefix mobile run export:web" -ForegroundColor Yellow
}
if (-not (Test-Path $EnvFile)) { throw "Không thấy $EnvFile (máy chủ chưa cài?)" }

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw "Cần 'Run as administrator' để sửa server.env." }

$lines = @(Get-Content $EnvFile -Encoding UTF8 | Where-Object { $_ -notmatch '^\s*(SMC_WEB_DIR|SMC_GUEST_SCANS)\s*=' })
$lines += "SMC_WEB_DIR=$WebDir"
$lines += "SMC_GUEST_SCANS=$GuestScans"
[System.IO.File]::WriteAllLines($EnvFile, $lines, (New-Object System.Text.UTF8Encoding($false)))
Write-Host "Đã ghi vào server.env:" -ForegroundColor Green
Write-Host "  SMC_WEB_DIR=$WebDir"
Write-Host "  SMC_GUEST_SCANS=$GuestScans  (khách quét thử $GuestScans lần rồi phải đăng nhập)"

Write-Host "`n==> Khởi động lại dịch vụ để áp dụng" -ForegroundColor Cyan
Restart-Service SmartMedicineServer
# Máy chủ cần vài giây (kết nối CSDL, chạy migration) mới nhận kết nối — thử lại tối đa ~60 giây.
Write-Host "Đang chờ máy chủ sẵn sàng..."
$page = $null; $lastError = ""
for ($i = 0; $i -lt 30 -and -not $page; $i++) {
  Start-Sleep -Seconds 2
  try { $page = Invoke-WebRequest "http://127.0.0.1:$PublicPort/" -UseBasicParsing -TimeoutSec 10 } catch { $lastError = $_.Exception.Message }
}
try {
  if (-not $page) { throw $lastError }
  $ok = $page.Content -match "Tủ thuốc thông minh"
  Write-Host ("Trang web ở cổng {0}: HTTP {1} {2}" -f $PublicPort, $page.StatusCode, $(if ($ok) { "ĐẠT" } else { "(nội dung lạ)" }))
  $api = Invoke-RestMethod "http://127.0.0.1:$PublicPort/api/v1/app/config" -TimeoutSec 20
  Write-Host ("Khách quét thử: {0} ({1} lượt)" -f $(if ($api.guest.enabled) { "bật" } else { "tắt" }), $api.guest.scans)
} catch {
  Write-Host "Chưa kiểm tra được trang web: $($_.Exception.Message). Xem nhật ký: C:\ProgramData\SmartMedicineCabinet\server\logs" -ForegroundColor Yellow
}
Write-Host "`nMở thử qua Internet bằng địa chỉ Funnel hiện tại (không cần tên miền), hoặc tên miền .id.vn sau khi tạo Cloudflare Tunnel." -ForegroundColor Green
