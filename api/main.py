"""
L3Tracker - Wafer Map Viewer API (Refactored w/ Pretty Table Logs)
- labels.json mtime 감지 → stale 시 자동 재로딩(멀티 워커 동기화)
- 디렉터리 캐시: 변경 즉시 무효화(list_dir_fast LRU)
- 클래스 삭제 시: 해당 class 라벨을 전 이미지에서 제거(일관성 유지)
- 라벨/클래스 라우트: 항상 no-store 헤더(브라우저 캐시 방지)
- 라벨/클래스 관련 요청 도착 시: classification mtime 감지 → 라벨 즉시 동기화
- 테이블형 Access Log: 고정폭 컬럼, 단일 라인 출력, 키워드 색상 하이라이트, NOTE에 파일경로/액션 표시
"""

# ======================== Imports ========================
import os, re, sys, json, time, shutil, asyncio, logging, logging.config
from pathlib import Path
from typing import List, Optional, Dict, Any, Tuple
from collections import OrderedDict
from threading import RLock
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from urllib.parse import urlparse, parse_qs

from fastapi import FastAPI, HTTPException, Query, Request, Path as PathParam, Depends
from fastapi.responses import JSONResponse, FileResponse, Response
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from starlette.middleware.gzip import GZipMiddleware
from starlette.middleware.base import BaseHTTPMiddleware
from pydantic import BaseModel, Field
from PIL import Image

from .access_logger import logger_instance
from . import config

# ======================== Logging ========================
LOGGING_CONFIG = {
    "version": 1,
    "disable_existing_loggers": False,
    "formatters": {
        "simple": {"format": "%(levelname)s: %(asctime)s     %(message)s", "datefmt": "%Y-%m-%d %H:%M:%S"}
    },
    "handlers": {
        "console": {"class": "logging.StreamHandler", "formatter": "simple", "stream": "ext://sys.stdout"}
    },
    "root": {"level": "INFO", "handlers": ["console"]},
    "loggers": {
        "uvicorn": {"handlers": ["console"], "level": "INFO", "propagate": False},
        "uvicorn.error": {"handlers": ["console"], "level": "INFO", "propagate": False},
        "uvicorn.access": {"handlers": [], "level": "CRITICAL", "propagate": False},  # 기본 액세스 로그 끔
        "l3tracker": {"handlers": ["console"], "level": "INFO", "propagate": False},
        "access": {"handlers": ["console"], "level": "INFO", "propagate": False},
    },
}
logging.config.dictConfig(LOGGING_CONFIG)
logger = logging.getLogger("l3tracker")

# ================= Pretty Access Table Logger =================
# 컬럼폭은 화면폭 기준으로 조정. PATH/NOTE 넉넉히 줌.
ACCESS_TABLE_COLOR = os.getenv("ACCESS_TABLE_COLOR", "1") != "0"  # 0이면 색 끔
ACCESS_TABLE_WIDTHS = [
    ("TAG", 7), ("TIME", 35), ("IP", 20), ("METHOD", 6), ("STS", 8), ("PATH", 24), ("NOTE", 50)
]

def _ansi(code: str) -> str:
    return f"\x1b[{code}m" if ACCESS_TABLE_COLOR else ""

CLR = {
    "reset": _ansi("0"), "dim": _ansi("2"), "bold": _ansi("1"),
    "red": _ansi("31"), "green": _ansi("32"), "yellow": _ansi("33"),
    "blue": _ansi("34"), "magenta": _ansi("35"), "cyan": _ansi("36"), "white": _ansi("37"),
}

def _truncate(s: str, w: int) -> str:
    s = "" if s is None else str(s)
    return (s[: w - 1] + "…") if len(s) > w else s

def _pad_plain(s: str, w: int) -> str:
    return _truncate(s, w).ljust(w)

def _border_line(ch_left: str, ch_mid: str, ch_right: str, ch_fill: str) -> str:
    return ch_left + ch_mid.join(ch_fill * w for _, w in ACCESS_TABLE_WIDTHS) + ch_right

ACCESS_TABLE_HEADER = _border_line("┌", "┬", "┐", "─") + "\n" + \
    "│" + "│".join(_pad_plain(name, w) for name, w in ACCESS_TABLE_WIDTHS) + "│\n" + \
    _border_line("├", "┼", "┤", "─")
ACCESS_TABLE_FOOTER = _border_line("└", "┴", "┘", "─")

_access_table_logger = logging.getLogger("access.table")
if not _access_table_logger.handlers:
    _h = logging.StreamHandler(sys.stdout)
    _h.setFormatter(logging.Formatter("%(message)s"))
    _access_table_logger.addHandler(_h)
    _access_table_logger.setLevel(logging.INFO)
    _access_table_logger.propagate = False

_access_table_header_printed = False
_access_count = 0
ACCESS_TABLE_HEADER_EVERY = int(os.getenv("ACCESS_TABLE_HEADER_EVERY", "0"))  # 0=비활성

def print_access_header_once():
    global _access_table_header_printed
    if not _access_table_header_printed:
        _access_table_logger.info(ACCESS_TABLE_HEADER)
        _access_table_header_printed = True

def _color_for_tag(tag: str) -> str:
    return {"IMAGE": CLR["cyan"], "ACTION": CLR["magenta"], "API": CLR["blue"], "INFO": CLR["white"]}.get(tag, "")

def _color_for_status(sts: int) -> str:
    if 200 <= sts < 300: return CLR["green"]
    if 300 <= sts < 400: return CLR["yellow"]
    return CLR["red"]

def _color_for_method(m: str) -> str:
    m = (m or "").upper()
    return {"GET": CLR["cyan"], "POST": CLR["yellow"], "DELETE": CLR["red"], "PUT": CLR["magenta"]}.get(m, CLR["white"])

