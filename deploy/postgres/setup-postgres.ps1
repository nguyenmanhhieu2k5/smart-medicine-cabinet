<#
.SYNOPSIS
  Chuẩn bị PostgreSQL trên Mini PC cho máy chủ Tủ thuốc thông minh (chạy lại nhiều lần được).

.DESCRIPTION
  1. Tạo vai trò ứng dụng (mặc định smc_app) KHÔNG phải superuser, mật khẩu ngẫu nhiên.
  2. Tạo CSDL smart_medicine (UTF8) do smc_app sở hữu; bỏ quyền CONNECT của PUBLIC.
  3. Tạo extension pg_trgm, unaccent.
  4. Chỉ cho PostgreSQL nghe localhost (listen_addresses) và siết pg_hba.conf về 127.0.0.1/::1
     (sao lưu file gốc trước khi sửa) rồi khởi động lại dịch vụ.
  5. Ghi DATABASE_URL + SMC_JWT_SECRET vào server.env (phân quyền: Administrators, SYSTEM, người chạy script).
  6. Chạy migration Alembic và kiểm tra kết nối.

  Cần: PowerShell "Run as administrator" và mật khẩu superuser 'postgres' (đặt lúc cài PostgreSQL).
  Mật khẩu chỉ dùng trong phiên chạy, không lưu lại.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File deploy\postgres\setup-postgres.ps1

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File deploy\postgres\setup-postgres.ps1 -PublicBaseUrl https://api.tuthuoc.example
#>
[CmdletBinding()]
param(
  [string]$ServiceName = "postgresql-x64-17",
  [string]$PgBin = "",
  [string]$PgHost = "127.0.0.1",
  [int]$Port = 5432,
  [string]$SuperUser = "postgres",
  [string]$Database = "smart_medicine",
  [string]$AppUser = "smc_app",
  [string]$EnvFile = "$env:ProgramData\SmartMedicineCabinet\server\server.env",
  [string]$PublicBaseUrl = "",
  [switch]$RotatePassword,
  # Không sửa postgresql.conf / pg_hba.conf và không khởi động lại dịch vụ (dùng khi chạy thử).
  [switch]$SkipSystemChanges,
  # Bỏ qua hỏi mật khẩu superuser (máy chủ thử dùng xác thực trust).
  [switch]$NoSuperPassword,
  [switch]$SkipMigrate
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
$Root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)

function Write-Step([string]$Text) { Write-Host "`n==> $Text" -ForegroundColor Cyan }
function New-RandomSecret([int]$Length) {
  $chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789".ToCharArray()
  $bytes = New-Object byte[] ($Length)
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  $rng.GetBytes($bytes)
  -join ($bytes | ForEach-Object { $chars[$_ % $chars.Length] })
}

# ---------------------------------------------------------------------------
Write-Step "1/6 Tìm PostgreSQL"
$service = Get-CimInstance Win32_Service -Filter "Name='$ServiceName'" -ErrorAction SilentlyContinue
$DataDir = $null
if ($service) {
  if ($service.PathName -match '-D\s+"([^"]+)"') { $DataDir = $Matches[1] }
  if (-not $PgBin -and $service.PathName -match '^"([^"]+)\\pg_ctl\.exe"') { $PgBin = $Matches[1] }
  Write-Host "  Dịch vụ: $ServiceName ($($service.State)), dữ liệu: $DataDir"
} elseif (-not $SkipSystemChanges) {
  throw "Không thấy dịch vụ $ServiceName. Cài PostgreSQL 17 (https://www.postgresql.org/download/windows/) hoặc chỉ định -ServiceName."
}
if (-not $PgBin) { $PgBin = Join-Path $env:ProgramFiles "PostgreSQL\17\bin" }
$psql = Join-Path $PgBin "psql.exe"
if (-not (Test-Path $psql)) { throw "Không thấy psql.exe trong $PgBin (chỉ định -PgBin)." }

if (-not $SkipSystemChanges) {
  $principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
  if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw "Cần mở PowerShell bằng 'Run as administrator' (để giới hạn PostgreSQL chỉ nghe localhost)."
  }
}

if (-not $NoSuperPassword) {
  $secure = Read-Host "Mật khẩu superuser '$SuperUser' của PostgreSQL" -AsSecureString
  $env:PGPASSWORD = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))
}

$env:PGOPTIONS = "-c client_min_messages=warning"  # không in NOTICE (PowerShell 5.1 coi stderr là lỗi)
function Invoke-Psql([string]$Sql, [string]$Db = "postgres") {
  $previous = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    $out = & $psql -h $PgHost -p $Port -U $SuperUser -d $Db -X -q -t -A -v ON_ERROR_STOP=1 -c $Sql 2>&1
    $code = $LASTEXITCODE
  } finally { $ErrorActionPreference = $previous }
  $text = ($out | ForEach-Object { "$_" } | Out-String).Trim()
  if ($code -ne 0) { throw "psql lỗi: $text" }
  return $text
}

