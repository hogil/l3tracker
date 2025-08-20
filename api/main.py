import os
import shutil
import logging
from pathlib import Path
from typing import Optional, List, Dict, Any
from fastapi import FastAPI, HTTPException, UploadFile, File
from fastapi.responses import FileResponse, JSONResponse, HTMLResponse
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from PIL import Image
import hashlib
import asyncio
import time
from concurrent.futures import ThreadPoolExecutor
import threading
from functools import lru_cache
from pydantic import BaseModel, Field
import sys
sys.path.append(str(Path(__file__).parent))

from config import (
    ROOT_DIR, THUMBNAIL_DIR, THUMBNAIL_SIZE, THUMBNAIL_FORMAT, THUMBNAIL_QUALITY,
    THUMBNAIL_CACHE_SECONDS, MAX_WORKERS, MAX_THUMBNAIL_BATCH,
    BACKGROUND_SCAN_INTERVAL, BACKGROUND_BATCH_SIZE, BACKGROUND_WORKERS
)
from utils import get_file_hash, is_supported_image, get_thumbnail_path, safe_resolve_path

# 프로젝트 루트 경로 (정적 파일용)
PROJECT_ROOT = Path(__file__).parent.parent

# 전역 이미지 인덱스 (상대경로, posix)
ALL_IMAGE_PATHS: List[str] = []

def build_image_index() -> int:
    """루트에서 모든 이미지 파일을 재귀적으로 수집하여 인덱스를 구축합니다."""
    global ALL_IMAGE_PATHS
    try:
        excluded_dirs = {"classification", "thumbnails", "__pycache__"}
        paths: List[str] = []
        for p in ROOT_DIR.rglob("*"):
            if not p.is_file():
                continue
            if not is_supported_image(p):
                continue
            rel = p.relative_to(ROOT_DIR)
            parts = set(part.lower() for part in rel.parts[:-1])
            if excluded_dirs & parts:
                continue
            paths.append(rel.as_posix())
        ALL_IMAGE_PATHS = paths
        logging.info(f"전역 이미지 인덱스 구축: {len(ALL_IMAGE_PATHS)}개")
        return len(ALL_IMAGE_PATHS)
    except Exception as e:
        logging.error(f"전역 이미지 인덱스 구축 실패: {e}")
        return 0

