import os
from pathlib import Path

# 기본 이미지 루트 경로 (환경변수 PROJECT_ROOT 로 재정의 가능)
# 절대 경로 예시: "C:/Your/Image/Folder" 또는 "/home/user/images"
ROOT_DIR = Path(os.getenv("PROJECT_ROOT", str(Path(__file__).parent.parent.resolve()))).resolve()
THUMBNAIL_DIR = ROOT_DIR / "thumbnails"
THUMBNAIL_SIZE = (128, 128)
THUMBNAIL_FORMAT = 'WEBP'
THUMBNAIL_QUALITY = 70
THUMBNAIL_CACHE_SECONDS = 86400  # 24시간
SUPPORTED_EXTS = {'.jpg', '.jpeg', '.png', '.bmp', '.gif', '.tiff', '.webp'}
MAX_WORKERS = 16
MAX_THUMBNAIL_BATCH = 30 

# 백그라운드 썸네일 생성 설정
BACKGROUND_SCAN_INTERVAL = int(os.getenv("BACKGROUND_SCAN_INTERVAL", "300"))  # 5분 (초)
BACKGROUND_BATCH_SIZE = int(os.getenv("BACKGROUND_BATCH_SIZE", "50"))  # 한 번에 처리할 이미지 수
BACKGROUND_WORKERS = max(2, MAX_WORKERS // 4)  # 백그라운드 전용 워커 수 