import hashlib
from pathlib import Path
from functools import lru_cache
from fastapi import HTTPException
from .config import ROOT_DIR, SUPPORTED_EXTS, THUMBNAIL_DIR, THUMBNAIL_FORMAT
from typing import Optional

@lru_cache(maxsize=1000)
def get_file_hash(file_path: str) -> str:
    return hashlib.md5(file_path.encode()).hexdigest()

def is_supported_image(path: Path) -> bool:
    return path.suffix.lower() in SUPPORTED_EXTS

def get_thumbnail_path(image_path: Path, size=(512, 512)) -> Path:
    file_hash = get_file_hash(str(image_path))
    return THUMBNAIL_DIR / f"{file_hash}_{size[0]}x{size[1]}.{THUMBNAIL_FORMAT.lower()}"

def safe_resolve_path(path: Optional[str]) -> Path:
    if path is None:
        return ROOT_DIR
    file_path = (ROOT_DIR / path).resolve()
    if not str(file_path).startswith(str(ROOT_DIR)):
        raise HTTPException(status_code=403, detail="Access denied")
    return file_path