# =====================
# 백그라운드 썸네일 생성 시스템
# =====================
class BackgroundThumbnailManager:
    def __init__(self):
        self.background_executor = ThreadPoolExecutor(max_workers=BACKGROUND_WORKERS)
        self.is_running = False
        self.scan_interval = BACKGROUND_SCAN_INTERVAL
        self.batch_size = BACKGROUND_BATCH_SIZE
        self.last_scan_time = 0
        self.total_generated = 0
        self.scan_count = 0
        self.min_user_idle_seconds = 1.5  # 사용자가 1.5초 이상 아무 요청이 없을 때만 스캔
        
    async def start(self):
        """백그라운드 썸네일 생성 시작"""
        if self.is_running:
            return
            
        self.is_running = True
        logging.info("백그라운드 썸네일 생성 시스템 시작")
        
        # 즉시 첫 스캔 실행
        asyncio.create_task(self._initial_scan())
        
        # 주기적 스캔 시작
        asyncio.create_task(self._periodic_scanner())
        
    async def stop(self):
        """백그라운드 시스템 정지"""
        self.is_running = False
        logging.info("백그라운드 썸네일 생성 시스템 정지")
        
    async def _initial_scan(self):
        """서버 시작 시 초기 스캔"""
        try:
            await asyncio.sleep(2)  # 서버 완전 시작 대기
            logging.info("초기 썸네일 스캔 시작")
            await self._scan_and_generate()
            logging.info("초기 썸네일 스캔 완료")
        except Exception as e:
            logging.error(f"초기 스캔 중 오류: {e}")
            
    async def _periodic_scanner(self):
        """주기적으로 새 이미지를 스캔하고 썸네일 생성"""
        while self.is_running:
            try:
                await asyncio.sleep(self.scan_interval)
                if not self.is_running:
                    break
                    
                # 사용자 요청 우선: 최근 사용자 액티비티가 있으면 건너뜀
                if time.time() - last_user_activity_ts < self.min_user_idle_seconds:
                    logging.info("사용자 요청 우선 - 이번 주기 스캔 건너뜀")
                    continue
                
                logging.info("주기적 썸네일 스캔 시작 (사용자 유휴 상태)")
                await self._scan_and_generate()
                
            except Exception as e:
                logging.error(f"주기적 스캔 중 오류: {e}")
                await asyncio.sleep(30)  # 오류 시 30초 대기
                
    async def _scan_and_generate(self):
        """이미지 스캔하고 썸네일 생성"""
        try:
            # 시작 직전에도 사용자 활동 감지 시 즉시 종료
            if time.time() - last_user_activity_ts < self.min_user_idle_seconds:
                logging.info("사용자 요청 감지 - 스캔 시작 취소")
                return
            self.scan_count += 1
            start_time = asyncio.get_event_loop().time()
            
            # 모든 이미지 파일 찾기
            all_images = []
            for idx, img_path in enumerate(ROOT_DIR.rglob("*")):
                # 긴 루프에서 주기적으로 양보 및 사용자 활동 체크
                if idx % 500 == 0:
                    if time.time() - last_user_activity_ts < self.min_user_idle_seconds:
                        logging.info("사용자 요청 감지 - 스캔(파일열거) 중단")
                        return
                    await asyncio.sleep(0)
                if img_path.is_file() and is_supported_image(img_path):
                    all_images.append(img_path)
                    
            # 썸네일이 없는 이미지들 필터링
            missing_thumbnails = []
            for jdx, img_path in enumerate(all_images):
                if jdx % 500 == 0:
                    if time.time() - last_user_activity_ts < self.min_user_idle_seconds:
                        logging.info("사용자 요청 감지 - 스캔(미싱필터) 중단")
                        return
                    await asyncio.sleep(0)
                thumb_path = get_thumbnail_path(img_path)
                if not thumb_path.exists():
                    missing_thumbnails.append(img_path)
                    
            if not missing_thumbnails:
                logging.info(f"새로 생성할 썸네일 없음 (총 {len(all_images)}개 이미지)")
                return
                
            logging.info(f"새 썸네일 {len(missing_thumbnails)}개 생성 시작 (전체 {len(all_images)}개 중)")
            
            # 배치 단위로 처리
            generated_count = 0
            for i in range(0, len(missing_thumbnails), self.batch_size):
                if not self.is_running:
                    break
                    
                # 사용자 요청 즉시 중단
                if time.time() - last_user_activity_ts < self.min_user_idle_seconds:
                    logging.info("사용자 요청 감지 - 썸네일 배치 시작 전 중단")
                    break

                batch = missing_thumbnails[i:i + self.batch_size]
                
                # 백그라운드에서 배치 처리
                tasks = []
                for img_path in batch:
                    task = asyncio.get_event_loop().run_in_executor(
                        self.background_executor,
                        self._create_thumbnail_safe,
                        img_path
                    )
                    tasks.append(task)
                    
                # 배치 완료 대기 (중간에도 사용자 요청이 있으면 즉시 중단)
                results = await asyncio.gather(*tasks, return_exceptions=True)
                
                # 결과 집계
                for result in results:
                    if result is True:
                        generated_count += 1
                        self.total_generated += 1
                        
                # 사용자 요청 우선: 최근 요청이 있으면 즉시 루프 종료
                if time.time() - last_user_activity_ts < self.min_user_idle_seconds:
                    logging.info("사용자 요청 감지 - 썸네일 배치 처리 중단")
                    break
                
                # CPU 양보 (사용자 액션 우선)
                await asyncio.sleep(0)
                
                # 진행상황 로그
                if (i + self.batch_size) % 200 == 0:
                    logging.info(f"백그라운드 썸네일 생성 진행: {min(i + self.batch_size, len(missing_thumbnails))}/{len(missing_thumbnails)}")
                    
            elapsed = asyncio.get_event_loop().time() - start_time
            self.last_scan_time = elapsed
            
            if generated_count > 0:
                logging.info(f"백그라운드 썸네일 생성 완료: {generated_count}개 생성 ({elapsed:.1f}초 소요)")
            else:
                logging.info(f"백그라운드 스캔 완료: 새 썸네일 없음 ({elapsed:.1f}초 소요)")
                
        except Exception as e:
            logging.error(f"썸네일 스캔 및 생성 중 오류: {e}")
            
    def _create_thumbnail_safe(self, img_path: Path) -> bool:
        """안전한 썸네일 생성 (오류 처리 포함)"""
        try:
            thumb_path = get_thumbnail_path(img_path)
            
            # 이미 존재하는지 다시 확인 (동시성 대비)
            if thumb_path.exists():
                return False
                
            # 썸네일 디렉터리 생성
            thumb_path.parent.mkdir(parents=True, exist_ok=True)
            
            # 썸네일 생성 (전체 이미지가 보이도록 패딩 적용)
            with Image.open(img_path) as img:
                if img.mode != 'RGB':
                    img = img.convert('RGB')
                
                # 이미지 전체가 보이도록 패딩과 함께 리사이즈
                img_w, img_h = img.size
                target_w, target_h = THUMBNAIL_SIZE
                
                # 비율 계산 (전체 이미지가 들어가도록)
                ratio = min(target_w / img_w, target_h / img_h)
                new_w = int(img_w * ratio)
                new_h = int(img_h * ratio)
                
                # 이미지 리사이즈
                img_resized = img.resize((new_w, new_h), Image.Resampling.BILINEAR)
                
                # 검은 배경에 중앙 정렬로 패딩
                thumbnail = Image.new('RGB', THUMBNAIL_SIZE, (0, 0, 0))
                paste_x = (target_w - new_w) // 2
                paste_y = (target_h - new_h) // 2
                thumbnail.paste(img_resized, (paste_x, paste_y))
                
                # 임시 파일에 먼저 저장하여 오류 확인
                temp_path = thumb_path.with_suffix('.tmp')
                thumbnail.save(temp_path, THUMBNAIL_FORMAT, quality=THUMBNAIL_QUALITY, method=4)
                
                # 파일 크기 확인 (0바이트 방지)
                if temp_path.stat().st_size > 0:
                    # 성공적으로 저장된 경우에만 최종 위치로 이동
                    temp_path.rename(thumb_path)
                    return True
                else:
                    # 0바이트 파일인 경우 삭제
                    temp_path.unlink(missing_ok=True)
                    logging.warning(f"0바이트 썸네일 생성됨: {img_path}")
                    return False
                
            return True
            
        except Exception as e:
            logging.warning(f"백그라운드 썸네일 생성 실패 {img_path}: {e}")
            # 오류 발생 시 임시 파일 정리
            temp_path = get_thumbnail_path(img_path).with_suffix('.tmp')
            temp_path.unlink(missing_ok=True)
            return False
            
    def get_stats(self) -> dict:
        """백그라운드 시스템 통계"""
        return {
            "is_running": self.is_running,
            "scan_interval_seconds": self.scan_interval,
            "total_generated": self.total_generated,
            "scan_count": self.scan_count,
            "last_scan_duration": round(self.last_scan_time, 2),
            "background_workers": self.background_executor._max_workers
        }
    
    def cleanup_corrupted_thumbnails(self) -> int:
        """손상된 썸네일 파일들을 정리합니다"""
        cleaned_count = 0
        try:
            thumb_dir = Path(ROOT_DIR) / "thumbnails"
            if not thumb_dir.exists():
                return 0
                
            for thumb_file in thumb_dir.rglob("*.webp"):
                try:
                    # 0바이트 파일 또는 손상된 파일 확인
                    if thumb_file.stat().st_size == 0:
                        thumb_file.unlink()
                        cleaned_count += 1
                        logging.info(f"손상된 썸네일 삭제: {thumb_file}")
                except Exception as e:
                    logging.warning(f"썸네일 정리 중 오류: {thumb_file} - {e}")
                    
        except Exception as e:
            logging.error(f"썸네일 정리 중 오류: {e}")
            
        return cleaned_count

