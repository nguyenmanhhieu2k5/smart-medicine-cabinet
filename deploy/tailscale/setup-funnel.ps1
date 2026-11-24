<#
.SYNOPSIS
  Đưa API CÔNG KHAI (cổng 8000: điện thoại Scanner + ESP32) ra Internet bằng Tailscale Funnel:
  địa chỉ cố định https://<mini-pc>.<tailnet>.ts.net:8443, tự chạy khi bật máy, không cần tên miền, không mở cổng router.

.DESCRIPTION
  - Dùng tài khoản Tailscale đã đăng nhập bằng deploy\tailscale\setup-tailscale.ps1 (kênh quản trị).
  - Funnel CHỈ mở cổng 8443 (hoặc 10000) → http://127.0.0.1:8000 (API công khai).
    Cổng 443 (API quản trị → 127.0.0.1:8001) vẫn CHỈ trong tailnet. Script kiểm tra lại cấu hình sau khi bật:
    nếu thấy API quản trị bị đưa ra Funnel thì tắt ngay và báo lỗi. Máy chủ cũng tự từ chối mọi yêu cầu có
    header Funnel ở cổng quản trị.
  - Lần đầu, tailnet phải cho phép Funnel: script in một liên kết — đăng nhập Tailscale, bấm Enable — rồi tự chờ.
  - Ghi SMC_PUBLIC_BASE_URL vào server.env (ứng dụng Windows hiện đúng địa chỉ WSS cho ESP32) và khởi động lại
    dịch vụ máy chủ nếu đang chạy với quyền Administrator.
  - KHÔNG dùng "tailscale funnel reset" (lệnh đó xóa cả kênh quản trị). Tắt: -Disable.
  - Cloudflare Tunnel (deploy\cloudflare) là cách thay thế khi có tên miền riêng — chỉ dùng MỘT trong hai.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File deploy\tailscale\setup-funnel.ps1
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File deploy\tailscale\setup-funnel.ps1 -Disable
#>
[CmdletBinding()]
param(
  # 443 bị cấm: cổng đó đang phục vụ API quản trị trong tailnet.
  [ValidateSet(8443, 10000)] [int]$Port = 8443,
  [int]$PublicApiPort = 8000,
  [int]$AdminApiPort = 8001,
  [string]$EnvFile = "$env:ProgramData\SmartMedicineCabinet\server\server.env",
  [string]$ServiceName = "SmartMedicineServer",
  [int]$ApprovalTimeoutMinutes = 15,
  [switch]$Disable
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
function Write-Step([string]$Text) { Write-Host "`n==> $Text" -ForegroundColor Cyan }

$ts = Join-Path $env:ProgramFiles "Tailscale\tailscale.exe"
if (-not (Test-Path $ts)) {
  $cmd = Get-Command tailscale.exe -ErrorAction SilentlyContinue
  if ($cmd) { $ts = $cmd.Source } else { throw "Chưa cài Tailscale. Chạy trước: deploy\tailscale\setup-tailscale.ps1" }
}

function Invoke-Ts([string[]]$Arguments) {
  # Lệnh native ghi ra stderr không được làm script dừng (PowerShell 5.1 + ErrorActionPreference=Stop).
  $old = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    $out = & $ts @Arguments 2>&1 | ForEach-Object { "$_" }
    return [pscustomobject]@{ Code = $LASTEXITCODE; Text = ($out -join "`n") }
  } finally { $ErrorActionPreference = $old }
}

function Get-TsStatus { (Invoke-Ts @("status", "--json")).Text | ConvertFrom-Json }
function Test-FunnelAllowed($Status) {
  $caps = @()
  if ($Status.Self.PSObject.Properties.Name -contains "CapMap" -and $Status.Self.CapMap) { $caps += $Status.Self.CapMap.PSObject.Properties.Name }
  if ($Status.Self.PSObject.Properties.Name -contains "Capabilities" -and $Status.Self.Capabilities) { $caps += $Status.Self.Capabilities }
  return [bool]($caps | Where-Object { $_ -eq "funnel" -or $_ -like "*/cap/funnel*" })
}

# ---------------------------------------------------------------------------
Write-Step "1/5 Kiểm tra Tailscale"
$status = Get-TsStatus
if ($status.BackendState -ne "Running") { throw "Tailscale chưa kết nối (trạng thái: $($status.BackendState)). Chạy deploy\tailscale\setup-tailscale.ps1 trước." }
$hostName = $status.Self.DNSName.TrimEnd(".")
$publicUrl = "https://${hostName}:$Port"
Write-Host "Máy: $hostName"

if ($Disable) {
  Write-Step "Tắt Funnel cổng $Port"
  $r = Invoke-Ts @("funnel", "--https=$Port", "off")
  Write-Host $r.Text
  Write-Host "Đã tắt. Điện thoại và ESP32 không kết nối được qua $publicUrl nữa. Kênh quản trị (cổng 443, tailnet) giữ nguyên." -ForegroundColor Yellow
  exit 0
}