def _short_note_path(p: str) -> str:
    """NOTE 칼럼에 넣을 짧은 경로(뒤 2~3 세그먼트만)"""
    if not p:
        return ""
    s = str(p).replace("\\", "/")
    segs = [x for x in s.split("/") if x]
    if len(segs) <= 3:  # 짧으면 그대로
        return s
    return "…/" + "/".join(segs[-3:])

def shorten_note_path(abs_path: str, root_dir: str) -> str:
    """NOTE 컬럼에서 루트 경로 생략하고 상대경로만 표시"""
    try:
        p = Path(abs_path).resolve()
        r = Path(root_dir).resolve()
        return str(p.relative_to(r))
    except Exception:
        return abs_path

def _note_from_request(request: Request, endpoint: str) -> str:
    try:
        qs = parse_qs(urlparse(str(request.url)).query)
    except Exception:
        qs = {}
    if endpoint.startswith("/api/thumbnail"):
        path = qs.get('path', [''])[0]
        return f"[{shorten_note_path(path, str(ROOT_DIR))}]"
    if endpoint.startswith("/api/image"):
        path = qs.get('path', [''])[0]
        return f"[{shorten_note_path(path, str(ROOT_DIR))}]"
    if endpoint.startswith("/api/classify"):
        return "[분류작업]"
    if endpoint.startswith("/api/labels"):
        return "[라벨]"
    if endpoint.startswith("/api/classes"):
        return "[클래스]"
    return ""

def log_access_row(*, tag: str, ip: str = "-", method: str = "-", status: int = 0,
                   path: str = "-", note: str = ""):
    """ANSI 길이를 무시하고 고정폭 정렬: 먼저 평문 패딩 → 그 위에 색 입힘."""
    global _access_count
    ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    # 1) 평문 셀 만들기 (ACCESS_TABLE_WIDTHS 사용)
    plain_cells = {}
    for col_name, width in ACCESS_TABLE_WIDTHS:
        if col_name == "TAG":
            plain_cells[col_name] = _pad_plain(tag, width)
        elif col_name == "TIME":
            plain_cells[col_name] = _pad_plain(ts, width)
        elif col_name == "IP":
            plain_cells[col_name] = _pad_plain(ip, width)
        elif col_name == "METHOD":
            plain_cells[col_name] = _pad_plain((method or "").upper(), width)
        elif col_name == "STS":
            plain_cells[col_name] = _pad_plain(str(status), width)
        elif col_name == "PATH":
            plain_cells[col_name] = _pad_plain(path, width)
        elif col_name == "NOTE":
            plain_cells[col_name] = _pad_plain(note, width)

    # 2) 색상 적용(중요도 높은 것만)
    tag_col = f"{_color_for_tag(tag)}{plain_cells['TAG']}{CLR['reset']}"
    method_col = f"{_color_for_method(method)}{plain_cells['METHOD']}{CLR['reset']}"
    sts_col = f"{_color_for_status(int(status))}{plain_cells['STS']}{CLR['reset']}"
    path_col = f"{CLR['dim']}{plain_cells['PATH']}{CLR['reset']}"  # PATH는 흐리게
    # NOTE 색상: 이미지/액션은 눈에 띄게
    note_color = CLR["white"] if tag == "IMAGE" else (CLR["magenta"] if tag == "ACTION" else "")
    note_col = f"{note_color}{plain_cells['NOTE']}{CLR['reset']}" if note_color else plain_cells["NOTE"]

    cells = [
        tag_col, plain_cells["TIME"], plain_cells["IP"], method_col, sts_col, path_col, note_col
    ]
    _access_table_logger.info("│" + "│".join(cells) + "│")

    _access_count += 1
    if ACCESS_TABLE_HEADER_EVERY and _access_count % ACCESS_TABLE_HEADER_EVERY == 0:
        _access_table_logger.info(ACCESS_TABLE_HEADER)

# ======================== Config Bindings ========================
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

# ======================== Pools / State / Caches ========================
IO_POOL = ThreadPoolExecutor(max_workers=IO_THREADS)
THUMBNAIL_SEM = asyncio.Semaphore(THUMBNAIL_SEM_SIZE)

USER_ACTIVITY_FLAG = False
BACKGROUND_TASKS_PAUSED = False
INDEX_BUILDING = False
INDEX_READY = False

FILE_INDEX: Dict[str, Dict[str, Any]] = {}
FILE_INDEX_LOCK = RLock()

LABELS: Dict[str, List[str]] = {}
LABELS_LOCK = RLock()
LABELS_MTIME: float = 0.0
CLASSES_MTIME: float = 0.0

class LRUCache:
    def __init__(self, capacity: int):
        self.capacity = capacity
        self._cache: OrderedDict[str, Any] = OrderedDict()
        self._lock = RLock()

    def get(self, key: str):
        with self._lock:
            val = self._cache.get(key)
            if val is None: return None
            self._cache.move_to_end(key);  return val

    def set(self, key: str, value: Any):
        with self._lock:
            if key in self._cache: self._cache.move_to_end(key)
            self._cache[key] = value
            if len(self._cache) > self.capacity: self._cache.popitem(last=False)

    def delete(self, key: str):
        with self._lock: self._cache.pop(key, None)

    def clear(self):
        with self._lock: self._cache.clear()

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
            if not item: return None
            exp, val = item
            if exp < now:
                del self._data[key];  return None
            self._data.move_to_end(key);  return val

    def set(self, key: str, value: Any):
        now = time.time()
        with self._lock:
            if key in self._data: self._data.move_to_end(key)
            self._data[key] = (now + self.ttl, value)
            if len(self._data) > self.capacity: self._data.popitem(last=False)

    def clear(self):
        with self._lock: self._data.clear()

THUMB_STAT_CACHE = TTLCache(THUMB_STAT_TTL_SECONDS, THUMB_STAT_CACHE_CAPACITY)

# ======================== FastAPI & Middleware ========================
app = FastAPI(title="L3Tracker API", version="2.6.0")