# 전역 백그라운드 매니저
background_thumbnail_manager = BackgroundThumbnailManager()

# =====================
# FastAPI 및 미들웨어 설정
# =====================
app = FastAPI(title="Wafer Map Viewer API", version="1.0.0")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_credentials=True, allow_methods=["*"], allow_headers=["*"])
app.add_middleware(GZipMiddleware, minimum_size=500)

# 사용자 액티비티 타임스탬프 (요청 우선 처리용)
last_user_activity_ts: float = 0.0

@app.middleware("http")
async def record_user_activity(request, call_next):
    # 사용자 요청 들어올 때마다 최근 액티비티 갱신
    global last_user_activity_ts
    last_user_activity_ts = time.time()
    try:
        response = await call_next(request)
        return response
    finally:
        # 응답 후에도 한 번 더 갱신 (스트리밍/대용량 응답 대비)
        last_user_activity_ts = time.time()

# =====================
# 애플리케이션 생명주기 관리
# =====================
@app.on_event("startup")
async def startup_event():
    """서버 시작 시 백그라운드 썸네일 시스템 시작"""
    logging.info("서버 시작 - 백그라운드 썸네일 시스템 초기화")
    
    # 손상된 썸네일 정리
    cleaned_count = background_thumbnail_manager.cleanup_corrupted_thumbnails()
    if cleaned_count > 0:
        logging.info(f"시작 시 {cleaned_count}개 손상된 썸네일 정리 완료")
    
    # 전역 이미지 인덱스 빌드 (비동기 아님 - 최초 1회)
    build_image_index()

    await background_thumbnail_manager.start()