$version = Invoke-Psql "SHOW server_version"
Write-Host "  Kết nối superuser thành công — PostgreSQL $version"

# ---------------------------------------------------------------------------
Write-Step "2/6 Vai trò ứng dụng '$AppUser' và CSDL '$Database'"
$existingUrl = $null
if (Test-Path $EnvFile) {
  $line = Get-Content $EnvFile -Encoding UTF8 | Where-Object { $_ -match '^\s*DATABASE_URL\s*=' } | Select-Object -First 1
  if ($line) { $existingUrl = ($line -split "=", 2)[1].Trim().Trim('"') }
}
$roleExists = (Invoke-Psql "SELECT 1 FROM pg_roles WHERE rolname = '$AppUser'") -eq "1"
$password = $null
if ($existingUrl -and $roleExists -and -not $RotatePassword) {
  Write-Host "  Giữ mật khẩu hiện có trong $EnvFile (dùng -RotatePassword để đổi)."
} else {
  $password = New-RandomSecret 32
  if ($roleExists) {
    Invoke-Psql "ALTER ROLE $AppUser WITH LOGIN PASSWORD '$password' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION" | Out-Null
    Write-Host "  Đã đặt mật khẩu mới cho vai trò $AppUser."
  } else {
    Invoke-Psql "CREATE ROLE $AppUser WITH LOGIN PASSWORD '$password' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION CONNECTION LIMIT 50" | Out-Null
    Write-Host "  Đã tạo vai trò $AppUser (không phải superuser)."
  }
}
$dbExists = (Invoke-Psql "SELECT 1 FROM pg_database WHERE datname = '$Database'") -eq "1"
if (-not $dbExists) {
  Invoke-Psql "CREATE DATABASE $Database OWNER $AppUser ENCODING 'UTF8' TEMPLATE template0" | Out-Null
  Write-Host "  Đã tạo CSDL $Database."
} else {
  Write-Host "  CSDL $Database đã có — giữ nguyên dữ liệu."
}
Invoke-Psql "REVOKE ALL ON DATABASE $Database FROM PUBLIC; GRANT CONNECT, TEMPORARY ON DATABASE $Database TO $AppUser" | Out-Null
Invoke-Psql "CREATE EXTENSION IF NOT EXISTS pg_trgm; CREATE EXTENSION IF NOT EXISTS unaccent" $Database | Out-Null
Write-Host "  Extension pg_trgm, unaccent: sẵn sàng."

# ---------------------------------------------------------------------------
Write-Step "3/6 Chỉ cho PostgreSQL nghe localhost"
if ($SkipSystemChanges) {
  Write-Host "  (bỏ qua — chạy thử với -SkipSystemChanges)"
} else {
  Invoke-Psql "ALTER SYSTEM SET listen_addresses = 'localhost'" | Out-Null
  Invoke-Psql "ALTER SYSTEM SET password_encryption = 'scram-sha-256'" | Out-Null
  $hba = Join-Path $DataDir "pg_hba.conf"
  $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
  Copy-Item $hba "$hba.bak-$stamp"
  $lines = Get-Content $hba -Encoding UTF8
  $out = New-Object System.Collections.Generic.List[string]
  foreach ($l in $lines) {
    $t = $l.Trim()
    if ($t -match '^(host|hostssl|hostnossl|hostgssenc|hostnogssenc)\s+\S+\s+\S+\s+(\S+)') {
      $addr = $Matches[2]
      if ($addr -notin @("127.0.0.1/32", "::1/128", "samehost")) { $out.Add("# [smart-medicine $stamp] tắt: $l"); continue }
    }
    $out.Add($l)
  }
  $joined = ($out -join "`n")
  if ($joined -notmatch '(?m)^host\s+all\s+all\s+127\.0\.0\.1/32\s+scram-sha-256') { $out.Add("host    all             all             127.0.0.1/32            scram-sha-256") }
  if ($joined -notmatch '(?m)^host\s+all\s+all\s+::1/128\s+scram-sha-256') { $out.Add("host    all             all             ::1/128                 scram-sha-256") }
  [System.IO.File]::WriteAllLines($hba, $out, (New-Object System.Text.UTF8Encoding($false)))
  Write-Host "  pg_hba.conf: chỉ còn kết nối từ 127.0.0.1 / ::1 (bản gốc: $hba.bak-$stamp)"
  Restart-Service -Name $ServiceName -Force
  $deadline = (Get-Date).AddSeconds(60)
  do { Start-Sleep -Milliseconds 800; & (Join-Path $PgBin "pg_isready.exe") -h 127.0.0.1 -p $Port | Out-Null } while ($LASTEXITCODE -ne 0 -and (Get-Date) -lt $deadline)
  $listen = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty LocalAddress -Unique
  $bad = @($listen | Where-Object { $_ -notin @("127.0.0.1", "::1") })
  if ($bad.Count -gt 0) { throw "PostgreSQL vẫn nghe trên: $($bad -join ', ')" }
  Write-Host "  PostgreSQL đang nghe: $($listen -join ', ') — không lộ ra mạng." -ForegroundColor Green
}