# -------- User-First flags --------
def set_user_activity():
    global USER_ACTIVITY_FLAG, BACKGROUND_TASKS_PAUSED
    USER_ACTIVITY_FLAG = True;  BACKGROUND_TASKS_PAUSED = True

def clear_user_activity():
    global USER_ACTIVITY_FLAG
    USER_ACTIVITY_FLAG = False

@app.middleware("http")
async def user_priority_middleware(request: Request, call_next):
    set_user_activity()
    try:
        response = await call_next(request)
    finally:
        asyncio.create_task(delayed_background_resume())
    return response

async def delayed_background_resume():
    await asyncio.sleep(1.5)
    global BACKGROUND_TASKS_PAUSED
    BACKGROUND_TASKS_PAUSED = False
    clear_user_activity()

# -------- No-store for labels/classes --------
@app.middleware("http")
async def no_store_for_labels_and_classes(request: Request, call_next):
    response = await call_next(request)
    p = request.url.path
    if p.startswith("/api/labels") or p.startswith("/api/classes"):
        response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
        response.headers["Pragma"] = "no-cache"
        response.headers["Expires"] = "0"
    return response

# -------- Access table log middleware (단일 출력) --------
class AccessTrackingMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        response = await call_next(request)

        client_ip = logger_instance.get_client_ip(request)
        endpoint = str(request.url.path)
        method = request.method
        status = response.status_code

        # 제외 경로 (통계 기록도 제외)
        skip_prefix = ["/favicon.ico", "/static/", "/js/", "/api/files/all", "/api/stats", "/api/stats/", "/stats"]
        if any(endpoint.startswith(p) for p in skip_prefix):
            return response

        # 태그 분류
        if endpoint.startswith(("/api/thumbnail", "/api/image")):
            tag = "IMAGE"
        elif endpoint.startswith("/api/classify"):
            tag = "ACTION"
        else:
            tag = "API"

        # 통계 업데이트 (새로 추가)
        try:
            logger_instance._update_stats(client_ip, endpoint, method)
        except Exception as e:
            pass

        # 내부 통계만 기록(콘솔은 우리가 처리)
        try:
            logger_instance.log_access(request, endpoint, status, console=False)  # 구현에 따라 무시될 수 있음
        except Exception:
            pass

        note = _note_from_request(request, endpoint)
        log_access_row(tag=tag, ip=client_ip, method=method, status=status, path=endpoint, note=note)
        return response

app.add_middleware(AccessTrackingMiddleware)
app.add_middleware(GZipMiddleware, minimum_size=1024)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_credentials=False, allow_methods=["*"], allow_headers=["*"])

# ======================== Utilities & Sync ========================
def is_supported_image(path: Path) -> bool:
    return path.suffix.lower() in SUPPORTED_EXTENSIONS

def get_thumbnail_path(image_path: Path, size: Tuple[int, int]) -> Path:
    relative_path = image_path.relative_to(ROOT_DIR)
    thumbnail_name = f"{relative_path.stem}_{size[0]}x{size[1]}.{THUMBNAIL_FORMAT.lower()}"
    return THUMBNAIL_DIR / relative_path.parent / thumbnail_name

def safe_resolve_path(path: Optional[str]) -> Path:
    if not path: return ROOT_DIR
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
    return str(abs_path.relative_to(ROOT_DIR)).replace("\\", "/")

# ----- labels/classes sync helpers -----
def _classification_dir() -> Path:
    return ROOT_DIR / "classification"

def _classes_stat_mtime() -> float:
    try: return _classification_dir().stat().st_mtime
    except FileNotFoundError: return 0.0

def _scan_classes() -> set:
    classes = set(); d = _classification_dir()
    if not d.exists(): return classes
    try:
        with os.scandir(d) as it:
            for e in it:
                if e.is_dir(follow_symlinks=False): classes.add(e.name)
    except FileNotFoundError:
        pass
    return classes

def _labels_reload_if_stale():
    global LABELS_MTIME
    try: st = LABELS_FILE.stat()
    except FileNotFoundError: return
    if st.st_mtime > LABELS_MTIME: _labels_load()

def _dircache_invalidate(path: Path):
    try: DIRLIST_CACHE.delete(str(path))
    except Exception: pass
    try: DIRLIST_CACHE.delete(str(path.resolve()))
    except Exception: pass

def _sync_labels_with_classes(existing_classes: set) -> int:
    removed = 0
    with LABELS_LOCK:
        for rel, labs in list(LABELS.items()):
            new_labs = [x for x in labs if x in existing_classes]
            if new_labs != labs:
                LABELS[rel] = new_labs or LABELS.pop(rel, None) or []
                removed += 1
    if removed: _labels_save()
    return removed

def _sync_labels_if_classes_changed():
    global CLASSES_MTIME
    cur = _classes_stat_mtime()
    if cur > CLASSES_MTIME:
        CLASSES_MTIME = cur
        classes = _scan_classes()
        cleaned = _sync_labels_with_classes(classes)
        if cleaned:
            logger.info(f"[SYNC] classes 변경 감지 → 라벨 {cleaned}개 이미지에서 정리됨")

async def labels_classes_sync_dep():
    _labels_reload_if_stale()
    _sync_labels_if_classes_changed()

def _remove_label_from_all_images(label_name: str) -> int:
    removed = 0
    with LABELS_LOCK:
        for rel, labs in list(LABELS.items()):
            if label_name in labs:
                new_labs = [x for x in labs if x != label_name]
                if new_labs: LABELS[rel] = new_labs
                else: LABELS.pop(rel, None)
                removed += 1
    if removed:
        _labels_save()
        log_access_row(tag="INFO", note=f"라벨 완전 삭제: '{label_name}' → {removed}개 이미지에서 제거")
    return removed

