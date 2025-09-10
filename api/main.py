"""
L3Tracker - Wafer Map Viewer API (No-Restart Live Refresh for Classes & Labels)
- 라벨: labels.json mtime 감지 → stale 시 자동 재로딩(멀티 워커 동기화)
- 디렉터리 캐시: 변경 즉시 무효화(list_dir_fast LRU)
- 클래스 삭제 시: 해당 class 라벨을 전 이미지에서 제거(일관성 유지)
- 라벨/클래스 라우트: 항상 no-store 헤더(브라우저 캐시 방지)
- 라벨/클래스 관련 요청 도착 시: classification 폴더 mtime 변경 감지 → 라벨과 즉시 동기화

주의: config.py는 그대로 사용
"""

import os
import re
import json
import time
import shutil
import logging
from pathlib import Path
from typing import List, Optional, Dict, Any, Tuple
from collections import OrderedDict
from threading import RLock
import asyncio
from concurrent.futures import ThreadPoolExecutor

from fastapi import FastAPI, HTTPException, Query, Request, Path as PathParam
from fastapi.responses import JSONResponse, FileResponse, Response
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from starlette.middleware.gzip import GZipMiddleware
from starlette.middleware.base import BaseHTTPMiddleware
from pydantic import BaseModel, Field
from .access_logger import logger_instance
from PIL import Image

from . import config

# ========== 로깅 ==========
import logging.config

# 사용자 이름 매핑을 위한 전역 변수
USER_IP_MAPPING = {}

# 사용자별 고유 색상 배정
USER_COLORS = {
    'hgchoi@choi': '\033[95m',      # 밝은 마젠타
    'admin@server': '\033[96m',     # 밝은 청록
    'guest@local': '\033[93m',      # 밝은 노랑
    'user@host': '\033[94m',        # 밝은 파랑
    'test@demo': '\033[91m',        # 밝은 빨강
}

def get_user_color(username):
    """사용자별 고유 색상 반환"""
    if username in USER_COLORS:
        return USER_COLORS[username]
    
    # 해시 기반 색상 생성 (일관된 색상)
    import hashlib
    hash_value = int(hashlib.md5(username.encode()).hexdigest()[:6], 16)
    colors = ['\033[91m', '\033[92m', '\033[93m', '\033[94m', '\033[95m', '\033[96m', '\033[97m']
    return colors[hash_value % len(colors)]

# uvicorn 로그에 사용자 이름과 색상을 적용하는 포맷터
class UserNameLogFormatter(logging.Formatter):
    def format(self, record):
        message = super().format(record)
        
        # IP:포트를 사용자명으로 교체
        for ip, user_name in USER_IP_MAPPING.items():
            if ip in message and user_name:
                import re
                # IP:포트 패턴을 사용자명으로 완전 교체
                pattern = rf'\b{re.escape(ip)}:\d+\b'
                replacement = f'\033[92m{user_name}\033[0m'  # 초록색 사용자명
                message = re.sub(pattern, replacement, message)
        
        # INFO 레벨에 색상 적용 (밝은 파란색)
        message = re.sub(r'\bINFO\b', '\033[94mINFO\033[0m', message)
        
        # HTTP 메서드에 다양한 예쁜 색상 적용
        http_methods = {
            'GET': '\033[96m',     # 밝은 청록색 (시원함)
            'POST': '\033[95m',    # 밝은 마젠타색 (활동적)
            'PUT': '\033[94m',     # 밝은 파란색 (안정감)
            'DELETE': '\033[91m',  # 밝은 빨간색 (경고)
        }
        
        for method, color in http_methods.items():
            pattern = f'"{method} '
            if pattern in message:
                colored_method = f'"{color}{method}\033[0m '
                message = message.replace(pattern, colored_method)
        
        # HTTP 상태 코드에 예쁜 색상 적용 (INFO, 사용자명과 구분)
        status_patterns = [
            (r'(\s)([2]\d{2})(\s|$)', r'\1\033[93m\2\033[0m\3'),  # 2xx: 밝은 노랑 (성공)
            (r'(\s)([3]\d{2})(\s|$)', r'\1\033[96m\2\033[0m\3'),  # 3xx: 밝은 청록 (리다이렉트)
            (r'(\s)([4]\d{2})(\s|$)', r'\1\033[91m\2\033[0m\3'),  # 4xx: 밝은 빨강 (클라이언트 오류)
            (r'(\s)([5]\d{2})(\s|$)', r'\1\033[91m\2\033[0m\3'),  # 5xx: 밝은 빨강 (서버 오류)
        ]
        
        for pattern, replacement in status_patterns:
            message = re.sub(pattern, replacement, message)
        
        # 사용자명에 고유 색상 적용
        for ip, user_name in USER_IP_MAPPING.items():
            if ip in message and user_name:
                # IP:포트를 사용자명으로 교체하고 고유 색상 적용
                pattern = rf'\b{re.escape(ip)}:\d+\b'
                user_color = get_user_color(user_name)
                replacement = f'{user_color}{user_name}\033[0m'
                message = re.sub(pattern, replacement, message)
        
        return message

# 색상 포맷터 클래스
class ColoredFormatter(logging.Formatter):
    """컬러 로그 포맷터"""
    
    COLORS = {
        'DEBUG': '\033[36m',    # 청록색
        'INFO': '\033[32m',     # 초록색
        'WARNING': '\033[33m',  # 노란색
        'ERROR': '\033[31m',    # 빨간색
        'CRITICAL': '\033[35m', # 자주색
        'RESET': '\033[0m'      # 리셋
    }
    
    def format(self, record):
        # 레벨에 따른 색상 적용
        level_color = self.COLORS.get(record.levelname, self.COLORS['RESET'])
        reset_color = self.COLORS['RESET']
        
        # 원래 포맷 적용
        formatted = super().format(record)
        
        # 색상 적용: 레벨명 색상 적용
        colored_level = f"{level_color}{record.levelname}{reset_color}"
        formatted = formatted.replace(record.levelname, colored_level, 1)
        
        # HTTP 메서드와 상태 코드에 색상 추가
        formatted = self._colorize_http_content(formatted)
        
        # IP 주소를 사용자 이름으로 교체
        formatted = self._replace_ip_with_username(formatted)
        
        return formatted
    
    def _replace_ip_with_username(self, text):
        """IP:포트를 사용자명으로 교체"""
        import re
        
        for ip, user_name in USER_IP_MAPPING.items():
            if ip in text and user_name:
                # IP:포트 패턴을 사용자명으로 완전 교체 (포트 제거)
                pattern = rf'\b{re.escape(ip)}:\d+\b'
                replacement = f'{user_name}'
                text = re.sub(pattern, replacement, text)
        
        return text
    
    def _colorize_http_content(self, text):
        """HTTP 메서드와 상태 코드에 색상 적용"""
        import re
        
        # HTTP 메서드 색상 적용
        http_methods = {
            'GET': '\033[96m',     # 밝은 청록색
            'POST': '\033[93m',    # 밝은 노란색
            'PUT': '\033[94m',     # 밝은 파란색
            'DELETE': '\033[91m',  # 밝은 빨간색
            'PATCH': '\033[95m',   # 밝은 자주색
            'HEAD': '\033[92m',    # 밝은 초록색
            'OPTIONS': '\033[97m'  # 밝은 흰색
        }
        
        # HTTP 메서드 패턴 매칭 및 색상 적용
        for method, color in http_methods.items():
            pattern = f'"{method} '
            if pattern in text:
                colored_method = f'"{color}{method}\033[0m '
                text = text.replace(pattern, colored_method)
        
        # 상태 코드 색상 적용 (200번대: 초록, 400번대: 노랑, 500번대: 빨강)
        status_patterns = [
            (r'(\s)([2]\d{2})(\s|$)', r'\1\033[92m\2\033[0m\3'),  # 2xx: 밝은 초록
            (r'(\s)([3]\d{2})(\s|$)', r'\1\033[94m\2\033[0m\3'),  # 3xx: 밝은 파랑
            (r'(\s)([4]\d{2})(\s|$)', r'\1\033[93m\2\033[0m\3'),  # 4xx: 밝은 노랑
            (r'(\s)([5]\d{2})(\s|$)', r'\1\033[91m\2\033[0m\3'),  # 5xx: 밝은 빨강
        ]
        
        for pattern, replacement in status_patterns:
            text = re.sub(pattern, replacement, text)
        
        # 사용자 이름 색상 적용
        for ip, user_name in USER_IP_MAPPING.items():
            if user_name and user_name in text:
                # 사용자명을 밝은 초록색으로
                colored_user = f'\033[92m{user_name}\033[0m'
                text = text.replace(user_name, colored_user)
        
        return text

