# L3Tracker - Wafer Map Viewer & Classifier

[![Python](https://img.shields.io/badge/Python-3.8%2B-blue)](https://www.python.org/)
[![FastAPI](https://img.shields.io/badge/FastAPI-0.100%2B-green)](https://fastapi.tiangolo.com/)
[![License](https://img.shields.io/badge/License-MIT-yellow)](LICENSE)

A high-performance web application for viewing, classifying, and managing semiconductor wafer map images with real-time file system monitoring.

## 🚀 Features

### Core Features
- **Real-time File System Monitoring**: Instant reflection of file/folder changes without server restart
- **Multi-mode Image Viewer**: Single image detail view and grid thumbnail view
- **Interactive Pan & Zoom**: Smooth image navigation with minimap support
- **Batch Processing**: Select and process multiple images simultaneously
- **Smart Search**: Advanced search with OR/AND/NOT operators and parentheses support

### Classification System
- **Dynamic Class Management**: Create, delete, and organize classification categories
- **Label Explorer**: Visual organization of classified images
- **Batch Classification**: Apply labels to multiple images at once
- **Real-time Sync**: Automatic synchronization between file system and UI

### Performance Optimizations
- **Intelligent Caching**: LRU cache for directory listings and thumbnails
- **Concurrent Processing**: Multi-threaded thumbnail generation (8-32 threads)
- **Memory Management**: Automatic cleanup of unused resources
- **Progressive Loading**: Lazy loading for large directories

## 📋 Requirements

- Python 3.8+
- FastAPI 0.100+
- Pillow for image processing
- uvicorn for ASGI server
- Wafer map dataset (e.g., wm-811k)

## 🛠️ Quick Start

### 1. Clone Repository
```bash
git clone https://github.com/yourusername/l3tracker.git
cd l3tracker
```

### 2. Install Dependencies
```bash
pip install -r requirements.txt
```

### 3. Configure Dataset Path
Edit `api/config.py`:
```python
ROOT_DIR = Path("D:/project/data/wm-811k")  # Your dataset path
```

### 4. Run Server
```bash
# Standard method
uvicorn api.main:app --host 0.0.0.0 --port 8080 --reload

# Or with module
python -m api.main
```

### 5. Open Browser
Navigate to http://localhost:8080

## 📁 Project Structure

```
l3tracker/
├── api/                    # Backend API
│   ├── main.py            # FastAPI application with real-time updates
│   ├── config.py          # Configuration settings
│   └── __init__.py
├── js/                    # Frontend JavaScript (modularized)
│   ├── main.js           # Core application logic
│   ├── grid.js          # Grid view functionality
│   ├── labels.js        # Label management system
│   ├── search.js        # Advanced search implementation
│   └── utils.js         # Utility functions
├── frontend/             # Optional frontend apps
│   └── app.py           # Streamlit interface
├── index.html           # Main HTML interface
├── requirements.txt     # Python dependencies
├── README.md           # This file
├── ARCHITECTURE.md     # System architecture
├── CHANGELOG.md        # Version history
└── UBUNTU_SETUP.md     # Ubuntu deployment guide
```

## 🎯 Usage Guide

### Image Navigation
- **Single Click**: View image in detail mode
- **Ctrl+Click**: Multi-select images
- **Shift+Click**: Range selection
- **Right Click**: Context menu for batch operations

### Grid Mode Features
- **Auto-switch**: Activates with 2+ selected images
- **Ctrl+Wheel**: Adjust grid columns (1-10)
- **Drag Select**: Box selection for multiple thumbnails
- **Context Menu**: Download, merge, copy operations

### Classification Workflow
1. **Create Classes**: Add classification categories in Class Manager
2. **Select Images**: Choose images to classify
3. **Apply Labels**: Click class button to label selected images
4. **View Results**: Check Label Explorer for organized view
5. **Export Data**: Labels saved in `labels/labels.json`

### Advanced Search
```
# Basic search
wafer

# AND operation
wafer and defect

# OR operation  
good or pass

# NOT operation
not fail

# Complex queries with parentheses
(wafer or chip) and not (fail or defect)
```

## 🔧 Configuration

Edit `api/config.py` for customization:

```python
# Paths
ROOT_DIR = Path("D:/project/data/wm-811k")
THUMBNAIL_DIR = ROOT_DIR / "thumbnails"
LABELS_DIR = ROOT_DIR / "labels"

# Performance
IO_THREADS = 32  # Concurrent I/O operations
THUMBNAIL_SEM = 32  # Simultaneous thumbnail generation
DIRLIST_CACHE_SIZE = 1024  # Directory cache entries

# Image Settings
THUMBNAIL_SIZE_DEFAULT = 512
THUMBNAIL_FORMAT = "WEBP"
THUMBNAIL_QUALITY = 100
SUPPORTED_EXTS = {'.jpg', '.jpeg', '.png', '.bmp', '.tiff', '.tif', '.webp', '.gif'}
```

## 🚀 Performance Tips

1. **Thumbnail Generation**: Pre-generate thumbnails for faster loading
2. **Worker Processes**: Adjust `WORKERS` in config for your CPU
3. **Cache Settings**: Increase cache sizes for larger datasets
4. **Network**: Use `--host 0.0.0.0` for LAN access

## 📊 API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/files` | GET | List directory contents |
| `/api/image` | GET | Serve full-size image |
| `/api/thumbnail` | GET | Generate/serve thumbnail |
| `/api/search` | GET | Search images by filename |
| `/api/classes` | GET/POST/DELETE | Manage classification classes |
| `/api/labels` | GET/POST/DELETE | Manage image labels |
| `/api/classify` | POST | Classify image to class |

## 🐛 Troubleshooting

### Common Issues

1. **Port Already in Use**
   ```bash
   # Change port
   uvicorn api.main:app --port 8081
   ```

2. **Permission Denied**
   ```bash
   # Run with appropriate permissions
   sudo uvicorn api.main:app --host 0.0.0.0 --port 80
   ```

3. **Slow Thumbnail Generation**
   - Increase `IO_THREADS` in config
   - Use SSD for dataset storage
   - Pre-generate thumbnails

## 🤝 Contributing

1. Fork the repository
2. Create feature branch (`git checkout -b feature/amazing-feature`)
3. Commit changes (`git commit -m 'Add amazing feature'`)
4. Push to branch (`git push origin feature/amazing-feature`)
5. Open Pull Request

## 📝 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## 🙏 Acknowledgments

- FastAPI for the excellent web framework
- Pillow for image processing capabilities
- The semiconductor industry for wafer map datasets

## 📞 Support

- **Issues**: [GitHub Issues](https://github.com/yourusername/l3tracker/issues)
- **Discussions**: [GitHub Discussions](https://github.com/yourusername/l3tracker/discussions)
- **Email**: your.email@example.com

---

⭐ Star this project if you find it helpful!