# ----- labels file I/O -----
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
            LABELS = {k: [str(x) for x in v] for k, v in data.items() if isinstance(v, list)}
        try:
            LABELS_MTIME = LABELS_FILE.stat().st_mtime
        except Exception:
            LABELS_MTIME = time.time()

        # ✅ 여기서 일반 logger.info 대신 표 형식 로그 출력
        log_access_row(
            tag="INFO",
            note=f"라벨 로드: {len(LABELS)}개 이미지 (mtime={LABELS_MTIME:.5f})"
        )
    except Exception as e:
        logger.error(f"라벨 로드 실패: {e}")


def _labels_save():
    global LABELS_MTIME
    try:
        LABELS_DIR.mkdir(parents=True, exist_ok=True)
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
# ======================== Directory Listing / Index ========================
def list_dir_fast(target: Path) -> List[Dict[str, str]]:
    no_cache_paths = ["classification", "images", "labels"]
    should_cache = not any(x in str(target).replace("\\", "/") for x in no_cache_paths)

    key = str(target)
    if should_cache:
    cached = DIRLIST_CACHE.get(key)
    if cached is not None:
        return cached

    items: List[Dict[str, str]] = []
    try:
        with os.scandir(target) as it:
            for entry in it:
                name = entry.name
                if name.startswith('.') or name == '__pycache__' or name in SKIP_DIRS: continue
                typ = "directory" if entry.is_dir(follow_symlinks=False) else "file"
                items.append({"name": name, "type": typ, "path": str(entry.path).replace('\\', '/')})
        directories = [x for x in items if x["type"] == "directory"]
        files = [x for x in items if x["type"] == "file"]
        directories.sort(key=lambda x: x["name"].lower(), reverse=True)
        files.sort(key=lambda x: x["name"].lower(), reverse=True)
        items = directories + files
        if should_cache: DIRLIST_CACHE.set(key, items)
    except FileNotFoundError:
        pass
    return items

async def build_file_index_background():
    global INDEX_BUILDING, INDEX_READY
    if INDEX_BUILDING: return
    INDEX_BUILDING, INDEX_READY = True, False
    log_access_row(tag="INFO", note="백그라운드 인덱스 구축 시작")

    def _walk_and_index():
        global INDEX_READY
        start = time.time()
        for root, dirs, files in os.walk(ROOT_DIR):
            if BACKGROUND_TASKS_PAUSED or USER_ACTIVITY_FLAG: time.sleep(0.1)
            for skip in list(SKIP_DIRS):
                if skip in dirs: dirs.remove(skip)
            for fn in files:
                if os.path.splitext(fn)[1].lower() not in SUPPORTED_EXTENSIONS: continue
                full = Path(root) / fn
                try: rel = str(full.relative_to(ROOT_DIR)).replace("\\", "/")
                except Exception: continue
                try:
                    st = full.stat()
                    rec = {"name_lower": fn.lower(), "size": st.st_size, "modified": st.st_mtime}
                    with FILE_INDEX_LOCK: FILE_INDEX[rel] = rec
                except Exception:
                    continue
            time.sleep(0.001)
        INDEX_READY = True
        elapsed = time.time() - start
        log_access_row(tag="INFO", note=f"인덱스 구축 완료: {len(FILE_INDEX)}개, {elapsed:.1f}s")

    try:
        await asyncio.get_running_loop().run_in_executor(ThreadPoolExecutor(max_workers=1), _walk_and_index)
    finally:
        INDEX_BUILDING = False

# ======================== Thumbnails / Common ========================
def _generate_thumbnail_sync(image_path: Path, thumbnail_path: Path, size: Tuple[int, int]):
    thumbnail_path.parent.mkdir(parents=True, exist_ok=True)
    with Image.open(image_path) as img:
        img.thumbnail(size, Image.Resampling.LANCZOS)
        img.save(thumbnail_path, THUMBNAIL_FORMAT.upper(), quality=THUMBNAIL_QUALITY, optimize=True)

async def generate_thumbnail(image_path: Path, size: Tuple[int, int]) -> Path:
    thumb = get_thumbnail_path(image_path, size)
    key = f"{thumb}|{size[0]}x{size[1]}"

    if not image_path.exists():
        raise FileNotFoundError(f"원본 이미지 파일이 존재하지 않습니다: {image_path}")

    image_mtime = image_path.stat().st_mtime

    cached = False
    if thumb.exists() and thumb.stat().st_size > 0:
        if thumb.stat().st_mtime >= image_mtime:    cached = THUMB_STAT_CACHE.get(key)
    if cached:
        THUMB_STAT_CACHE.set(key, True);  return thumb

    async with THUMBNAIL_SEM:
        if thumb.exists() and thumb.stat().st_size > 0 and thumb.stat().st_mtime >= image_mtime:
            THUMB_STAT_CACHE.set(key, True);  return thumb
        if thumb.exists():
            try: thumb.unlink()
            except Exception as e: logger.warning(f"기존 썸네일 삭제 실패: {thumb}, 오류: {e}")
        await asyncio.get_running_loop().run_in_executor(
            ThreadPoolExecutor(max_workers=1), _generate_thumbnail_sync, image_path, thumb, size
        )
        THUMB_STAT_CACHE.set(key, True)
        return thumb

def maybe_304(request: Request, st) -> Optional[Response]:
    etag = compute_etag(st)
    if request.headers.get("if-none-match") == etag:
        return Response(status_code=304, headers={"ETag": etag, "Cache-Control": "public, max-age=604800, immutable"})
    return None

# ======================== Schemas ========================
_CLASS_NAME_RE = re.compile(r"^[A-Za-z0-9_\-]+$")

class CreateClassReq(BaseModel):
    name: str = Field(..., min_length=1, max_length=128)

class LabelAddReq(BaseModel):
    image_path: str = Field(..., description="ROOT 기준 상대경로 또는 절대경로도 허용")
    labels: List[str] = Field(..., min_items=1)