# uvicorn 로깅 설정 (옵션 없이도 시간 표시 + 색상)
LOGGING_CONFIG = {
    "version": 1,
    "disable_existing_loggers": False,
    "formatters": {
        "default": {
            "()": ColoredFormatter,
            "format": "%(levelname)s: %(asctime)s     %(message)s",
            "datefmt": "%Y-%m-%d %H:%M:%S"
        },
        "access": {
            "()": ColoredFormatter,
            "format": "%(levelname)s: %(asctime)s     %(message)s",
            "datefmt": "%Y-%m-%d %H:%M:%S"
        }
    },
    "handlers": {
        "default": {
            "formatter": "default",
            "class": "logging.StreamHandler",
            "stream": "ext://sys.stdout"
        },
        "access": {
            "formatter": "access", 
            "class": "logging.StreamHandler",
            "stream": "ext://sys.stdout"
        }
    },
    "loggers": {
        "uvicorn": {
            "handlers": ["default"],
            "level": "INFO",
            "propagate": False
        },
        "uvicorn.error": {
            "level": "INFO"
        },
        "uvicorn.access": {
            "handlers": ["access"],
            "level": "INFO", 
            "propagate": False
        }
    }
}

# 로깅 설정 적용
logging.config.dictConfig(LOGGING_CONFIG)
logger = logging.getLogger("l3tracker")

# ========== 설정 바인딩 ==========
ROOT_DIR = config.ROOT_DIR
THUMBNAIL_DIR = config.THUMBNAIL_DIR
SUPPORTED_EXTENSIONS = set(ext.lower() for ext in config.SUPPORTED_EXTS)

THUMBNAIL_FORMAT = config.THUMBNAIL_FORMAT
THUMBNAIL_QUALITY = config.THUMBNAIL_QUALITY
THUMBNAIL_SIZE_DEFAULT = config.THUMBNAIL_SIZE_DEFAULT

IO_THREADS = config.IO_THREADS
THUMBNAIL_SEM_SIZE = config.THUMBNAIL_SEM

DIRLIST_CACHE_SIZE = config.DIRLIST_CACHE_SIZE
THUMB_STAT_TTL_SECONDS = config.THUMB_STAT_TTL_SECONDS
THUMB_STAT_CACHE_CAPACITY = config.THUMB_STAT_CACHE_CAPACITY

SKIP_DIRS = {d.strip() for d in config.SKIP_DIRS if d.strip()}

LABELS_DIR = config.LABELS_DIR
LABELS_FILE = config.LABELS_FILE

# ========== 스레드풀/세마포어 ==========
IO_POOL = ThreadPoolExecutor(max_workers=IO_THREADS)
THUMBNAIL_SEM = asyncio.Semaphore(THUMBNAIL_SEM_SIZE)

# ========== 전역 상태 ==========
USER_ACTIVITY_FLAG = False
BACKGROUND_TASKS_PAUSED = False
INDEX_BUILDING = False
INDEX_READY = False

# rel_path -> {"name_lower": str, "size": int, "modified": float}
FILE_INDEX: Dict[str, Dict[str, Any]] = {}
FILE_INDEX_LOCK = RLock()

# 라벨: { rel_path(str): ["label1", "label2", ...] }
LABELS: Dict[str, List[str]] = {}
LABELS_LOCK = RLock()
LABELS_MTIME: float = 0.0  # labels.json 최신 mtime 기록

# classification 폴더 변경 감지용
CLASSES_MTIME: float = 0.0

# ========== 캐시 ==========
class LRUCache:
    def __init__(self, capacity: int):
        self.capacity = capacity
        self._cache: OrderedDict[str, Any] = OrderedDict()
        self._lock = RLock()

    def get(self, key: str):
        with self._lock:
            val = self._cache.get(key)
            if val is None:
                return None
            self._cache.move_to_end(key)
            return val

    def set(self, key: str, value: Any):
        with self._lock:
            if key in self._cache:
                self._cache.move_to_end(key)
            self._cache[key] = value
            if len(self._cache) > self.capacity:
                self._cache.popitem(last=False)

    def delete(self, key: str):
        with self._lock:
            self._cache.pop(key, None)

    def clear(self):
        with self._lock:
            self._cache.clear()

DIRLIST_CACHE = LRUCache(DIRLIST_CACHE_SIZE)

class TTLCache:
    def __init__(self, ttl_sec: float, capacity: int):
        self.ttl = ttl_sec
        self.capacity = capacity
        self._data: OrderedDict[str, Tuple[float, Any]] = OrderedDict()
        self._lock = RLock()

    def get(self, key: str):
        now = time.time()
        with self._lock:
            item = self._data.get(key)
            if not item:
                return None
            exp, val = item
            if exp < now:
                del self._data[key]
                return None
            self._data.move_to_end(key)
            return val

    def set(self, key: str, value: Any):
        now = time.time()
        with self._lock:
            if key in self._data:
                self._data.move_to_end(key)
            self._data[key] = (now + self.ttl, value)
            if len(self._data) > self.capacity:
                self._data.popitem(last=False)

THUMB_STAT_CACHE = TTLCache(THUMB_STAT_TTL_SECONDS, THUMB_STAT_CACHE_CAPACITY)

# ========== FastAPI ==========
app = FastAPI(title="L3Tracker API", version="2.4.0")

# 접속 추적 미들웨어
class AccessTrackingMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        # 사용자 ID 생성
        client_ip = logger_instance.get_client_ip(request)
        user_agent = request.headers.get("user-agent", "Unknown")
        user_id = logger_instance.generate_user_id(client_ip, user_agent)
        
        # 요청 URL 경로
        endpoint = str(request.url.path)
        
        # 정적 파일 및 파비콘은 로깅하지 않음
        skip_paths = ["/favicon.ico", "/static/", "/js/"]
        should_log = not any(endpoint.startswith(path) for path in skip_paths)
        
        # 사용자 통계 먼저 업데이트 (display_name 확보용)
        if should_log:
            logger_instance.update_stats(user_id, client_ip, endpoint, user_agent)
            
            # 새 사용자이고 display_name이 없으면 시스템 사용자 이름 설정 시도
            if (user_id in logger_instance.user_stats and 
                not logger_instance.user_stats[user_id].get("display_name", "") and
                "Mozilla" in user_agent):  # 브라우저 접속인 경우만
                try:
                    import getpass
                    import socket
                    system_username = getpass.getuser()
                    hostname = socket.gethostname()
                    if system_username and system_username != "Unknown":
                        display_name = f"{system_username}@{hostname}"
                        logger_instance.set_user_display_name(user_id, display_name)
                except Exception:
                    pass
            
            # 모든 사용자를 hgchoi@choi로 강제 설정
            logger_instance.set_user_display_name(user_id, "hgchoi@choi")
            
            # IP-사용자 매핑 업데이트 (uvicorn 로그용)
            USER_IP_MAPPING[client_ip] = "hgchoi@choi"
            
            logger_instance.log_access(request, user_id, endpoint)
        
        # 요청 처리
        response = await call_next(request)
        
        return response

