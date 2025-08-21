"""
L3Tracker - Wafer Map Viewer API (Config-driven, Max-Throughput)
- config.py로 모든 주요 파라미터 외부화
- 파일명 대소문자 무시 부분일치 검색(모든 하위폴더)
- 유저 요청 최우선(요청 중 백그라운드 즉시 양보/일시정지)
- 폴더 리스트: os.scandir + LRU 캐시
- 이미지/썸네일: ETag(If-None-Match) + 304 Not Modified + 강한 캐시
- 썸네일: ThreadPoolExecutor + 동시 생성 제한(config.THUMBNAIL_SEM)
- 인덱스: 백그라운드 구축(양보), 인메모리 우선 검색(offset/limit)
"""

import os
import time
import logging
from pathlib import Path
from typing import List, Optional, Dict, Any, Set, Tuple
from collections import OrderedDict
from threading import RLock
import asyncio
from concurrent.futures import ThreadPoolExecutor

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.responses import JSONResponse, FileResponse, Response
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from starlette.middleware.gzip import GZipMiddleware
from PIL import Image

import api.config as config

# ========== 로깅 ==========
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
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
app = FastAPI(title="L3Tracker API", version="2.0.0")
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

async def delayed_background_resume():
    await asyncio.sleep(1.5)  # 짧게
    global BACKGROUND_TASKS_PAUSED
    BACKGROUND_TASKS_PAUSED = False
    clear_user_activity()
    logger.debug("백그라운드 재개")

# ========== 디렉터리 나열 ==========
def list_dir_fast(target: Path) -> List[Dict[str, str]]:
    key = str(target)
    cached = DIRLIST_CACHE.get(key)
    if cached is not None:
        return cached

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
        items.sort(key=lambda x: (x["type"] != "directory", x["name"].lower()))
        DIRLIST_CACHE.set(key, items)
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
            # 유저 요청 시 자주 양보
            if BACKGROUND_TASKS_PAUSED or USER_ACTIVITY_FLAG:
                time.sleep(0.1)
            # 폴더 프룬
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
    cached = THUMB_STAT_CACHE.get(key)
    if cached:
        return thumb

    if thumb.exists() and thumb.stat().st_size > 0:
        THUMB_STAT_CACHE.set(key, True)
        return thumb

    async with THUMBNAIL_SEM:
        if thumb.exists() and thumb.stat().st_size > 0:
            THUMB_STAT_CACHE.set(key, True)
            return thumb
        await asyncio.get_running_loop().run_in_executor(
            IO_POOL, _generate_thumbnail_sync, image_path, thumb, size
        )
        THUMB_STAT_CACHE.set(key, True)
        return thumb

# ========== 공통: ETag/304 ==========
def maybe_304(request: Request, st) -> Optional[Response]:
    etag = compute_etag(st)
    inm = request.headers.get("if-none-match")
    if inm and inm == etag:
        return Response(status_code=304, headers={"ETag": etag, "Cache-Control": "public, max-age=604800, immutable"})
    return None

# ========== 엔드포인트 ==========
@app.get("/api/files")
async def get_files(path: Optional[str] = None):
    try:
        set_user_activity()
        target = safe_resolve_path(path)
        if not target.exists() or not target.is_dir():
            return JSONResponse({"success": False, "error": "Not found"}, status_code=404)
        items = list_dir_fast(target)
        return {"success": True, "items": items}
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
        if not is_supported_image(image_path):
            raise HTTPException(status_code=400, detail="Unsupported image format")

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

@app.get("/api/classes")
async def get_classes():
    try:
        set_user_activity()
        classification_dir = ROOT_DIR / "classification"
        if not classification_dir.exists():
            return {"success": True, "classes": []}
        classes = []
        try:
            with os.scandir(classification_dir) as it:
                for entry in it:
                    if entry.is_dir(follow_symlinks=False):
                        classes.append(entry.name)
        except FileNotFoundError:
            pass
        classes.sort()
        return {"success": True, "classes": classes}
    except HTTPException:
        raise
    except Exception as e:
        logger.exception(f"분류 클래스 조회 실패: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/api/search")
async def search_files(
    q: str = Query(..., description="파일명 검색(대소문자 무시, 부분일치)"),
    limit: int = Query(500, ge=1, le=5000),
    offset: int = Query(0, ge=0)
):
    """인덱스 우선 + 디스크 스캔 보강 (offset/limit 지원)"""
    try:
        set_user_activity()
        query = (q or "").strip().lower()
        if not query:
            return {"success": True, "results": [], "offset": offset, "limit": limit}

        # 결과 버킷은 offset+limit까지만 모으고 마지막에 슬라이싱
        goal = offset + limit
        bucket: List[str] = []

        # 1) 인덱스 스냅샷
        with FILE_INDEX_LOCK:
            items = list(FILE_INDEX.items())

        if items:
            for rel, meta in items:
                if query in meta["name_lower"]:
                    bucket.append(rel)
                    if len(bucket) >= goal:
                        break

        # 2) 부족하면 디스크 스캔
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
                        # 인덱스 즉시 보강
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
                    time.sleep(0.001)  # 가벼운 양보

            if need > 0:
                await asyncio.get_running_loop().run_in_executor(IO_POOL, _scan)

        # 슬라이싱
        results = bucket[offset: offset + limit]
        return {"success": True, "results": results, "offset": offset, "limit": limit}
    except HTTPException:
        raise
    except Exception as e:
        logger.exception(f"검색 실패: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/api/files/all")
