"""
비즈니스 로직 서비스 클래스들
파일 관리, 라벨 관리, 클래스 관리를 분리
"""

import os
import json
import time
import shutil
import asyncio
from pathlib import Path
from typing import List, Dict, Any, Optional, Set, Tuple
from threading import RLock
from concurrent.futures import ThreadPoolExecutor

from .utils import PathUtils, FileUtils, ValidationUtils, Constants
from .cache_manager import cache_manager


class FileService:
    """파일 시스템 관련 서비스"""
    
    def __init__(self, root_dir: Path, supported_extensions: Set[str], skip_dirs: Set[str]):
        self.root_dir = root_dir
        self.supported_extensions = supported_extensions
        self.skip_dirs = skip_dirs
        self.file_index: Dict[str, Dict[str, Any]] = {}
        self.file_index_lock = RLock()
        self.index_ready = False
        self.index_building = False
    
    def list_directory(self, target: Path) -> List[Dict[str, str]]:
        """디렉토리 내용 나열 (캐시 적용)"""
        cache_key = f"dir_list:{target}"
        
        # 캐시 확인
        if cache_manager.should_cache_dir(target):
            cached = cache_manager.dir_cache.get(cache_key)
            if cached is not None:
                return cached
        
        items = []
        try:
            with os.scandir(target) as it:
                for entry in it:
                    name = entry.name
                    if name.startswith('.') or name == '__pycache__':
                        continue
                    if name in self.skip_dirs:
                        continue
                    
                    typ = "directory" if entry.is_dir(follow_symlinks=False) else "file"
                    items.append({"name": name, "type": typ})
            
            # 정렬: 디렉토리 우선, 이름 내림차순
            directories = [x for x in items if x["type"] == "directory"]
            files = [x for x in items if x["type"] == "file"]
            
            directories.sort(key=lambda x: x["name"].lower(), reverse=True)
            files.sort(key=lambda x: x["name"].lower(), reverse=True)
            
            items = directories + files
            
            # 캐시 저장
            if cache_manager.should_cache_dir(target):
                cache_manager.dir_cache.set(cache_key, items)
                
        except (FileNotFoundError, PermissionError):
            items = []
        
        cache_manager.increment_operations()
        return items
    
    def invalidate_directory_cache(self, path: Path) -> None:
        """디렉토리 캐시 무효화"""
        cache_manager.invalidate_path_caches(path)
    
    async def build_file_index(self, executor: ThreadPoolExecutor) -> None:
        """파일 인덱스 구축 (백그라운드)"""
        if self.index_building:
            return
        
        self.index_building = True
        self.index_ready = False
        
        def _build_index():
            start_time = time.time()
            new_index = {}
            
            for root, dirs, files in os.walk(self.root_dir):
                # 스킵 디렉토리 제거
                for skip_dir in list(self.skip_dirs):
                    if skip_dir in dirs:
                        dirs.remove(skip_dir)
                
                for filename in files:
                    ext = os.path.splitext(filename)[1].lower()
                    if ext not in self.supported_extensions:
                        continue
                    
                    full_path = Path(root) / filename
                    try:
                        rel_path = str(full_path.relative_to(self.root_dir)).replace("\\", "/")
                        stat = full_path.stat()
                        
                        new_index[rel_path] = {
                            "name_lower": filename.lower(),
                            "size": stat.st_size,
                            "modified": stat.st_mtime,
                            "hash": FileUtils.get_file_hash(full_path) if stat.st_size < 1024*1024 else ""  # 1MB 이하만 해시 계산
                        }
                    except Exception:
                        continue
                    
                    # 주기적으로 양보
                    if len(new_index) % 1000 == 0:
                        time.sleep(0.001)
            
            # 원자적 업데이트
            with self.file_index_lock:
                self.file_index = new_index
                self.index_ready = True
            
            elapsed = time.time() - start_time
            print(f"파일 인덱스 구축 완료: {len(new_index)}개 파일, {elapsed:.1f}초")
        
        try:
            await asyncio.get_running_loop().run_in_executor(executor, _build_index)
        finally:
            self.index_building = False
    
    def search_files(self, query: str, limit: int = 500, offset: int = 0) -> List[str]:
        """파일 검색"""
        query_lower = query.lower().strip()
        if not query_lower:
            return []
        
        results = []
        goal = offset + limit
        
        # 인덱스에서 검색
        with self.file_index_lock:
            for rel_path, metadata in self.file_index.items():
                if query_lower in metadata["name_lower"]:
                    results.append(rel_path)
                    if len(results) >= goal:
                        break
        
        return results[offset:offset + limit]
    
    def get_file_stats(self) -> Dict[str, Any]:
        """파일 통계"""
        with self.file_index_lock:
            total_files = len(self.file_index)
            total_size = sum(meta["size"] for meta in self.file_index.values())
            
            # 파일 형식별 통계
            extensions = {}
            for meta in self.file_index.values():
                # 파일명에서 확장자 추출
                name = list(self.file_index.keys())[0]  # 임시로 첫 번째 키 사용
                ext = os.path.splitext(name)[1].lower()
                extensions[ext] = extensions.get(ext, 0) + 1
        
        return {
            "total_files": total_files,
            "total_size": total_size,
            "index_ready": self.index_ready,
            "extensions": extensions
        }