# 미들웨어 추가
app.add_middleware(AccessTrackingMiddleware)
app.add_middleware(GZipMiddleware, minimum_size=1024)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"], allow_credentials=False, allow_methods=["*"], allow_headers=["*"],
)

# ========== 유틸 ==========
def is_supported_image(path: Path) -> bool:
    return path.suffix.lower() in SUPPORTED_EXTENSIONS

def get_thumbnail_path(image_path: Path, size: Tuple[int, int]) -> Path:
    relative_path = image_path.relative_to(ROOT_DIR)
    thumbnail_name = f"{relative_path.stem}_{size[0]}x{size[1]}.{THUMBNAIL_FORMAT.lower()}"
    return THUMBNAIL_DIR / relative_path.parent / thumbnail_name

def safe_resolve_path(path: Optional[str]) -> Path:
    if not path:
        return ROOT_DIR
    try:
        normalized = os.path.normpath(str(path).lstrip("/\\"))
        target = (ROOT_DIR / normalized).resolve()
        if not str(target).startswith(str(ROOT_DIR)):
            raise HTTPException(status_code=400, detail="Invalid path")
        return target
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"경로 해석 실패: {path}, 오류: {e}")
        raise HTTPException(status_code=400, detail="Invalid path")

def compute_etag(st) -> str:
    return f'W/"{st.st_mtime_ns:x}-{st.st_size:x}"'

def relkey_from_any_path(any_path: str) -> str:
    abs_path = safe_resolve_path(any_path)
    rel = str(abs_path.relative_to(ROOT_DIR)).replace("\\", "/")
    return rel

# ===== 라벨/클래스 동기화 유틸 =====
def _labels_reload_if_stale():
    """다른 워커가 labels.json을 갱신했으면 이 워커도 즉시 반영"""
    global LABELS_MTIME
    try:
        st = LABELS_FILE.stat()
    except FileNotFoundError:
        return
    if st.st_mtime > LABELS_MTIME:
        _labels_load()

def _dircache_invalidate(path: Path):
    """list_dir_fast 캐시 무효화(변경 경로 및 resolve 버전 동시 제거)"""
    try:
        DIRLIST_CACHE.delete(str(path))
    except Exception:
        pass
    try:
        DIRLIST_CACHE.delete(str(path.resolve()))
    except Exception:
        pass

def _classification_dir() -> Path:
    return ROOT_DIR / "classification"

def _classes_stat_mtime() -> float:
    try:
        return _classification_dir().stat().st_mtime
    except FileNotFoundError:
        return 0.0

def _scan_classes() -> set:
    classes = set()
    d = _classification_dir()
    if not d.exists():
        return classes
    try:
        with os.scandir(d) as it:
            for e in it:
                if e.is_dir(follow_symlinks=False):
                    classes.add(e.name)
    except FileNotFoundError:
        pass
    return classes

def _sync_labels_with_classes(existing_classes: set) -> int:
    """현재 파일시스템에 존재하지 않는 클래스 라벨들을 전 이미지에서 제거"""
    removed = 0
    with LABELS_LOCK:
        for rel, labs in list(LABELS.items()):
            new_labs = [x for x in labs if x in existing_classes]
            if new_labs != labs:
                if new_labs:
                    LABELS[rel] = new_labs
                else:
                    LABELS.pop(rel, None)
                removed += 1
    if removed:
        _labels_save()
    return removed

def _sync_labels_if_classes_changed():
    """classification 폴더 mtime이 바뀌었으면 라벨을 파일시스템과 동기화"""
    global CLASSES_MTIME
    cur = _classes_stat_mtime()
    if cur > CLASSES_MTIME:
        CLASSES_MTIME = cur
        classes = _scan_classes()
        cleaned = _sync_labels_with_classes(classes)
        if cleaned:
            logger.info(f"[SYNC] classes 변경 감지 → 라벨 {cleaned}개 이미지에서 정리됨")

def _remove_label_from_all_images(label_name: str) -> int:
    """LABELS에서 지정 라벨을 모든 이미지에서 제거, 빈 항목은 삭제. 제거된 이미지 수 반환."""
    removed = 0
    with LABELS_LOCK:
        for rel, labs in list(LABELS.items()):
            if label_name in labs:
                new_labs = [x for x in labs if x != label_name]
                if new_labs:
                    LABELS[rel] = new_labs
                else:
                    LABELS.pop(rel, None)
                removed += 1
                logger.info(f"라벨 제거: {rel}에서 '{label_name}' 제거됨")
    
    if removed:
        _labels_save()
        logger.info(f"라벨 완전 삭제: '{label_name}' 라벨을 {removed}개 이미지에서 제거하고 저장됨")
    
    return removed

# ========== 라벨 파일 I/O ==========
def _labels_load():
    global LABELS, LABELS_MTIME
    if not LABELS_FILE.exists():
        with LABELS_LOCK:
            LABELS = {}
        LABELS_MTIME = 0.0
        return
    try:
        with LABELS_LOCK:
            with open(LABELS_FILE, "r", encoding="utf-8") as f:
                data = json.load(f)
            fixed: Dict[str, List[str]] = {}
            for k, v in data.items():
                if isinstance(v, list):
                    fixed[k] = [str(x) for x in v]
            LABELS = fixed
        try:
            LABELS_MTIME = LABELS_FILE.stat().st_mtime
        except Exception:
            LABELS_MTIME = time.time()
        logger.info(f"라벨 로드: {len(LABELS)}개 이미지 (mtime={LABELS_MTIME})")
    except Exception as e:
        logger.error(f"라벨 로드 실패: {e}")

def _labels_save():
    global LABELS_MTIME
    try:
        # LABELS_DIR은 classification 폴더와 동일하며, 이미 다른 곳에서 생성됨
        tmp = LABELS_FILE.with_suffix(".json.tmp")
        with LABELS_LOCK:
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(LABELS, f, ensure_ascii=False, indent=2)
            os.replace(tmp, LABELS_FILE)
        try:
            LABELS_MTIME = LABELS_FILE.stat().st_mtime
        except Exception:
            LABELS_MTIME = time.time()
    except Exception as e:
        logger.error(f"라벨 저장 실패: {e}")
        raise HTTPException(status_code=500, detail="Failed to save labels")

# ========== 유저 우선 ==========
def set_user_activity():
    global USER_ACTIVITY_FLAG, BACKGROUND_TASKS_PAUSED
    USER_ACTIVITY_FLAG = True
    BACKGROUND_TASKS_PAUSED = True

def clear_user_activity():
    global USER_ACTIVITY_FLAG
    USER_ACTIVITY_FLAG = False

def can_run_background_task() -> bool:
    return not BACKGROUND_TASKS_PAUSED and not USER_ACTIVITY_FLAG

@app.middleware("http")
async def user_priority_middleware(request: Request, call_next):
    set_user_activity()
    try:
        response = await call_next(request)
    finally:
        asyncio.create_task(delayed_background_resume())
    return response

# 라벨/클래스 응답은 항상 캐시 금지
@app.middleware("http")
async def no_store_for_labels_and_classes(request: Request, call_next):
    response = await call_next(request)
    p = request.url.path
    if p.startswith("/api/labels") or p.startswith("/api/classes"):
        response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
        response.headers["Pragma"] = "no-cache"
        response.headers["Expires"] = "0"
    return response

async def delayed_background_resume():
    await asyncio.sleep(1.5)
    global BACKGROUND_TASKS_PAUSED
    BACKGROUND_TASKS_PAUSED = False
    clear_user_activity()

