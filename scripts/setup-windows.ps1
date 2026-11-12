<#
.SYNOPSIS
  Cài đặt môi trường phát triển cho "Tủ thuốc thông minh" trên Windows 10/11.

.DESCRIPTION
  1. Tìm Python 3.11–3.13 (64-bit) và Node.js >= 20
  2. Tạo backend\.venv và cài backend\requirements-dev.txt
  3. npm install (gốc + frontend)
  4. Chuẩn bị mô hình OCR trong ocr_models\ (nếu chưa có)
  5. Kiểm tra file danh mục data\DAV_unique.xlsx

  Chạy lại nhiều lần được; bước nào đã xong sẽ được bỏ qua.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\setup-windows.ps1

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\setup-windows.ps1 -Python "C:\Python312\python.exe"

.NOTES
  Script này đã được kiểm tra cú pháp và chạy thử các bước trên Linux bằng PowerShell 7,
  nhưng CHƯA được chạy trên Windows thật trong quá trình phát triển.
#>
[CmdletBinding()]
param(
  # Đường dẫn python.exe muốn dùng (mặc định: tự tìm bằng "py" hoặc "python")
  [string]$Python = "",
  # Bỏ qua bước chuẩn bị mô hình OCR
  [switch]$SkipModels
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

$Root = Split-Path -Parent $PSScriptRoot
$OnWindows = ($PSVersionTable.PSVersion.Major -lt 6) -or $IsWindows

function Write-Step([string]$Text) { Write-Host "`n==> $Text" -ForegroundColor Cyan }
function Write-Ok([string]$Text) { Write-Host "    $Text" -ForegroundColor Green }
function Write-Note([string]$Text) { Write-Host "    $Text" -ForegroundColor Yellow }

function Invoke-Checked {
  param([string]$File, [string[]]$Arguments = @(), [string]$WorkingDirectory = $Root)
  Push-Location $WorkingDirectory
  try {
    & $File @Arguments
    if ($LASTEXITCODE -ne 0) { throw "Lệnh lỗi (mã $LASTEXITCODE): $File $($Arguments -join ' ')" }
  }
  finally { Pop-Location }
}

function Get-PythonInfo {
  # Trả về "đường_dẫn|major.minor|số_bit" hoặc $null nếu không chạy được.
  param([string]$File, [string[]]$Arguments = @())
  try {
    $code = "import sys, struct; print(sys.executable + '|' + str(sys.version_info[0]) + '.' + str(sys.version_info[1]) + '|' + str(struct.calcsize('P') * 8))"
    $output = & $File @Arguments -c $code 2>$null
    if ($LASTEXITCODE -eq 0 -and $output) { return ($output | Select-Object -Last 1).Trim() }
  }
  catch { }
  return $null
}

function Resolve-Python {
  $supported = @("3.12", "3.13", "3.11")
  $candidates = @()
  if ($Python) { $candidates += , @($Python) }
  if ($OnWindows) { foreach ($version in $supported) { $candidates += , @("py", "-$version") } }
  $candidates += , @("python")
  $candidates += , @("python3")
  $fallback = $null
  foreach ($candidate in $candidates) {
    $file = $candidate[0]
    $arguments = @()
    if ($candidate.Count -gt 1) { $arguments = $candidate[1..($candidate.Count - 1)] }
    $info = Get-PythonInfo -File $file -Arguments $arguments
    if (-not $info) { continue }
    $parts = $info.Split("|")
    if ($parts[2] -ne "64") { Write-Note "Bỏ qua $($parts[0]): Python 32-bit không dùng được (cần 64-bit)."; continue }
    if ($supported -contains $parts[1]) { return $parts }
    if (-not $fallback) { $fallback = $parts }
  }
  if ($fallback) {
    Write-Note "Chỉ tìm thấy Python $($fallback[1]). Dự án được kiểm thử với 3.11–3.13; phiên bản khác có thể thiếu gói cài sẵn."
    return $fallback
  }
  throw "Không tìm thấy Python 64-bit. Cài Python 3.12 từ https://www.python.org/downloads/windows/ (chọn 'Add python.exe to PATH') rồi chạy lại."
}

# ----------------------------------------------------------------------------- #
Write-Step "Kiểm tra công cụ"
$pythonInfo = Resolve-Python
Write-Ok "Python $($pythonInfo[1]) ($($pythonInfo[2])-bit): $($pythonInfo[0])"

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw "Không tìm thấy Node.js. Cài Node.js LTS (>= 20) từ https://nodejs.org/ rồi mở lại PowerShell."
}
$nodeVersion = (& node --version).Trim()
$nodeMajor = [int]($nodeVersion.TrimStart("v").Split(".")[0])
if ($nodeMajor -lt 20) { throw "Node.js $nodeVersion quá cũ. Cần Node.js >= 20." }
Write-Ok "Node.js $nodeVersion, npm $((& npm --version).Trim())"

