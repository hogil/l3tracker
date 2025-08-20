import os
from pathlib import Path
from math import floor

# ===== 경로 / 포맷 =====
ROOT_DIR = Path(os.getenv("PROJECT_ROOT", "D:/project/data/wm-811k")).resolve()
THUMBNAIL_DIR = ROOT_DIR / "thumbnails"

THUMBNAIL_SIZE_DEFAULT = int(os.getenv("THUMBNAIL_SIZE", "512"))
THUMBNAIL_FORMAT = os.getenv("THUMBNAIL_FORMAT", "WEBP")
THUMBNAIL_QUALITY = int(os.getenv("THUMBNAIL_QUALITY", "100"))

SUPPORTED_EXTS = {'.jpg', '.jpeg', '.png', '.bmp', '.tiff', '.tif', '.webp', '.gif'}
SKIP_DIRS = set(os.getenv("SKIP_DIRS", "classification,thumbnails").split(","))

# ===== 동시성 / 성능 =====
CPU_COUNT = os.cpu_count() or 8
IO_THREADS = int(os.getenv("IO_THREADS", "0")) or max(8, CPU_COUNT)
THUMBNAIL_SEM = int(os.getenv("THUMBNAIL_SEM", "32"))

DIRLIST_CACHE_SIZE = int(os.getenv("DIRLIST_CACHE_SIZE", "1024"))
THUMB_STAT_TTL_SECONDS = float(os.getenv("THUMB_STAT_TTL_SECONDS", "5"))
THUMB_STAT_CACHE_CAPACITY = int(os.getenv("THUMB_STAT_CACHE_CAPACITY", "8192"))

# ===== 서버 기본값 =====
DEFAULT_HOST = os.getenv("HOST", "0.0.0.0")
DEFAULT_PORT = int(os.getenv("PORT", "8080"))
DEFAULT_RELOAD = os.getenv("RELOAD", "0") == "1"

# 👉 DEFAULT_WORKERS: CPU의 75%를 기본으로, 최소 24개 (환경변수 WORKERS가 있으면 그 값 사용)
def _default_workers():
    return max(24, floor((os.cpu_count() or 8) * 0.75))

DEFAULT_WORKERS = int(os.getenv("WORKERS", str(_default_workers())))