class LabelService:
    """라벨 관리 서비스"""
    
    def __init__(self, labels_file: Path):
        self.labels_file = labels_file
        self.labels: Dict[str, List[str]] = {}
        self.labels_lock = RLock()
        self.labels_mtime = 0.0
    
    def load_labels(self) -> None:
        """라벨 파일 로드"""
        if not self.labels_file.exists():
            with self.labels_lock:
                self.labels = {}
            self.labels_mtime = 0.0
            return
        
        try:
            with self.labels_lock:
                with open(self.labels_file, "r", encoding="utf-8") as f:
                    data = json.load(f)
                
                # 데이터 정규화
                normalized = {}
                for key, value in data.items():
                    if isinstance(value, list):
                        normalized[key] = [str(x) for x in value]
                
                self.labels = normalized
            
            try:
                self.labels_mtime = self.labels_file.stat().st_mtime
            except Exception:
                self.labels_mtime = time.time()
                
            print(f"라벨 로드 완료: {len(self.labels)}개 이미지")
            
        except Exception as e:
            print(f"라벨 로드 실패: {e}")
            with self.labels_lock:
                self.labels = {}
    
    def save_labels(self) -> None:
        """라벨 파일 저장"""
        try:
            # 디렉토리 생성
            self.labels_file.parent.mkdir(parents=True, exist_ok=True)
            
            # 임시 파일로 원자적 저장
            temp_file = self.labels_file.with_suffix(".json.tmp")
            
            with self.labels_lock:
                with open(temp_file, "w", encoding="utf-8") as f:
                    json.dump(self.labels, f, ensure_ascii=False, indent=2)
                
                os.replace(temp_file, self.labels_file)
            
            try:
                self.labels_mtime = self.labels_file.stat().st_mtime
            except Exception:
                self.labels_mtime = time.time()
                
        except Exception as e:
            print(f"라벨 저장 실패: {e}")
            raise
    
    def reload_if_stale(self) -> None:
        """다른 프로세스가 파일을 업데이트했으면 다시 로드"""
        try:
            current_mtime = self.labels_file.stat().st_mtime
            if current_mtime > self.labels_mtime:
                self.load_labels()
        except FileNotFoundError:
            pass
    
    def add_labels(self, image_path: str, labels: List[str]) -> List[str]:
        """이미지에 라벨 추가"""
        with self.labels_lock:
            current_labels = set(self.labels.get(image_path, []))
            current_labels.update(label.strip() for label in labels if label.strip())
            
            if current_labels:
                self.labels[image_path] = sorted(current_labels)
            else:
                self.labels.pop(image_path, None)
        
        self.save_labels()
        return self.labels.get(image_path, [])
    
    def remove_labels(self, image_path: str, labels: Optional[List[str]] = None) -> List[str]:
        """이미지에서 라벨 제거"""
        with self.labels_lock:
            if image_path not in self.labels:
                return []
            
            if labels is None:
                # 모든 라벨 제거
                self.labels.pop(image_path, None)
            else:
                # 특정 라벨만 제거
                to_remove = {label.strip() for label in labels if label.strip()}
                current_labels = [label for label in self.labels[image_path] if label not in to_remove]
                
                if current_labels:
                    self.labels[image_path] = current_labels
                else:
                    self.labels.pop(image_path, None)
        
        self.save_labels()
        return self.labels.get(image_path, [])
    
    def get_labels(self, image_path: str) -> List[str]:
        """이미지 라벨 조회"""
        with self.labels_lock:
            return list(self.labels.get(image_path, []))
    
    def remove_label_from_all_images(self, label_name: str) -> int:
        """모든 이미지에서 특정 라벨 제거"""
        removed_count = 0
        
        with self.labels_lock:
            for image_path, labels in list(self.labels.items()):
                if label_name in labels:
                    new_labels = [label for label in labels if label != label_name]
                    if new_labels:
                        self.labels[image_path] = new_labels
                    else:
                        self.labels.pop(image_path, None)
                    removed_count += 1
        
        if removed_count > 0:
            self.save_labels()
        
        return removed_count
    
    def get_label_stats(self) -> Dict[str, Any]:
        """라벨 통계"""
        with self.labels_lock:
            all_labels = set()
            for labels in self.labels.values():
                all_labels.update(labels)
            
            label_counts = {}
            for labels in self.labels.values():
                for label in labels:
                    label_counts[label] = label_counts.get(label, 0) + 1
        
        return {
            "total_images": len(self.labels),
            "unique_labels": len(all_labels),
            "label_distribution": dict(sorted(label_counts.items(), key=lambda x: x[1], reverse=True))
        }