@app.on_event("shutdown")
async def shutdown_event():
    """서버 종료 시 백그라운드 시스템 정리"""
    logging.info("서버 종료 - 백그라운드 시스템 정지")
    await background_thumbnail_manager.stop()

# =====================
# 워커/캐시 상태 관리
# =====================
thumbnail_executor = ThreadPoolExecutor(max_workers=MAX_WORKERS)
thumbnail_lock = threading.Lock()
worker_stats = {"total_processed": 0, "active_workers": 0, "cache_hits": 0}

# =====================
# Pydantic 모델 정의
# =====================
class ThumbnailPreloadRequest(BaseModel):
    paths: List[str] = Field(..., description="썸네일을 미리 생성할 이미지 경로들")

class ClassRequest(BaseModel):
    name: str = Field(..., description="클래스 이름")

class ClassDeleteRequest(BaseModel):
    names: List[str] = Field(..., description="삭제할 클래스 이름들")

class ClassifyRequest(BaseModel):
    class_name: str = Field(..., description="분류할 클래스 이름")
    image_path: str = Field(..., description="분류할 이미지 경로")

class ClassifyDeleteRequest(BaseModel):
    class_name: str = Field(..., description="클래스 이름")
    image_name: str = Field(..., description="삭제할 이미지 파일명")

class ApiResponse(BaseModel):
    success: bool
    data: Optional[Dict[str, Any]] = None
    error: Optional[str] = None

# =====================
# 썸네일 생성 로직
# =====================
def create_thumbnail(image_path: Path, size=THUMBNAIL_SIZE) -> Optional[Path]:
    """이미지 썸네일을 생성합니다."""
    thumb_path = get_thumbnail_path(image_path, size)
    if thumb_path.exists():
        with thumbnail_lock:
            worker_stats["cache_hits"] += 1
        return thumb_path
    
    try:
        with thumbnail_lock:
            worker_stats["active_workers"] += 1
            worker_stats["total_processed"] += 1
        
        with Image.open(image_path) as img:
            if img.mode != 'RGB':
                img = img.convert('RGB')
            
            # 이미지 전체가 보이도록 패딩과 함께 리사이즈
            img_w, img_h = img.size
            target_w, target_h = size
            
            # 비율 계산 (전체 이미지가 들어가도록)
            ratio = min(target_w / img_w, target_h / img_h)
            new_w = int(img_w * ratio)
            new_h = int(img_h * ratio)
            
            # 이미지 리사이즈
            img_resized = img.resize((new_w, new_h), Image.Resampling.BILINEAR)
            
            # 검은 배경에 중앙 정렬로 패딩
            thumbnail = Image.new('RGB', size, (0, 0, 0))
            paste_x = (target_w - new_w) // 2
            paste_y = (target_h - new_h) // 2
            thumbnail.paste(img_resized, (paste_x, paste_y))
            
            thumbnail.save(thumb_path, THUMBNAIL_FORMAT, quality=THUMBNAIL_QUALITY, method=4)
            return thumb_path
    except Exception as e:
        logging.warning(f"썸네일 생성 실패: {image_path} - {e}")
        return None
    finally:
        with thumbnail_lock:
            worker_stats["active_workers"] -= 1

