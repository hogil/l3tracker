"""
🚀 L3Tracker - Wafer Map Viewer API
사용자 요청 최우선 처리 시스템
"""

import os
import logging
from pathlib import Path
from typing import List, Optional, Dict, Any
from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import JSONResponse, FileResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import uvicorn
from PIL import Image
import io
import asyncio
from concurrent.futures import ThreadPoolExecutor
import time

# 로깅 설정
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

# 설정
ROOT_DIR = Path("D:/project/data/wm-811k")
THUMBNAIL_DIR = ROOT_DIR / "thumbnails"
THUMBNAIL_SIZE = (512, 512)
THUMBNAIL_QUALITY = 100
SUPPORTED_EXTENSIONS = {'.png', '.jpg', '.jpeg', '.bmp', '.tiff', '.tif'}

# 전역 변수 (사용자 요청 우선)
USER_ACTIVITY_FLAG = False
BACKGROUND_TASKS_PAUSED = False
FILE_CACHE = {}
THUMBNAIL_CACHE = {}

# FastAPI 앱
app = FastAPI(title="L3Tracker API", version="1.0.0")

# CORS 설정
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# 정적 파일 서빙은 API 엔드포인트 뒤에 배치

# 유틸리티 함수들
def is_supported_image(file_path: Path) -> bool:
    """지원되는 이미지 파일인지 확인"""
    return file_path.suffix.lower() in SUPPORTED_EXTENSIONS

def get_thumbnail_path(image_path: Path, size: tuple = THUMBNAIL_SIZE) -> Path:
    """썸네일 파일 경로 생성"""
    relative_path = image_path.relative_to(ROOT_DIR)
    thumbnail_name = f"{relative_path.stem}_{size[0]}x{size[1]}.webp"
    return THUMBNAIL_DIR / relative_path.parent / thumbnail_name

def safe_resolve_path(path: Optional[str] = None) -> Path:
    """안전한 경로 해석"""
    if not path:
        return ROOT_DIR
    
    try:
        target = ROOT_DIR / path
        resolved = target.resolve()
        
        # 보안 검사: ROOT_DIR 밖으로 나가지 않도록
        if not str(resolved).startswith(str(ROOT_DIR.resolve())):
            raise HTTPException(status_code=400, detail="Invalid path")
        
        return resolved
    except Exception as e:
        logger.error(f"경로 해석 실패: {path}, 오류: {e}")
        raise HTTPException(status_code=400, detail="Invalid path")

# 사용자 활동 감지 및 백그라운드 작업 제어
def set_user_activity():
    """사용자 활동 감지 - 백그라운드 작업 일시 중지"""
    global USER_ACTIVITY_FLAG, BACKGROUND_TASKS_PAUSED
    USER_ACTIVITY_FLAG = True
    BACKGROUND_TASKS_PAUSED = True
    logger.info("사용자 활동 감지 - 백그라운드 작업 일시 중지")

def clear_user_activity():
    """사용자 활동 플래그 초기화"""
    global USER_ACTIVITY_FLAG
    USER_ACTIVITY_FLAG = False

def can_run_background_task() -> bool:
    """백그라운드 작업 실행 가능 여부"""
    return not BACKGROUND_TASKS_PAUSED and not USER_ACTIVITY_FLAG

# 사용자 요청 우선 처리 미들웨어
@app.middleware("http")
async def user_priority_middleware(request, call_next):
    """사용자 요청 우선 처리 미들웨어"""
    set_user_activity()
    
    # 사용자 요청 즉시 처리
    response = await call_next(request)
    
    # 응답 후 백그라운드 작업 재개 준비
    asyncio.create_task(delayed_background_resume())
    
    return response

async def delayed_background_resume():
    """지연된 백그라운드 작업 재개"""
    await asyncio.sleep(2.0)  # 2초 후 백그라운드 작업 재개
    global BACKGROUND_TASKS_PAUSED
    BACKGROUND_TASKS_PAUSED = False
    logger.info("백그라운드 작업 재개 준비 완료")