# ----------------------------------------------------------------------------- #
Write-Step "Môi trường Python (backend\.venv)"
$venvDir = Join-Path (Join-Path $Root "backend") ".venv"
if ($OnWindows) { $venvPython = Join-Path (Join-Path $venvDir "Scripts") "python.exe" }
else { $venvPython = Join-Path (Join-Path $venvDir "bin") "python" }

if (-not (Test-Path $venvPython)) {
  Invoke-Checked -File $pythonInfo[0] -Arguments @("-m", "venv", $venvDir)
  Write-Ok "Đã tạo $venvDir"
}
else { Write-Ok "Đã có $venvDir" }

& $venvPython -m pip --version *> $null
if ($LASTEXITCODE -ne 0) { Invoke-Checked -File $venvPython -Arguments @("-m", "ensurepip", "--upgrade") }
Invoke-Checked -File $venvPython -Arguments @("-m", "pip", "install", "--upgrade", "pip", "--quiet")
Invoke-Checked -File $venvPython -Arguments @("-m", "pip", "install", "-r", (Join-Path (Join-Path $Root "backend") "requirements-dev.txt"))
Write-Ok "Đã cài thư viện Python"

# ----------------------------------------------------------------------------- #
Write-Step "Thư viện Node.js (Electron + giao diện)"
Invoke-Checked -File "npm" -Arguments @("install", "--no-audit", "--no-fund")
Write-Ok "Đã cài node_modules (gốc và frontend)"

# ----------------------------------------------------------------------------- #
Write-Step "Mô hình OCR (ocr_models\)"
function Test-OcrModel([string]$Name) {
  foreach ($folder in @($Name, "${Name}_onnx")) {
    $dir = Join-Path (Join-Path $Root "ocr_models") $folder
    if ((Test-Path (Join-Path $dir "inference.onnx")) -and (Test-Path (Join-Path $dir "inference.yml"))) { return $true }
  }
  return $false
}
$modelsReady = (Test-OcrModel "PP-OCRv6_small_det") -and (Test-OcrModel "PP-OCRv6_small_rec")
if ($modelsReady) { Write-Ok "Đã có PP-OCRv6 small (phát hiện + nhận dạng)" }
elseif ($SkipModels) { Write-Note "Bỏ qua (-SkipModels). Ứng dụng sẽ tự tải mô hình ở lần quét đầu tiên (cần Internet)." }
else {
  Write-Note "Chưa có mô hình — thử tải gói chính thức của PaddleOCR…"
  & $venvPython (Join-Path $PSScriptRoot "download_ocr_models.py")
  if ($LASTEXITCODE -ne 0) {
    Write-Note "Không tải được gói chính thức — thử lấy mô hình ONNX từ gói rapidocr trên PyPI…"
    & $venvPython -m pip install --quiet pyyaml
    & $venvPython (Join-Path $PSScriptRoot "build_ocr_models_from_rapidocr.py") --out (Join-Path $Root "ocr_models")
    if ($LASTEXITCODE -ne 0) {
      Write-Note "Chưa chuẩn bị được mô hình OCR. Bạn vẫn chạy được ứng dụng; chức năng quét sẽ báo thiếu mô hình cho tới khi có mạng."
    }
  }
}

# ----------------------------------------------------------------------------- #
Write-Step "Danh mục thuốc"
$catalog = Join-Path (Join-Path $Root "data") "DAV_unique.xlsx"
if (Test-Path $catalog) { Write-Ok "Đã có $catalog ($([math]::Round((Get-Item $catalog).Length / 1MB, 1)) MB)" }
else { Write-Note "Chưa có data\DAV_unique.xlsx — chép file Excel vào thư mục data\ (hoặc nhập trong Cài đặt của ứng dụng)." }

Write-Host "`nHoàn tất. Chạy thử:  npm run dev      Đóng gói:  scripts\build-windows.ps1" -ForegroundColor Green