async def create_thumbnail_async(image_path: Path, size=THUMBNAIL_SIZE) -> Optional[Path]:
    """비동기로 썸네일을 생성합니다."""
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(thumbnail_executor, create_thumbnail, image_path, size)

# =====================
# 썸네일 관련 엔드포인트
# =====================
@app.get("/api/thumbnail")
async def get_thumbnail(path: str, size: int = 512):
    """이미지 썸네일을 반환합니다."""
    try:
        file_path = safe_resolve_path(path)
        if not file_path.is_file():
            return JSONResponse({"success": False, "error": "Image not found"}, status_code=404)
        if not is_supported_image(file_path):
            return JSONResponse({"success": False, "error": "Unsupported image format"}, status_code=400)
        
        thumb_path = await create_thumbnail_async(file_path, (size, size))
        if not thumb_path:
            return JSONResponse({"success": False, "error": "Failed to create thumbnail"}, status_code=500)
        
        headers = {
            "Cache-Control": f"public, max-age={THUMBNAIL_CACHE_SECONDS}",
            "ETag": f'"{get_file_hash(str(thumb_path))}"'
        }
        return FileResponse(str(thumb_path), media_type="image/webp", headers=headers)
    except Exception as e:
        logging.error(f"썸네일 생성 중 오류: {e}")
        return JSONResponse({"success": False, "error": "Internal server error"}, status_code=500)

@app.get("/api/thumbnail/status")
async def get_thumbnail_status(path: str):
    """썸네일 상태를 확인합니다."""
    try:
        file_path = safe_resolve_path(path)
        if not file_path.is_file():
            return JSONResponse({"success": False, "error": "Image not found"}, status_code=404)
        if not is_supported_image(file_path):
            return {"status": "unsupported", "message": "Unsupported image format"}
        
        thumb_path = get_thumbnail_path(file_path)
        if thumb_path.exists():
            return {"status": "cached", "path": str(thumb_path.relative_to(ROOT_DIR))}
        else:
            return {"status": "not_cached", "message": "Thumbnail not generated yet"}
    except Exception as e:
        logging.error(f"썸네일 상태 확인 중 오류: {e}")
        return JSONResponse({"success": False, "error": "Internal server error"}, status_code=500)

@app.post("/api/thumbnail/preload")
async def preload_thumbnails(data: ThumbnailPreloadRequest):
    """여러 썸네일을 미리 생성합니다."""
    try:
        paths = data.paths
        if not paths:
            return JSONResponse({'success': False, 'error': 'No paths provided'}, status_code=400)
        
        tasks = []
        processed = 0
        
        for path in paths:
            try:
                file_path = safe_resolve_path(path)
                if not file_path.is_file():
                    continue
                if not is_supported_image(file_path):
                    continue
                if get_thumbnail_path(file_path).exists():
                    continue
                
                tasks.append(create_thumbnail_async(file_path, THUMBNAIL_SIZE))
                processed += 1
                if processed >= MAX_THUMBNAIL_BATCH:
                    break
            except Exception:
                continue
        
        if tasks:
            results = await asyncio.gather(*tasks, return_exceptions=True)
            return {"success": True, "results": [str(r) for r in results if r]}
        return {"success": True, "results": []}
    except Exception as e:
        logging.error(f"썸네일 미리 생성 중 오류: {e}")
        return JSONResponse({"success": False, "error": "Internal server error"}, status_code=500)

@app.get("/api/thumbnail/stats")
async def get_background_stats():
    """백그라운드 썸네일 시스템 상태를 반환합니다."""
    try:
        stats = background_thumbnail_manager.get_stats()
        stats["main_workers"] = MAX_WORKERS
        return {"success": True, "data": stats}
    except Exception as e:
        logging.error(f"백그라운드 상태 조회 중 오류: {e}")
        return JSONResponse({"success": False, "error": "Internal server error"}, status_code=500)