# API 엔드포인트들
@app.get("/api/files")
async def get_files(path: Optional[str] = None):
    """📁 폴더 내용 조회 - 사용자 우선 처리"""
    try:
        # 사용자 활동 플래그 설정
        set_user_activity()
        
        target = safe_resolve_path(path)
        if not target.exists() or not target.is_dir():
            return JSONResponse({"success": False, "error": "Not found"}, status_code=404)
        
        # 즉시 응답을 위한 빠른 파일 목록 생성
        items = []
        for entry in target.iterdir():
            if entry.name.startswith('.') or entry.name == '__pycache__':
                continue
            if entry.name in ['classification', 'thumbnails']:
                continue
            
            items.append({
                "name": entry.name,
                "type": "directory" if entry.is_dir() else "file"
            })
        
        # 빠른 정렬 (사용자 응답 우선)
        try:
            items.sort(key=lambda x: (not x["type"] == "directory", x["name"].lower()))
        except:
            pass  # 정렬 실패해도 응답은 보냄
        
        logger.info(f"폴더 내용 조회 완료: {path or 'root'} ({len(items)}개 항목)")
        return {"success": True, "items": items}
        
    except Exception as e:
        logger.error(f"폴더 조회 실패: {e}")
        return JSONResponse({"success": False, "error": str(e)}, status_code=500)

@app.get("/api/image")
async def get_image(path: str):
    """🖼️ 이미지 파일 제공 - 사용자 우선 처리"""
    try:
        set_user_activity()
        
        image_path = safe_resolve_path(path)
        if not image_path.exists() or not image_path.is_file():
            raise HTTPException(status_code=404, detail="Image not found")
        
        if not is_supported_image(image_path):
            raise HTTPException(status_code=400, detail="Unsupported image format")
        
        logger.info(f"이미지 제공: {path}")
        return FileResponse(image_path)
        
    except Exception as e:
        logger.error(f"이미지 제공 실패: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/api/thumbnail")
async def get_thumbnail(path: str, size: int = 512):
    """🖼️ 썸네일 제공 - 사용자 우선 처리"""
    try:
        set_user_activity()
        
        image_path = safe_resolve_path(path)
        if not image_path.exists():
            raise HTTPException(status_code=404, detail="Image not found")
        
        thumbnail_size = (size, size)
        thumbnail_path = get_thumbnail_path(image_path, thumbnail_size)
        
        # 썸네일이 있으면 즉시 제공
        if thumbnail_path.exists() and thumbnail_path.stat().st_size > 0:
            logger.info(f"기존 썸네일 제공: {path}")
            return FileResponse(thumbnail_path)
        
        # 썸네일이 없으면 즉시 생성 (사용자 응답 우선)
        try:
            with Image.open(image_path) as img:
                img.thumbnail(thumbnail_size, Image.Resampling.LANCZOS)
                
                # WebP로 저장
                thumbnail_path.parent.mkdir(parents=True, exist_ok=True)
                img.save(thumbnail_path, "WEBP", quality=THUMBNAIL_QUALITY, optimize=True)
                
                logger.info(f"썸네일 즉시 생성 완료: {path}")
                return FileResponse(thumbnail_path)
                
        except Exception as e:
            logger.error(f"썸네일 생성 실패: {e}")
            # 썸네일 생성 실패 시 원본 이미지 제공
            return FileResponse(image_path)
            
    except Exception as e:
        logger.error(f"썸네일 제공 실패: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/api/classes")
async def get_classes():
    """🏷️ 분류 클래스 목록 - 사용자 우선 처리"""
    try:
        set_user_activity()
        
        classification_dir = ROOT_DIR / "classification"
        if not classification_dir.exists():
            return {"success": True, "classes": []}
        
        classes = []
        for item in classification_dir.iterdir():
            if item.is_dir():
                classes.append(item.name)
        
        classes.sort()
        logger.info(f"분류 클래스 목록 조회: {len(classes)}개")
        return {"success": True, "classes": classes}
        
    except Exception as e:
        logger.error(f"분류 클래스 조회 실패: {e}")
        return JSONResponse({"success": False, "error": str(e)}, status_code=500)

@app.get("/api/search")
async def search_files(q: str = Query(..., description="검색 쿼리")):
    """🔍 파일 검색 - 사용자 우선 처리"""
    try:
        set_user_activity()
        
        if not q.strip():
            return {"success": True, "results": []}
        
        query = q.lower().strip()
        results = []
        
        # 빠른 검색 (사용자 응답 우선)
        try:
            for img_path in ROOT_DIR.rglob("*"):
                if not img_path.is_file() or not is_supported_image(img_path):
                    continue
                
                # classification, thumbnails 폴더 제외
                if "classification" in img_path.parts or "thumbnails" in img_path.parts:
                    continue
                
                # 파일명에 검색어 포함 여부 확인
                if query in img_path.name.lower():
                    rel_path = str(img_path.relative_to(ROOT_DIR))
                    results.append(f"/{rel_path}")
                
                # 사용자 활동 감지 시 검색 중단
                if USER_ACTIVITY_FLAG:
                    logger.info("사용자 활동 감지 - 검색 중단")
                    break
                    
        except Exception as e:
            logger.error(f"검색 중 오류: {e}")
        
        logger.info(f"검색 완료: '{q}' -> {len(results)}개 결과")
        return {"success": True, "results": results}
        
    except Exception as e:
        logger.error(f"검색 실패: {e}")
        return JSONResponse({"success": False, "error": str(e)}, status_code=500)