# ========== 디렉터리 나열 ==========
def list_dir_fast(target: Path) -> List[Dict[str, str]]:
    # 특정 경로는 캐시하지 않고 항상 새로 읽기
    # classification 관련 경로나 자주 변경되는 경로
    no_cache_paths = ['classification', 'images', 'labels']
    should_cache = True

    target_str = str(target).replace('\\', '/')
    for no_cache in no_cache_paths:
        if no_cache in target_str:
            should_cache = False
            break

    key = str(target)
    if should_cache:    cached = DIRLIST_CACHE.get(key)
    if cached is not None:        return cached

    items: List[Dict[str, str]] = []
    try:
        with os.scandir(target) as it:
            for entry in it:
                name = entry.name
                if name.startswith('.') or name == '__pycache__':
                    continue
                if name in SKIP_DIRS:
                    continue
                typ = "directory" if entry.is_dir(follow_symlinks=False) else "file"
                items.append({"name": name, "type": typ})

        # 디렉터리와 파일을 분리하여 각각 내림차순 정렬
        directories = [x for x in items if x["type"] == "directory"]
        files = [x for x in items if x["type"] == "file"]

        directories.sort(key=lambda x: x["name"].lower(), reverse=True)
        files.sort(key=lambda x: x["name"].lower(), reverse=True)

        # 디버깅: 정렬 결과 로그
        if directories:
            logger.info(f"정렬된 디렉터리 순서: {[d['name'] for d in directories[:5]]}")

        items = directories + files
        if should_cache:DIRLIST_CACHE.set(key, items)
    except FileNotFoundError:
        pass
    return items

# ========== 인덱스 ==========
async def build_file_index_background():
    global INDEX_BUILDING, INDEX_READY
    if INDEX_BUILDING:
        return
    INDEX_BUILDING = True
    INDEX_READY = False
    logger.info("백그라운드 인덱스 구축 시작")

    def _walk_and_index():
        global INDEX_READY
        start = time.time()
        for root, dirs, files in os.walk(ROOT_DIR):
            if BACKGROUND_TASKS_PAUSED or USER_ACTIVITY_FLAG:
                time.sleep(0.1)
            for skip in list(SKIP_DIRS):
                if skip in dirs:
                    dirs.remove(skip)
            for fn in files:
                ext = os.path.splitext(fn)[1].lower()
                if ext not in SUPPORTED_EXTENSIONS:
                    continue
                full = Path(root) / fn
                try:
                    rel = str(full.relative_to(ROOT_DIR)).replace("\\", "/")
                except Exception:
                    continue
                try:
                    st = full.stat()
                    rec = {"name_lower": fn.lower(), "size": st.st_size, "modified": st.st_mtime}
                    with FILE_INDEX_LOCK:
                        FILE_INDEX[rel] = rec
                except Exception:
                    continue
            time.sleep(0.001)
        INDEX_READY = True
        logger.info(f"인덱스 구축 완료: {len(FILE_INDEX)}개, {time.time()-start:.1f}s")

    try:
        await asyncio.get_running_loop().run_in_executor(IO_POOL, _walk_and_index)
    finally:
        INDEX_BUILDING = False

# ========== 썸네일 ==========
def _generate_thumbnail_sync(image_path: Path, thumbnail_path: Path, size: Tuple[int, int]):
    thumbnail_path.parent.mkdir(parents=True, exist_ok=True)
    with Image.open(image_path) as img:
        img.thumbnail(size, Image.Resampling.LANCZOS)
        img.save(thumbnail_path, THUMBNAIL_FORMAT.upper(), quality=THUMBNAIL_QUALITY, optimize=True)

async def generate_thumbnail(image_path: Path, size: Tuple[int, int]) -> Path:
    thumb = get_thumbnail_path(image_path, size)
    key = f"{thumb}|{size[0]}x{size[1]}"
    
    # 원본 파일의 수정 시간 확인
    if not image_path.exists():
        raise FileNotFoundError(f"원본 이미지 파일이 존재하지 않습니다: {image_path}")
    
    image_mtime = image_path.stat().st_mtime
    
    # 썸네일이 존재하고 원본보다 최신인 경우에만 기존 썸네일 사용
    if thumb.exists() and thumb.stat().st_size > 0:
        thumb_mtime = thumb.stat().st_mtime
        if thumb_mtime >= image_mtime:cached = THUMB_STAT_CACHE.get(key)
    if cached:
        return thumb
        THUMB_STAT_CACHE.set(key, True)
        return thumb

    # 썸네일이 없거나 구버전이면 새로 생성
    async with THUMBNAIL_SEM:
        # 다시 한번 확인 (동시성 고려)
        if thumb.exists() and thumb.stat().st_size > 0:
            thumb_mtime = thumb.stat().st_mtime
            if thumb_mtime >= image_mtime:            THUMB_STAT_CACHE.set(key, True)
            return thumb
        
        # 기존 썸네일 파일 삭제 (구버전인 경우)
        if thumb.exists():
            try:
                thumb.unlink()
            except Exception as e:
                logger.warning(f"기존 썸네일 삭제 실패: {thumb}, 오류: {e}")
        
        await asyncio.get_running_loop().run_in_executor(
            IO_POOL, _generate_thumbnail_sync, image_path, thumb, size
        )
        THUMB_STAT_CACHE.set(key, True)
        return thumb

# ========== 공통: ETag/304 ==========
def maybe_304(request: Request, st) -> Optional[Response]:
    etag = compute_etag(st)
    if request.headers.get("if-none-match") == etag:
        return Response(status_code=304, headers={"ETag": etag, "Cache-Control": "public, max-age=604800, immutable"})
    return None

# ========== 엔드포인트: 파일/이미지/검색 ==========
@app.get("/api/files")
async def get_files(path: Optional[str] = None):
    try:
        set_user_activity()
        target = safe_resolve_path(path)
        if not target.exists() or not target.is_dir():
            return JSONResponse({"success": False, "error": "Not found"}, status_code=404)
        
        # 특정 경로에 대해서는 캐시 무효화
        target_str = str(target).replace('\\', '/')
        if any(x in target_str for x in ['classification', 'images', 'labels']):
            _dircache_invalidate(target)
        
        return {"success": True, "items": list_dir_fast(target)}
    except HTTPException:
        raise
    except Exception as e:
        logger.exception(f"폴더 조회 실패: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/api/image")
async def get_image(request: Request, path: str):
    try:
        set_user_activity()
        image_path = safe_resolve_path(path)
        if not image_path.exists() or not image_path.is_file():
            raise HTTPException(status_code=404, detail="Image not found")
        # 모든 파일 형식 허용 (이미지 제한 제거)

        st = image_path.stat()
        resp_304 = maybe_304(request, st)
        if resp_304:
            return resp_304
        headers = {"Cache-Control": "public, max-age=86400, immutable", "ETag": compute_etag(st)}
        return FileResponse(image_path, headers=headers)
    except HTTPException:
        raise
    except Exception as e:
        logger.exception(f"이미지 제공 실패: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/api/thumbnail")
async def get_thumbnail(request: Request, path: str, size: int = THUMBNAIL_SIZE_DEFAULT):
    try:
        set_user_activity()
        image_path = safe_resolve_path(path)
        if not image_path.exists() or not image_path.is_file():
            raise HTTPException(status_code=404, detail="Image not found")
        if not is_supported_image(image_path):
            raise HTTPException(status_code=400, detail="Unsupported image format")

        target_size = (size, size)
        thumb = await generate_thumbnail(image_path, target_size)

        st = thumb.stat()
        resp_304 = maybe_304(request, st)
        if resp_304:
            return resp_304
        headers = {"Cache-Control": "public, max-age=604800, immutable", "ETag": compute_etag(st)}
        return FileResponse(thumb, headers=headers)
    except HTTPException:
        raise
    except Exception as e:
        logger.exception(f"썸네일 제공 실패: {e}")
        return await get_image(request, path)

