<#
.SYNOPSIS
  Cấu hình điện năng cho Mini PC làm máy chủ 24/7: không ngủ, không ngủ đông khi cắm điện.
.DESCRIPTION
  Tắt standby/hibernate khi cắm điện (AC). Màn hình vẫn được phép tắt để tiết kiệm điện.
  Bật "khởi động lại sau khi mất điện" phải chỉnh trong BIOS (HP Z2 Mini G4: Advanced → Power-On Options →
  After Power Loss = Power On) — script chỉ nhắc, không sửa BIOS.
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File deploy\windows\configure-server-power.ps1
#>
$ErrorActionPreference = "Stop"
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
powercfg /change standby-timeout-ac 0
powercfg /change hibernate-timeout-ac 0
powercfg /change disk-timeout-ac 0
powercfg /change monitor-timeout-ac 15
$standby = (powercfg /q SCHEME_CURRENT SUB_SLEEP STANDBYIDLE | Select-String "Current AC Power Setting Index").ToString()
Write-Host "Ngủ khi cắm điện: $standby (0x00000000 = không bao giờ)" -ForegroundColor Green
Write-Host "Nhắc: bật BIOS 'After Power Loss = Power On' để máy tự bật lại sau khi mất điện; Windows Update nên đặt giờ hoạt động phù hợp."