class ClassificationService:
    """분류 관리 서비스"""
    
    def __init__(self, classification_dir: Path, label_service: LabelService):
        self.classification_dir = classification_dir
        self.label_service = label_service
        self.classes_mtime = 0.0
    
    def get_classes(self) -> List[str]:
        """클래스 목록 조회"""
        if not self.classification_dir.exists():
            self.classification_dir.mkdir(parents=True, exist_ok=True)
            return []
        
        classes = []
        try:
            with os.scandir(self.classification_dir) as entries:
                for entry in entries:
                    if entry.is_dir(follow_symlinks=False):
                        classes.append(entry.name)
        except (FileNotFoundError, PermissionError):
            pass
        
        return sorted(classes, key=str.lower)
    
    def create_class(self, class_name: str) -> Dict[str, Any]:
        """클래스 생성"""
        # 유효성 검증
        is_valid, error_msg = ValidationUtils.validate_class_name(class_name)
        if not is_valid:
            raise ValueError(error_msg)
        
        class_dir = self.classification_dir / class_name
        if class_dir.exists():
            raise ValueError("이미 존재하는 클래스입니다")
        
        class_dir.mkdir(parents=True, exist_ok=False)
        
        # 캐시 무효화
        cache_manager.invalidate_path_caches(self.classification_dir)
        cache_manager.clear_all_caches()  # 즉시 반영을 위해 전체 캐시 클리어
        
        return {
            "class": class_name,
            "path": str(class_dir),
            "refresh_required": True
        }
    
    def delete_class(self, class_name: str, force: bool = False) -> Dict[str, Any]:
        """클래스 삭제"""
        is_valid, error_msg = ValidationUtils.validate_class_name(class_name)
        if not is_valid:
            raise ValueError(error_msg)
        
        class_dir = self.classification_dir / class_name
        if not class_dir.exists() or not class_dir.is_dir():
            raise FileNotFoundError("클래스를 찾을 수 없습니다")
        
        if force:
            shutil.rmtree(class_dir)
        else:
            if any(class_dir.iterdir()):
                raise ValueError("클래스 디렉토리가 비어있지 않습니다")
            class_dir.rmdir()
        
        # 라벨에서 클래스 제거
        removed_count = self.label_service.remove_label_from_all_images(class_name)
        
        # 캐시 무효화
        cache_manager.invalidate_path_caches(self.classification_dir)
        cache_manager.clear_all_caches()
        
        return {
            "deleted": class_name,
            "force": force,
            "labels_cleaned": removed_count,
            "refresh_required": True
        }
    
    def delete_multiple_classes(self, class_names: List[str]) -> Dict[str, Any]:
        """여러 클래스 일괄 삭제"""
        deleted = []
        failed = []
        total_cleaned = 0
        
        for class_name in class_names:
            try:
                class_name = class_name.strip()
                is_valid, error_msg = ValidationUtils.validate_class_name(class_name)
                if not is_valid:
                    failed.append({"class": class_name, "error": error_msg})
                    continue
                
                class_dir = self.classification_dir / class_name
                if not class_dir.exists() or not class_dir.is_dir():
                    failed.append({"class": class_name, "error": "클래스를 찾을 수 없습니다"})
                    continue
                
                shutil.rmtree(class_dir)
                deleted.append(class_name)
                
                # 라벨에서 클래스 제거
                total_cleaned += self.label_service.remove_label_from_all_images(class_name)
                
            except Exception as e:
                failed.append({"class": class_name, "error": str(e)})
        
        # 라벨 다시 로드
        if total_cleaned > 0:
            self.label_service.load_labels()
        
        # 캐시 무효화
        cache_manager.invalidate_path_caches(self.classification_dir)
        
        return {
            "deleted": deleted,
            "failed": failed,
            "labels_cleaned": total_cleaned,
            "refresh_required": True
        }
    
    def get_class_images(self, class_name: str, limit: int = 500, offset: int = 0) -> List[str]:
        """클래스 폴더 내 이미지 조회"""
        is_valid, error_msg = ValidationUtils.validate_class_name(class_name)
        if not is_valid:
            raise ValueError(error_msg)
        
        class_dir = self.classification_dir / class_name
        if not class_dir.exists() or not class_dir.is_dir():
            raise FileNotFoundError("클래스를 찾을 수 없습니다")
        
        images = []
        goal = offset + limit
        
        for img_path in class_dir.rglob("*"):
            if img_path.is_file() and FileUtils.is_supported_image(img_path, {'.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.tiff', '.tif'}):
                try:
                    rel_path = str(img_path.relative_to(self.classification_dir.parent)).replace("\\", "/")
                    images.append(rel_path)
                    if len(images) >= goal:
                        break
                except Exception:
                    continue
        
        return images[offset:offset + limit]