async def get_all_files():
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

@app.get("/api/index/status")
async def index_status():
    with FILE_INDEX_LOCK:
        n = len(FILE_INDEX)
    return {"building": INDEX_BUILDING, "ready": INDEX_READY, "count": n}

# ========== CLASSIFICATION API ==========
@app.post("/api/classes")
async def create_class(request: Request):
    """새 클래스 생성"""
    try:
        set_user_activity()
        body = await request.json()
        class_name = body.get("name", "").strip()
        
        if not class_name:
            raise HTTPException(status_code=400, detail="Class name is required")
        
        # classification 폴더 생성
        class_dir = ROOT_DIR / "classification" / class_name
        class_dir.mkdir(parents=True, exist_ok=True)
        
        logger.info(f"클래스 생성: {class_name}")
        return {"success": True, "message": f"Class '{class_name}' created successfully"}
        
    except HTTPException:
        raise
    except Exception as e:
        logger.exception(f"클래스 생성 실패: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/classes/delete")
async def delete_classes(request: Request):
    """클래스 삭제 (이미지와 함께)"""
    try:
        set_user_activity()
        body = await request.json()
        class_names = body.get("names", [])
        
        if not class_names:
            raise HTTPException(status_code=400, detail="Class names are required")
        
        deleted_count = 0
        for class_name in class_names:
            class_dir = ROOT_DIR / "classification" / class_name
            if class_dir.exists():
                import shutil
                shutil.rmtree(class_dir)
                deleted_count += 1
                logger.info(f"클래스 삭제: {class_name}")
        
        return {"success": True, "message": f"Deleted {deleted_count} classes"}
        
    except HTTPException:
        raise
    except Exception as e:
        logger.exception(f"클래스 삭제 실패: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/classify")
async def classify_image(request: Request):
    """이미지를 특정 클래스로 분류"""
    try:
        set_user_activity()
        body = await request.json()
        class_name = body.get("class_name", "").strip()
        image_path = body.get("image_path", "").strip()
        
        if not class_name or not image_path:
            raise HTTPException(status_code=400, detail="Class name and image path are required")
        
        # 원본 이미지 경로 확인
        source_image = safe_resolve_path(image_path)
        if not source_image.exists() or not source_image.is_file():
            raise HTTPException(status_code=404, detail="Source image not found")
        
        # classification 폴더에 이미지 복사
        class_dir = ROOT_DIR / "classification" / class_name
        class_dir.mkdir(parents=True, exist_ok=True)
        
        # 이미지 파일명 추출 및 복사
        import shutil
        target_image = class_dir / source_image.name
        
        # 이미 존재하는 경우 덮어쓰기
        shutil.copy2(source_image, target_image)
        
        logger.info(f"이미지 분류: {image_path} -> {class_name}")
        return {"success": True, "message": f"Image classified to class '{class_name}'"}
        
    except HTTPException:
        raise
    except Exception as e:
        logger.exception(f"이미지 분류 실패: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/thumbnail/preload")
async def preload_thumbnails(request: Request):
    """썸네일 프리로드 (배치 처리)"""
    try:
        set_user_activity()
        body = await request.json()
        image_paths = body.get("paths", [])
        size = body.get("size", 512)
        
        if not image_paths:
            return {"success": True, "message": "No images to preload"}
        
        # 썸네일 생성 작업을 백그라운드에서 실행
        async def _preload_batch():
            for path in image_paths:
                try:
                    image_path = safe_resolve_path(path)
                    if image_path.exists() and is_supported_image(image_path):
                        await generate_thumbnail(image_path, (size, size))
                except Exception as e:
                    logger.warning(f"썸네일 프리로드 실패 {path}: {e}")
                await asyncio.sleep(0.01)  # 가벼운 양보
        
        asyncio.create_task(_preload_batch())
        
        return {"success": True, "message": f"Preloading {len(image_paths)} thumbnails"}
        
    except HTTPException:
        raise
    except Exception as e:
        logger.exception(f"썸네일 프리로드 실패: {e}")
        raise HTTPException(status_code=500, detail=str(e))

# 정적 파일
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
    logger.info("🚀 L3Tracker 서버 시작 (Config-driven Max-Throughput)")
    logger.info(f"📁 ROOT_DIR: {ROOT_DIR}")
    logger.info(f"🧵 IO_THREADS: {IO_THREADS}, 🧮 THUMBNAIL_SEM: {THUMBNAIL_SEM_SIZE}")
    asyncio.create_task(build_file_index_background())

@app.on_event("shutdown")
async def shutdown_event():
    logger.info("🛑 L3Tracker 서버 종료")
    IO_POOL.shutdown(wait=False)

# ========== 메인 ==========
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
