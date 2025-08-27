# L3Tracker Architecture

## System Overview

L3Tracker is a high-performance web application built with a modern, scalable architecture designed for real-time image management and classification.

```
┌──────────────────────────────────────────────────────┐
│                   Web Browser                        │
│  ┌──────────────────────────────────────────────┐  │
│  │            HTML/CSS/JavaScript               │  │
│  │  ┌─────────┐ ┌─────────┐ ┌─────────────┐   │  │
│  │  │ main.js │ │ grid.js │ │ labels.js   │   │  │
│  │  └─────────┘ └─────────┘ └─────────────┘   │  │
│  └──────────────────────────────────────────────┘  │
└────────────────────┬────────────────────────────────┘
                     │ HTTP/WebSocket
┌────────────────────┴────────────────────────────────┐
│                 FastAPI Backend                      │
│  ┌──────────────────────────────────────────────┐  │
│  │              API Endpoints                    │  │
│  │  ┌──────────┐ ┌──────────┐ ┌────────────┐  │  │
│  │  │  Files   │ │  Images  │ │   Labels   │  │  │
│  │  └──────────┘ └──────────┘ └────────────┘  │  │
│  ├──────────────────────────────────────────────┤  │
│  │            Caching Layer                      │  │
│  │  ┌──────────┐ ┌──────────┐ ┌────────────┐  │  │
│  │  │   LRU    │ │   TTL    │ │  DirList   │  │  │
│  │  └──────────┘ └──────────┘ └────────────┘  │  │
│  ├──────────────────────────────────────────────┤  │
│  │         Concurrent Processing                 │  │
│  │  ┌──────────┐ ┌──────────┐ ┌────────────┐  │  │
│  │  │ThreadPool│ │Semaphore │ │  Workers   │  │  │
│  │  └──────────┘ └──────────┘ └────────────┘  │  │
│  └──────────────────────────────────────────────┘  │
└────────────────────┬────────────────────────────────┘
                     │ File System
┌────────────────────┴────────────────────────────────┐
│                  Data Storage                        │
│  ┌──────────────────────────────────────────────┐  │
│  │  Images  │  Thumbnails  │  Labels  │ Classes │  │
│  └──────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────┘
```

## Core Components

### 1. Frontend Layer

#### main.js - Core Application
- **WaferMapViewer Class**: Central controller managing all UI interactions
- **State Management**: Maintains application state for selections, modes, and transforms
- **Event Handling**: Coordinates mouse, keyboard, and touch events
- **DOM Caching**: Optimizes performance by caching DOM element references

#### grid.js - Grid View System
- **Dynamic Grid Layout**: Adjustable columns (1-10) with real-time updates
- **Thumbnail Manager**: Intelligent caching and lazy loading
- **Drag Selection**: Box selection with scroll-aware coordinates
- **Batch Operations**: Context menu for multiple image operations

#### labels.js - Classification Interface
- **Label Explorer**: Hierarchical view of classified images
- **Class Manager**: CRUD operations for classification categories
- **Real-time Sync**: Automatic updates when file system changes

### 2. Backend Layer

#### FastAPI Application (main.py)
```python
# Core Features
- Async request handling with uvicorn
- Middleware for CORS and compression
- User activity prioritization
- Background task management
```

#### Caching System
```python
# Three-tier caching
1. LRU Cache: Directory listings (1024 entries)
2. TTL Cache: Thumbnail stats (8192 entries, 5s TTL)
3. Memory Cache: File index for search
```

#### Concurrent Processing
```python
# Resource Management
- ThreadPoolExecutor: IO_THREADS (8-32)
- Semaphore: THUMBNAIL_SEM (32 concurrent)
- Workers: Multi-process (75% CPU cores)
```

### 3. Data Layer

#### File System Structure
```
ROOT_DIR/
├── images/           # Original images
├── thumbnails/       # Generated thumbnails
├── labels/          
│   └── labels.json  # Label database
└── classification/   # Organized by classes
    ├── class1/
    ├── class2/
    └── ...
```

