<#
.SYNOPSIS
  Mở kênh quản trị riêng (Admin API, cổng 8001) cho ứng dụng Windows qua Tailscale.

.DESCRIPTION
  - Cài Tailscale (winget) nếu chưa có, đăng nhập tailnet, bật chế độ Unattended (chạy cả khi chưa đăng nhập Windows).
  - `tailscale serve` đưa http://127.0.0.1:8001 lên tailnet (HTTPS + MagicDNS), cổng 8001 vẫn chỉ nghe localhost.
  - Admin API KHÔNG bao giờ đi qua Cloudflare/Internet công khai.

  Chuẩn bị trên https://login.tailscale.com/admin:
    DNS → bật MagicDNS và HTTPS Certificates (để dùng -Mode https, khuyến nghị).
    Access controls → chỉ cho máy Admin truy cập Mini PC (xem deploy\tailscale\README.md).

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File deploy\tailscale\setup-tailscale.ps1
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File deploy\tailscale\setup-tailscale.ps1 -Mode http
#>
[CmdletBinding()]
param(
  [ValidateSet("https", "http")] [string]$Mode = "https",
  [int]$AdminPort = 8001,
  [switch]$Reset
)
$ErrorActionPreference = "Stop"
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

$ts = Join-Path $env:ProgramFiles "Tailscale\tailscale.exe"
if (-not (Test-Path $ts)) {
  Write-Host "Chưa có Tailscale — cài bằng winget (Windows sẽ hỏi quyền quản trị)…" -ForegroundColor Yellow
  winget install --id Tailscale.Tailscale -e --accept-source-agreements --accept-package-agreements
  if (-not (Test-Path $ts)) { throw "Không cài được Tailscale. Tải thủ công: https://tailscale.com/download/windows" }
}

if ($Reset) { & $ts serve reset; Write-Host "Đã gỡ cấu hình tailscale serve."; return }

Write-Host "`n==> Đăng nhập tailnet (mở trình duyệt nếu cần) và bật Unattended" -ForegroundColor Cyan
& $ts up --unattended
if ($LASTEXITCODE -ne 0) { throw "tailscale up thất bại." }

Write-Host "`n==> Đưa Admin API lên tailnet" -ForegroundColor Cyan
try { Invoke-WebRequest "http://127.0.0.1:$AdminPort/api/health" -UseBasicParsing -TimeoutSec 5 | Out-Null }
catch { Write-Host "Cảnh báo: chưa thấy Admin API ở 127.0.0.1:$AdminPort (dịch vụ SmartMedicineServer đã chạy chưa?)" -ForegroundColor Yellow }
if ($Mode -eq "https") { & $ts serve --bg --https=443 "http://127.0.0.1:$AdminPort" }
else { & $ts serve --bg --http=80 "http://127.0.0.1:$AdminPort" }
if ($LASTEXITCODE -ne 0) { throw "tailscale serve thất bại (với -Mode https cần bật HTTPS Certificates trong trang quản trị Tailscale)." }

$status = & $ts status --json | ConvertFrom-Json
$dns = ($status.Self.DNSName).TrimEnd(".")
$scheme = if ($Mode -eq "https") { "https" } else { "http" }
$url = "${scheme}://$dns"
& $ts serve status
Write-Host @"

Địa chỉ máy chủ cho ứng dụng Windows (Cài đặt kết nối → Địa chỉ máy chủ):
    $url
Chỉ các máy trong cùng tailnet mới truy cập được. Kiểm tra từ máy Admin:  $url/api/health
"@ -ForegroundColor Green