class LabelDelReq(BaseModel):
    image_path: str
    labels: Optional[List[str]] = None

class ClassifyRequest(BaseModel):
    image_path: str
    class_name: str

class ClassifyDeleteRequest(BaseModel):
    image_path: Optional[str] = None
    image_name: Optional[str] = None
    class_name: str

# ======================== Endpoints ========================
# Files / Images / Search
@app.get("/api/files")
async def get_files(path: Optional[str] = None):
    try:
        target = safe_resolve_path(path)
        if not target.exists() or not target.is_dir():
            return JSONResponse({"success": False, "error": "Not found"}, status_code=404)
        if any(x in str(target).replace('\\', '/') for x in ['classification', 'images', 'labels']):
            _dircache_invalidate(target)
        return {"success": True, "items": list_dir_fast(target)}
    except Exception as e:
        logger.exception(f"폴더 조회 실패: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/api/image")
async def get_image(request: Request, path: str):
    try:
        image_path = safe_resolve_path(path)
        if not image_path.exists() or not image_path.is_file():
            raise HTTPException(status_code=404, detail="Image not found")
        st = image_path.stat()
        resp_304 = maybe_304(request, st)
        if resp_304: return resp_304
        headers = {"Cache-Control": "public, max-age=86400, immutable", "ETag": compute_etag(st)}
        return FileResponse(image_path, headers=headers)
    except Exception as e:
        logger.exception(f"이미지 제공 실패: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/api/thumbnail")
async def get_thumbnail(request: Request, path: str, size: int = THUMBNAIL_SIZE_DEFAULT):
    try:
        image_path = safe_resolve_path(path)
        if not image_path.exists() or not image_path.is_file():
            raise HTTPException(status_code=404, detail="Image not found")
        if not is_supported_image(image_path):
            raise HTTPException(status_code=400, detail="Unsupported image format")
        thumb = await generate_thumbnail(image_path, (size, size))
        st = thumb.stat()
        resp_304 = maybe_304(request, st)
        if resp_304: return resp_304
        headers = {"Cache-Control": "public, max-age=604800, immutable", "ETag": compute_etag(st)}
        return FileResponse(thumb, headers=headers)
    except Exception as e:
        logger.exception(f"썸네일 제공 실패: {e}")
        return await get_image(request, path)

@app.get("/api/search")
async def search_files(q: str = Query(..., description="파일명 검색(대소문자 무시, 부분일치)"),
    limit: int = Query(500, ge=1, le=5000),
                       offset: int = Query(0, ge=0)):
    try:
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
                    if len(bucket) >= goal: break

        if len(bucket) < goal:
            seen = set(bucket); need = goal - len(bucket)
            def _scan():
                nonlocal need
                for root, dirs, files in os.walk(ROOT_DIR):
                    for skip in list(SKIP_DIRS):
                        if skip in dirs: dirs.remove(skip)
                    for fn in files:
                        ext = os.path.splitext(fn)[1].lower()
                        if ext not in SUPPORTED_EXTENSIONS: continue
                        low = fn.lower()
                        if query not in low: continue
                        full = Path(root) / fn
                        try: rel = str(full.relative_to(ROOT_DIR)).replace("\\", "/")
                        except Exception: continue
                        if rel in seen: continue
                        seen.add(rel); bucket.append(rel)
                        try:
                            st = full.stat()
                            rec = {"name_lower": low, "size": st.st_size, "modified": st.st_mtime}
                            with FILE_INDEX_LOCK: FILE_INDEX[rel] = rec
                        except Exception:
                            pass
                        need -= 1
                        if need <= 0: return
                    time.sleep(0.001)
            if need > 0:
                await asyncio.get_running_loop().run_in_executor(ThreadPoolExecutor(max_workers=1), _scan)

        results = bucket[offset: offset + limit]
        return {"success": True, "results": results, "offset": offset, "limit": limit}
    except Exception as e:
        logger.exception(f"검색 실패: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/api/files/all")
async def get_all_files():
    try:
        with FILE_INDEX_LOCK:
            keys = list(FILE_INDEX.keys())
        if not keys and not INDEX_BUILDING:
            asyncio.create_task(build_file_index_background())
        return {"success": True, "files": keys}
    except Exception as e:
        logger.exception(f"전체 파일 목록 조회 실패: {e}")
        raise HTTPException(status_code=500, detail=str(e))

# ---------------- Classes ----------------
@app.get("/api/classes")
async def get_classes(_=Depends(labels_classes_sync_dep)):
    try:
        classification_dir = _classification_dir()
        _dircache_invalidate(classification_dir)
        if not classification_dir.exists():
            classification_dir.mkdir(parents=True, exist_ok=True)
            log_access_row(tag="INFO", note=f"classification 폴더 생성: {classification_dir}")
            return {"success": True, "classes": []}
        classes = []
        try:
            with os.scandir(classification_dir) as it:
                for entry in it:
                    if entry.is_dir(follow_symlinks=False): classes.append(entry.name)
        except FileNotFoundError:
            pass
        return {"success": True, "classes": sorted(classes, key=str.lower)}
    except Exception as e:
        logger.exception(f"분류 클래스 조회 실패: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/classes")
