<#
.SYNOPSIS
  Đưa Public API (cổng 8000: mobile Scanner + ESP32) ra Internet bằng Cloudflare Tunnel — không mở cổng router.

.DESCRIPTION
  Cách 1 (khuyến nghị) — tunnel quản lý trên dashboard:
    Cloudflare Zero Trust → Networks → Tunnels → Create tunnel (Cloudflared) → đặt tên → copy TOKEN.
    Public Hostname: api.<tên-miền-của-bạn>  →  Service: HTTP  →  127.0.0.1:8000
    Rồi chạy:  setup-cloudflared.ps1 -TunnelToken <TOKEN> -PublicUrl https://api.<tên-miền>
  Cách 2 — chạy thử không cần tài khoản/tên miền (địa chỉ ngẫu nhiên *.trycloudflare.com, mất khi tắt):
    setup-cloudflared.ps1 -QuickTest

  TUYỆT ĐỐI không trỏ tunnel tới cổng 8001 (Admin). Máy chủ cũng tự chặn mọi yêu cầu có header Cloudflare
  ở cổng Admin.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File deploy\cloudflare\setup-cloudflared.ps1 -TunnelToken eyJh... -PublicUrl https://api.tuthuoc.example
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File deploy\cloudflare\setup-cloudflared.ps1 -QuickTest
#>
[CmdletBinding()]
param(
  [string]$TunnelToken = "",
  [string]$PublicUrl = "",
  [switch]$QuickTest,
  [int]$PublicPort = 8000,
  [string]$EnvFile = "$env:ProgramData\SmartMedicineCabinet\server\server.env"
)
$ErrorActionPreference = "Stop"
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

function Find-Cloudflared {
  $cmd = Get-Command cloudflared -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  foreach ($p in @("${env:ProgramFiles(x86)}\cloudflared\cloudflared.exe", "$env:ProgramFiles\cloudflared\cloudflared.exe")) { if (Test-Path $p) { return $p } }
  return $null
}
$cf = Find-Cloudflared
if (-not $cf) {
  Write-Host "Chưa có cloudflared — cài bằng winget…" -ForegroundColor Yellow
  winget install --id Cloudflare.cloudflared -e --accept-source-agreements --accept-package-agreements
  $cf = Find-Cloudflared
  if (-not $cf) { throw "Không cài được cloudflared: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/" }
}
& $cf --version

try { Invoke-WebRequest "http://127.0.0.1:$PublicPort/api/v1/health" -UseBasicParsing -TimeoutSec 5 | Out-Null }
catch { Write-Host "Cảnh báo: Public API chưa chạy ở 127.0.0.1:$PublicPort" -ForegroundColor Yellow }

if ($QuickTest) {
  Write-Host "`nTunnel thử (Ctrl+C để dừng). Địa chỉ https://*.trycloudflare.com in bên dưới — nhập vào ứng dụng mobile." -ForegroundColor Cyan
  & $cf tunnel --no-autoupdate --url "http://127.0.0.1:$PublicPort"
  return
}

if (-not $TunnelToken) { throw "Thiếu -TunnelToken (xem hướng dẫn trong phần mô tả: Get-Help .\setup-cloudflared.ps1 -Full)." }
$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw "Cần 'Run as administrator' để cài dịch vụ cloudflared." }

Write-Host "`n==> Cài cloudflared thành dịch vụ Windows (tự chạy khi khởi động)" -ForegroundColor Cyan
& $cf service install $TunnelToken
Start-Sleep -Seconds 5
Get-Service cloudflared | Format-Table Name, Status, StartType -AutoSize | Out-String | Write-Host

if ($PublicUrl) {
  $PublicUrl = $PublicUrl.TrimEnd("/")
  if (Test-Path $EnvFile) {
    $lines = @(Get-Content $EnvFile -Encoding UTF8 | Where-Object { $_ -notmatch '^\s*SMC_PUBLIC_BASE_URL\s*=' })
    $lines += "SMC_PUBLIC_BASE_URL=$PublicUrl"
    [System.IO.File]::WriteAllLines($EnvFile, $lines, (New-Object System.Text.UTF8Encoding($false)))
    Write-Host "Đã ghi SMC_PUBLIC_BASE_URL=$PublicUrl vào server.env (khởi động lại dịch vụ SmartMedicineServer để áp dụng)."
  }
  Write-Host "Kiểm tra qua Internet (có thể mất 1–2 phút để DNS cập nhật):"
  try { (Invoke-RestMethod "$PublicUrl/api/v1/health" -TimeoutSec 20) | Format-List | Out-String | Write-Host }
  catch { Write-Host "  Chưa truy cập được $PublicUrl — kiểm tra Public Hostname trong dashboard trỏ tới http://127.0.0.1:$PublicPort" -ForegroundColor Yellow }
  Write-Host "WebSocket cho ESP32: $($PublicUrl -replace '^https://', 'wss://')/api/v1/device/ws" -ForegroundColor Green
}