#### Label Database Schema
```json
{
  "path/to/image.jpg": ["class1", "class2"],
  "path/to/another.png": ["class3"]
}
```

## Key Design Patterns

### 1. Observer Pattern
- File system monitoring with instant UI updates
- Event-driven architecture for user interactions

### 2. Strategy Pattern
- Different caching strategies for different path types
- Pluggable thumbnail generation backends

### 3. Factory Pattern
- Dynamic creation of UI components
- Thumbnail generation with format selection

### 4. Singleton Pattern
- Single instance of WaferMapViewer
- Global thumbnail manager

## Performance Optimizations

### 1. Intelligent Caching
```python
# Path-specific caching
if 'classification' in path or 'images' in path:
    skip_cache = True  # Real-time updates
else:
    use_lru_cache = True  # Performance
```

### 2. Progressive Loading
- Lazy directory expansion
- Viewport-based thumbnail loading
- Chunked search results

### 3. Memory Management
- Automatic blob URL cleanup
- Periodic cache trimming
- Request cancellation on navigation

### 4. Network Optimization
- HTTP caching headers (ETag, Cache-Control)
- Gzip compression
- Concurrent request limits

## Security Considerations

### 1. Path Traversal Prevention
```python
def safe_resolve_path(path):
    target = (ROOT_DIR / path).resolve()
    if not str(target).startswith(str(ROOT_DIR)):
        raise HTTPException(400, "Invalid path")
```

### 2. Input Validation
- Regex validation for class names
- File extension whitelisting
- Size limits for uploads

### 3. Rate Limiting
- Thumbnail generation semaphore
- Concurrent request limits
- Memory usage monitoring

## Scalability Features

### 1. Horizontal Scaling
- Stateless API design
- File-based data storage
- Multi-worker support

### 2. Vertical Scaling
- Configurable thread pools
- Adjustable cache sizes
- Dynamic worker allocation

### 3. Load Balancing
- User activity prioritization
- Background task scheduling
- Request queuing

## Monitoring & Debugging

### 1. Logging
```python
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s'
)
```

### 2. Performance Metrics
- Cache hit rates
- Thumbnail generation time
- Request latency

### 3. Error Handling
- Graceful degradation
- Detailed error messages
- Automatic recovery

## Future Enhancements

### Planned Features
1. **WebSocket Support**: Real-time collaboration
2. **Database Backend**: PostgreSQL for large datasets
3. **Machine Learning**: Auto-classification with CNNs
4. **Cloud Storage**: S3/Azure blob integration
5. **Advanced Analytics**: Defect pattern analysis

### Architecture Evolution
1. **Microservices**: Separate thumbnail service
2. **Message Queue**: Redis for job processing
3. **CDN Integration**: CloudFlare for static assets
4. **Container Orchestration**: Kubernetes deployment

## Development Workflow

### Local Development
```bash
# Install dependencies
pip install -r requirements.txt

# Run with auto-reload
uvicorn api.main:app --reload --host 0.0.0.0 --port 8080
```

### Testing
```bash
# Unit tests
pytest tests/

# Integration tests
pytest tests/integration/

# Load testing
locust -f tests/load/locustfile.py
```

### Deployment
```bash
# Production build
docker build -t l3tracker .

# Run container
docker run -p 8080:8080 -v /data:/data l3tracker
```

## Dependencies

### Python Packages
- **FastAPI**: Web framework
- **Pillow**: Image processing
- **uvicorn**: ASGI server
- **watchdog**: File monitoring

### JavaScript Libraries
- **No external dependencies**: Pure vanilla JS
- **Future considerations**: React/Vue for complex UIs

## API Design Principles

### RESTful Conventions
- GET for queries
- POST for creation
- DELETE for removal
- Consistent URL patterns

### Response Format
```json
{
  "success": true,
  "data": {},
  "error": null,
  "timestamp": "2024-12-27T10:00:00Z"
}
```

### Error Handling
```json
{
  "success": false,
  "data": null,
  "error": "Detailed error message",
  "code": 400
}
```

---

This architecture is designed for maintainability, scalability, and performance, providing a solid foundation for semiconductor wafer map analysis and classification tasks.