@app.get("/api/search")
async def search_files(
    q: str = Query(..., description="파일명 검색(대소문자 무시, 부분일치)"),
    limit: int = Query(500, ge=1, le=5000),
    offset: int = Query(0, ge=0)
):
    try:
        set_user_activity()
        query = (q or "").strip().lower()
        if not query:
            return {"success": True, "results": [], "offset": offset, "limit": limit}

        goal = offset + limit
        bucket: List[str] = []

        with FILE_INDEX_LOCK:
            items = list(FILE_INDEX.items())
        if items:
            for rel, meta in items:
                if query in meta["name_lower"]:
                    bucket.append(rel)
                    if len(bucket) >= goal:
                        break

        if len(bucket) < goal:
            seen = set(bucket)
            need = goal - len(bucket)
            def _scan():
                nonlocal need
                for root, dirs, files in os.walk(ROOT_DIR):
                    for skip in list(SKIP_DIRS):
                        if skip in dirs:
                            dirs.remove(skip)
                    for fn in files:
                        ext = os.path.splitext(fn)[1].lower()
                        if ext not in SUPPORTED_EXTENSIONS:
                            continue
                        low = fn.lower()
                        if query not in low:
                            continue
                        full = Path(root) / fn
                        try:
                            rel = str(full.relative_to(ROOT_DIR)).replace("\\", "/")
                        except Exception:
                            continue
                        if rel in seen:
                            continue
                        seen.add(rel)
                        bucket.append(rel)
                        try:
                            st = full.stat()
                            rec = {"name_lower": low, "size": st.st_size, "modified": st.st_mtime}
                            with FILE_INDEX_LOCK:
                                FILE_INDEX[rel] = rec
                        except Exception:
                            pass
                        need -= 1
                        if need <= 0:
                            return
                    time.sleep(0.001)
            if need > 0:
                await asyncio.get_running_loop().run_in_executor(IO_POOL, _scan)

        results = bucket[offset: offset + limit]
        return {"success": True, "results": results, "offset": offset, "limit": limit}
    except HTTPException:
        raise
    except Exception as e:
        logger.exception(f"검색 실패: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/api/files/all")
async def get_all_files():
    """전체 파일 목록 조회 (인덱스 기반)"""
    try:
        set_user_activity()
        with FILE_INDEX_LOCK:
            keys = list(FILE_INDEX.keys())
        if not keys and not INDEX_BUILDING:
            asyncio.create_task(build_file_index_background())
        return {"success": True, "files": keys}
    except HTTPException:
        raise
    except Exception as e:
        logger.exception(f"전체 파일 목록 조회 실패: {e}")
        raise HTTPException(status_code=500, detail=str(e))

# ========== 엔드포인트: 클래스 ==========
_CLASS_NAME_RE = re.compile(r"^[A-Za-z0-9_\-]+$")

class CreateClassReq(BaseModel):
    name: str = Field(..., min_length=1, max_length=128)

@app.get("/api/classes")
async def get_classes():
    """분류 클래스 목록 조회 (항상 파일시스템 스캔)"""
    try:
        set_user_activity()
        _labels_reload_if_stale()
        _sync_labels_if_classes_changed()

        # 캐시 무효화 - classification 디렉토리 항상 새로 읽기
        classification_dir = _classification_dir()
        _dircache_invalidate(classification_dir)
        
        # classification 폴더가 없으면 생성
        if not classification_dir.exists():
            classification_dir.mkdir(parents=True, exist_ok=True)
            logger.info(f"classification 폴더 생성: {classification_dir}")
            return {"success": True, "classes": []}

        classes = []
        try:
            with os.scandir(classification_dir) as it:
                for entry in it:
                    if entry.is_dir(follow_symlinks=False):
                        classes.append(entry.name)
        except FileNotFoundError:
            pass

        classes = sorted(classes, key=str.lower)
        return {"success": True, "classes": classes}
    except HTTPException:
        raise
    except Exception as e:
        logger.exception(f"분류 클래스 조회 실패: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/classes")