@app.get("/api/thumbnail/batch")
async def get_thumbnails_batch(paths: str):
    """여러 썸네일 정보를 일괄 반환합니다."""
    try:
        path_list = paths.split(',')
        thumbnails = []
        
        for path in path_list:
            if not path.strip():
                continue
            file_path = safe_resolve_path(path.strip())
            if not file_path.is_file():
                continue
            if not is_supported_image(file_path):
                continue
            
            thumb_path = create_thumbnail(file_path, THUMBNAIL_SIZE)
            if thumb_path:
                rel_thumb = thumb_path.relative_to(ROOT_DIR)
                thumbnails.append({
                    "original_path": path.strip(),
                    "thumbnail_path": str(rel_thumb),
                    "thumbnail_url": f"/api/thumbnail?path={path.strip()}&size=512"
                })
        
        return {"success": True, "thumbnails": thumbnails}
    except Exception as e:
        logging.error(f"썸네일 일괄 처리 중 오류: {e}")
        return JSONResponse({"success": False, "error": "Internal server error"}, status_code=500)

@app.get("/api/worker/stats")
async def get_worker_stats():
    """워커 통계를 반환합니다."""
    try:
        return {
            "total_processed": worker_stats["total_processed"],
            "active_workers": worker_stats["active_workers"],
            "cache_hits": worker_stats["cache_hits"],
            "cache_hit_rate": f"{worker_stats['cache_hits'] / max(worker_stats['total_processed'], 1) * 100:.1f}%",
            "thread_pool_size": MAX_WORKERS
        }
    except Exception as e:
        logging.error(f"워커 통계 조회 중 오류: {e}")
        return JSONResponse({"success": False, "error": "Internal server error"}, status_code=500)

@app.get("/api/background/stats")
async def get_background_stats():
    """백그라운드 썸네일 시스템 통계를 반환합니다."""
    try:
        stats = background_thumbnail_manager.get_stats()
        
        # 현재 대기 중인 이미지 수 계산 (선택적)
        try:
            all_images_count = len([p for p in ROOT_DIR.rglob("*") if p.is_file() and is_supported_image(p)])
            existing_thumbs = len([p for p in THUMBNAIL_DIR.rglob("*") if p.is_file() and p.suffix.lower() == '.webp'])
            stats["total_images"] = all_images_count
            stats["existing_thumbnails"] = existing_thumbs
            stats["pending_thumbnails"] = max(0, all_images_count - existing_thumbs)
        except Exception:
            stats["total_images"] = "계산 중"
            stats["existing_thumbnails"] = "계산 중"
            stats["pending_thumbnails"] = "계산 중"
            
        return {"success": True, "stats": stats}
    except Exception as e:
        logging.error(f"백그라운드 통계 조회 중 오류: {e}")
        return JSONResponse({"success": False, "error": "Internal server error"}, status_code=500)

@app.post("/api/background/trigger")
async def trigger_background_scan():
    """백그라운드 스캔을 즉시 실행합니다."""
    try:
        if not background_thumbnail_manager.is_running:
            return JSONResponse({"success": False, "error": "Background system is not running"}, status_code=400)
            
        # 백그라운드 스캔 트리거
        asyncio.create_task(background_thumbnail_manager._scan_and_generate())
        return {"success": True, "message": "Background scan triggered"}
    except Exception as e:
        logging.error(f"백그라운드 스캔 트리거 중 오류: {e}")
        return JSONResponse({"success": False, "error": "Internal server error"}, status_code=500)

# =====================
# 파일 시스템 관련 엔드포인트
# =====================
@app.get("/api/files")
async def get_files(path: Optional[str] = None):
    """디렉토리 내용을 반환합니다."""
    try:
        target = safe_resolve_path(path)
        if not target.exists() or not target.is_dir():
            return JSONResponse({"success": False, "error": "Not found"}, status_code=404)
        
        items = []
        for entry in sorted(target.iterdir(), key=lambda x: (not x.is_dir(), x.name.lower())):
            if entry.name.startswith('.') or entry.name == '__pycache__':
                continue
            # classification, thumbnails 폴더는 파일 탐색기에서 숨기기
            if entry.name in ['classification', 'thumbnails']:
                continue
            items.append({
                "name": entry.name,
                "type": "directory" if entry.is_dir() else "file"
            })
        
        return {"success": True, "items": items}
    except Exception as e:
        logging.error(f"파일 목록 조회 중 오류: {e}")
        return JSONResponse({"success": False, "error": "Internal server error"}, status_code=500)

