<#
.SYNOPSIS
  Cài máy chủ Tủ thuốc thông minh (FastAPI + PaddleOCR + IoT) thành dịch vụ Windows chạy 24/7.

.DESCRIPTION
  Dùng WinSW v2.12.0 (MIT) làm trình bao dịch vụ:
    - Tự chạy khi khởi động máy (Automatic, Delayed), sau dịch vụ PostgreSQL.
    - Tự khởi động lại khi lỗi (10 s / 30 s / 60 s), xoay vòng nhật ký.
    - Chạy: backend\.venv\Scripts\python.exe -m app.server, đọc cấu hình từ server.env.
  File WinSW được kiểm tra SHA-256 trước khi dùng.

  Cần "Run as administrator". Chạy deploy\postgres\setup-postgres.ps1 trước.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File deploy\windows\install-server-service.ps1
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File deploy\windows\install-server-service.ps1 -Uninstall
#>
[CmdletBinding()]
param(
  [string]$ServiceName = "SmartMedicineServer",
  [string]$EnvFile = "$env:ProgramData\SmartMedicineCabinet\server\server.env",
  [string]$ServiceDir = "$env:ProgramData\SmartMedicineCabinet\service",
  [string]$WinSWPath = "",
  [string]$DependsOn = "postgresql-x64-17",
  [switch]$Uninstall
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
$Root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$WinSWUrl = "https://github.com/winsw/winsw/releases/download/v2.12.0/WinSW-x64.exe"
$WinSWSha256 = "05b82d46ad331cc16bdc00de5c6332c1ef818df8ceefcd49c726553209b3a0da"
$exe = Join-Path $ServiceDir "$ServiceName.exe"

function Write-Step([string]$Text) { Write-Host "`n==> $Text" -ForegroundColor Cyan }

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw "Cần mở PowerShell bằng 'Run as administrator'."
}

if ($Uninstall) {
  if (Test-Path $exe) {
    & $exe stop | Out-Null
    & $exe uninstall
    Write-Host "Đã gỡ dịch vụ $ServiceName (dữ liệu và CSDL giữ nguyên)." -ForegroundColor Green
  } else { Write-Host "Chưa cài dịch vụ $ServiceName." }
  return
}

Write-Step "1/4 Kiểm tra môi trường"
$python = Join-Path $Root "backend\.venv\Scripts\python.exe"
if (-not (Test-Path $python)) { throw "Thiếu $python — chạy setup-windows.bat trước." }
if (-not (Test-Path $EnvFile)) { throw "Thiếu $EnvFile — chạy deploy\postgres\setup-postgres.ps1 trước." }
$env:SMC_ENV_FILE = $EnvFile
$env:PYTHONUTF8 = "1"
Push-Location (Join-Path $Root "backend")
try {
  & $python -m app.cli check
  if ($LASTEXITCODE -ne 0) { throw "Kiểm tra cấu hình thất bại (xem thông báo ở trên)." }
} finally { Pop-Location }
$values = @{}
foreach ($l in (Get-Content $EnvFile -Encoding UTF8)) { if ($l -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$') { $values[$Matches[1]] = $Matches[2].Trim() } }
$publicPort = if ($values.ContainsKey("SMC_PUBLIC_PORT")) { $values["SMC_PUBLIC_PORT"] } else { "8000" }
$adminPort = if ($values.ContainsKey("SMC_ADMIN_PORT")) { $values["SMC_ADMIN_PORT"] } else { "8001" }

Write-Step "2/4 Chuẩn bị WinSW"
New-Item -ItemType Directory -Force -Path $ServiceDir | Out-Null
if (-not $WinSWPath) {
  $WinSWPath = Join-Path $env:TEMP "WinSW-x64-v2.12.0.exe"
  if (-not (Test-Path $WinSWPath)) {
    Write-Host "  Tải $WinSWUrl"
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Invoke-WebRequest -Uri $WinSWUrl -OutFile $WinSWPath -UseBasicParsing
  }
}
$hash = (Get-FileHash $WinSWPath -Algorithm SHA256).Hash.ToLower()
if ($hash -ne $WinSWSha256) { throw "SHA-256 của WinSW không khớp ($hash). Không dùng file này." }
$existing = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($existing) {
  Write-Host "  Dịch vụ đã có — dừng để cập nhật cấu hình."
  if (Test-Path $exe) { & $exe stop | Out-Null; & $exe uninstall | Out-Null }
  Start-Sleep -Seconds 2
}
Copy-Item $WinSWPath $exe -Force

$backend = Join-Path $Root "backend"
$logDir = Join-Path (Split-Path -Parent $EnvFile) "logs"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$xml = @"
<service>
  <id>$ServiceName</id>
  <name>Smart Medicine Cabinet Server</name>
  <description>Tủ thuốc thông minh — FastAPI (Public :$publicPort, Admin :$adminPort, chỉ 127.0.0.1) + PaddleOCR + IoT hub, CSDL PostgreSQL.</description>
  <executable>$python</executable>
  <arguments>-m app.server</arguments>
  <workingdirectory>$backend</workingdirectory>
  <env name="SMC_ENV_FILE" value="$EnvFile"/>
  <env name="PYTHONUTF8" value="1"/>
  <env name="PYTHONIOENCODING" value="utf-8"/>
  <startmode>Automatic</startmode>
  <delayedAutoStart>true</delayedAutoStart>
  <depend>$DependsOn</depend>
  <onfailure action="restart" delay="10 sec"/>
  <onfailure action="restart" delay="30 sec"/>
  <onfailure action="restart" delay="60 sec"/>
  <resetfailure>1 hour</resetfailure>
  <stoptimeout>30 sec</stoptimeout>
  <logpath>$logDir</logpath>
  <log mode="roll-by-size">
    <sizeThreshold>10240</sizeThreshold>
    <keepFiles>5</keepFiles>
  </log>
</service>
"@
[System.IO.File]::WriteAllText((Join-Path $ServiceDir "$ServiceName.xml"), $xml, (New-Object System.Text.UTF8Encoding($false)))

Write-Step "3/4 Cài và khởi động dịch vụ"
& $exe install
if ($LASTEXITCODE -ne 0) { throw "WinSW install thất bại." }
& $exe start
$deadline = (Get-Date).AddSeconds(180)
$ok = $false
do {
  Start-Sleep -Seconds 3
  try {
    $a = Invoke-WebRequest -Uri "http://127.0.0.1:$adminPort/api/health" -UseBasicParsing -TimeoutSec 3
    $p = Invoke-WebRequest -Uri "http://127.0.0.1:$publicPort/api/v1/health" -UseBasicParsing -TimeoutSec 3
    $ok = ($a.StatusCode -eq 200 -and $p.StatusCode -eq 200)
  } catch { $ok = $false }
} while (-not $ok -and (Get-Date) -lt $deadline)
if (-not $ok) { throw "Dịch vụ chưa trả lời sau 3 phút — xem nhật ký trong $logDir" }

Write-Step "4/4 Xong"
Get-Service $ServiceName | Format-Table Name, Status, StartType -AutoSize | Out-String | Write-Host
Write-Host @"
  Public API (cho Cloudflare Tunnel): http://127.0.0.1:$publicPort/api/v1/health
  Admin API  (cho tailscale serve)  : http://127.0.0.1:$adminPort/api/health
  Nhật ký: $logDir
  Quản lý: Get-Service $ServiceName | Restart-Service $ServiceName | deploy\windows\install-server-service.ps1 -Uninstall
"@ -ForegroundColor Green