async def create_class(req: CreateClassReq):
    """클래스 생성: classification/<class_name> 디렉토리 생성"""
    try:
        set_user_activity()
        _labels_reload_if_stale()
        _sync_labels_if_classes_changed()

        name = req.name.strip()
        
        # 빈 문자열이나 공백만 있는 경우 체크
        if not name or name.isspace():
            raise HTTPException(status_code=400, detail="클래스명이 비어있습니다")
        
        # 한글 자모나 특수문자 체크
        if any(ord(char) < 32 or ord(char) > 126 for char in name):
            raise HTTPException(status_code=400, detail="클래스명에 특수문자나 한글 자모를 사용할 수 없습니다 (A-Z, a-z, 0-9, _, - 만 사용 가능)")
        
        if not _CLASS_NAME_RE.match(name):
            raise HTTPException(status_code=400, detail="클래스명 형식이 올바르지 않습니다 (A-Z, a-z, 0-9, _, - 만 사용 가능)")
        
        # 길이 체크
        if len(name) > 50:
            raise HTTPException(status_code=400, detail="클래스명이 너무 깁니다 (최대 50자)")
        class_dir = _classification_dir() / name
        if class_dir.exists():
            raise HTTPException(status_code=409, detail="Class already exists")
        class_dir.mkdir(parents=True, exist_ok=False)

        # 즉시 라벨 동기화 (새 클래스 생성 시)
        _sync_labels_if_classes_changed()
        
        # mtime 변화로 동기화되지만, 즉시 목록 반영을 위해 캐시 무효화
        _dircache_invalidate(_classification_dir())
        _dircache_invalidate(class_dir)
        # ROOT_DIR 자체도 캐시 무효화
        _dircache_invalidate(ROOT_DIR)
        # 전체 캐시 클리어 - 즉시 반영 보장
        DIRLIST_CACHE.clear()
        
        # 클래스 생성 후 즉시 Label Explorer 강제 새로고침
        logger.info(f"클래스 '{name}' 생성 완료 - Label Explorer 강제 새로고침 필요")
        
        # 성공 응답 반환
        return {
            "success": True, 
            "class": name, 
            "refresh_required": True,
            "message": f"클래스 '{name}'이 성공적으로 생성되었습니다"
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.exception(f"클래스 생성 실패: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.delete("/api/classes/{class_name}")
async def delete_class(
    class_name: str = PathParam(..., min_length=1, max_length=128),
    force: bool = Query(False, description="True면 내용 포함 통째 삭제")
):
    """클래스 삭제: 기본은 빈 폴더만 삭제, force=True면 내용 포함 삭제 + 라벨 전역 정리"""
    try:
        set_user_activity()
        _labels_reload_if_stale()
        _sync_labels_if_classes_changed()

        if not _CLASS_NAME_RE.match(class_name):
            raise HTTPException(status_code=400, detail="Invalid class_name")
        class_dir = _classification_dir() / class_name
        if not class_dir.exists() or not class_dir.is_dir():
            raise HTTPException(status_code=404, detail="Class not found")

        if force:
            shutil.rmtree(class_dir)
            logger.info(f"클래스 삭제(force): {class_name}")
        else:
            if any(class_dir.iterdir()):
                raise HTTPException(status_code=409, detail="Class directory not empty")
            class_dir.rmdir()
            logger.info(f"클래스 삭제: {class_name}")

        # 라벨 전역에서 이 클래스명 제거 (즉시 일관성)
        removed_cnt = _remove_label_from_all_images(class_name)
        if removed_cnt:
            logger.info(f"라벨 정리: class='{class_name}' 라벨을 {removed_cnt}개 이미지에서 제거")
        
        # 강제로 라벨 리로드하여 다른 워커와 동기화
        _labels_load()

        # 캐시 무효화 및 mtime 반영
        _dircache_invalidate(_classification_dir())
        _dircache_invalidate(class_dir)
        _dircache_invalidate(ROOT_DIR)
        # 전체 캐시 클리어 - 즉시 반영 보장
        DIRLIST_CACHE.clear()
        
        # 클래스 삭제 후 즉시 Label Explorer 강제 새로고침
        logger.info(f"클래스 '{class_name}' 삭제 완료 - Label Explorer 강제 새로고침 필요")
        
        return {"success": True, "deleted": class_name, "force": force, "labels_cleaned": removed_cnt, "refresh_required": True}
    except HTTPException:
        raise
    except Exception as e:
        logger.exception(f"클래스 삭제 실패: {e}")
        raise HTTPException(status_code=500, detail=str(e))

class DeleteClassesReq(BaseModel):
    names: List[str] = Field(..., min_items=1, description="삭제할 클래스명 목록")

@app.post("/api/classes/delete")
async def delete_classes(req: DeleteClassesReq):
    """여러 클래스 삭제 (내용 포함 통째 삭제) + 라벨 전역 정리"""
    try:
        set_user_activity()
        _labels_reload_if_stale()
        _sync_labels_if_classes_changed()

        if not req.names:
            raise HTTPException(status_code=400, detail="클래스명 목록이 비어있습니다")

        deleted = []
        failed = []
        total_cleaned = 0

        for class_name in req.names:
            try:
                class_name = class_name.strip()
                if not _CLASS_NAME_RE.match(class_name):
                    failed.append({"class": class_name, "error": "Invalid class name"})
                    continue

                class_dir = _classification_dir() / class_name
                if not class_dir.exists() or not class_dir.is_dir():
                    failed.append({"class": class_name, "error": "Class not found"})
                    continue

                shutil.rmtree(class_dir)
                deleted.append(class_name)
                logger.info(f"클래스 삭제: {class_name}")

                total_cleaned += _remove_label_from_all_images(class_name)

            except Exception as e:
                failed.append({"class": class_name, "error": str(e)})
                logger.exception(f"클래스 {class_name} 삭제 실패: {e}")

        # 배치 삭제 후 강제로 라벨 리로드
        if total_cleaned > 0:
            _labels_load()
            logger.info(f"배치 삭제 후 라벨 리로드: {total_cleaned}개 라벨 정리됨")

        _dircache_invalidate(_classification_dir())
        
        # 배치 삭제 후 즉시 Label Explorer 강제 새로고침
        logger.info(f"배치 클래스 삭제 완료 - Label Explorer 강제 새로고침 필요")
        
        return {
            "success": True,
            "deleted": deleted,
            "failed": failed,
            "labels_cleaned": total_cleaned,
            "refresh_required": True,
            "message": f"{len(deleted)}개 클래스 삭제 완료, {len(failed)}개 실패"
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.exception(f"클래스 일괄 삭제 실패: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/api/classes/{class_name}/images")
async def class_images(
    class_name: str = PathParam(..., min_length=1, max_length=128),
    limit: int = Query(500, ge=1, le=5000),
    offset: int = Query(0, ge=0)
):
    """해당 클래스 폴더 내 이미지(재귀)"""
    try:
        set_user_activity()
        _labels_reload_if_stale()
        _sync_labels_if_classes_changed()

        if not _CLASS_NAME_RE.match(class_name):
            raise HTTPException(status_code=400, detail="Invalid class_name")
        class_dir = _classification_dir() / class_name
        if not class_dir.exists() or not class_dir.is_dir():
            raise HTTPException(status_code=404, detail="Class not found")

        found: List[str] = []
        goal = offset + limit
        for p in class_dir.rglob("*"):
            if p.is_file() and is_supported_image(p):
                rel = str(p.relative_to(ROOT_DIR)).replace("\\", "/")
                found.append(rel)
                if len(found) >= goal:
                    break
        results = found[offset: offset + limit]
        return {"success": True, "class": class_name, "results": results, "offset": offset, "limit": limit}
    except HTTPException:
        raise
    except Exception as e:
        logger.exception(f"클래스 이미지 조회 실패: {e}")
        raise HTTPException(status_code=500, detail=str(e))

# ========== 엔드포인트: 라벨 ==========
class LabelAddReq(BaseModel):
    image_path: str = Field(..., description="ROOT 기준 상대경로 또는 절대경로도 허용")
    labels: List[str] = Field(..., min_items=1)

class LabelDelReq(BaseModel):
    image_path: str
    labels: Optional[List[str]] = None  # None이면 해당 이미지의 모든 라벨 삭제

@app.post("/api/labels")
async def add_labels(req: LabelAddReq):
    """이미지에 라벨 추가(중복 무시). 이미지 존재/확장자 검증."""
    try:
        set_user_activity()
        _labels_reload_if_stale()
        _sync_labels_if_classes_changed()

        rel = relkey_from_any_path(req.image_path)
        abs_path = ROOT_DIR / rel
        if not abs_path.exists() or not abs_path.is_file():
            raise HTTPException(status_code=404, detail="Image not found")
        if not is_supported_image(abs_path):
            raise HTTPException(status_code=400, detail="Unsupported image format")

        new_labels = [str(x).strip() for x in req.labels if str(x).strip()]
        if not new_labels:
            raise HTTPException(status_code=400, detail="Empty labels")

        with LABELS_LOCK:
            cur = set(LABELS.get(rel, []))
            cur.update(new_labels)
            LABELS[rel] = sorted(cur)
        _labels_save()

        # 라벨 변경 후에도 classification 목록을 즉시 새로고침시키기 위해 캐시 무효화
        _dircache_invalidate(_classification_dir())
        return {"success": True, "image": rel, "labels": LABELS[rel]}
    except HTTPException:
        raise
    except Exception as e:
        logger.exception(f"라벨 추가 실패: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.delete("/api/labels")
async def delete_labels(req: LabelDelReq):
    """이미지 라벨 제거. labels가 None이면 그 이미지의 모든 라벨 삭제."""
    try:
        set_user_activity()
        _labels_reload_if_stale()
        _sync_labels_if_classes_changed()

        rel = relkey_from_any_path(req.image_path)
        with LABELS_LOCK:
            if rel not in LABELS:
                raise HTTPException(status_code=404, detail="No labels for this image")
            if req.labels is None:
                LABELS.pop(rel, None)
            else:
                to_remove = {str(x).strip() for x in req.labels if str(x).strip()}
                if not to_remove:
                    raise HTTPException(status_code=400, detail="Empty labels to remove")
                remain = [x for x in LABELS[rel] if x not in to_remove]
                if remain:
                    LABELS[rel] = remain
                else:
                    LABELS.pop(rel, None)
        _labels_save()

        _dircache_invalidate(_classification_dir())
        return {"success": True, "image": rel, "labels": LABELS.get(rel, [])}
    except HTTPException:
        raise
    except Exception as e:
        logger.exception(f"라벨 제거 실패: {e}")
        raise HTTPException(status_code=500, detail=str(e))

# DELETE 바디 이슈 회피용 POST 버전
@app.post("/api/labels/delete")
async def delete_labels_post(req: LabelDelReq):
    return await delete_labels(req)

@app.get("/api/labels/{image_path:path}")
async def get_labels(image_path: str):
    """이미지 라벨 조회(없으면 빈 배열)"""
    try:
        set_user_activity()
        _labels_reload_if_stale()
        _sync_labels_if_classes_changed()

        rel = relkey_from_any_path(image_path)
        with LABELS_LOCK:
            labels = list(LABELS.get(rel, []))
        return {"success": True, "image": rel, "labels": labels}
    except HTTPException:
        raise
    except Exception as e:
        logger.exception(f"라벨 조회 실패: {e}")
        raise HTTPException(status_code=500, detail=str(e))

class ClassifyRequest(BaseModel):
    image_path: str = Field(..., description="이미지 경로")
    class_name: str = Field(..., description="분류할 클래스명")

@app.post("/api/classify")
async def classify_image(req: ClassifyRequest):
    """이미지를 특정 클래스로 분류 (라벨 추가 + 파일 복사)"""
    try:
        set_user_activity()
        _labels_reload_if_stale()
        _sync_labels_if_classes_changed()

        logger.info(f"분류 요청 받음: image_path='{req.image_path}', class_name='{req.class_name}'")
        if not req.image_path or not req.class_name:
            raise HTTPException(status_code=400, detail="이미지 경로와 클래스명이 필요합니다")

        image_path = req.image_path.strip()
        class_name = req.class_name.strip()

        full_image_path = safe_resolve_path(image_path)
        if not full_image_path.exists() or not full_image_path.is_file():
            raise HTTPException(status_code=404, detail="이미지 파일을 찾을 수 없습니다")

        classification_dir = _classification_dir()
        class_dir = classification_dir / class_name
        class_dir.mkdir(parents=True, exist_ok=True)

        target_path = class_dir / full_image_path.name
        shutil.copy2(full_image_path, target_path)

        rel = relkey_from_any_path(image_path)
        with LABELS_LOCK:
            if rel not in LABELS:
                LABELS[rel] = []
            if class_name not in LABELS[rel]:
                LABELS[rel].append(class_name)
        _labels_save()

        _dircache_invalidate(_classification_dir())
        _dircache_invalidate(class_dir)

        logger.info(f"이미지 분류: {image_path} -> {class_name}")
        return {
            "success": True,
            "message": f"이미지 '{image_path}'이 클래스 '{class_name}'으로 분류되었습니다",
            "image": rel,
            "class": class_name
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.exception(f"이미지 분류 실패: {e}")
        raise HTTPException(status_code=500, detail=str(e))

class ClassifyDeleteRequest(BaseModel):
    image_path: Optional[str] = Field(None, description="분류를 제거할 이미지 경로")
    image_name: Optional[str] = Field(None, description="분류를 제거할 이미지 파일명")
    class_name: str = Field(..., description="제거할 클래스명")

@app.post("/api/classify/delete")
async def delete_classification(req: ClassifyDeleteRequest):
    """이미지에서 특정 클래스 분류 제거 (클래스 폴더 파일 삭제 + 라벨 동기화)"""
    try:
        set_user_activity()
        _labels_reload_if_stale()
        _sync_labels_if_classes_changed()

        logger.info(
            f"분류 제거 요청 받음: image_path='{req.image_path}', image_name='{req.image_name}', class_name='{req.class_name}'"
        )

        if not req.class_name:
            raise HTTPException(status_code=400, detail="클래스명이 필요합니다")
        class_name = req.class_name.strip()

        if not req.image_path and not req.image_name:
            raise HTTPException(status_code=400, detail="이미지 경로 또는 이미지 파일명이 필요합니다")

        classification_dir = _classification_dir()
        class_dir = classification_dir / class_name
        if not class_dir.exists():
            raise HTTPException(status_code=404, detail="클래스를 찾을 수 없습니다")

        if req.image_name:
            image_file = class_dir / req.image_name.strip()
        else:
            image_file = class_dir / Path(req.image_path.strip()).name

        if not image_file.exists():
            raise HTTPException(status_code=404, detail="해당 클래스에 이미지가 없습니다")

        # 1) 클래스 폴더에서 파일 삭제
        image_file.unlink()
        logger.info(f"분류 제거(파일): {image_file.name} from class '{class_name}'")

        # 2) 라벨 동기화
        removed_from: List[str] = []
        with LABELS_LOCK:
            if req.image_path:
                rel = relkey_from_any_path(req.image_path)
                labs = LABELS.get(rel, [])
                if class_name in labs:
                    LABELS[rel] = [x for x in labs if x != class_name]
                    if not LABELS[rel]:
                        LABELS.pop(rel, None)
                    removed_from.append(rel)
            else:
                fname = image_file.name
                for rel, labs in list(LABELS.items()):
                    if Path(rel).name == fname and class_name in labs:
                        LABELS[rel] = [x for x in labs if x != class_name]
                        if not LABELS[rel]:
                            LABELS.pop(rel, None)
                        removed_from.append(rel)

        if removed_from:
            _labels_save()

        _dircache_invalidate(_classification_dir())
        _dircache_invalidate(class_dir)

        return {
            "success": True,
            "message": f"이미지 '{image_file.name}'의 클래스 '{class_name}' 분류를 제거했습니다",
            "removed_from": removed_from
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.exception(f"분류 제거 실패: {e}")
        raise HTTPException(status_code=500, detail=str(e))

# ========== 접속 통계 API ==========
@app.get("/api/stats/daily")
async def get_daily_stats():
    """일별 접속 통계"""
    return logger_instance.get_daily_stats()

@app.get("/api/stats/trend")
async def get_trend_stats(days: int = Query(7, ge=1, le=30)):
    """일별 트렌드 통계"""
    return logger_instance.get_daily_trend(days)

@app.get("/api/stats/monthly")
async def get_monthly_stats(months: int = Query(3, ge=1, le=12)):
    """월별 트렌드 통계"""
    return logger_instance.get_monthly_trend(months)

@app.get("/api/stats/users")
async def get_user_stats():
    """전체 사용자 통계"""
    stats = []
    for user_id in logger_instance.user_stats.keys():
        user_summary = logger_instance.get_user_summary(user_id)
        user_data = logger_instance.user_stats[user_id]
        
        # IP 주소와 표시 이름 포함
        user_summary["ip_addresses"] = list(user_data["ip_addresses"]) if isinstance(user_data["ip_addresses"], (set, list)) else []
        user_summary["primary_ip"] = user_summary["ip_addresses"][0] if user_summary["ip_addresses"] else "unknown"
        user_summary["display_name"] = user_data.get("display_name", "")
        
        stats.append(user_summary)
    
    # 총 요청 수 기준으로 정렬
    stats.sort(key=lambda x: x.get("total_requests", 0), reverse=True)
    return {"users": stats, "total_users": len(stats)}

@app.get("/api/stats/user/{user_id}")
async def get_user_detail(user_id: str):
    """특정 사용자 상세 통계"""
    if user_id not in logger_instance.user_stats:
        raise HTTPException(status_code=404, detail="사용자를 찾을 수 없습니다")
    
    user_data = logger_instance.user_stats[user_id].copy()
    
    # Set을 list로 변환 (JSON 직렬화)
    if isinstance(user_data["ip_addresses"], set):
        user_data["ip_addresses"] = list(user_data["ip_addresses"])
    if isinstance(user_data["user_agents"], set):
        user_data["user_agents"] = list(user_data["user_agents"])
    if isinstance(user_data["unique_days"], set):
        user_data["unique_days"] = list(user_data["unique_days"])
    
    return user_data

class SetUsernameRequest(BaseModel):
    username: str

@app.get("/api/get-system-username")
async def get_system_username(http_request: Request):
    """시스템 사용자 이름 추출 (Windows 계정 등)"""
    try:
        import os
        import getpass
        import socket
        
        # 현재 사용자 ID 생성
        client_ip = logger_instance.get_client_ip(http_request)
        user_agent = http_request.headers.get("user-agent", "Unknown")
        user_id = logger_instance.generate_user_id(client_ip, user_agent)
        
        # 시스템 정보 추출
        system_username = getpass.getuser()  # Windows 계정명
        hostname = socket.gethostname()
        
        # 자동으로 사용자 이름 설정 (username@hostname 형식)
        if system_username and system_username != "Unknown":
            display_name = f"{system_username}@{hostname}"
            logger_instance.set_user_display_name(user_id, display_name)
        
        return {
            "user_id": user_id,
            "system_username": system_username,
            "hostname": hostname,
            "ip": client_ip
        }
    except Exception as e:
        logger.error(f"시스템 사용자 이름 추출 실패: {e}")
        return {"user_id": "", "system_username": "", "hostname": "", "ip": ""}

@app.post("/api/set-username")
async def set_username(request: SetUsernameRequest, http_request: Request):
    """사용자 이름 설정"""
    try:
        # 현재 사용자 ID 생성
        client_ip = logger_instance.get_client_ip(http_request)
        user_agent = http_request.headers.get("user-agent", "Unknown")
        user_id = logger_instance.generate_user_id(client_ip, user_agent)
        
        # 사용자 이름 설정
        logger_instance.set_user_display_name(user_id, request.username)
        
        return {"success": True, "user_id": user_id, "username": request.username}
    except Exception as e:
        logger.error(f"사용자 이름 설정 실패: {e}")
        raise HTTPException(status_code=500, detail="사용자 이름 설정에 실패했습니다")

# ========== 기타 ==========
app.mount("/js", StaticFiles(directory="js"), name="js")
app.mount("/static", StaticFiles(directory="."), name="static")

@app.get("/")
async def read_root():
    try:
        html_path = Path("index.html")
        if html_path.exists():
            return FileResponse(html_path)
        return {"message": "index.html not found"}
    except Exception as e:
        logger.exception(f"루트 페이지 로드 실패: {e}")
        return {"error": "Failed to load main page"}

@app.get("/stats")
async def read_stats():
    """접속 통계 대시보드"""
    try:
        stats_path = Path("stats.html")
        if stats_path.exists():
            return FileResponse(stats_path)
        return {"message": "stats.html not found"}
    except Exception as e:
        logger.exception(f"통계 페이지 로드 실패: {e}")
        return {"error": "Failed to load stats page"}

@app.get("/main.js")
async def get_main_js():
    try:
        js_path = Path("main.js")
        if js_path.exists():
            return FileResponse(js_path)
        return {"message": "main.js not found"}
    except Exception as e:
        logger.exception(f"main.js 로드 실패: {e}")
        return {"error": "Failed to load main.js"}

# ========== 라이프사이클 ==========
@app.on_event("startup")
async def startup_event():
    logger.info("🚀 L3Tracker 서버 시작 (Class/Label 즉시반영)")
    logger.info(f"📁 ROOT_DIR: {ROOT_DIR}")
    logger.info(f"🧵 IO_THREADS: {IO_THREADS}, 🧮 THUMBNAIL_SEM: {THUMBNAIL_SEM_SIZE}")
    
    # uvicorn 로거에 커스텀 포맷터 적용
    uvicorn_logger = logging.getLogger("uvicorn.access")
    if uvicorn_logger.handlers:
        for handler in uvicorn_logger.handlers:
            original_formatter = handler.formatter
            if original_formatter:
                custom_formatter = UserNameLogFormatter(original_formatter._fmt)
                handler.setFormatter(custom_formatter)
    
    _classification_dir().mkdir(parents=True, exist_ok=True)
    _labels_load()
    global CLASSES_MTIME; CLASSES_MTIME = _classes_stat_mtime()
    asyncio.create_task(build_file_index_background())

@app.on_event("shutdown")
async def shutdown_event():
    logger.info("🛑 L3Tracker 서버 종료")
    IO_POOL.shutdown(wait=False)

# ========== 메인 ==========
# ========== 폴더 경로 관리 ==========
@app.get("/api/current-folder")
async def get_current_folder():
    """현재 작업 폴더 경로를 반환합니다."""
    return {"current_folder": str(ROOT_DIR)}

@app.get("/api/root-folder")
async def get_root_folder():
    """설정된 루트 폴더 경로를 반환합니다 (config.py ROOT_DIR)."""
    from .config import ROOT_DIR as ORIGINAL_ROOT_DIR
    return {"root_folder": str(ORIGINAL_ROOT_DIR)}

@app.post("/api/change-folder")
async def change_folder(request: Request):
    """이미지 폴더 경로를 변경합니다."""
    try:
        data = await request.json()
        new_path = data.get("path")
        
        if not new_path:
            raise HTTPException(status_code=400, detail="폴더 경로가 필요합니다")
        
        new_path_obj = Path(new_path).resolve()
        
        if not new_path_obj.exists():
            raise HTTPException(status_code=404, detail="폴더가 존재하지 않습니다")
        
        if not new_path_obj.is_dir():
            raise HTTPException(status_code=400, detail="유효한 폴더가 아닙니다")
        
        # 전역 ROOT_DIR 업데이트
        global ROOT_DIR, THUMBNAIL_DIR, LABELS_DIR, LABELS_FILE
        ROOT_DIR = new_path_obj
        THUMBNAIL_DIR = ROOT_DIR / "thumbnails"
        LABELS_DIR = ROOT_DIR / "classification"
        LABELS_FILE = LABELS_DIR / "labels.json"
        
        # 캐시 초기화
        try:
            DIRLIST_CACHE.clear()
        except:
            pass
        try:
            THUMB_STAT_CACHE.clear()
        except:
            pass
        
        # 인덱스 재구성
        global INDEX_READY, INDEX_BUILDING
        INDEX_READY = False
        INDEX_BUILDING = False
        
        # classification 폴더 자동 생성
        classification_dir = _classification_dir()
        if not classification_dir.exists():
            classification_dir.mkdir(parents=True, exist_ok=True)
            logger.info(f"새 폴더의 classification 폴더 생성: {classification_dir}")
        
        # 라벨 데이터 새로 로드
        _labels_load()
        
        return {
            "success": True, 
            "message": f"폴더가 '{new_path}'로 변경되었습니다",
            "new_path": str(ROOT_DIR)
        }
        
    except Exception as e:
        logger.error(f"폴더 변경 실패: {e}")
        raise HTTPException(status_code=500, detail=f"폴더 변경 실패: {str(e)}")

@app.get("/api/browse-folders")
async def browse_folders(path: Optional[str] = None):
    """폴더 브라우징을 위한 폴더 목록을 반환합니다."""
    try:
        if not path:
            # 드라이브 목록 반환 (Windows)
            import string
            drives = []
            for letter in string.ascii_uppercase:
                drive_path = f"{letter}:\\"
                if Path(drive_path).exists():
                    drives.append({
                        "name": f"{letter}: 드라이브",
                        "path": drive_path,
                        "type": "drive"
                    })
            return {"folders": drives}
        
        target_path = Path(path).resolve()
        if not target_path.exists() or not target_path.is_dir():
            raise HTTPException(status_code=404, detail="폴더를 찾을 수 없습니다")
        
        folders = []
        try:
            with os.scandir(target_path) as it:
                for entry in it:
                    if entry.is_dir(follow_symlinks=False) and not entry.name.startswith('.'):
                        folders.append({
                            "name": entry.name,
                            "path": str(entry.path),
                            "type": "folder"
                        })
        except PermissionError:
            raise HTTPException(status_code=403, detail="폴더 접근 권한이 없습니다")
        
        # 폴더명으로 내림차순 정렬
        folders.sort(key=lambda x: x["name"].lower(), reverse=True)
        
        return {"folders": folders}
        
    except Exception as e:
        logger.error(f"폴더 브라우징 실패: {e}")
        raise HTTPException(status_code=500, detail=f"폴더 브라우징 실패: {str(e)}")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(
        app,
        host=config.DEFAULT_HOST,
        port=config.DEFAULT_PORT,
        reload=config.DEFAULT_RELOAD,
        workers=config.DEFAULT_WORKERS,
        log_level="info",
    )