@app.get("/api/image")
async def get_image(path: str):
    """이미지 파일을 반환합니다."""
    try:
        file_path = safe_resolve_path(path)
        if not file_path.is_file():
            return JSONResponse({"success": False, "error": "Image not found"}, status_code=404)
        return FileResponse(str(file_path))
    except Exception as e:
        logging.error(f"이미지 반환 중 오류: {e}")
        return JSONResponse({"success": False, "error": "Internal server error"}, status_code=500)

# =====================
# 전역 파일 인덱스/검색 엔드포인트
# =====================
@app.get("/api/files/all")
async def get_all_image_files():
    """루트 이하의 모든 이미지 파일 경로(상대경로, POSIX)를 반환합니다.
    - 'classification', 'thumbnails' 디렉토리는 제외
    - 지원 이미지 확장자만 포함
    """
    try:
        excluded_dirs = {"classification", "thumbnails", "__pycache__"}
        files: List[str] = []
        for p in ROOT_DIR.rglob("*"):
            if not p.is_file():
                continue
            if not is_supported_image(p):
                continue
            # 제외 디렉토리 필터
            rel = p.relative_to(ROOT_DIR)
            parts = set(part.lower() for part in rel.parts[:-1])
            if excluded_dirs & parts:
                continue
            files.append(rel.as_posix())
        return {"success": True, "files": files}
    except Exception as e:
        logging.error(f"전체 파일 인덱스 생성 중 오류: {e}")
        return JSONResponse({"success": False, "error": "Internal server error"}, status_code=500)

@app.get("/api/search")
async def search_files(q: str):
    """서버에서 전역 인덱스를 사용해 빠르게 파일명 검색을 수행합니다.
    - 불리언 연산자는 간단히 지원 (or/and/not, 괄호 없음)
    - 항상 대소문자 무시
    """
    try:
        if not q or not q.strip():
            return {"success": True, "results": []}
        query = q.lower().strip()

        # 간단 파서: or 우선 분리 → 각 토큰에서 and 처리 → not 접두어 처리
        def matches(name: str) -> bool:
            ors = [part.strip() for part in query.split(' or ')] if ' or ' in query else [query]
            for or_term in ors:
                ands = [a.strip() for a in or_term.split(' and ')] if ' and ' in or_term else [or_term]
                and_ok = True
                for term in ands:
                    if term.startswith('not '):
                        t = term[4:].strip()
                        if t and t in name:
                            and_ok = False
                            break
                    else:
                        if term and term not in name:
                            and_ok = False
                            break
                if and_ok:
                    return True
            return False

        # 전역 인덱스가 비어 있으면 재구축
        if not ALL_IMAGE_PATHS:
            build_image_index()

        results: List[str] = []
        qlower = query
        for p in ALL_IMAGE_PATHS:
            name = p.split('/')[-1].lower()
            if matches(name):
                results.append(p)
        return {"success": True, "results": results}
    except Exception as e:
        logging.error(f"서버 검색 오류: {e}")
        return JSONResponse({"success": False, "error": "Internal server error"}, status_code=500)

# =====================
# 분류 관련 엔드포인트
# =====================
@app.get("/api/classes")
def get_classes():
    """모든 클래스를 반환합니다."""
    try:
        base = ROOT_DIR / "classification"
        if not base.exists():
            base.mkdir(parents=True)
        return {"success": True, "classes": [d.name for d in base.iterdir() if d.is_dir()]}
    except Exception as e:
        logging.error(f"클래스 목록 조회 중 오류: {e}")
        return JSONResponse({"success": False, "error": "Internal server error"}, status_code=500)

@app.post("/api/classes")
def add_class(data: ClassRequest):
    """새 클래스를 추가합니다."""
    try:
        name = data.name
        if not name:
            return JSONResponse({'success': False, 'error': 'No class name'}, status_code=400)
        
        base = ROOT_DIR / "classification"
        path = base / name
        path.mkdir(parents=True, exist_ok=True)
        return {'success': True}
    except Exception as e:
        logging.error(f"클래스 추가 중 오류: {e}")
        return JSONResponse({"success": False, "error": "Internal server error"}, status_code=500)

