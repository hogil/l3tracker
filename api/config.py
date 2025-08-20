import os
from pathlib import Path

# ===== 경로 / 포맷 =====
ROOT_DIR = Path(os.getenv("PROJECT_ROOT", "D:/project/data/wm-811k")).resolve()
THUMBNAIL_DIR = ROOT_DIR / "thumbnails"

# 썸네일 기본 한 변 크기 (정사각형), 저장 포맷/품질
THUMBNAIL_SIZE_DEFAULT = int(os.getenv("THUMBNAIL_SIZE", "512"))  # e.g. 512 -> 512x512
THUMBNAIL_FORMAT = os.getenv("THUMBNAIL_FORMAT", "WEBP")
THUMBNAIL_QUALITY = int(os.getenv("THUMBNAIL_QUALITY", "100"))

# 지원 확장자 (입력 이미지)
SUPPORTED_EXTS = {'.jpg', '.jpeg', '.png', '.bmp', '.tiff', '.tif', '.webp', '.gif'}

# 검색/인덱싱 시 스킵할 폴더
SKIP_DIRS = set(os.getenv("SKIP_DIRS", "classification,thumbnails").split(","))

# ===== 동시성 / 성능 =====
CPU_COUNT = os.cpu_count() or 8
IO_THREADS = int(os.getenv("IO_THREADS", "0")) or max(8, CPU_COUNT)  # 디코딩/파일 I/O 풀
THUMBNAIL_SEM = int(os.getenv("THUMBNAIL_SEM", "32"))               # 썸네일 동시 생성 제한

# 캐시
DIRLIST_CACHE_SIZE = int(os.getenv("DIRLIST_CACHE_SIZE", "1024"))
THUMB_STAT_TTL_SECONDS = float(os.getenv("THUMB_STAT_TTL_SECONDS", "5"))
THUMB_STAT_CACHE_CAPACITY = int(os.getenv("THUMB_STAT_CACHE_CAPACITY", "8192"))

# ===== 서버 기본값 (원하면 CLI로 덮어쓰기 권장) =====
DEFAULT_HOST = os.getenv("HOST", "0.0.0.0")
DEFAULT_PORT = int(os.getenv("PORT", "8080"))
DEFAULT_RELOAD = os.getenv("RELOAD", "0") == "1"   # 개발용: RELOAD=1
DEFAULT_WORKERS = int(os.getenv("WORKERS", "1"))  # 운영은 CLI의 --workers 권장