@app.get("/api/files/all")
async def get_all_files():
    """📋 전체 파일 목록 - 사용자 우선 처리"""
    try:
        set_user_activity()
        
        # 캐시된 결과가 있으면 즉시 반환
        if FILE_CACHE:
            logger.info("캐시된 전체 파일 목록 제공")
            return {"success": True, "files": list(FILE_CACHE.keys())}
        
        # 백그라운드에서 전체 파일 목록 구축 (사용자 응답 지연 없음)
        asyncio.create_task(build_file_index_background())
        
        # 즉시 빈 결과 반환 (사용자 응답 우선)
        logger.info("전체 파일 목록 백그라운드 구축 시작")
        return {"success": True, "files": []}
        
    except Exception as e:
        logger.error(f"전체 파일 목록 조회 실패: {e}")
        return JSONResponse({"success": False, "error": str(e)}, status_code=500)

async def build_file_index_background():
    """백그라운드에서 전체 파일 인덱스 구축"""
    global FILE_CACHE
    
    try:
        # 사용자 활동이 없을 때만 실행
        if not can_run_background_task():
            logger.info("사용자 활동 감지 - 백그라운드 인덱스 구축 연기")
            return
        
        logger.info("백그라운드 전체 파일 인덱스 구축 시작")
        
        for img_path in ROOT_DIR.rglob("*"):
            if not img_path.is_file() or not is_supported_image(img_path):
                continue
            
            if "classification" in img_path.parts or "thumbnails" in img_path.parts:
                continue
            
            rel_path = str(img_path.relative_to(ROOT_DIR))
            FILE_CACHE[rel_path] = {
                "size": img_path.stat().st_size,
                "modified": img_path.stat().st_mtime
            }
            
            # 사용자 활동 감지 시 즉시 중단
            if USER_ACTIVITY_FLAG:
                logger.info("사용자 활동 감지 - 백그라운드 인덱스 구축 중단")
                break
            
            # CPU 양보
            await asyncio.sleep(0.01)
        
        logger.info(f"백그라운드 인덱스 구축 완료: {len(FILE_CACHE)}개 파일")
        
    except Exception as e:
        logger.error(f"백그라운드 인덱스 구축 실패: {e}")

# 정적 파일 서빙 (API 엔드포인트 뒤에 배치)
app.mount("/", StaticFiles(directory="..", html=True), name="static")

# 서버 시작/종료 이벤트
@app.on_event("startup")
async def startup_event():
    """🚀 서버 시작 - 사용자 우선 처리 시스템 초기화"""
    logger.info("🚀 L3Tracker 서버 시작 - 사용자 우선 처리 시스템")
    logger.info(f"📁 이미지 루트: {ROOT_DIR}")
    logger.info(f"🌐 서버 주소: http://0.0.0.0:8080")
    logger.info(f"📊 썸네일 디렉토리: {THUMBNAIL_DIR}")
    logger.info("⚡ 사용자 요청 최우선 처리 시스템 활성화")

@app.on_event("shutdown")
async def shutdown_event():
    """🛑 서버 종료"""
    logger.info("🛑 L3Tracker 서버 종료")

# 메인 실행
if __name__ == "__main__":
    print("=" * 60)
    print("🚀 L3Tracker - 사용자 우선 처리 시스템")
    print("=" * 60)
    print(f"📁 이미지 루트: {ROOT_DIR}")
    print(f"🌐 서버 주소: http://0.0.0.0:8080")
    print(f"📊 썸네일 크기: {THUMBNAIL_SIZE[0]}x{THUMBNAIL_SIZE[1]}")
    print(f"🎨 썸네일 품질: {THUMBNAIL_QUALITY}%")
    print("=" * 60)
    print("⚡ 핵심 기능:")
    print("  - 사용자 요청 최우선 처리 ✅")
    print("  - 폴더 열기 즉시 응답 ✅")
    print("  - 백그라운드 작업 자동 일시 중지 ✅")
    print("  - 안정적인 서버 운영 ✅")
    print("=" * 60)
    
    uvicorn.run(
        "api.main:app",
        host="0.0.0.0",
        port=8080,
        reload=False,
        workers=1,  # 단일 워커로 안정성 확보
        log_level="info"
    )
