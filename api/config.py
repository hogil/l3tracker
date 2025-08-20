import os
from pathlib import Path

# 기본 이미지 루트 경로 (환경변수 PROJECT_ROOT 로 재정의 가능)
# wm-811k 데이터셋 경로로 설정
ROOT_DIR = Path(os.getenv("PROJECT_ROOT", "D:/project/data/wm-811k")).resolve()
THUMBNAIL_DIR = ROOT_DIR / "thumbnails"
THUMBNAIL_SIZE = (512, 512)
THUMBNAIL_FORMAT = 'WEBP'
THUMBNAIL_QUALITY = 95
THUMBNAIL_CACHE_SECONDS = 86400  # 24시간
SUPPORTED_EXTS = {'.jpg', '.jpeg', '.png', '.bmp', '.gif', '.tiff', '.webp'}
MAX_WORKERS = 16
MAX_THUMBNAIL_BATCH = 30

# 백그라운드 썸네일 생성 설정
BACKGROUND_SCAN_INTERVAL = int(os.getenv("BACKGROUND_SCAN_INTERVAL", "300"))  # 5분 (초)
BACKGROUND_BATCH_SIZE = int(os.getenv("BACKGROUND_BATCH_SIZE", "10"))  # 한 번에 처리할 이미지 수 (사용자 액션 우선순위)
BACKGROUND_WORKERS = max(2, MAX_WORKERS // 4)

# 서버 설정
DEFAULT_HOST = os.getenv("HOST", "0.0.0.0")
DEFAULT_PORT = int(os.getenv("PORT", "8080"))  # 기본 포트를 8080으로 변경  # 백그라운드 전용 워커 수
