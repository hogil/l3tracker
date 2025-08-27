# Changelog

All notable changes to L3Tracker will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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