async def create_class(req: CreateClassReq, _=Depends(labels_classes_sync_dep)):
    try:
        name = req.name.strip()
        if not name or name.isspace(): raise HTTPException(status_code=400, detail="클래스명이 비어있습니다")
        if any(ord(c) < 32 or ord(c) > 126 for c in name):
            raise HTTPException(status_code=400, detail="클래스명에 특수문자/한글 자모 사용 불가 (A-Z,a-z,0-9,_,-)")
        if not _CLASS_NAME_RE.match(name): raise HTTPException(status_code=400, detail="클래스명 형식 오류")
        if len(name) > 50: raise HTTPException(status_code=400, detail="클래스명이 너무 깁니다 (최대 50자)")
        class_dir = _classification_dir() / name
        if class_dir.exists(): raise HTTPException(status_code=409, detail="Class already exists")
        class_dir.mkdir(parents=True, exist_ok=False)
        _sync_labels_if_classes_changed()
        for p in (_classification_dir(), class_dir, ROOT_DIR): _dircache_invalidate(p)
        DIRLIST_CACHE.clear()
        log_access_row(tag="INFO", note=f"클래스 '{name}' 생성 완료")
        return {"success": True, "class": name, "refresh_required": True, "message": f"클래스 '{name}' 생성됨"}
    except Exception as e:
        logger.exception(f"클래스 생성 실패: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.delete("/api/classes/{class_name}")
async def delete_class(class_name: str = PathParam(..., min_length=1, max_length=128),
                       force: bool = Query(False, description="True면 내용 포함 통째 삭제"),
                       _=Depends(labels_classes_sync_dep)):
    try:
        if not _CLASS_NAME_RE.match(class_name): raise HTTPException(status_code=400, detail="Invalid class_name")
        class_dir = _classification_dir() / class_name
        if not class_dir.exists() or not class_dir.is_dir(): raise HTTPException(status_code=404, detail="Class not found")
        if force:
            shutil.rmtree(class_dir)
            log_access_row(tag="INFO", note=f"클래스 삭제(force): {class_name}")
        else:
            if any(class_dir.iterdir()): raise HTTPException(status_code=409, detail="Class directory not empty")
            class_dir.rmdir()
            log_access_row(tag="INFO", note=f"클래스 삭제: {class_name}")
        removed_cnt = _remove_label_from_all_images(class_name)
        _labels_load()
        for p in (_classification_dir(), class_dir, ROOT_DIR): _dircache_invalidate(p)
        DIRLIST_CACHE.clear()
        log_access_row(tag="INFO", note=f"클래스 '{class_name}' 삭제 완료")
        return {"success": True, "deleted": class_name, "force": force, "labels_cleaned": removed_cnt, "refresh_required": True}
    except Exception as e:
        logger.exception(f"클래스 삭제 실패: {e}")
        raise HTTPException(status_code=500, detail=str(e))

class DeleteClassesReq(BaseModel):
    names: List[str] = Field(..., min_items=1)

@app.post("/api/classes/delete")
async def delete_classes(req: DeleteClassesReq, _=Depends(labels_classes_sync_dep)):
    try:
        if not req.names: raise HTTPException(status_code=400, detail="클래스명 목록이 비어있습니다")
        deleted, failed, total_cleaned = [], [], 0
        for class_name in req.names:
            try:
                class_name = class_name.strip()
                if not _CLASS_NAME_RE.match(class_name): raise ValueError("Invalid class name")
                class_dir = _classification_dir() / class_name
                if not class_dir.exists() or not class_dir.is_dir(): raise FileNotFoundError("Class not found")
                shutil.rmtree(class_dir); deleted.append(class_name)
                total_cleaned += _remove_label_from_all_images(class_name)
            except Exception as e:
                failed.append({"class": class_name, "error": str(e)})
                logger.exception(f"클래스 {class_name} 삭제 실패: {e}")
        if total_cleaned > 0: _labels_load()
        _dircache_invalidate(_classification_dir())
        log_access_row(tag="INFO", note="배치 클래스 삭제 완료 - Label Explorer 새로고침 필요")
        return {"success": True, "deleted": deleted, "failed": failed, "labels_cleaned": total_cleaned,
                "refresh_required": True, "message": f"{len(deleted)}개 삭제, {len(failed)}개 실패"}
    except Exception as e:
        logger.exception(f"클래스 일괄 삭제 실패: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/api/classes/{class_name}/images")
async def class_images(class_name: str = PathParam(..., min_length=1, max_length=128),
                       limit: int = Query(500, ge=1, le=5000),
                       offset: int = Query(0, ge=0),
                       _=Depends(labels_classes_sync_dep)):
    try:
        if not _CLASS_NAME_RE.match(class_name): raise HTTPException(status_code=400, detail="Invalid class_name")
        class_dir = _classification_dir() / class_name
        if not class_dir.exists() or not class_dir.is_dir(): raise HTTPException(status_code=404, detail="Class not found")
        found: List[str] = []; goal = offset + limit
        for p in class_dir.rglob("*"):
            if p.is_file() and is_supported_image(p):
                rel = str(p.relative_to(ROOT_DIR)).replace("\\", "/")
                found.append(rel)
                if len(found) >= goal: break
        return {"success": True, "class": class_name, "results": found[offset: offset + limit], "offset": offset, "limit": limit}
    except Exception as e:
        logger.exception(f"클래스 이미지 조회 실패: {e}")
        raise HTTPException(status_code=500, detail=str(e))

# ---------------- Labels ----------------
@app.post("/api/labels")
async def add_labels(req: LabelAddReq, _=Depends(labels_classes_sync_dep)):
    try:
        rel = relkey_from_any_path(req.image_path)
        abs_path = ROOT_DIR / rel
        if not abs_path.exists() or not abs_path.is_file(): raise HTTPException(status_code=404, detail="Image not found")
        if not is_supported_image(abs_path): raise HTTPException(status_code=400, detail="Unsupported image format")
        new_labels = [str(x).strip() for x in req.labels if str(x).strip()]
        if not new_labels: raise HTTPException(status_code=400, detail="Empty labels")
        with LABELS_LOCK:
            cur = set(LABELS.get(rel, [])); cur.update(new_labels); LABELS[rel] = sorted(cur)
        _labels_save(); _dircache_invalidate(_classification_dir())
        return {"success": True, "image": rel, "labels": LABELS[rel]}
    except Exception as e:
        logger.exception(f"라벨 추가 실패: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.delete("/api/labels")
async def delete_labels(req: LabelDelReq, _=Depends(labels_classes_sync_dep)):
    try:
        rel = relkey_from_any_path(req.image_path)
        with LABELS_LOCK:
            if rel not in LABELS: raise HTTPException(status_code=404, detail="No labels for this image")
            if req.labels is None: LABELS.pop(rel, None)
            else:
                to_remove = {str(x).strip() for x in req.labels if str(x).strip()}
                if not to_remove: raise HTTPException(status_code=400, detail="Empty labels to remove")
                remain = [x for x in LABELS[rel] if x not in to_remove]
                LABELS[rel] = remain or LABELS.pop(rel, None) or []
        _labels_save(); _dircache_invalidate(_classification_dir())
        return {"success": True, "image": rel, "labels": LABELS.get(rel, [])}
    except Exception as e:
        logger.exception(f"라벨 제거 실패: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/labels/delete")
async def delete_labels_post(req: LabelDelReq, _=Depends(labels_classes_sync_dep)):
    return await delete_labels(req)

@app.get("/api/labels/{image_path:path}")
async def get_labels(image_path: str, _=Depends(labels_classes_sync_dep)):
    try:
        rel = relkey_from_any_path(image_path)
        with LABELS_LOCK: labels = list(LABELS.get(rel, []))
        return {"success": True, "image": rel, "labels": labels}
    except Exception as e:
        logger.exception(f"라벨 조회 실패: {e}")
        raise HTTPException(status_code=500, detail=str(e))

# ---------------- Classify ----------------
@app.post("/api/classify")
async def classify_image(req: ClassifyRequest, _=Depends(labels_classes_sync_dep)):
    try:
        if not req.image_path or not req.class_name:
            raise HTTPException(status_code=400, detail="이미지 경로와 클래스명이 필요합니다")
        image_path = req.image_path.strip();  class_name = req.class_name.strip()
        full_image_path = safe_resolve_path(image_path)
        if not full_image_path.exists() or not full_image_path.is_file():
            raise HTTPException(status_code=404, detail="이미지 파일을 찾을 수 없습니다")
        class_dir = _classification_dir() / class_name;  class_dir.mkdir(parents=True, exist_ok=True)
        shutil.copy2(full_image_path, class_dir / full_image_path.name)
        rel = relkey_from_any_path(image_path)
        with LABELS_LOCK:
            if rel not in LABELS: LABELS[rel] = []
            if class_name not in LABELS[rel]: LABELS[rel].append(class_name)
        _labels_save();  _dircache_invalidate(_classification_dir()); _dircache_invalidate(class_dir)
        log_access_row(tag="INFO", note=f"이미지 분류: {image_path} -> {class_name}")
        return {"success": True, "message": f"이미지 '{image_path}'이 클래스 '{class_name}'으로 분류되었습니다",
                "image": rel, "class": class_name}
    except Exception as e:
        logger.exception(f"이미지 분류 실패: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/classify/delete")
async def delete_classification(req: ClassifyDeleteRequest, _=Depends(labels_classes_sync_dep)):
    try:
        if not req.class_name: raise HTTPException(status_code=400, detail="클래스명이 필요합니다")
        class_name = req.class_name.strip()
        if not req.image_path and not req.image_name:
            raise HTTPException(status_code=400, detail="이미지 경로 또는 이미지 파일명이 필요합니다")

        class_dir = _classification_dir() / class_name
        if not class_dir.exists(): raise HTTPException(status_code=404, detail="클래스를 찾을 수 없습니다")

        image_file = class_dir / (req.image_name.strip() if req.image_name else Path(req.image_path.strip()).name)
        if not image_file.exists(): raise HTTPException(status_code=404, detail="해당 클래스에 이미지가 없습니다")

        image_file.unlink()
        removed_from: List[str] = []
        with LABELS_LOCK:
            if req.image_path:
                rel = relkey_from_any_path(req.image_path)
                labs = LABELS.get(rel, [])
                if class_name in labs:
                    LABELS[rel] = [x for x in labs if x != class_name]
                    if not LABELS[rel]: LABELS.pop(rel, None)
                    removed_from.append(rel)
            else:
                fname = image_file.name
                for rel, labs in list(LABELS.items()):
                    if Path(rel).name == fname and class_name in labs:
                        LABELS[rel] = [x for x in labs if x != class_name]
                        if not LABELS[rel]: LABELS.pop(rel, None)
                        removed_from.append(rel)
        if removed_from: _labels_save()
        _dircache_invalidate(_classification_dir()); _dircache_invalidate(class_dir)
        return {"success": True, "message": f"이미지 '{image_file.name}'의 클래스 '{class_name}' 분류를 제거했습니다",
                "removed_from": removed_from}
    except Exception as e:
        logger.exception(f"분류 제거 실패: {e}")
        raise HTTPException(status_code=500, detail=str(e))

# ---------------- Stats passthrough ----------------
@app.get("/api/stats/daily")
async def get_daily_stats(): return logger_instance.get_daily_stats()

@app.get("/api/stats/trend")
async def get_trend_stats(days: int = Query(7, ge=1, le=30)): return logger_instance.get_daily_trend(days)

@app.get("/api/stats/monthly")
async def get_monthly_stats(months: int = Query(3, ge=1, le=12)): return logger_instance.get_monthly_trend(months)

@app.get("/api/stats/users")
async def get_users_stats(): return logger_instance.get_users_stats()

@app.get("/api/stats/recent-users")
async def get_recent_users(): return logger_instance.get_recent_users()

@app.get("/api/stats/user/{user_id}")
async def get_user_detail(user_id: str):
    user_detail = logger_instance.get_user_detail(user_id)
    if user_detail is None: raise HTTPException(status_code=404, detail="User not found")
    return user_detail

@app.get("/api/stats/active-users")
async def get_active_users():
    """현재 활성 사용자 목록"""
    return logger_instance.get_active_users()

# ---------------- Static / Pages ----------------
app.mount("/js", StaticFiles(directory="js"), name="js")
app.mount("/static", StaticFiles(directory="."), name="static")

@app.get("/")
async def read_root():
    try:
        html_path = Path("index.html")
        return FileResponse(html_path) if html_path.exists() else {"message": "index.html not found"}
    except Exception as e:
        logger.exception(f"루트 페이지 로드 실패: {e}")
        return {"error": "Failed to load main page"}

@app.get("/stats")
async def read_stats():
    try:
        stats_path = Path("stats.html")
        return FileResponse(stats_path) if stats_path.exists() else {"message": "stats.html not found"}
    except Exception as e:
        logger.exception(f"통계 페이지 로드 실패: {e}")
        return {"error": "Failed to load stats page"}

@app.get("/main.js")
async def get_main_js():
    try:
        js_path = Path("main.js")
        return FileResponse(js_path) if js_path.exists() else {"message": "main.js not found"}
    except Exception as e:
        logger.exception(f"main.js 로드 실패: {e}")
        return {"error": "Failed to load main.js"}

# ---------------- Folder / Lifecycle ----------------
@app.get("/api/current-folder")
async def get_current_folder(): return {"current_folder": str(ROOT_DIR)}

@app.get("/api/root-folder")
async def get_root_folder():
    from .config import ROOT_DIR as ORIGINAL_ROOT_DIR
    return {"root_folder": str(ORIGINAL_ROOT_DIR)}

@app.post("/api/change-folder")
async def change_folder(request: Request):
    try:
        data = await request.json()
        new_path = data.get("path")
        if not new_path: raise HTTPException(status_code=400, detail="폴더 경로가 필요합니다")
        new_path_obj = Path(new_path).resolve()
        if not new_path_obj.exists(): raise HTTPException(status_code=404, detail="폴더가 존재하지 않습니다")
        if not new_path_obj.is_dir(): raise HTTPException(status_code=400, detail="유효한 폴더가 아닙니다")

        global ROOT_DIR, THUMBNAIL_DIR, LABELS_DIR, LABELS_FILE
        ROOT_DIR = new_path_obj
        THUMBNAIL_DIR = ROOT_DIR / "thumbnails"
        LABELS_DIR = ROOT_DIR / "classification"
        LABELS_FILE = LABELS_DIR / "labels.json"

        DIRLIST_CACHE.clear();  THUMB_STAT_CACHE.clear()
        global INDEX_READY, INDEX_BUILDING
        INDEX_READY = False; INDEX_BUILDING = False

        classification_dir = _classification_dir()
        if not classification_dir.exists():
            classification_dir.mkdir(parents=True, exist_ok=True)
            log_access_row(tag="INFO", note=f"새 폴더의 classification 폴더 생성: {classification_dir}")

        _labels_load()
        return {"success": True, "message": f"폴더가 '{new_path}'로 변경되었습니다", "new_path": str(ROOT_DIR)}
    except Exception as e:
        logger.error(f"폴더 변경 실패: {e}")
        raise HTTPException(status_code=500, detail=f"폴더 변경 실패: {str(e)}")

@app.get("/api/browse-folders")
async def browse_folders(path: Optional[str] = None):
    try:
        if not path:
            import string
            drives = []
            for letter in string.ascii_uppercase:
                drive_path = f"{letter}:\\"
                if Path(drive_path).exists():
                    drives.append({"name": f"{letter}: 드라이브", "path": drive_path, "type": "drive"})
            return {"folders": drives}

        target_path = Path(path).resolve()
        if not target_path.exists() or not target_path.is_dir():
            raise HTTPException(status_code=404, detail="폴더를 찾을 수 없습니다")

        folders = []
        try:
            with os.scandir(target_path) as it:
                for entry in it:
                    if entry.is_dir(follow_symlinks=False) and not entry.name.startswith('.'):
                        folders.append({"name": entry.name, "path": str(entry.path), "type": "folder"})
        except PermissionError:
            raise HTTPException(status_code=403, detail="폴더 접근 권한이 없습니다")

        folders.sort(key=lambda x: x["name"].lower(), reverse=True)
        return {"folders": folders}
    except Exception as e:
        logger.error(f"폴더 브라우징 실패: {e}")
        raise HTTPException(status_code=500, detail=f"폴더 브라우징 실패: {str(e)}")

# ======================== Lifecycle ========================
@app.on_event("startup")
async def startup_event():
    bootlog = logging.getLogger("uvicorn.error")
    bootlog.info("🚀 L3Tracker 서버 시작 (테이블 로그 시스템)")
    bootlog.info(f"📍 호스트: {config.DEFAULT_HOST}")
    bootlog.info(f"🔌 포트: {config.DEFAULT_PORT}")
    bootlog.info(f"📁 ROOT_DIR: {config.ROOT_DIR}")
    bootlog.info(f"🔧 PROJECT_ROOT: {os.getenv('PROJECT_ROOT', 'NOT SET')}")
    bootlog.info("=" * 50)
    print_access_header_once()

    _classification_dir().mkdir(parents=True, exist_ok=True)
    _labels_load()
    global CLASSES_MTIME
    CLASSES_MTIME = _classes_stat_mtime()
    asyncio.create_task(build_file_index_background())

@app.on_event("shutdown")
async def shutdown_event():
    logging.getLogger("uvicorn.error").info("🛑 L3Tracker 서버 종료")

# ======================== __main__ ========================
if __name__ == "__main__":
    import uvicorn
    uvicorn.run(
        app,
        host=config.DEFAULT_HOST,
        port=config.DEFAULT_PORT,
        reload=config.DEFAULT_RELOAD,
        workers=config.DEFAULT_WORKERS,
        log_level="info",
        access_log=False,  # uvicorn access 로그 비활성화 (커스텀 테이블 사용)
        use_colors=True,
        log_config=None,
    )
