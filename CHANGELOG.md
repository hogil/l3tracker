# Changelog

All notable changes to L3Tracker will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.5.0] - 2024-12-28

### ✨ Added
- **폴더 브라우저 시스템**: 이미지 폴더 변경 및 하위폴더 탐색 기능
  - 제품 선택 드롭다운으로 하위폴더 빠른 접근
  - 폴더 선택 모달창 (아이콘 방식, 더블클릭 지원)
  - "위로" 버튼으로 상위폴더 이동 (루트 제한)
  - 루트 폴더로 빠른 이동 기능
- **향상된 UI/UX**:
  - 이미지 크게보기에서 파일명 표시 (경로 포함)
  - 상대경로 표시 (이미지 폴더를 루트로)
  - 미니맵과 줌 컨트롤의 z-index 최적화
  - 그리드 보기 파일명 글자크기 증가 (11px → 13px)
- **폴더 정렬**: 모든 폴더 목록을 내림차순으로 정렬

### 🐛 Fixed
- **폴더 변경 후 우클릭 메뉴 문제**: 하위폴더 이동 후 다운로드/클립보드 복사 작동 안 되는 문제 해결
- **이미지 위치 조정**: 크게보기에서 이미지가 파일명 패널과 겹치지 않도록 위치 최적화
- **폴더 브라우저 경로 표시**: 절대경로 대신 상대경로로 깔끔하게 표시
- **서버 시작 오류**: IndentationError 수정으로 안정적인 서버 실행

### 🔄 Changed
- **이미지 스케일링**: 초기 이미지 크기를 0.96배로 조정하여 최적 표시
- **이미지 위치**: 파일명 패널 높이의 0.4배만큼 아래로 이동하여 균형 잡힌 레이아웃
- **폴더 변경 로직**: 폴더 이동 시 선택 상태 완전 초기화로 일관성 유지
- **UI 텍스트**: "하위 폴더 선택" → "제품 선택"으로 변경
- **동적 텍스트 업데이트**: 제품 선택 시 드롭다운 텍스트가 선택된 폴더명으로 변경

### 🔧 Technical
- 폴더 브라우저 상태 추적을 위한 `currentBrowserPath` 변수 도입
- `/api/browse-folders` 엔드포인트에서 내림차순 정렬 보장
- 폴더 변경 시 `selectedImages`, `gridSelectedIdxs`, `selectedImagePath` 초기화
- CSS 변수 활용한 동적 레이아웃 조정 (`--filename-bar-height`)
- 상대경로 계산 로직으로 사용자 친화적 경로 표시

## [2.4.0] - 2024-12-27

### ✨ Added
- Real-time file system monitoring without server restart
- Intelligent directory caching with automatic invalidation
- Advanced search with OR/AND/NOT operators and parentheses support
- Drag selection in grid mode for multiple thumbnails
- Batch operations context menu (download, merge, copy)
- Clipboard operations for image and file lists
- Label Explorer with visual classification organization
- Keyboard shortcuts (Escape, Ctrl+A) in grid mode
- Memory optimization with automatic cleanup
- Toast notifications for user feedback

### 🐛 Fixed
- Class deletion now immediately reflects in file system
- Label files properly sync after class removal
- New folders in images directory appear without restart
- Grid mode thumbnail loading performance improved
- Memory leaks from blob URLs properly cleaned
- File system cache invalidation for dynamic paths

### 🔄 Changed
- Caching strategy: classification/images/labels paths no longer cached
- Improved thumbnail manager with concurrent loading limits
- Better error handling for file operations
- Enhanced UI responsiveness during heavy operations
- Optimized grid rendering for large image sets

### 🔧 Technical
- Migrated from single file to modular architecture
- Implemented LRU cache with TTL for thumbnails
- Added thread pool executor for I/O operations
- Introduced semaphore for thumbnail generation control
- Cache invalidation cascade for related paths

## [2.3.0] - 2024-12-20

### Added
- Multi-threaded thumbnail generation
- Worker process configuration
- Batch classification support
- File system event handlers

### Fixed
- Memory management issues
- Thumbnail generation bottlenecks

## [2.2.0] - 2024-12-15

### Added
- Grid view with adjustable columns
- Minimap navigation
- Pan and zoom controls
- Search functionality

### Changed
- Improved UI responsiveness
- Better error handling

## [2.1.0] - 2024-12-10

### Added
- Label Explorer interface
- Class management system
- JSON export for labels

### Fixed
- File selection bugs
- UI scaling issues

## [2.0.0] - 2024-12-05

### Added
- Complete FastAPI backend rewrite
- Real-time updates
- Concurrent processing

### Changed
- Migrated from Flask to FastAPI
- New modular architecture

### Removed
- Legacy synchronous endpoints

## [1.5.0] - 2024-11-30

### Added
- Basic classification features
- Image thumbnails
- Folder navigation

## [1.0.0] - 2024-11-20

### Added
- Initial release
- Basic image viewer
- File explorer
- Simple labeling

---

## Upgrade Notes

### From 2.4.x to 2.5.0
- No breaking changes
- 새로운 폴더 브라우저 기능 추가로 더 편리한 네비게이션 가능
- Clear browser cache for best performance
- 기존 선택 상태는 폴더 변경 시 자동으로 초기화됨

### From 2.3.x to 2.4.0
- No breaking changes
- Clear browser cache for best performance
- Optional: Delete old thumbnail cache

### From 2.2.x to 2.3.0
- Update config.py with new worker settings
- Restart server after update

### From 1.x to 2.x
- Complete reinstall recommended
- Backup labels.json before upgrade
- New config format required