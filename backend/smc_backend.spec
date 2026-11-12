# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller spec — đóng gói backend FastAPI + PaddleOCR thành thư mục ``dist/smc-backend``.

    cd backend
    python -m PyInstaller smc_backend.spec --noconfirm --clean

Kết quả: ``backend/dist/smc-backend/smc-backend(.exe)`` + thư mục ``_internal``.
electron-builder chép thư mục này vào ``resources/backend`` của bản cài đặt.

Ghi chú:
- Chế độ onedir (không phải onefile) để khởi động nhanh và không giải nén ra thư mục tạm mỗi lần chạy.
- ``console=True``: Electron ẩn cửa sổ console (windowsHide) và ghi stdout/stderr vào logs/backend.log.
- PaddleX kiểm tra thư viện phụ thuộc bằng importlib.metadata nên phải chép metadata (.dist-info).
- SMC_BUNDLE_PADDLE=1 (scripts/build-backend.mjs tự đặt khi backend/.venv có cài PaddlePaddle): kèm engine
  PaddlePaddle. Với bản paddlepaddle-gpu (CUDA 11.8) chỉ chép các DLL CUDA cần cho NHẬN DẠNG — xem
  NVIDIA_INFERENCE_DLLS. Không đặt: chỉ có ONNX Runtime (bản cài nhẹ hơn nhiều).
- Python chạy ở UTF-8 mode (giống PYTHONUTF8=1 khi chạy từ mã nguồn — bản đóng băng bỏ qua biến PYTHON*):
  nhật ký tiếng Việt không bị lỗi mã hoá, open() mặc định UTF-8.
"""
import glob
import importlib.metadata as metadata
import importlib.util
import os
import re

from PyInstaller.utils.hooks import collect_data_files, collect_dynamic_libs, collect_submodules, copy_metadata

BUNDLE_PADDLE = os.environ.get("SMC_BUNDLE_PADDLE") == "1"

# PaddlePaddle trên Windows nạp DLL CUDA từ <thư mục chứa gói paddle>/nvidia/<gói>/bin (paddle/__init__.py).
# Chỉ các DLL dưới đây cần cho suy luận OCR; cufft, curand, cusolver, cusparse, nvrtc và các DLL *_train của
# cuDNN chỉ dùng khi huấn luyện / phép toán khác — bỏ đi để bản cài nhẹ hơn ~1,4 GB.
NVIDIA_INFERENCE_DLLS = {
    "cuda_runtime": ["cudart64_*.dll"],
    "cublas": ["cublas64_*.dll", "cublasLt64_*.dll"],
    "cudnn": ["cudnn64_*.dll", "cudnn_ops_infer64_*.dll", "cudnn_cnn_infer64_*.dll", "cudnn_adv_infer64_*.dll"],
}


def nvidia_inference_binaries() -> list[tuple[str, str]]:
    spec = importlib.util.find_spec("paddle")
    if spec is None or spec.origin is None:
        return []
    base = os.path.join(os.path.dirname(os.path.dirname(spec.origin)), "nvidia")
    found = []
    for package, patterns in NVIDIA_INFERENCE_DLLS.items():
        for pattern in patterns:
            for path in glob.glob(os.path.join(base, package, "bin", pattern)):
                found.append((path, f"nvidia/{package}/bin"))
    return found


def installed_requirements(distribution: str) -> list[str]:
    """Tên các gói phụ thuộc (đã cài) của một gói — để chép metadata."""
    names: set[str] = set()
    for requirement in metadata.requires(distribution) or []:
        name = re.split(r"[<>=!~;\[\s]", requirement, maxsplit=1)[0].strip()
        if not name:
            continue
        try:
            metadata.version(name)
        except metadata.PackageNotFoundError:
            continue
        names.add(name)
    return sorted(names)


datas = []
datas += collect_data_files("paddlex", include_py_files=False)
datas += collect_data_files("paddleocr", include_py_files=False)

metadata_packages = {"paddlex", "paddleocr", "onnxruntime", "numpy", "pandas", "opencv-contrib-python"}
metadata_packages.update(installed_requirements("paddlex"))
metadata_packages.update(installed_requirements("paddleocr"))
if BUNDLE_PADDLE:
    metadata_packages.update({"paddlepaddle", "paddlepaddle-gpu"})  # gói nào không cài sẽ được bỏ qua bên dưới
else:
    metadata_packages.discard("paddlepaddle")
for package in sorted(metadata_packages):
    try:
        datas += copy_metadata(package)
    except Exception as error:  # gói tuỳ chọn không có metadata -> bỏ qua
        print(f"[smc] bỏ qua metadata của {package}: {error}")

hiddenimports = []
hiddenimports += collect_submodules("app")  # router/model được nạp động theo tên
hiddenimports += collect_submodules("uvicorn")
hiddenimports += [
    "multipart",
    "python_multipart",
    "websockets.legacy.client",
    "websockets.asyncio.client",
    "sqlalchemy.dialects.sqlite",
    "openpyxl.cell._writer",
    "pyclipper",
    "shapely",
]

excludes = [
    # Không dùng trong ứng dụng — loại ra để bản cài đặt gọn hơn.
    "tkinter", "matplotlib", "IPython", "notebook", "jupyter", "pytest", "_pytest",
    "torch", "torchvision", "tensorflow", "jax", "sklearn", "scipy.spatial.cKDTree",
    "playwright", "rapidocr", "PyInstaller",
]
binaries = []
if BUNDLE_PADDLE:
    if importlib.util.find_spec("paddle") is None:
        raise SystemExit("[smc] SMC_BUNDLE_PADDLE=1 nhưng môi trường Python này chưa cài PaddlePaddle.")
    binaries += collect_dynamic_libs("paddle")  # paddle/libs/*.dll: phi (kernel GPU/CPU), mkldnn, mklml…
    cuda = nvidia_inference_binaries()
    binaries += cuda
    hiddenimports += collect_submodules("paddle.inference")
    print(f"[smc] Kèm PaddlePaddle; {len(cuda)} DLL CUDA cho suy luận: {', '.join(sorted(os.path.basename(p) for p, _ in cuda)) or '(bản CPU)'}")
else:
    excludes += ["paddle"]

a = Analysis(
    ["run_backend.py"],
    pathex=[os.path.abspath(".")],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=excludes,
    noarchive=False,
    optimize=0,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [("X utf8", None, "OPTION")],  # = python -X utf8
    exclude_binaries=True,
    name="smc-backend",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=True,
    disable_windowed_traceback=False,
    icon=os.path.abspath(os.path.join("..", "assets", "icon.ico")) if os.name == "nt" else None,
)
coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    name="smc-backend",
)