@app.post("/api/classify")
def classify_image(data: ClassifyRequest):
    """이미지를 특정 클래스로 분류합니다."""
    try:
        class_name = data.class_name
        image_path = data.image_path
        if not class_name or not image_path:
            return JSONResponse({'success': False, 'error': 'Missing data'}, status_code=400)
        
        base = ROOT_DIR / "classification"
        class_dir = base / class_name
        class_dir.mkdir(parents=True, exist_ok=True)
        
        src = safe_resolve_path(image_path)
        if not src.exists():
            return JSONResponse({'success': False, 'error': 'Image not found'}, status_code=404)
        
        dst = class_dir / src.name
        shutil.copy2(str(src), str(dst))
        return {'success': True}
    except Exception as e:
        logging.error(f"이미지 분류 중 오류: {e}")
        return JSONResponse({"success": False, "error": "Internal server error"}, status_code=500)

@app.post("/api/classify/delete")
def delete_labeled_image(data: ClassifyDeleteRequest):
    """분류된 이미지를 삭제합니다."""
    try:
        class_name = data.class_name
        image_name = data.image_name
        if not class_name or not image_name:
            return JSONResponse({'success': False, 'error': 'Missing data'}, status_code=400)
        
        base = ROOT_DIR / "classification"
        img_path = base / class_name / image_name
        if not img_path.exists():
            return JSONResponse({'success': False, 'error': 'Image not found'}, status_code=404)
        
        img_path.unlink()
        return {'success': True}
    except Exception as e:
        logging.error(f"분류된 이미지 삭제 중 오류: {e}")
        return JSONResponse({"success": False, "error": "Internal server error"}, status_code=500)

@app.post("/api/classes/delete")
def delete_classes(data: ClassDeleteRequest):
    """클래스들을 삭제합니다."""
    try:
        names = data.names
        if not names or not isinstance(names, list):
            return JSONResponse({'success': False, 'error': 'Missing class names'}, status_code=400)
        
        base = ROOT_DIR / "classification"
        for name in names:
            path = base / name
            if path.exists() and path.is_dir():
                shutil.rmtree(str(path))
        return {'success': True}
    except Exception as e:
        logging.error(f"클래스 삭제 중 오류: {e}")
        return JSONResponse({"success": False, "error": "Internal server error"}, status_code=500)

# =====================
# 정적 파일 서빙
# =====================
@app.get("/", response_class=HTMLResponse)
async def read_root():
    """메인 HTML 페이지를 반환합니다."""
    return FileResponse(str(PROJECT_ROOT / "index.html"))

@app.get("/main.js")
async def get_main_js():
    """메인 JavaScript 파일을 반환합니다."""
    return FileResponse(str(PROJECT_ROOT / "main.js"))

@app.get("/{file_path:path}")
async def serve_static(file_path: str):
    """정적 파일을 서빙합니다."""
    try:
        # 정적 파일은 프로젝트 루트에서, 이미지는 ROOT_DIR에서
        if file_path.endswith(('.html', '.js', '.css', '.ico')) or file_path.startswith('js/'):
            file = PROJECT_ROOT / file_path
        else:
            file = safe_resolve_path(file_path)
            
        if not file.exists():
            return JSONResponse({"success": False, "error": "Not found"}, status_code=404)
        return FileResponse(str(file))
    except Exception as e:
        logging.error(f"정적 파일 서빙 중 오류: {e}")
        return JSONResponse({"success": False, "error": "Internal server error"}, status_code=500)

# =====================
# 서버 실행
# =====================
if __name__ == "__main__":
    import uvicorn
    from config import DEFAULT_HOST, DEFAULT_PORT
    
    logging.basicConfig(
        level=logging.INFO,
        format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
    )
    
    print(f"🚀 Wafer Map Viewer 서버 시작")
    print(f"📁 이미지 루트 디렉토리: {ROOT_DIR}")
    print(f"🌐 서버 주소: http://{DEFAULT_HOST}:{DEFAULT_PORT}")
    print(f"📊 썸네일 디렉토리: {THUMBNAIL_DIR}")
    
    uvicorn.run(
        "main:app",
        host=DEFAULT_HOST,
        port=DEFAULT_PORT,
        reload=False,
        log_level="info"
    )