# ---------------------------------------------------------------------------
Write-Step "4/6 Ghi cấu hình máy chủ: $EnvFile"
$envDir = Split-Path -Parent $EnvFile
New-Item -ItemType Directory -Force -Path $envDir | Out-Null
$values = [ordered]@{}
$me = "$($env:USERDOMAIN)\$($env:USERNAME)"
if (Test-Path $EnvFile) {
  & icacls $EnvFile /grant "${me}:M" | Out-Null  # chủ sở hữu file luôn đổi được ACL → ghi lại được khi chạy lại
  Copy-Item $EnvFile "$EnvFile.bak-$(Get-Date -Format yyyyMMdd-HHmmss)"
  foreach ($l in (Get-Content $EnvFile -Encoding UTF8)) {
    if ($l -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$') { $values[$Matches[1]] = $Matches[2].Trim().Trim('"') }
  }
}
if ($password) {
  $values["DATABASE_URL"] = "postgresql+psycopg://${AppUser}:${password}@127.0.0.1:${Port}/${Database}"
}
if (-not $values.Contains("SMC_JWT_SECRET")) { $values["SMC_JWT_SECRET"] = New-RandomSecret 64 }
if ($PublicBaseUrl) { $values["SMC_PUBLIC_BASE_URL"] = $PublicBaseUrl.TrimEnd("/") }
if (-not $values.Contains("SMC_DATA_DIR")) { $values["SMC_DATA_DIR"] = $envDir }
$body = @("# Cấu hình máy chủ Tủ thuốc thông minh — tạo bởi deploy\postgres\setup-postgres.ps1", "# KHÔNG chia sẻ file này: chứa mật khẩu CSDL và khóa ký JWT.")
foreach ($k in $values.Keys) { $body += "$k=$($values[$k])" }
[System.IO.File]::WriteAllLines($EnvFile, $body, (New-Object System.Text.UTF8Encoding($false)))
# Chỉ Administrators, SYSTEM và người đang chạy script được đọc.
& icacls $EnvFile /inheritance:r /grant:r "*S-1-5-32-544:F" "*S-1-5-18:F" "${me}:M" | Out-Null
Get-ChildItem "$EnvFile.bak-*" -ErrorAction SilentlyContinue | ForEach-Object {
  & icacls $_.FullName /inheritance:r /grant:r "*S-1-5-32-544:F" "*S-1-5-18:F" "${me}:M" | Out-Null  # bản sao cũng chứa mật khẩu
}
Write-Host "  Đã ghi DATABASE_URL (mật khẩu ẩn), SMC_JWT_SECRET; phân quyền file đã siết."

# ---------------------------------------------------------------------------
Write-Step "5/6 Migration lược đồ"
$python = Join-Path $Root "backend\.venv\Scripts\python.exe"
if ($SkipMigrate) {
  Write-Host "  (bỏ qua)"
} elseif (-not (Test-Path $python)) {
  Write-Host "  Chưa có backend\.venv — chạy setup-windows.bat rồi: backend\.venv\Scripts\python -m app.cli db upgrade" -ForegroundColor Yellow
} else {
  $env:SMC_ENV_FILE = $EnvFile
  $env:PYTHONUTF8 = "1"
  Push-Location (Join-Path $Root "backend")
  try {
    & $python -m app.cli db upgrade
    if ($LASTEXITCODE -ne 0) { throw "Migration thất bại." }
    & $python -m app.cli check
  } finally { Pop-Location }
}
Remove-Item Env:\PGPASSWORD, Env:\PGOPTIONS -ErrorAction SilentlyContinue

# ---------------------------------------------------------------------------
Write-Step "6/6 Xong"
Write-Host @"
  Bước tiếp theo (gõ trong PowerShell, từ thư mục dự án):
    cd backend
    1. Tạo tài khoản quản trị:   .\.venv\Scripts\python -m app.cli create-admin --email <email> --name "<Họ tên>"
    2. (Nếu có dữ liệu cũ)       .\.venv\Scripts\python -m app.cli migrate-sqlite --source "`$env:APPDATA\SmartMedicineCabinet\data\cabinet.db"
    cd ..
    3. Cài dịch vụ máy chủ:      powershell -ExecutionPolicy Bypass -File .\deploy\windows\install-server-service.ps1   (Run as administrator)
"@
