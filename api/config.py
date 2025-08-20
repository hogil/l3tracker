import os
from pathlib import Path

# ⚠️ 새로운 PC에서 사용하려면 이 경로를 수정하세요!
# 예시: "C:/Users/사용자명/Documents/images" 또는 "/home/사용자명/images"
ROOT_DIR = Path("D:/project/data/wm-811k").resolve()

# 환경변수로 재정의 가능 (선택사항)
if os.getenv("PROJECT_ROOT"):
    ROOT_DIR = Path(os.getenv("PROJECT_ROOT")).resolve()

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