# ---------------------------------------------------------------------------
Write-Step "2/5 Quyền Funnel của tailnet"
if (-not (Test-FunnelAllowed $status)) {
  $link = "https://login.tailscale.com/f/funnel?node=$($status.Self.ID)"
  Write-Host "Tailnet chưa cho phép Funnel. Mở liên kết sau, đăng nhập tài khoản Tailscale và bấm Enable:" -ForegroundColor Yellow
  Write-Host "  $link" -ForegroundColor Yellow
  try { Start-Process $link } catch { }
  $deadline = (Get-Date).AddMinutes($ApprovalTimeoutMinutes)
  do {
    Start-Sleep -Seconds 5
    $status = Get-TsStatus
  } until ((Test-FunnelAllowed $status) -or (Get-Date) -gt $deadline)
  if (-not (Test-FunnelAllowed $status)) { throw "Chưa thấy Funnel được cho phép sau $ApprovalTimeoutMinutes phút. Duyệt xong thì chạy lại script." }
}
Write-Host "Funnel đã được cho phép." -ForegroundColor Green

# ---------------------------------------------------------------------------
Write-Step "3/5 Bật Funnel: $publicUrl → http://127.0.0.1:$PublicApiPort (chỉ API công khai)"
$r = Invoke-Ts @("funnel", "--bg", "--https=$Port", "http://127.0.0.1:$PublicApiPort")
if ($r.Code -ne 0) { throw "tailscale funnel lỗi (mã $($r.Code)): $($r.Text)" }
Write-Host $r.Text

# ---------------------------------------------------------------------------
Write-Step "4/5 Kiểm tra an toàn: API quản trị không được ra Internet"
$serve = (Invoke-Ts @("serve", "status", "--json")).Text | ConvertFrom-Json
$funneled = @()
if ($serve.PSObject.Properties.Name -contains "AllowFunnel" -and $serve.AllowFunnel) {
  $funneled = @($serve.AllowFunnel.PSObject.Properties | Where-Object { $_.Value } | ForEach-Object { $_.Name })
}
$problems = @()
foreach ($hp in $funneled) {
  $web = $serve.Web.PSObject.Properties | Where-Object { $_.Name -eq $hp } | Select-Object -First 1
  $targets = @()
  if ($web) { $targets = @($web.Value.Handlers.PSObject.Properties | ForEach-Object { $_.Value.Proxy }) }
  foreach ($t in $targets) {
    if ($t -notmatch "^http://(127\.0\.0\.1|localhost):$PublicApiPort/?$") { $problems += "$hp → $t" }
  }
  if (-not $hp.EndsWith(":$Port")) { $problems += "$hp (cổng Funnel ngoài dự kiến)" }
}
if ($problems.Count -gt 0) {
  foreach ($hp in $funneled) { $port = $hp.Split(":")[-1]; [void](Invoke-Ts @("funnel", "--https=$port", "off")) }
  throw "Phát hiện Funnel trỏ sai: $($problems -join '; '). Đã tắt Funnel. Kiểm tra lại 'tailscale serve status'."
}
if (-not ($funneled -contains "${hostName}:$Port")) { throw "Funnel chưa bật cho ${hostName}:$Port — xem 'tailscale funnel status'." }
Write-Host "Funnel: $($funneled -join ', ') → 127.0.0.1:$PublicApiPort. API quản trị (cổng $AdminApiPort) chỉ trong tailnet." -ForegroundColor Green

# ---------------------------------------------------------------------------
Write-Step "5/5 Cấu hình máy chủ"
if (Test-Path $EnvFile) {
  $lines = @(Get-Content -LiteralPath $EnvFile -Encoding UTF8)
  if ($lines -match "^SMC_PUBLIC_BASE_URL=") {
    $lines = $lines | ForEach-Object { if ($_ -match "^SMC_PUBLIC_BASE_URL=") { "SMC_PUBLIC_BASE_URL=$publicUrl" } else { $_ } }
  } else {
    $lines += "SMC_PUBLIC_BASE_URL=$publicUrl"
  }
  [System.IO.File]::WriteAllLines($EnvFile, [string[]]$lines, (New-Object System.Text.UTF8Encoding($false)))
  Write-Host "Đã ghi SMC_PUBLIC_BASE_URL=$publicUrl vào $EnvFile"
  $isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  if ($isAdmin -and (Get-Service $ServiceName -ErrorAction SilentlyContinue)) {
    Restart-Service $ServiceName
    Write-Host "Đã khởi động lại dịch vụ $ServiceName."
  } else {
    Write-Host "Khởi động lại dịch vụ để áp dụng (PowerShell Administrator):  Restart-Service $ServiceName" -ForegroundColor Yellow
  }
} else {
  Write-Host "Không thấy $EnvFile — đặt SMC_PUBLIC_BASE_URL=$publicUrl thủ công." -ForegroundColor Yellow
}

Write-Host @"

  Xong. Địa chỉ cố định, tự chạy cùng Tailscale khi bật máy:
    Ứng dụng điện thoại (Máy chủ):  $publicUrl
    ESP32 (config.h):               SERVER_HOST "$hostName"   SERVER_PORT $Port   USE_TLS 1
    Đường WebSocket của ESP32:      wss://${hostName}:$Port/api/v1/device/ws
    Ứng dụng Windows (Tailscale):   https://$hostName   (không đổi, chỉ trong tailnet)
  Kiểm tra:  powershell -ExecutionPolicy Bypass -File deploy\windows\health-check.ps1 -PublicUrl $publicUrl
"@ -ForegroundColor Green
