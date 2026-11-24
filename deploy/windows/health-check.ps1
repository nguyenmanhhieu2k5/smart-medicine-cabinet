<#
.SYNOPSIS
  Kiểm tra nhanh mọi thành phần của máy chủ Mini PC (không cần quyền quản trị).
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File deploy\windows\health-check.ps1
  powershell -ExecutionPolicy Bypass -File deploy\windows\health-check.ps1 -PublicUrl https://api.tuthuoc.example
#>
param([int]$PublicPort = 8000, [int]$AdminPort = 8001, [string]$PublicUrl = "")
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
$failed = 0
function Check([string]$Name, [scriptblock]$Test) {
  try { $detail = & $Test; Write-Host ("[ OK ] {0} {1}" -f $Name, $detail) -ForegroundColor Green }
  catch { $script:failed++; Write-Host ("[LỖI] {0}: {1}" -f $Name, $_.Exception.Message) -ForegroundColor Red }
}
foreach ($svc in @("postgresql-x64-17", "SmartMedicineServer", "Tailscale")) {
  Check "Dịch vụ $svc" { $s = Get-Service $svc -ErrorAction Stop; if ($s.Status -ne "Running") { throw "đang $($s.Status)" }; "($($s.StartType))" }
}
# Kênh công khai (điện thoại + ESP32): Cloudflare Tunnel HOẶC Tailscale Funnel — chỉ cần một.
$tsExe = Join-Path $env:ProgramFiles "Tailscale\tailscale.exe"
$serve = $null
if (Test-Path $tsExe) {
  $old = $ErrorActionPreference; $ErrorActionPreference = "Continue"
  try { $serve = (& $tsExe serve status --json 2>$null | Out-String) | ConvertFrom-Json } catch { $serve = $null } finally { $ErrorActionPreference = $old }
}
$funnels = @()
if ($serve -and ($serve.PSObject.Properties.Name -contains "AllowFunnel") -and $serve.AllowFunnel) {
  $funnels = @($serve.AllowFunnel.PSObject.Properties | Where-Object { $_.Value } | ForEach-Object { $_.Name })
}
$cloudflared = Get-Service cloudflared -ErrorAction SilentlyContinue
Check "Kênh công khai (Cloudflare Tunnel hoặc Tailscale Funnel)" {
  $parts = @()
  if ($cloudflared) { if ($cloudflared.Status -ne "Running") { throw "dịch vụ cloudflared đang $($cloudflared.Status)" }; $parts += "cloudflared ($($cloudflared.StartType))" }
  if ($funnels.Count) { $parts += "Funnel " + ($funnels -join ", ") }
  if (-not $parts.Count) { throw "chưa có — chạy deploy\tailscale\setup-funnel.ps1 hoặc deploy\cloudflare\setup-cloudflared.ps1" }
  $parts -join " + "
}
if ($funnels.Count) {
  Check "Funnel chỉ mở API công khai (:$PublicPort), không mở API quản trị (:$AdminPort)" {
    foreach ($hp in $funnels) {
      $web = $serve.Web.PSObject.Properties | Where-Object { $_.Name -eq $hp } | Select-Object -First 1
      $targets = @(); if ($web) { $targets = @($web.Value.Handlers.PSObject.Properties | ForEach-Object { $_.Value.Proxy }) }
      foreach ($t in $targets) { if ($t -notmatch "^http://(127\.0\.0\.1|localhost):$PublicPort/?$") { throw "$hp đang trỏ tới $t — tắt ngay: tailscale funnel --https=$($hp.Split(':')[-1]) off" } }
    }
    "(" + ($funnels -join ", ") + " → 127.0.0.1:$PublicPort)"
  }
}
Check "PostgreSQL chỉ nghe localhost" {
  $l = Get-NetTCPConnection -LocalPort 5432 -State Listen -ErrorAction Stop | Select-Object -ExpandProperty LocalAddress -Unique
  $bad = @($l | Where-Object { $_ -notin @("127.0.0.1", "::1") }); if ($bad.Count) { throw "đang nghe cả $($bad -join ', ')" }; "($($l -join ', '))"
}
Check "Public API :$PublicPort" { $r = Invoke-RestMethod "http://127.0.0.1:$PublicPort/api/v1/health" -TimeoutSec 5; if ($r.status -ne "ok") { throw $r.status }; "v$($r.version), OCR $($r.ocr)" }
Check "Admin API :$AdminPort" { $r = Invoke-RestMethod "http://127.0.0.1:$AdminPort/api/health" -TimeoutSec 5; "CSDL $($r.database), $($r.catalog_count) thuốc" }
if ($PublicUrl) {
  Check "Địa chỉ công khai $PublicUrl" { $r = Invoke-RestMethod ($PublicUrl.TrimEnd("/") + "/api/v1/health") -TimeoutSec 15; "status $($r.status)" }
  Check "API quản trị KHÔNG lộ qua địa chỉ công khai" {
    try { Invoke-WebRequest ($PublicUrl.TrimEnd("/") + "/api/settings") -UseBasicParsing -TimeoutSec 15 | Out-Null; throw "truy cập được /api/settings qua Internet!" }
    catch [System.Net.WebException] { if ($_.Exception.Response.StatusCode.value__ -in 404, 403) { "(bị chặn như mong muốn)" } else { throw } }
  }
}
Check "Ngủ khi cắm điện đã tắt" { $v = (powercfg /q SCHEME_CURRENT SUB_SLEEP STANDBYIDLE | Select-String "Current AC Power Setting Index").ToString(); if ($v -notmatch "0x00000000") { throw $v.Trim() }; "" }
if ($failed) { Write-Host "`n$failed mục lỗi." -ForegroundColor Red; exit 1 } else { Write-Host "`nMọi thành phần hoạt động." -ForegroundColor Green }
