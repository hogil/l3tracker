/**
 * WaferMapViewer
 * 
 * A class to manage the wafer map viewer application.
 * This includes:
 * - Lazy-loading file explorer
 * - Image panning and zooming
 * - A responsive minimap
 * - Sidebar resizing
 */

// Constants
const DEFAULT_GRID_COLS = 3;
const DEFAULT_THUMB_SIZE = 128;
const MIN_SIDEBAR_WIDTH = 200;
const MAX_SIDEBAR_WIDTH_RATIO = 0.5;
const MIN_DRAG_DISTANCE = 5;
const ZOOM_FACTOR = 1.2;
const THUMB_BATCH_SIZE = 20;
const DEBOUNCE_DELAY = 0;

/**
 * Thumbnail Manager
 * 썸네일 로딩과 캐싱을 관리하는 클래스
 */
class ThumbnailManager {
    constructor() {
        this.cache = new Map(); // path -> { url, loading, timestamp }
        this.maxCacheSize = 500;
        this.cacheTimeout = 10 * 60 * 1000; // 10분
        this.concurrentLoads = 0;
        this.maxConcurrentLoads = 8;
        this.loadQueue = [];
    }

    async loadThumbnail(imgPath) {
        const cached = this.cache.get(imgPath);
        
        // 유효한 캐시가 있으면 반환
        if (cached?.url && (Date.now() - cached.timestamp) < this.cacheTimeout) {
            return cached.url;
        }
        
        // 로딩 중이면 대기
        if (cached?.loading) {
            return cached.loading;
        }
        
        // 새로운 로딩 시작
        const loadingPromise = this.fetchThumbnail(imgPath);
        this.cache.set(imgPath, { 
            loading: loadingPromise, 
            timestamp: Date.now() 
        });
        
        try {
            const url = await loadingPromise;
            this.cache.set(imgPath, { 
                url, 
                timestamp: Date.now() 
            });
            this.trimCache();
            return url;
        } catch (error) {
            this.cache.delete(imgPath);
            // console.warn(`썸네일 로드 실패: ${imgPath}`, error);
            return null;
        }
    }

    async fetchThumbnail(imgPath) {
        // 동시 로딩 수 제한
        if (this.concurrentLoads >= this.maxConcurrentLoads) {
            await new Promise(resolve => this.loadQueue.push(resolve));
        }
        
        this.concurrentLoads++;
        
        try {
            const response = await fetch(`/api/thumbnail?path=${encodeURIComponent(imgPath)}&size=128`);
            if (response.ok) {
                const blob = await response.blob();
                return URL.createObjectURL(blob);
            }
            throw new Error(`HTTP ${response.status}`);
        } finally {
            this.concurrentLoads--;
            // 대기 중인 요청 처리
            if (this.loadQueue.length > 0) {
                const resolve = this.loadQueue.shift();
                resolve();
            }
        }
    }

    async preloadBatch(imagePaths) {
        // 이미 캐시된 것 제외
        const uncachedPaths = imagePaths.filter(path => {
            const cached = this.cache.get(path);
            return !cached || (!cached.url && !cached.loading);
        });
        
        if (uncachedPaths.length === 0) return;
        
        // 배치 크기 제한
        const batchSize = Math.min(uncachedPaths.length, THUMB_BATCH_SIZE || 50);
        const batch = uncachedPaths.slice(0, batchSize);
        
        // 서버 배치 프리로드 시도
        try {
            const response = await fetch('/api/thumbnail/preload', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ paths: batch })
            });
            
            if (response.ok) {
                const result = await response.json();
                if (batch.length > 20) { // 대량 처리시만 로그
                    console.log(`썸네일 생성: ${result.results?.length || batch.length}개`);
                }
                return result;
            }
        } catch (error) {
            console.warn('썸네일 배치 로드 실패, 개별 로딩으로 전환:', error);
        }
        
        // 서버 배치 실패 시 개별 로딩
        const promises = batch.map(path => this.loadThumbnail(path));
        return Promise.allSettled(promises);
    }

    trimCache() {
        if (this.cache.size <= this.maxCacheSize) return;
        
        // 현재 DOM에서 사용 중인 썸네일 URL 수집
        const activeUrls = new Set();
        const images = document.querySelectorAll('.grid-thumb-img');
        images.forEach(img => {
            if (img.src && img.src.startsWith('blob:')) {
                activeUrls.add(img.src);
            }
            if (img.dataset.thumbnailUrl) {
                activeUrls.add(img.dataset.thumbnailUrl);
            }
        });
        
        const entries = Array.from(this.cache.entries())
            .filter(([_, data]) => data.url && !activeUrls.has(data.url)) // 사용 중이 아닌 URL만
            .sort((a, b) => a[1].timestamp - b[1].timestamp);
        
        const deleteCount = Math.max(0, this.cache.size - this.maxCacheSize);
        const toDelete = entries.slice(0, deleteCount);
        
        toDelete.forEach(([path, data]) => {
            if (data.url) URL.revokeObjectURL(data.url);
            this.cache.delete(path);
        });
    }

    clearCache() {
        this.cache.forEach(data => {
            if (data.url) URL.revokeObjectURL(data.url);
        });
        this.cache.clear();
        this.loadQueue.length = 0;
        this.concurrentLoads = 0;
    }

    // 사용하지 않는 캐시 정리 (메모리 최적화)
    cleanupOldCache() {
        const now = Date.now();
        
        // 현재 DOM에서 사용 중인 썸네일 URL 수집
        const activeUrls = new Set();
        const images = document.querySelectorAll('.grid-thumb-img');
        images.forEach(img => {
            if (img.src && img.src.startsWith('blob:')) {
                activeUrls.add(img.src);
            }
            if (img.dataset.thumbnailUrl) {
                activeUrls.add(img.dataset.thumbnailUrl);
            }
        });
        
        const toDelete = [];
        this.cache.forEach((data, path) => {
            if (data.url && 
                (now - data.timestamp) > this.cacheTimeout && 
                !activeUrls.has(data.url)) { // 현재 사용 중이 아닌 것만 삭제
                toDelete.push(path);
            }
        });
        
        toDelete.forEach(path => {
            const data = this.cache.get(path);
            if (data?.url) URL.revokeObjectURL(data.url);
            this.cache.delete(path);
        });
        
        return toDelete.length;
    }

    getCacheStats() {
        const entries = Array.from(this.cache.values());
        return {
            total: this.cache.size,
            loaded: entries.filter(d => d.url).length,
            loading: entries.filter(d => d.loading).length,
            concurrent: this.concurrentLoads,
            queued: this.loadQueue.length
        };
    }
}

class WaferMapViewer {
    constructor() {
        this.cacheDom();
        this.initState();
        this.bindEvents();
        this.init();
        // 디바운싱된 showGrid
        this._showGridScheduled = false;
        // 썸네일 매니저
        this.thumbnailManager = new ThumbnailManager();
        
        // 주기적인 메모리 정리 (5분마다)
        this.cleanupInterval = setInterval(() => {
            this.performCleanup();
        }, 5 * 60 * 1000);
        
        // 페이지 언로드시 정리
        window.addEventListener('beforeunload', () => {
            this.cleanup();
        });
    }

    /**
     * Cache all necessary DOM elements for fast access.
     */
    cacheDom() {
        this.dom = {
            sidebar: document.querySelector('.sidebar'),
            resizer: document.getElementById('resizer'),
            resizerRight: document.getElementById('resizer-right'),
            fileExplorer: document.getElementById('file-explorer'),
            viewerContainer: document.getElementById('viewer-container'),
            imageCanvas: document.getElementById('image-canvas'),
            minimapContainer: document.getElementById('minimap-container'),
            minimapCanvas: document.getElementById('minimap-canvas'),
            minimapViewport: document.getElementById('minimap-viewport'),
            zoomInBtn: document.getElementById('zoom-in-btn'),
            zoomOutBtn: document.getElementById('zoom-out-btn'),
            zoomLevelInput: document.getElementById('zoom-level'),
            resetViewBtn: document.getElementById('reset-view-btn'),
            zoom50Btn: document.getElementById('zoom-50-btn'),
            zoom100Btn: document.getElementById('zoom-100-btn'),
            zoom200Btn: document.getElementById('zoom-200-btn'),
            zoom300Btn: document.getElementById('zoom-300-btn'),
            wrapperRight: document.querySelector('.wrapper-right'),
            overlayCanvas: document.getElementById('overlay-canvas'),
            addClassBtn: document.getElementById('add-class-btn'),
            newClassInput: document.getElementById('new-class-input'),
            classList: document.getElementById('class-list'),
            labelStatus: document.getElementById('label-status'),
            deleteClassBtn: document.getElementById('delete-class-btn'),
            fileSearch: document.getElementById('file-search'),
            searchBtn: document.getElementById('search-btn'),
            gridDownloadSelected: document.getElementById('grid-download-selected'),
        };
        for (const [key, el] of Object.entries(this.dom)) {
            if (!el) {
                // console.error(`[WaferMapViewer] DOM element not found: ${key}`);
            }
        }
        this.imageCtx = this.dom.imageCanvas?.getContext('2d', { willReadFrequently: false });
        this.minimapCtx = this.dom.minimapCanvas?.getContext('2d', { willReadFrequently: false });
        if (this.dom.imageCanvas) {
            this.dom.imageCanvas.style.willChange = 'transform';
            this.dom.imageCanvas.style.transform = 'translateZ(0)';
        }
        if (this.dom.minimapCanvas) {
            this.dom.minimapCanvas.style.willChange = 'transform';
            this.dom.minimapCanvas.style.transform = 'translateZ(0)';
        }
    }

    /**
     * Initialize the application's state.
     */
    initState() {
        this.imageCtx.imageSmoothingQuality = 'high';
        this.transform = { scale: 1, dx: 0, dy: 0 };
        this.isPanning = false;
        this.panStart = { x: 0, y: 0 };
        this.currentImage = null;
        this.selectedImages = [];
        this.gridMode = false;
        this.gridCols = DEFAULT_GRID_COLS;
        this.gridThumbSize = DEFAULT_THUMB_SIZE;

        // 클래스 선택 상태 초기화 (Label Explorer와 Class Manager가 공유)
        this.classSelection = { selected: [], lastClicked: null };
        this.labelSelection = { selected: [], lastClicked: null, openFolders: {}, selectedClasses: [] };

        // Bind 'this' for event handlers that are dynamically added/removed
        this.boundHandleMouseMove = this.handleMouseMove.bind(this);
        this.boundHandleMouseUp = this.handleMouseUp.bind(this);
        this.boundSidebarMove = this.handleSidebarMove.bind(this);
        this.boundSidebarUp = this.handleSidebarUp.bind(this);
        // 우측 리사이저
        this.boundHandleRightMove = this.handleRightMove.bind(this);
        this.boundHandleRightUp = this.handleRightUp.bind(this);
    }

    /**
     * Bind all static event listeners. (함수 분리)
     */
    bindEvents() {
        this.bindViewerEvents();
        this.bindSidebarEvents();
        this.bindZoomEvents();
        this.bindFileExplorerEvents();
        this.bindGridEvents();
        this.bindMinimapEvents();
        this.bindGridControlEvents();
    }

    bindViewerEvents() {
        if (this.dom.viewerContainer)
            this.dom.viewerContainer.addEventListener('wheel', e => {
                if (this.gridMode) return; // grid 모드에서는 팬/줌 비활성화
                this.handleWheel(e);
            }, { passive: false });
        if (this.dom.viewerContainer)
            this.dom.viewerContainer.addEventListener('mousedown', e => {
                if (this.gridMode) return; // grid 모드에서는 팬(이동) 비활성화
                this.handleMouseDown(e);
            });
        if (this.dom.viewerContainer)
            new ResizeObserver(() => this.handleResize()).observe(this.dom.viewerContainer);
    }

    bindSidebarEvents() {
        if (this.dom.resizer)
            this.dom.resizer.addEventListener('mousedown', e => this.handleSidebarDown(e));
        if (this.dom.resizerRight)
            this.dom.resizerRight.addEventListener('mousedown', e => this.handleRightDown(e));
    }

    bindZoomEvents() {
        if (this.dom.zoomInBtn)
            this.dom.zoomInBtn.addEventListener('click', () => this.zoomAtCenter(ZOOM_FACTOR));
        if (this.dom.zoomOutBtn)
            this.dom.zoomOutBtn.addEventListener('click', () => this.zoomAtCenter(1 / ZOOM_FACTOR));
        if (this.dom.resetViewBtn)
            this.dom.resetViewBtn.addEventListener('click', () => this.resetView());
        if (this.dom.zoom50Btn)
            this.dom.zoom50Btn.addEventListener('click', () => this.setZoom(0.5));
        if (this.dom.zoom100Btn)
            this.dom.zoom100Btn.addEventListener('click', () => this.setZoom(1.0));
        if (this.dom.zoom200Btn)
            this.dom.zoom200Btn.addEventListener('click', () => this.setZoom(2.0));
        if (this.dom.zoom300Btn)
            this.dom.zoom300Btn.addEventListener('click', () => this.setZoom(3.0));
    }

    bindFileExplorerEvents() {
        if (this.dom.fileExplorer) {
            this.dom.fileExplorer.addEventListener('click', e => this.handleFileClick(e));
            this.dom.fileExplorer.addEventListener('contextmenu', e => this.handleFileRightClick(e));
        }
    }

    // Wafer Map Explorer 오른쪽 클릭 처리
    handleFileRightClick(e) {
        e.preventDefault();
        
        // 모든 선택 해제
        this.clearWaferMapExplorerSelection();
        
        // 그리드 모드 숨기기
        this.hideGrid();
        
        // 단일 이미지 모드도 숨기기
        this.hideImage();
        
        // 초기 상태로 복귀 - 검색창이 보이는 상태
        this.showInitialState();
        
        console.log('Wafer Map Explorer: 오른쪽 클릭으로 모든 선택 해제 및 초기 상태 복귀');
    }

    // 단일 이미지 모드 숨기기
    hideImage() {
        // 캔버스 숨기기
        if (this.dom.imageCanvas) {
            this.dom.imageCanvas.style.display = 'none';
        }
        if (this.dom.overlayCanvas) {
            this.dom.overlayCanvas.style.display = 'none';
        }
        if (this.dom.minimapContainer) {
            this.dom.minimapContainer.style.display = 'none';
        }
        
        // 뷰어 컨테이너 클래스 제거
        if (this.dom.viewerContainer) {
            this.dom.viewerContainer.classList.remove('single-image-mode');
        }
        
        // 줌 바 숨기기 (이미지가 없을 때는 불필요)
        const viewControls = document.querySelector('.view-controls');
        if (viewControls) {
            viewControls.style.display = 'none';
        }
        
        // 현재 이미지 정리
        this.currentImage = null;
        this.currentImageBitmap = null;
        this.selectedImagePath = '';
    }

    // 초기 상태 표시 (검색창과 상단 컨트롤만 보이는 상태)
    showInitialState() {
        // 그리드 컨트롤 표시
        const gridControls = document.getElementById('grid-controls');
        if (gridControls) {
            gridControls.style.display = 'flex';
        }
        
        // 뷰어 컨테이너를 그리드 모드로 설정하되 빈 상태
        if (this.dom.viewerContainer) {
            this.dom.viewerContainer.classList.add('grid-mode');
            this.dom.viewerContainer.classList.remove('single-image-mode');
        }
        
        // 빈 그리드 표시 (검색 안내 메시지)
        const grid = document.getElementById('image-grid');
        if (grid) {
            grid.innerHTML = `
                <div style="grid-column: 1 / -1; text-align: center; padding: 40px; color: #888;">
                    <p style="font-size: 16px; margin-bottom: 8px;">파일을 선택하거나 검색해보세요</p>
                    <p style="font-size: 14px; opacity: 0.7;">Wafer Map Explorer에서 파일/폴더를 클릭하거나 상단 검색창을 이용하세요</p>
                </div>
            `;
        }
        
        // 줌 바 숨기기 (초기 상태에서는 불필요)
        const viewControls = document.querySelector('.view-controls');
        if (viewControls) {
            viewControls.style.display = 'none';
        }
        
        // 커서 초기화
        if (this.dom.viewerContainer) {
            this.dom.viewerContainer.style.cursor = 'default';
        }
    }

    bindGridEvents() {
        const grid = document.getElementById('image-grid');
        const scrollWrapper = grid?.parentElement;
        if (!grid || !scrollWrapper) return;

        // 드래그 오버레이 생성 또는 가져오기
        let dragOverlay = document.getElementById('grid-drag-select');
        if (!dragOverlay) {
            dragOverlay = document.createElement('div');
            dragOverlay.id = 'grid-drag-select';
            dragOverlay.style.cssText = `
                position: absolute;
                display: none;
                background: rgba(0, 153, 255, 0.2);
                border: 2px solid #09f;
                border-radius: 3px;
                pointer-events: none;
                z-index: 1000;
                box-sizing: border-box;
            `;
            scrollWrapper.appendChild(dragOverlay);
            console.log('드래그 오버레이 생성 및 추가됨');
        }
        
        // 드래그 오버레이가 올바른 부모에 있는지 확인
        if (dragOverlay.parentElement !== scrollWrapper) {
            scrollWrapper.appendChild(dragOverlay);
            console.log('드래그 오버레이를 스크롤 래퍼로 이동');
        }

        grid.addEventListener('wheel', e => {
            if (!this.gridMode) return;
            if (e.ctrlKey) {
                e.preventDefault();
                let newCols = this.gridCols - Math.sign(e.deltaY);
                newCols = Math.max(1, Math.min(10, newCols));
                this.gridCols = newCols;
                const gridColsRange = document.getElementById('grid-cols-range');
                if(gridColsRange) gridColsRange.value = newCols.toString();
                document.documentElement.style.setProperty('--grid-cols', newCols.toString());
                if (this.selectedImages && this.selectedImages.length > 1) {
                    this.scheduleShowGrid();
                }
            } else if (e.shiftKey) {
                e.preventDefault();
                scrollWrapper.scrollLeft += e.deltaY;
            }
        }, { passive: false });

        // 드래그 상태 변수
        let dragData = {
            start: null,
            selecting: false,
            active: false,
            startTime: 0
        };
        
        // 좌표 변환 유틸리티 함수들
        const getScrollAdjustedCoords = (clientX, clientY) => {
            const rect = scrollWrapper.getBoundingClientRect();
            return {
                x: clientX - rect.left + scrollWrapper.scrollLeft,
                y: clientY - rect.top + scrollWrapper.scrollTop
            };
        };
        
        const getViewportCoords = (clientX, clientY) => {
            const rect = scrollWrapper.getBoundingClientRect();
            return {
                x: clientX - rect.left,
                y: clientY - rect.top
            };
        };
        
        // 드래그 박스 업데이트 함수 (성능 최적화)
        const updateDragBox = (startCoords, currentCoords) => {
            const left = Math.min(startCoords.x, currentCoords.x);
            const top = Math.min(startCoords.y, currentCoords.y);
            const width = Math.abs(currentCoords.x - startCoords.x);
            const height = Math.abs(currentCoords.y - startCoords.y);
            
            // 한번에 스타일 업데이트 (reflow 최소화)
            dragOverlay.style.cssText = `
                position: absolute;
                display: block;
                left: ${left}px;
                top: ${top}px;
                width: ${width}px;
                height: ${height}px;
                background: rgba(0, 153, 255, 0.2);
                border: 2px solid #09f;
                border-radius: 3px;
                pointer-events: none;
                z-index: 1000;
                box-sizing: border-box;
                will-change: transform;
            `;
            
            return { left, top, width, height };
        };

        // 마우스 다운 이벤트 - 드래그 준비
        scrollWrapper.addEventListener('mousedown', e => {
            if (!this.gridMode || e.button !== 0) return;
            
            e.preventDefault();
            e.stopPropagation();
            
            // 드래그 데이터 초기화
            dragData.startTime = Date.now();
            dragData.selecting = true;
            dragData.active = false;
            dragData.start = getScrollAdjustedCoords(e.clientX, e.clientY);
            
            // 마우스 추적 시작
            startMouseTracking();
            
            document.body.style.userSelect = 'none';
        });

        // 마우스 움직임 이벤트 - 드래그 처리 (쓰로틀링 적용)
        let mouseMoveTimeoutId = null;
        document.addEventListener('mousemove', e => {
            if (!dragData.selecting || !dragData.start) return;
            
            // 쓰로틀링: 16ms마다 처리 (60fps)
            if (mouseMoveTimeoutId) return;
            mouseMoveTimeoutId = requestAnimationFrame(() => {
                mouseMoveTimeoutId = null;
                
                const currentCoords = getScrollAdjustedCoords(e.clientX, e.clientY);
                const dragDistance = Math.abs(currentCoords.x - dragData.start.x) + Math.abs(currentCoords.y - dragData.start.y);
                
                // 최소 드래그 거리를 넘으면 드래그 박스 표시 시작
                if (!dragData.active && dragDistance > MIN_DRAG_DISTANCE) {
                    dragData.active = true;
                    document.body.style.cursor = 'crosshair';
                    
                    // 드래그 박스 초기 표시
                    dragOverlay.style.cssText = `
                        position: absolute;
                        display: block;
                        left: ${dragData.start.x}px;
                        top: ${dragData.start.y}px;
                        width: 0px;
                        height: 0px;
                        background: rgba(0, 153, 255, 0.2);
                        border: 2px solid #09f;
                        border-radius: 3px;
                        pointer-events: none;
                        z-index: 1000;
                        box-sizing: border-box;
                        will-change: transform;
                    `;
                }
                
                // 드래그가 활성화된 경우 박스 업데이트
                if (dragData.active) {
                    e.preventDefault();
                    updateDragBox(dragData.start, currentCoords);
                }
            });
        }, { passive: false });

        // 썸네일과 드래그 영역의 교차 검사 함수
        const findIntersectingThumbnails = (dragLeft, dragTop, dragRight, dragBottom) => {
            const intersectingIdxs = [];
            const cells = Array.from(grid.querySelectorAll('.grid-thumb-wrap'));
            
            cells.forEach((cell, idx) => {
                const cellRect = cell.getBoundingClientRect();
                const scrollRect = scrollWrapper.getBoundingClientRect();
                
                // 셀의 스크롤 조정된 좌표 계산
                const cellLeft = cellRect.left - scrollRect.left + scrollWrapper.scrollLeft;
                const cellTop = cellRect.top - scrollRect.top + scrollWrapper.scrollTop;
                const cellRight = cellLeft + cellRect.width;
                const cellBottom = cellTop + cellRect.height;

                // 드래그 영역과 셀의 교차 검사
                const intersects = (
                    dragRight >= cellLeft && 
                    dragLeft <= cellRight && 
                    dragBottom >= cellTop && 
                    dragTop <= cellBottom
                );

                if (intersects) {
                    intersectingIdxs.push(idx);
                }
            });
            
            return intersectingIdxs;
        };

        // 마우스업 이벤트 - 드래그 완료 및 선택 처리
        const onMouseUp = (e) => {
            if (!dragData.selecting) return;
            
            // 상태 초기화
            const wasActive = dragData.active;
            dragData.selecting = false;
            dragData.active = false;
            document.body.style.userSelect = '';
            document.body.style.cursor = '';
            dragOverlay.style.display = 'none';
            
            // 마우스 추적 중지
            stopMouseTracking();

            // 단순 클릭인 경우 (드래그 박스가 활성화되지 않음)
            if (!wasActive) {
                const thumbWrap = e.target.closest('.grid-thumb-wrap');
                if (thumbWrap) {
                    const cells = Array.from(grid.querySelectorAll('.grid-thumb-wrap'));
                    const idx = cells.indexOf(thumbWrap);
                    if (idx !== -1) {
                        this.toggleGridImageSelect(idx, e);
                    }
                } else if (!e.ctrlKey) {
                    // 빈 영역 클릭으로 선택 해제
                    this.gridSelectedIdxs = [];
                    this.updateGridSelection();
                }
                dragData.start = null;
                return;
            }

            // 드래그 선택 처리
            if (!dragData.start) {
                console.warn('드래그 시작점이 없습니다.');
                return;
            }

            const currentCoords = getScrollAdjustedCoords(e.clientX, e.clientY);
            
            // 드래그 영역 계산
            const dragLeft = Math.min(dragData.start.x, currentCoords.x);
            const dragTop = Math.min(dragData.start.y, currentCoords.y);
            const dragRight = Math.max(dragData.start.x, currentCoords.x);
            const dragBottom = Math.max(dragData.start.y, currentCoords.y);
            
            // 최소 드래그 거리 검사
            const dragWidth = dragRight - dragLeft;
            const dragHeight = dragBottom - dragTop;
            if (dragWidth < MIN_DRAG_DISTANCE && dragHeight < MIN_DRAG_DISTANCE) {
                dragData.start = null;
                return;
            }

            // 교차하는 썸네일 찾기
            const newIdxs = findIntersectingThumbnails(dragLeft, dragTop, dragRight, dragBottom);

            // 선택 모드에 따라 처리
            if (e.ctrlKey) {
                // Ctrl: 토글 선택
                const combined = [...this.gridSelectedIdxs];
                newIdxs.forEach(idx => {
                    const existingIndex = combined.indexOf(idx);
                    if (existingIndex >= 0) {
                        combined.splice(existingIndex, 1);
                    } else {
                        combined.push(idx);
                    }
                });
                this.gridSelectedIdxs = combined;
            } else {
                // 기본: 새로운 선택으로 교체
                this.gridSelectedIdxs = newIdxs;
            }
            
            this.updateGridSelection();
            
            // 정리
            dragData.start = null;
        };

        // 이벤트 리스너 등록
        document.addEventListener('mouseup', onMouseUp);
        
        // 스크롤 중 드래그 박스 위치 실시간 업데이트 (디바운싱)
        let scrollTimeoutId = null;
        scrollWrapper.addEventListener('scroll', () => {
            if (!dragData.active || !dragData.start || dragOverlay.style.display !== 'block') return;
            
            // 스크롤 중 임시로 투명도 감소
            dragOverlay.style.opacity = '0.5';
            
            // 디바운싱: 스크롤 종료 후 위치 업데이트
            if (scrollTimeoutId) clearTimeout(scrollTimeoutId);
            scrollTimeoutId = setTimeout(() => {
                const lastMouseEvent = window.lastMouseEvent;
                if (lastMouseEvent && dragData.active) {
                    const currentCoords = getScrollAdjustedCoords(lastMouseEvent.clientX, lastMouseEvent.clientY);
                    updateDragBox(dragData.start, currentCoords);
                    dragOverlay.style.opacity = '1';
                }
            }, 50);
        }, { passive: true });
        
        // 마우스 이벤트 최적화 - 드래그 중에만 위치 추적
        let mouseTracker = null;
        const startMouseTracking = () => {
            if (!mouseTracker) {
                mouseTracker = (e) => { window.lastMouseEvent = e; };
                document.addEventListener('mousemove', mouseTracker, { passive: true });
            }
        };
        
        const stopMouseTracking = () => {
            if (mouseTracker) {
                document.removeEventListener('mousemove', mouseTracker);
                mouseTracker = null;
                window.lastMouseEvent = null;
            }
        };

         // 키보드 단축키 (grid 모드에서만)
         document.addEventListener('keydown', (e) => {
             if (!this.gridMode) return;
             
             if (e.key === 'Escape') {
                 // ESC: 선택 해제
                 this.gridSelectedIdxs = [];
                 this.updateGridSelection();
                 e.preventDefault();
             } else if (e.ctrlKey && e.key === 'a') {
                 // Ctrl+A: 전체 선택
                 if (this.selectedImages) {
                     this.gridSelectedIdxs = this.selectedImages.map((_, i) => i);
                     this.updateGridSelection();
                 }
                 e.preventDefault();
             }
         });
    }

    bindMinimapEvents() {
        if (this.dom.minimapCanvas) {
            this.dom.minimapCanvas.addEventListener('click', e => this.handleMinimapClick(e));
        }
        
        // 뷰포트 드래그 기능 추가
        if (this.dom.minimapViewport) {
            this.dom.minimapViewport.addEventListener('mousedown', e => this.handleViewportDragStart(e));
        }
        
        // 바운드 함수들 추가
        this.boundHandleViewportDrag = this.handleViewportDrag.bind(this);
        this.boundHandleViewportDragEnd = this.handleViewportDragEnd.bind(this);
    }

    bindGridControlEvents() {
        const gridZoom = document.getElementById('grid-zoom-range');
        if (gridZoom) {
            gridZoom.addEventListener('input', e => {
                this.gridThumbSize = parseInt(e.target.value, 10);
                document.documentElement.style.setProperty('--thumb-size', this.gridThumbSize + 'px');
            });
        }
        const gridSelectAll = document.getElementById('grid-select-all');
        if (gridSelectAll) {
            gridSelectAll.onclick = () => {
                if (this.selectedImages) {
                    this.gridSelectedIdxs = this.selectedImages.map((_, i) => i);
                    this.updateGridSelection();
                }
            };
        }
        const gridDeselectAll = document.getElementById('grid-deselect-all');
        if (gridDeselectAll) {
            gridDeselectAll.onclick = () => {
                this.gridSelectedIdxs = [];
                this.updateGridSelection();
            };
        }
        const gridColsRange = document.getElementById('grid-cols-range');
        if (gridColsRange) {
            gridColsRange.addEventListener('input', e => {
                this.gridCols = parseInt(e.target.value, 10);
                document.documentElement.style.setProperty('--grid-cols', this.gridCols);
                if (this.selectedImages && this.selectedImages.length > 1) {
                    this.scheduleShowGrid();
                }
            });
        }
        const minusBtn = document.getElementById('grid-cols-minus');
        const plusBtn = document.getElementById('grid-cols-plus');
        if (minusBtn) {
            minusBtn.onclick = () => {
                this.gridCols = Math.max(1, this.gridCols - 1);
                document.getElementById('grid-cols-range').value = this.gridCols;
                document.documentElement.style.setProperty('--grid-cols', this.gridCols);
                if (this.selectedImages && this.selectedImages.length > 1) {
                    this.scheduleShowGrid();
                }
            };
        }
        if (plusBtn) {
            plusBtn.onclick = () => {
                this.gridCols = Math.min(10, this.gridCols + 1);
                document.getElementById('grid-cols-range').value = this.gridCols;
                document.documentElement.style.setProperty('--grid-cols', this.gridCols);
                if (this.selectedImages && this.selectedImages.length > 1) {
                    this.scheduleShowGrid();
                }
            };
        }
        
        // 파일명 검색 기능 이벤트 리스너
        if (this.dom.searchBtn) {
            this.dom.searchBtn.addEventListener('click', () => this.performSearch());
        }
        if (this.dom.fileSearch) {
            this.dom.fileSearch.addEventListener('keydown', e => {
                if (e.key === 'Enter') this.performSearch();
            });
        }
        
        // 선택된 파일 다운로드 기능
        if (this.dom.gridDownloadSelected) {
            this.dom.gridDownloadSelected.addEventListener('click', () => this.downloadSelectedImages());
        }
    }

    /**
     * Initial application entry point.
     */
    init() {
        this._drawScheduled = false; // draw() 스케줄링 플래그
        this.loadDirectoryContents(null, this.dom.fileExplorer);
        this.initClassification();
        this.refreshLabelExplorer();
        
        // 초기 실행 시 안내 메시지 표시
        this.showInitialState();
    }

    // =====================
    // 파일 탐색기/그리드/이미지 로딩/뷰어/라벨링 등 주요 함수
    // =====================
    async loadDirectoryContents(path, containerElement) {
        console.log("[DEBUG] loadDirectoryContents called with path:", path);
        try {
            const url = path ? `/api/files?path=${encodeURIComponent(path)}` : '/api/files';
            console.log("[DEBUG] Fetching URL:", url);
            const data = await fetchJson(url);
            const files = Array.isArray(data.items) ? data.items : [];
            containerElement.innerHTML = this.createFileTreeHtml(files, path || '');
            // classification 폴더 자동 확장 제거 (항상 닫힘)
        } catch (error) {
            containerElement.innerHTML = `<p style=\"color: #ff5555; padding: 10px;\">Error loading files.</p>`;
            console.error("[DEBUG] loadDirectoryContents error:", error);
        }
    }

    createFileTreeHtml(nodes, parentPath) {
        nodes = Array.isArray(nodes) ? nodes : [];
        let html = '<ul>';
        for (const node of nodes) {
            const fullPath = parentPath ? `${parentPath}/${node.name}` : node.name;
            if (node.type === 'directory') {
                html += `<li><details><summary data-path="${fullPath}" class="folder">📁 ${node.name}</summary><div class="folder-content" style="padding-left: 1rem;"></div></details></li>`;
            } else if (node.type === 'file') {
                html += `<li><a href="#" data-path="${fullPath}">📄 ${node.name}</a></li>`;
            }
        }
        return html + '</ul>';
    }



    async selectAllFolderFiles(folderPath) {
        try {
            console.log(`폴더 선택: ${folderPath}`);
            
            // API를 통해 폴더 내 모든 파일 가져오기 (재귀적)
            const allFiles = await this.getAllFilesInFolder(folderPath);
            
            if (!this.selectedImages) this.selectedImages = [];
            
            // 이미지 파일만 필터링하고 중복 제거
            const imageFiles = allFiles.filter(path => this.isImageFile(path));
            this.selectedImages = Array.from(new Set([...this.selectedImages, ...imageFiles]));
            
            console.log(`폴더 ${folderPath}에서 ${imageFiles.length}개 이미지 선택됨`);
        } catch (error) {
            console.error(`폴더 파일 선택 실패: ${folderPath}`, error);
        }
    }

    async deselectFolderFiles(folderPath) {
        try {
            console.log(`폴더 선택 해제: ${folderPath}`);
            
            // API를 통해 폴더 내 모든 파일 가져오기 (재귀적)
            const allFiles = await this.getAllFilesInFolder(folderPath);
            
            if (!this.selectedImages) this.selectedImages = [];
            
            // 해당 폴더의 파일들을 선택에서 제거
            const imageFiles = allFiles.filter(path => this.isImageFile(path));
            this.selectedImages = this.selectedImages.filter(p => !imageFiles.includes(p));
            
            console.log(`폴더 ${folderPath}에서 ${imageFiles.length}개 이미지 선택 해제됨`);
        } catch (error) {
            console.error(`폴더 파일 선택 해제 실패: ${folderPath}`, error);
        }
    }

    async selectFolderRange(startFolder, endFolder) {
        try {
            // DOM에서 모든 폴더 요소 찾기
            const allFolders = Array.from(document.querySelectorAll('#file-explorer summary.folder'));
            
            const startIndex = allFolders.indexOf(startFolder);
            const endIndex = allFolders.indexOf(endFolder);
            
            if (startIndex === -1 || endIndex === -1) {
                console.error('범위 선택 실패: 폴더를 찾을 수 없음');
                return;
            }
            
            // 시작과 끝 인덱스 정렬
            const minIndex = Math.min(startIndex, endIndex);
            const maxIndex = Math.max(startIndex, endIndex);
            
            // 범위 내 모든 폴더 선택
            for (let i = minIndex; i <= maxIndex; i++) {
                const folderElement = allFolders[i];
                const path = folderElement.dataset.path;
                
                if (!folderElement.classList.contains('selected')) {
                    folderElement.classList.add('selected');
                    this.selectedFolders.add(path);
                    await this.selectAllFolderFiles(path);
                }
            }
            
            console.log(`범위 선택: ${maxIndex - minIndex + 1}개 폴더 선택됨`);
        } catch (error) {
            console.error('폴더 범위 선택 실패:', error);
        }
    }

    async performSearch() {
        try {
            const fileQuery = this.dom.fileSearch?.value?.trim() || '';
            
            if (!fileQuery) {
                alert('파일명을 입력해주세요.');
                return;
            }
            
            // 즉시 버튼 피드백 제공
            const searchBtn = this.dom.searchBtn;
            const originalText = searchBtn?.textContent || '검색';
            if (searchBtn) {
                searchBtn.textContent = '검색 중...';
                searchBtn.disabled = true;
                searchBtn.style.opacity = '0.6';
            }
            
            console.log(`파일명 검색 시작: "${fileQuery}"`);
            const startTime = performance.now();
            
            // 빠른 파일명 검색 - 현재 로드된 파일들만 검색
            const matchedImages = this.fastFileNameSearch(fileQuery);
            
            const endTime = performance.now();
            console.log(`검색 완료: ${matchedImages.length}개 이미지 발견 (${(endTime - startTime).toFixed(1)}ms)`);
            
            // 버튼 상태 복원
            if (searchBtn) {
                searchBtn.textContent = originalText;
                searchBtn.disabled = false;
                searchBtn.style.opacity = '1';
            }
            
            if (matchedImages.length === 0) {
                alert('검색 결과가 없습니다.');
                return;
            }
            
            // 검색 결과를 그리드 모드로 표시
            this.selectedImages = matchedImages;
            this.gridSelectedIdxs = [];
            this.showGrid(matchedImages);
            
        } catch (error) {
            console.error('검색 실패:', error);
            
            // 오류 시에도 버튼 상태 복원
            const searchBtn = this.dom.searchBtn;
            if (searchBtn) {
                searchBtn.textContent = '검색';
                searchBtn.disabled = false;
                searchBtn.style.opacity = '1';
            }
            
            alert('검색 중 오류가 발생했습니다.');
        }
    }

    // 빠른 파일명 검색 - DOM에서 직접 검색 (OR/AND 연산자 지원)
    fastFileNameSearch(fileQuery) {
        const results = [];
        
        // 현재 DOM에 로드된 모든 파일 링크 검색
        const fileElements = this.dom.fileExplorer.querySelectorAll('a[data-path]');
        
        for (const element of fileElements) {
            const filePath = element.dataset.path;
            const fileName = element.textContent.trim().toLowerCase();
            
            // 이미지 파일인지 확인
            if (!this.isImageFile(filePath)) continue;
            
            // 고급 검색 로직 적용
            if (this.matchesSearchQuery(fileName, fileQuery)) {
                results.push(filePath);
            }
        }
        
        return results;
    }

    // 고급 검색 매칭 로직 (OR/AND/NOT/괄호 지원)
    matchesSearchQuery(fileName, query) {
        try {
            const normalizedQuery = query.toLowerCase().trim();
            return this.evaluateExpression(fileName, normalizedQuery);
        } catch (error) {
            console.warn('검색 표현식 오류, 기본 검색으로 전환:', error.message);
            // 오류 시 기본 포함 검색으로 폴백
            return fileName.includes(query.toLowerCase().trim());
        }
    }

    // 표현식 평가 (괄호, OR, AND, NOT 지원)
    evaluateExpression(fileName, expression) {
        // 괄호 처리
        while (expression.includes('(')) {
            const lastOpenParen = expression.lastIndexOf('(');
            const closeParen = expression.indexOf(')', lastOpenParen);
            
            if (closeParen === -1) {
                throw new Error('괄호가 닫히지 않음');
            }
            
            const innerExpression = expression.substring(lastOpenParen + 1, closeParen);
            const result = this.evaluateExpression(fileName, innerExpression);
            
            // 괄호 부분을 결과로 교체 (임시 토큰 사용)
            const token = `__RESULT_${result}__`;
            expression = expression.substring(0, lastOpenParen) + token + expression.substring(closeParen + 1);
        }
        
        // OR 연산자 처리 (가장 낮은 우선순위)
        if (expression.includes(' or ')) {
            const orTerms = this.splitByOperator(expression, ' or ');
            return orTerms.some(term => this.evaluateAndExpression(fileName, term.trim()));
        }
        
        return this.evaluateAndExpression(fileName, expression);
    }

    // AND 표현식 평가
    evaluateAndExpression(fileName, expression) {
        // AND 연산자 처리
        const andTerms = this.splitByOperator(expression, ' and ');
        return andTerms.every(term => this.evaluateNotExpression(fileName, term.trim()));
    }

    // NOT 표현식 평가
    evaluateNotExpression(fileName, expression) {
        // 결과 토큰 처리
        if (expression.startsWith('__RESULT_')) {
            return expression === '__RESULT_true__';
        }
        
        // NOT 연산자 처리
        if (expression.startsWith('not ')) {
            const term = expression.substring(4).trim();
            return !this.evaluateBasicTerm(fileName, term);
        }
        
        return this.evaluateBasicTerm(fileName, expression);
    }

    // 기본 용어 평가
    evaluateBasicTerm(fileName, term) {
        if (term.startsWith('__RESULT_')) {
            return term === '__RESULT_true__';
        }
        
        // 공백으로 분리된 여러 단어는 모두 포함되어야 함
        const words = term.split(/\s+/).filter(word => word.length > 0);
        return words.every(word => fileName.includes(word));
    }

    // 연산자로 분할 (괄호 결과 토큰 고려)
    splitByOperator(expression, operator) {
        const parts = [];
        let current = '';
        let i = 0;
        
        while (i < expression.length) {
            if (expression.substring(i, i + operator.length) === operator) {
                parts.push(current);
                current = '';
                i += operator.length;
            } else {
                current += expression[i];
                i++;
            }
        }
        parts.push(current);
        
        return parts.filter(part => part.trim().length > 0);
    }

    downloadImage(imagePath) {
        try {
            const fileName = imagePath.split('/').pop();
            const downloadUrl = `/api/image?path=${encodeURIComponent(imagePath)}`;
            
            // 임시 링크 생성하여 다운로드
            const link = document.createElement('a');
            link.href = downloadUrl;
            link.download = fileName;
            link.style.display = 'none';
            
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            
            console.log(`이미지 다운로드: ${fileName}`);
        } catch (error) {
            console.error('이미지 다운로드 실패:', error);
            alert('이미지 다운로드에 실패했습니다.');
        }
    }

    downloadSelectedImages() {
        try {
            if (!this.gridSelectedIdxs || this.gridSelectedIdxs.length === 0) {
                alert('다운로드할 이미지를 선택해주세요.');
                return;
            }

            if (!this.selectedImages) {
                alert('선택된 이미지가 없습니다.');
                return;
            }

            const selectedImagePaths = this.gridSelectedIdxs.map(idx => this.selectedImages[idx]).filter(Boolean);
            
            if (selectedImagePaths.length === 0) {
                alert('유효한 이미지가 선택되지 않았습니다.');
                return;
            }

            console.log(`${selectedImagePaths.length}개 이미지 다운로드 시작`);

            // 각 이미지를 순차적으로 다운로드 (브라우저 제한 고려)
            selectedImagePaths.forEach((imagePath, index) => {
                setTimeout(() => {
                    this.downloadImage(imagePath);
                }, index * 300); // 300ms 간격으로 다운로드
            });

            alert(`${selectedImagePaths.length}개 파일 다운로드를 시작합니다.`);
        } catch (error) {
            console.error('선택된 이미지 다운로드 실패:', error);
            alert('선택된 이미지 다운로드에 실패했습니다.');
        }
    }

    showContextMenu(event, clickedIdx) {
        // 클릭된 항목이 선택되지 않은 경우 해당 항목만 선택
        if (!this.gridSelectedIdxs.includes(clickedIdx)) {
            this.gridSelectedIdxs = [clickedIdx];
            this.updateGridSelection();
        }

        const contextMenu = document.getElementById('grid-context-menu');
        if (!contextMenu) return;

        // 메뉴 위치 설정
        contextMenu.style.display = 'block';
        contextMenu.style.left = event.pageX + 'px';
        contextMenu.style.top = event.pageY + 'px';

        // 화면 경계 체크
        const rect = contextMenu.getBoundingClientRect();
        if (rect.right > window.innerWidth) {
            contextMenu.style.left = (event.pageX - rect.width) + 'px';
        }
        if (rect.bottom > window.innerHeight) {
            contextMenu.style.top = (event.pageY - rect.height) + 'px';
        }

        // 메뉴 항목 이벤트 리스너 등록 (한 번만)
        if (!this.contextMenuInitialized) {
            this.initializeContextMenu();
            this.contextMenuInitialized = true;
        }

        // 외부 클릭으로 메뉴 숨기기
        this.hideContextMenuHandler = (e) => {
            if (!contextMenu.contains(e.target)) {
                this.hideContextMenu();
            }
        };
        document.addEventListener('click', this.hideContextMenuHandler);
    }

    hideContextMenu() {
        const contextMenu = document.getElementById('grid-context-menu');
        if (contextMenu) {
            contextMenu.style.display = 'none';
        }
        if (this.hideContextMenuHandler) {
            document.removeEventListener('click', this.hideContextMenuHandler);
            this.hideContextMenuHandler = null;
        }
    }

    initializeContextMenu() {
        const downloadItem = document.getElementById('context-download');
        const mergeCopyItem = document.getElementById('context-merge-copy');
        const listCopyItem = document.getElementById('context-list-copy');
        const tableCopyItem = document.getElementById('context-table-copy');
        const cancelItem = document.getElementById('context-cancel');

        if (downloadItem) {
            downloadItem.onclick = () => {
                this.hideContextMenu();
                this.downloadSelectedImages();
            };
        }

        if (mergeCopyItem) {
            mergeCopyItem.onclick = () => {
                this.hideContextMenu();
                this.mergeAndCopyImages();
            };
        }

        if (listCopyItem) {
            listCopyItem.onclick = () => {
                this.hideContextMenu();
                this.copyFileList();
            };
        }

        if (tableCopyItem) {
            tableCopyItem.onclick = () => {
                this.hideContextMenu();
                this.copyFileListAsTable();
            };
        }

        if (cancelItem) {
            cancelItem.onclick = () => {
                this.hideContextMenu();
            };
        }
    }

    async mergeAndCopyImages() {
        try {
            if (!this.gridSelectedIdxs || this.gridSelectedIdxs.length === 0) {
                alert('합칠 이미지를 선택해주세요.');
                return;
            }

            const selectedCount = this.gridSelectedIdxs.length;
            const gridSize = Math.ceil(Math.sqrt(selectedCount));
            
            alert(`${selectedCount}개 이미지를 ${gridSize}x${gridSize} 그리드로 합치는 중...`);

            // Canvas 생성
            const canvas = document.createElement('canvas');
            const ctx = canvas.getContext('2d');
            
            // 각 이미지 크기 (512px로 설정)
            const imageSize = 512;
            canvas.width = gridSize * imageSize;
            canvas.height = gridSize * imageSize;
            
            // 배경을 검은색으로 설정
            ctx.fillStyle = '#000000';
            ctx.fillRect(0, 0, canvas.width, canvas.height);

            const imagePromises = this.gridSelectedIdxs.map(async (idx, index) => {
                const imagePath = this.selectedImages[idx];
                const response = await fetch(`/api/image?path=${encodeURIComponent(imagePath)}`);
                const blob = await response.blob();
                const img = new Image();
                
                return new Promise((resolve, reject) => {
                    img.onload = () => {
                        const row = Math.floor(index / gridSize);
                        const col = index % gridSize;
                        const x = col * imageSize;
                        const y = row * imageSize;
                        
                        // 이미지를 비율 유지하며 중앙 정렬로 그리기
                        const scale = Math.min(imageSize / img.width, imageSize / img.height);
                        const scaledWidth = img.width * scale;
                        const scaledHeight = img.height * scale;
                        const offsetX = (imageSize - scaledWidth) / 2;
                        const offsetY = (imageSize - scaledHeight) / 2;
                        
                        ctx.drawImage(img, x + offsetX, y + offsetY, scaledWidth, scaledHeight);
                        resolve();
                    };
                    img.onerror = reject;
                    img.src = URL.createObjectURL(blob);
                });
            });

            await Promise.all(imagePromises);

            // Canvas를 Blob으로 변환하고 클립보드에 복사
            canvas.toBlob(async (blob) => {
                try {
                    const item = new ClipboardItem({ 'image/png': blob });
                    await navigator.clipboard.write([item]);
                    alert(`${selectedCount}개 이미지가 ${gridSize}x${gridSize} 그리드로 합쳐져서 클립보드에 복사되었습니다!`);
                } catch (error) {
                    console.error('클립보드 복사 실패:', error);
                    alert('클립보드 복사에 실패했습니다. 브라우저가 클립보드 API를 지원하지 않을 수 있습니다.');
                }
            }, 'image/png');

        } catch (error) {
            console.error('이미지 합치기 실패:', error);
            alert('이미지 합치기에 실패했습니다.');
        }
    }

    copyFileList() {
        try {
            if (!this.gridSelectedIdxs || this.gridSelectedIdxs.length === 0) {
                alert('복사할 파일을 선택해주세요.');
                return;
            }

            const selectedFiles = this.gridSelectedIdxs.map(idx => this.selectedImages[idx]).filter(Boolean);
            const fileListText = selectedFiles.join('\n');

            navigator.clipboard.writeText(fileListText).then(() => {
                alert(`${selectedFiles.length}개 파일 경로가 클립보드에 복사되었습니다!`);
            }).catch(error => {
                console.error('클립보드 복사 실패:', error);
                
                // 폴백: textarea 사용
                const textarea = document.createElement('textarea');
                textarea.value = fileListText;
                textarea.style.position = 'fixed';
                textarea.style.opacity = '0';
                document.body.appendChild(textarea);
                textarea.select();
                document.execCommand('copy');
                document.body.removeChild(textarea);
                
                alert(`${selectedFiles.length}개 파일 경로가 클립보드에 복사되었습니다!`);
            });

        } catch (error) {
            console.error('파일 리스트 복사 실패:', error);
            alert('파일 리스트 복사에 실패했습니다.');
        }
    }

    copyFileListAsTable() {
        try {
            if (!this.gridSelectedIdxs || this.gridSelectedIdxs.length === 0) {
                alert('복사할 파일을 선택해주세요.');
                return;
            }

            const selectedFiles = this.gridSelectedIdxs.map(idx => this.selectedImages[idx]).filter(Boolean);
            
            // 파일 정보를 테이블 형태로 변환
            const tableData = selectedFiles.map(filePath => {
                // 파일 경로에서 폴더와 파일명 분리
                const pathParts = filePath.split('/');
                const fileName = pathParts[pathParts.length - 1];
                const folder = pathParts.length > 1 ? pathParts[pathParts.length - 2] : '';
                
                // 확장자 제거
                const nameWithoutExt = fileName.replace(/\.[^/.]+$/, '');
                
                // 파일명을 _ 로 분할
                const nameParts = nameWithoutExt.split('_');
                
                return {
                    folder: folder || 'ROOT',
                    part1: nameParts[0] || '',
                    part2: nameParts[1] || '',
                    part3: nameParts[2] || '',
                    part4: nameParts[3] || '',
                    part5: nameParts[4] || ''
                };
            });

            // TSV (Tab-Separated Values) 형태로 테이블 생성
            const headers = ['Folder', 'Name_Part1', 'Name_Part2', 'Name_Part3', 'Name_Part4', 'Name_Part5'];
            let tableText = headers.join('\t') + '\n';
            
            tableData.forEach(row => {
                const values = [row.folder, row.part1, row.part2, row.part3, row.part4, row.part5];
                tableText += values.join('\t') + '\n';
            });

            navigator.clipboard.writeText(tableText).then(() => {
                alert(`${selectedFiles.length}개 파일의 테이블 데이터가 클립보드에 복사되었습니다!\n(Excel에 붙여넣기 가능)`);
            }).catch(error => {
                console.error('클립보드 복사 실패:', error);
                
                // 폴백: textarea 사용
                const textarea = document.createElement('textarea');
                textarea.value = tableText;
                textarea.style.position = 'fixed';
                textarea.style.opacity = '0';
                document.body.appendChild(textarea);
                textarea.select();
                document.execCommand('copy');
                document.body.removeChild(textarea);
                
                alert(`${selectedFiles.length}개 파일의 테이블 데이터가 클립보드에 복사되었습니다!\n(Excel에 붙여넣기 가능)`);
            });

        } catch (error) {
            console.error('파일 리스트 테이블 복사 실패:', error);
            alert('파일 리스트 테이블 복사에 실패했습니다.');
        }
    }

    async getAllFilesInFolder(folderPath) {
        const allFiles = [];
        
        try {
            const response = await fetch(`/api/files?path=${encodeURIComponent(folderPath)}`);
            const data = await response.json();
            const items = Array.isArray(data.items) ? data.items : [];
            
            for (const item of items) {
                const itemPath = `${folderPath}/${item.name}`;
                
                if (item.type === 'file') {
                    allFiles.push(itemPath);
                } else if (item.type === 'directory') {
                    // 재귀적으로 하위 폴더 탐색
                    const subFiles = await this.getAllFilesInFolder(itemPath);
                    allFiles.push(...subFiles);
                }
            }
        } catch (error) {
            console.error(`폴더 스캔 실패: ${folderPath}`, error);
        }
        
        return allFiles;
    }

    isImageFile(filePath) {
        const imageExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.svg', '.tiff', '.tif'];
        const extension = filePath.toLowerCase().substring(filePath.lastIndexOf('.'));
        return imageExtensions.includes(extension);
    }

    updateFileExplorerSelection() {
        // 시각적 선택 상태 업데이트
        this.dom.fileExplorer.querySelectorAll('a.selected').forEach(a => a.classList.remove('selected'));
        
        if (this.selectedImages) {
            this.selectedImages.forEach(selPath => {
                const a = this.dom.fileExplorer.querySelector(`a[data-path="${selPath.replace(/"/g, '\\"')}"]`);
                if (a) a.classList.add('selected');
            });
        }
        
        // 뷰 모드 결정
        if (this.selectedImages && this.selectedImages.length > 1) {
            this.showGrid(this.selectedImages);
        } else if (this.selectedImages && this.selectedImages.length === 1) {
            this.hideGrid();
            this.loadImage(this.selectedImages[0]);
            this.selectedImagePath = this.selectedImages[0];
        } else {
            this.hideGrid();
        }
        
        if (this.selectedImages && this.selectedImages.length > 0) {
            this.selectedImagePath = this.selectedImages[this.selectedImages.length - 1];
        }
    }

    clearWaferMapExplorerSelection() {
        try {
            // Wafer Map Explorer 선택 해제
            this.selectedImages = [];
            this.selectedFolders = new Set();
            
            // 시각적 선택 상태 제거
            if (this.dom && this.dom.fileExplorer) {
                this.dom.fileExplorer.querySelectorAll('.selected').forEach(el => {
                    el.classList.remove('selected');
                });
            }
            
            console.log('Wafer Map Explorer 선택 해제됨');
        } catch (error) {
            console.warn('clearWaferMapExplorerSelection 내부 오류:', error);
        }
    }

    clearLabelExplorerSelection() {
        try {
            // Label Explorer 선택 해제
            if (this.labelSelection) {
                this.labelSelection.selected = [];
                this.labelSelection.selectedClasses = [];
                
                // 그리드 모드 해제
                if (this.gridMode) {
                    console.log('Label Explorer: 우클릭 선택 해제 → 그리드 모드 종료');
                    this.hideGrid();
                }
                
                // 시각적 선택 상태 제거
                const container = document.getElementById('label-explorer-list');
                if (container) {
                    container.querySelectorAll('.selected').forEach(el => {
                        el.classList.remove('selected');
                    });
                    
                    // 폴더 선택 상태도 제거
                    container.querySelectorAll('div').forEach(summary => {
                        summary.style.background = 'transparent';
                        summary.style.color = '#fff';
                        summary.style.borderRadius = '0';
                    });
                }
            }
            
            console.log('Label Explorer 선택 해제됨');
        } catch (error) {
            console.warn('clearLabelExplorerSelection 내부 오류:', error);
        }
    }

    setupLabelExplorerKeyboardShortcuts(classes, classToImgList, labelSelection) {
        // 이미 바인딩되어 있으면 중복 방지
        if (this.labelExplorerKeysSetup) return;
        this.labelExplorerKeysSetup = true;
        
        const handleKeyDown = (e) => {
            // Label Explorer 영역 내에서만 동작 (더 정확한 체크)
            const labelExplorerFrame = document.querySelector('.label-explorer-frame');
            const isInLabelExplorer = labelExplorerFrame && (
                labelExplorerFrame.contains(e.target) ||
                e.target === labelExplorerFrame ||
                e.target.closest('#label-explorer-list')
            );
            
            if (!isInLabelExplorer) return;
            
            try {
                if (e.key === 'Escape') {
                    // ESC: 선택 해제
                    labelSelection.selected = [];
                    labelSelection.selectedClasses = [];
                    
                    // 그리드 모드 해제
                    if (this.gridMode) {
                        console.log('Label Explorer: ESC 키 → 그리드 모드 종료');
                        this.hideGrid();
                    }
                    
                    this.updateLabelExplorerSelection();
                    try {
                        this.clearWaferMapExplorerSelection();
                    } catch (error) {
                        console.warn('clearWaferMapExplorerSelection error:', error);
                    }
                    e.preventDefault();
                    console.log('Label Explorer: ESC로 전체 선택 해제');
                    
                } else if (e.ctrlKey && e.key === 'a') {
                    // Ctrl+A: 전체 이미지 선택
                    labelSelection.selected = [];
                    labelSelection.selectedClasses = [];
                    
                    // 모든 이미지 선택
                    for (const cls of classes) {
                        const imgList = classToImgList[cls] || [];
                        for (const img of imgList) {
                            if (img.type === 'file') {
                                labelSelection.selected.push(`${cls}/${img.name}`);
                            }
                        }
                    }
                    
                    // 전체 이미지 선택 시 그리드 모드로 전환
                    if (labelSelection.selected.length > 1) {
                        console.log(`Label Explorer: Ctrl+A → 그리드 모드 (${labelSelection.selected.length}개 이미지)`);
                        this.showGridFromLabelExplorer(labelSelection.selected);
                    }
                    
                    this.updateLabelExplorerSelection();
                    try {
                        this.clearWaferMapExplorerSelection();
                    } catch (error) {
                        console.warn('clearWaferMapExplorerSelection error:', error);
                    }
                    e.preventDefault();
                    console.log(`Label Explorer: Ctrl+A로 ${labelSelection.selected.length}개 이미지 선택`);
                }
            } catch (error) {
                console.warn('Label Explorer 키보드 단축키 오류:', error);
            }
        };
        
        document.addEventListener('keydown', handleKeyDown);
        
        // 정리 함수 저장 (필요시 사용)
        this.cleanupLabelExplorerKeys = () => {
            document.removeEventListener('keydown', handleKeyDown);
            this.labelExplorerKeysSetup = false;
        };
    }

    async handleFileClick(e) {
        const target = e.target;
        // Handle folder expansion
        if (target.tagName === 'SUMMARY' && target.classList.contains('folder')) {
            const detailsElement = target.parentElement;
            if (!detailsElement.open && !detailsElement.dataset.loaded) {
                const path = target.dataset.path;
                const contentDiv = target.nextElementSibling;
                await this.loadDirectoryContents(path, contentDiv);
                detailsElement.dataset.loaded = 'true';
            }
            // ctrl+클릭으로 폴더 선택/해제 (폴더 열리지 않음)
            if (e.ctrlKey) {
                e.preventDefault(); // 기본 폴더 열기/닫기 동작 방지
                e.stopPropagation(); // 이벤트 버블링 방지
                
                const path = target.dataset.path;
                if (!this.selectedFolders) this.selectedFolders = new Set();
                
                // 다른 Explorer 선택 해제
                this.clearLabelExplorerSelection();
                
                // 첫 번째 선택된 폴더 기록 (Shift 선택용)
                if (!this.lastSelectedFolder && !target.classList.contains('selected')) {
                    this.lastSelectedFolder = target;
                }
                
                if (target.classList.contains('selected')) {
                    // 선택 해제
                    target.classList.remove('selected');
                    this.selectedFolders.delete(path);
                    await this.deselectFolderFiles(path);
                } else {
                    // 선택 - 폴더는 열지 않고 선택만
                    target.classList.add('selected');
                    this.selectedFolders.add(path);
                    await this.selectAllFolderFiles(path);
                }
                
                // UI 업데이트
                this.updateFileExplorerSelection();
                return; // 추가 처리 방지
            }
            
            // shift+클릭으로 범위 선택 (폴더 열리지 않음)
            if (e.shiftKey && this.lastSelectedFolder) {
                e.preventDefault();
                e.stopPropagation(); // 이벤트 버블링 방지
                
                const path = target.dataset.path;
                if (!this.selectedFolders) this.selectedFolders = new Set();
                
                // 다른 Explorer 선택 해제
                this.clearLabelExplorerSelection();
                
                await this.selectFolderRange(this.lastSelectedFolder, target);
                
                // UI 업데이트
                this.updateFileExplorerSelection();
                return;
            }
        } 
        // Handle file selection (multi-select)
        else if (target.tagName === 'A') {
        e.preventDefault();
            const path = target.dataset.path;
            
            // 다른 Explorer 선택 해제
            this.clearLabelExplorerSelection();
            
            const allLinks = Array.from(this.dom.fileExplorer.querySelectorAll('a[data-path]'));
            const idx = allLinks.findIndex(a => a.dataset.path === path);
            if (e.shiftKey && this.lastExplorerClickedIdx !== undefined) {
                const [from, to] = [this.lastExplorerClickedIdx, idx].sort((a, b) => a - b);
                const range = allLinks.slice(from, to + 1).map(a => a.dataset.path);
                this.selectedImages = Array.from(new Set([...(this.selectedImages || []), ...range]));
                // Shift 범위 선택 시에는 항상 그리드 모드
                this.hideGrid();
                this.showGrid(this.selectedImages);
            } else if (e.ctrlKey) {
                if (!this.selectedImages) this.selectedImages = [];
                if (this.selectedImages.includes(path)) {
                    this.selectedImages = this.selectedImages.filter(p => p !== path);
                } else {
                    this.selectedImages.push(path);
                }
                // Ctrl 다중 선택 시에는 항상 그리드 모드
                this.hideGrid();
                if (this.selectedImages.length > 0) {
                    this.showGrid(this.selectedImages);
                }
            } else {
                // 단일 클릭 - 이미지 파일이면 자세히보기 모드
                this.selectedImages = [path];
                this.selectedImagePath = path;
                
                // 이미지 파일인지 확인
                if (this.isImageFile(path)) {
                    // 자세히보기 모드로 전환
                    this.hideGrid();
                    this.loadImage(path);
                } else {
                    // 이미지가 아니면 그리드 모드
                    this.showGrid(this.selectedImages);
                }
            }
            this.lastExplorerClickedIdx = idx;
            // Highlight all selected
            this.dom.fileExplorer.querySelectorAll('a.selected').forEach(a => a.classList.remove('selected'));
            this.selectedImages.forEach(selPath => {
                const a = this.dom.fileExplorer.querySelector(`a[data-path="${selPath.replace(/"/g, '\"')}"]`);
                if (a) a.classList.add('selected');
            });
        }
    }

    // --- IMAGE LOADING ---
    async loadImage(path) {
        try {
            const blob = await fetch(`/api/image?path=${encodeURIComponent(path)}`).then(r => r.blob());
            this.currentImageBitmap = await createImageBitmap(blob);
            this.currentImage = this.currentImageBitmap;
            this.resetView(false);
            this.dom.minimapContainer.style.display = 'block';
            this.dom.imageCanvas.style.display = 'block';
            this.dom.overlayCanvas.style.display = 'block';
            
            // 줌 바 표시 (이미지가 로드되었을 때만)
            const viewControls = document.querySelector('.view-controls');
            if (viewControls) {
                viewControls.style.display = 'flex';
            }
            
            this.scheduleDraw();
        } catch (err) {
            console.error(`Failed to load image: ${path}`, err);
            this.dom.minimapContainer.style.display = 'none';
        }
    }

    // --- VIEWPORT & DRAWING ---
    scheduleDraw() {
        if (this._drawScheduled) return;
        this._drawScheduled = true;
        requestAnimationFrame(() => {
            this._drawScheduled = false;
            this.draw();
        });
    }

    draw() {
        if (!this.currentImage) return;
        const { width, height } = this.dom.viewerContainer.getBoundingClientRect();
        this.dom.imageCanvas.width = width;
        this.dom.imageCanvas.height = height;
        this.dom.imageCanvas.style.width = '100%';
        this.dom.imageCanvas.style.height = '100%';
        this.dom.imageCanvas.style.display = 'block';
        this.dom.imageCanvas.style.margin = '0';
        this.dom.imageCanvas.style.position = 'absolute';
        this.dom.imageCanvas.style.left = '0';
        this.dom.imageCanvas.style.top = '0';
        this.dom.imageCanvas.style.right = '0';
        this.dom.imageCanvas.style.bottom = '0';
        this.dom.imageCanvas.style.zIndex = 1;
        this.dom.viewerContainer.style.position = 'relative';
        // Set canvas background to black
        this.imageCtx.save();
        this.imageCtx.setTransform(1, 0, 0, 1, 0, 0);
        this.imageCtx.globalAlpha = 1.0;
        this.imageCtx.fillStyle = '#000';
        this.imageCtx.fillRect(0, 0, width, height);
        this.imageCtx.restore();
        // Draw the image
        this.imageCtx.save();
        this.imageCtx.translate(this.transform.dx, this.transform.dy);
        this.imageCtx.scale(this.transform.scale, this.transform.scale);
        this.imageCtx.drawImage(this.currentImage, 0, 0);
        this.imageCtx.restore();
        this.updateMinimap();
    }
    
    resetView(shouldDraw = true) {
        if (!this.currentImage) return;
        const container = this.dom.viewerContainer.getBoundingClientRect();
        const imgRatio = this.currentImage.width / this.currentImage.height;
        const containerRatio = container.width / container.height;
        this.transform.scale = (imgRatio > containerRatio)
            ? container.width / this.currentImage.width
            : container.height / this.currentImage.height;
        this.transform.dx = (container.width - this.currentImage.width * this.transform.scale) / 2;
        this.transform.dy = (container.height - this.currentImage.height * this.transform.scale) / 2; // 가운데 정렬
        this.updateZoomDisplay();
        if (shouldDraw) this.scheduleDraw();
    }

    handleResize() {
        this.scheduleDraw();
    }
    
    // --- PAN & ZOOM HANDLERS ---
    handleMouseDown(e) {
        if (this.gridMode) return; // grid 모드에서는 팬(이동) 비활성화
        if (e.button !== 0) return; // Only left-click
        this.isPanning = true;
        this.panStart.x = e.clientX - this.transform.dx;
        this.panStart.y = e.clientY - this.transform.dy;
        document.addEventListener('mousemove', this.boundHandleMouseMove);
        document.addEventListener('mouseup', this.boundHandleMouseUp);
        this.dom.viewerContainer.style.cursor = 'grabbing';
    }

    handleMouseUp() {
        if (this.gridMode) return;
        this.isPanning = false;
        this.dom.viewerContainer.style.cursor = 'grab';
        document.removeEventListener('mousemove', this.boundHandleMouseMove);
        document.removeEventListener('mouseup', this.boundHandleMouseUp);
    }

    handleMouseMove(e) {
        if (this.gridMode) return;
        if (!this.isPanning) return;
        this.transform.dx = e.clientX - this.panStart.x;
        this.transform.dy = e.clientY - this.panStart.y;
        this.scheduleDraw();
    }
    
    handleWheel(e) {
        // grid 모드에서는 뷰어 컨테이너 휠 이벤트 비활성화
        if (this.gridMode) return;
        
        if (e.ctrlKey) {
            e.preventDefault();
            const scaleAmount = 1 - e.deltaY * 0.001;
            this.zoomAtPoint(scaleAmount, e.clientX, e.clientY);
            this.scheduleDraw();
        } else if (e.shiftKey) {
            // allow native scroll as well as pan
            this.transform.dx -= e.deltaY; // move horizontally
            this.scheduleDraw();
            // do not preventDefault
        } else {
            // allow native scroll as well as pan
            this.transform.dy -= e.deltaY; // move vertically
            this.scheduleDraw();
            // do not preventDefault
        }
    }

    zoomAtPoint(scale, clientX, clientY) {
        const viewerRect = this.dom.viewerContainer.getBoundingClientRect();
        const x = clientX - viewerRect.left;
        const y = clientY - viewerRect.top;

        const newScale = this.transform.scale * scale;
        this.transform.dx = x - (x - this.transform.dx) * scale;
        this.transform.dy = y - (y - this.transform.dy) * scale;
        this.transform.scale = newScale;

        this.updateZoomDisplay();
        this.scheduleDraw();
    }
    
    zoomAtCenter(factor) {
        const viewerRect = this.dom.viewerContainer.getBoundingClientRect();
        this.zoomAtPoint(factor, viewerRect.left + viewerRect.width / 2, viewerRect.top + viewerRect.height / 2);
    }

    setZoom(level) {
        const scale = level;
        const currentScale = this.transform.scale;
        const factor = scale / currentScale;
        this.zoomAtCenter(factor);
    }
    
    updateZoomDisplay() {
        this.dom.zoomLevelInput.value = `${Math.round(this.transform.scale * 100)}%`;
    }

    // --- MINIMAP ---
    updateMinimap() {
        if (!this.currentImage) return;
        // 미니맵 크기 및 이미지 크기
        const mapW = this.dom.minimapCanvas.width = this.dom.minimapContainer.offsetWidth;
        const mapH = this.dom.minimapCanvas.height = this.dom.minimapContainer.offsetHeight;
        const imgW = this.currentImage.width;
        const imgH = this.currentImage.height;
        // 이미지 전체를 미니맵에 fit (pad 포함)
        const scale = Math.min(mapW / imgW, mapH / imgH);
        const padX = (mapW - imgW * scale) / 2;
        const padY = (mapH - imgH * scale) / 2;
        this.minimapCtx.clearRect(0, 0, mapW, mapH);
        this.minimapCtx.drawImage(this.currentImage, padX, padY, imgW * scale, imgH * scale);
        // 메인 뷰의 영역(이미지 좌표계) → 미니맵 좌표계로 변환
        const { width: viewW, height: viewH } = this.dom.viewerContainer.getBoundingClientRect();
        const viewScale = this.transform.scale;
        const viewX = -this.transform.dx / viewScale;
        const viewY = -this.transform.dy / viewScale;
        const vpX = padX + viewX * scale;
        const vpY = padY + viewY * scale;
        const vpW = viewW / viewScale * scale;
        const vpH = viewH / viewScale * scale;
        // 뷰포트 사각형 스타일 적용
        const vp = this.dom.minimapViewport.style;
        vp.left = `${vpX}px`;
        vp.top = `${vpY}px`;
        vp.width = `${vpW}px`;
        vp.height = `${vpH}px`;
        vp.display = 'block';
    }

    // --- SIDEBAR RESIZING ---
    handleSidebarDown(e) {
        e.preventDefault();
        document.addEventListener('mousemove', this.boundSidebarMove);
        document.addEventListener('mouseup', this.boundSidebarUp);
    }

    handleSidebarMove(e) {
        const newWidth = e.clientX;
        const maxWidth = window.innerWidth * MAX_SIDEBAR_WIDTH_RATIO;
        if (newWidth > MIN_SIDEBAR_WIDTH && newWidth < maxWidth) {
            this.dom.sidebar.style.width = newWidth + 'px';
            this.handleResize();
        }
    }

    handleSidebarUp() {
        document.removeEventListener('mousemove', this.boundSidebarMove);
        document.removeEventListener('mouseup', this.boundSidebarUp);
    }

    // --- CLASSIFICATION ---
    async initClassification() {
        this.selectedClass = null;
        this.selectedClasses = [];
        this.selectedImagePath = null;
        this.classSelection = { selected: [], lastClicked: null };
        this.initAddLabelModal();
        this.refreshClassList();
        this.dom.addClassBtn = document.getElementById('add-class-btn');
        this.dom.newClassInput = document.getElementById('new-class-input');
        this.dom.classList = document.getElementById('class-list');
        this.dom.labelStatus = document.getElementById('label-status');
        this.dom.deleteClassBtn = document.getElementById('delete-class-btn');
        this.dom.deleteClassBtn.addEventListener('click', () => this.deleteSelectedClasses());
        this.dom.addClassBtn.addEventListener('click', () => this.addClass());
        this.dom.newClassInput.addEventListener('keydown', e => {
            if (e.key === 'Enter') this.addClass();
        });
    }

    async refreshClassList() {
        const container = this.dom.classList;
        const scrollTop = container ? container.scrollTop : 0;
        const res = await fetch('/api/classes');
        const data = await res.json();
        const classes = Array.isArray(data.classes) ? data.classes.sort() : [];
        
        // Class Manager frame 클릭 시 선택 해제
        const classFrame = document.querySelector('.classification-frame');
        if (classFrame && !classFrame.hasAttribute('data-click-bound')) {
            classFrame.setAttribute('data-click-bound', 'true');
            classFrame.addEventListener('click', (e) => {
                // 버튼이 아닌 곳 클릭 시 선택 해제
                if (!e.target.closest('button') && !e.target.closest('input')) {
                    this.classSelection.selected = [];
                    this.classSelection.lastClicked = null;
                    this.selectedClass = null;
                    this.updateClassListSelection();
                }
            });
        }
        
        // 기존 버튼들과 새 클래스 목록 비교하여 부분 갱신
        const existingButtons = Array.from(container.children);
        const existingClasses = existingButtons.map(btn => btn.textContent);
        
        // 새로 추가된 클래스만 버튼 생성
        const newClasses = classes.filter(cls => !existingClasses.includes(cls));
        newClasses.forEach(cls => {
            const btn = document.createElement('button');
            btn.textContent = cls;
            btn.className = 'class-btn' + (this.selectedClass === cls ? ' selected' : '');
            btn.style.padding = '4px 14px';
            btn.style.background = this.classSelection?.selected.includes(cls) ? '#09f' : '#222';
            btn.style.color = this.classSelection?.selected.includes(cls) ? '#fff' : '#fff';
            btn.style.border = this.classSelection?.selected.includes(cls) ? '2px solid #09f' : '1px solid #444';
            btn.style.borderRadius = '6px';
            btn.style.fontWeight = '500';
            btn.style.fontSize = '15px';
            btn.style.marginRight = '2px';
            btn.style.cursor = 'pointer';
            btn.style.display = 'flex';
            btn.style.flexWrap = 'wrap';
            btn.style.gap = '12px 12px';
            btn.onclick = async (e) => {
                const isCtrl = e.ctrlKey || e.metaKey;
                const isShift = e.shiftKey;
                if (!isCtrl && !isShift) {
                    // grid 모드: 선택된 이미지들 모두 라벨링
                    if (this.gridMode && this.gridSelectedIdxs && this.gridSelectedIdxs.length > 0) {
                        this.selectedClass = cls;
                        if (this.dom.labelStatus) this.dom.labelStatus.textContent = '';
                        for (const idx of this.gridSelectedIdxs) {
                            const path = this.selectedImages[idx];
                            await fetch('/api/classify', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ class_name: this.selectedClass, image_path: path })
                            });
                        }
                        // 버튼 색상 피드백
                        const originalBg = btn.style.background;
                        btn.style.background = '#2ecc40';
                        setTimeout(() => {
                            btn.style.background = originalBg;
                            this.refreshLabelExplorer();
                        }, 200);
                        return;
                    }
                    // 단일 이미지 모드: 기존 동작 유지
                    if (this.selectedImagePath) {
                        this.selectedClass = cls;
                        if (this.dom.labelStatus) this.dom.labelStatus.textContent = '';
                        await this.labelImage();
                        const originalBg = btn.style.background;
                        btn.style.background = '#2ecc40';
                        setTimeout(() => {
                            btn.style.background = originalBg;
                            this.refreshLabelExplorer();
                        }, 200);
                        return;
                    } else {
                        this.selectedClass = cls;
                        this.classSelection.selected = [];
                        this.classSelection.lastClicked = null;
                        this.updateClassListSelection();
                        return;
                    }
                }
                // Ctrl/Shift: 다중 선택(삭제용)
                if (isShift && this.classSelection.lastClicked !== null) {
                    const all = classes;
                    const lastIdx = all.indexOf(this.classSelection.lastClicked);
                    const thisIdx = all.indexOf(cls);
                    if (lastIdx !== -1 && thisIdx !== -1) {
                        const [from, to] = [lastIdx, thisIdx].sort((a,b)=>a-b);
                        const range = all.slice(from, to+1);
                        this.classSelection.selected = Array.from(new Set([...this.classSelection.selected, ...range]));
                    }
                } else if (isCtrl) {
                    if (this.classSelection.selected.includes(cls)) {
                        this.classSelection.selected = this.classSelection.selected.filter(k => k !== cls);
                    } else {
                        this.classSelection.selected = [...this.classSelection.selected, cls];
                    }
                    this.classSelection.lastClicked = cls;
                }
                this.selectedClass = this.classSelection.selected.length === 1 ? this.classSelection.selected[0] : null;
                this.dom.deleteClassBtn.disabled = false;
                this.updateClassListSelection();
            };
            container.appendChild(btn);
        });
        
        // 삭제된 클래스의 버튼 제거
        const deletedClasses = existingClasses.filter(cls => !classes.includes(cls));
        deletedClasses.forEach(cls => {
            const btn = existingButtons.find(b => b.textContent === cls);
            if (btn) btn.remove();
        });
        
        // 선택 상태 업데이트
        this.updateClassListSelection();
        
        // 스크롤 위치 복원
        if (container) container.scrollTop = scrollTop;
    }

    updateClassListSelection() {
        // 기존 버튼들의 선택 상태만 업데이트
        const buttons = this.dom.classList.querySelectorAll('button');
        buttons.forEach(btn => {
            const cls = btn.textContent;
            btn.className = 'class-btn' + (this.selectedClass === cls ? ' selected' : '');
            btn.style.background = this.classSelection?.selected.includes(cls) ? '#09f' : '#222';
            btn.style.border = this.classSelection?.selected.includes(cls) ? '2px solid #09f' : '1px solid #444';
        });
    }

    async addClass() {
        const names = this.dom.newClassInput.value.split(',').map(s => s.trim()).filter(Boolean);
        if (!names.length) return;
        
        // 즉시 버튼 피드백 제공
        const addBtn = this.dom.addClassBtn;
        const originalText = addBtn?.textContent || 'Add Class';
        if (addBtn) {
            addBtn.textContent = '추가 중...';
            addBtn.disabled = true;
            addBtn.style.opacity = '0.6';
        }
        
        try {
            console.log(`Adding classes: ${names.join(', ')}`);
            
            for (const name of names) {
                await fetch('/api/classes', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ name })
                });
            }
            
            this.dom.newClassInput.value = '';
            await this.refreshClassList();
            await this.refreshLabelExplorer();
            
            console.log(`Successfully added ${names.length} classes`);
        } catch (error) {
            console.error('클래스 추가 실패:', error);
            alert('클래스 추가에 실패했습니다.');
        } finally {
            // 버튼 상태 복원
            if (addBtn) {
                addBtn.textContent = originalText;
                addBtn.disabled = false;
                addBtn.style.opacity = '1';
            }
        }
    }

    async labelImage() {
        const container = document.getElementById('label-explorer-list');
        if (this.gridMode && this.gridSelectedIdxs && this.gridSelectedIdxs.length > 0 && this.selectedClass) {
            for (const idx of this.gridSelectedIdxs) {
                const path = this.selectedImages[idx];
                await fetch('/api/classify', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ class_name: this.selectedClass, image_path: path })
                });
            }
            this.refreshLabelExplorer();
            this.refreshClassList();
        } else if (this.selectedClass && this.selectedImagePath) {
            const res = await fetch('/api/classify', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ class_name: this.selectedClass, image_path: this.selectedImagePath })
            });
            if (res.ok) {
                // Explorer에서 classification/클래스 폴더 자동 오픈
                const explorer = this.dom.fileExplorer;
                const classSummary = explorer.querySelector(`summary[data-path="classification/${this.selectedClass}"]`);
                if (classSummary) {
                    classSummary.parentElement.open = true;
                    this.loadDirectoryContents(`classification/${this.selectedClass}`, classSummary.nextElementSibling);
                }
            }
        }
    }

    async deleteSelectedClasses() {
        let names = this.classSelection.selected;
        
        // 선택된 클래스가 없으면 텍스트박스에서 쉼표로 구분된 클래스들 가져오기
        if (names.length === 0) {
            const input = this.dom.newClassInput.value.trim();
            if (input) {
                names = input.split(',').map(s => s.trim()).filter(Boolean);
            }
        }
        
        if (names.length === 0) {
            alert('Please select classes or enter class names separated by commas');
            return;
        }
        
        const confirmMessage = names.length === 1 
            ? `Delete class "${names[0]}" and all its images?`
            : `Delete ${names.length} classes (${names.join(', ')}) and all their images?`;
            
        if (!confirm(confirmMessage)) return;
        
        console.log(`Deleting classes: ${names.join(', ')}`);
        
        await fetch('/api/classes/delete', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ names })
        });
        
        // 텍스트박스도 클리어
        this.dom.newClassInput.value = '';
        this.selectedClass = null;
        this.classSelection.selected = [];
        this.classSelection.lastClicked = null;
        
        await this.refreshClassList();
        await this.refreshLabelExplorer();
        this.loadDirectoryContents(null, this.dom.fileExplorer);
        
        console.log(`Successfully deleted ${names.length} classes`);
    }

    // --- ADD LABEL MODAL ---
    initAddLabelModal() {
        const modal = document.getElementById('add-label-modal');
        const closeBtn = modal.querySelector('.modal-close');
        const cancelBtn = document.getElementById('modal-cancel');
        const addBtn = document.getElementById('modal-add-label');
        const removeBtn = document.getElementById('modal-remove-labels');
        const classSelect = document.getElementById('modal-class-select');
        const newClassInput = document.getElementById('modal-new-class-input');
        
        // 선택된 라벨 목록 초기화
        this.selectedLabelsForRemoval = [];
        
        // 모달 닫기 이벤트들
        closeBtn.onclick = () => this.closeAddLabelModal();
        cancelBtn.onclick = () => this.closeAddLabelModal();
        
        // 모달 배경 클릭시 닫기
        modal.onclick = (e) => {
            if (e.target === modal) this.closeAddLabelModal();
        };
        
        // Add Label 버튼
        addBtn.onclick = async () => {
            await this.addLabelFromModal();
        };
        
        // Remove Selected Labels 버튼
        if (removeBtn) {
            removeBtn.onclick = async () => {
                await this.removeSelectedLabels();
            };
        }
        
        // 드롭다운과 새 클래스 입력 필드 상호작용
        classSelect.onchange = () => {
            if (classSelect.value) {
                newClassInput.value = '';
            }
        };
        
        newClassInput.oninput = () => {
            if (newClassInput.value.trim()) {
                classSelect.value = '';
            }
        };
        
        // Enter 키로 라벨 추가
        newClassInput.onkeydown = (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                this.addLabelFromModal();
            }
        };
        
        // ESC 키로 모달 닫기
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && modal.style.display === 'flex') {
                this.closeAddLabelModal();
            }
        });
    }
    
    getSelectedImagesForModal() {
        // 그리드 모드에서 선택된 이미지들 반환
        if (this.gridMode && this.gridSelectedIdxs && this.gridSelectedIdxs.length > 0) {
            return this.gridSelectedIdxs.map(idx => this.selectedImages[idx]).filter(Boolean);
        }
        // 단일 이미지 모드에서는 현재 선택된 이미지 반환
        if (this.selectedImagePath) {
            return [this.selectedImagePath];
        }
        return [];
    }

    toggleLabelSelection(labelDiv) {
        const isSelected = labelDiv.classList.contains('selected');
        
        if (isSelected) {
            labelDiv.classList.remove('selected');
            const className = labelDiv.dataset.className;
            this.selectedLabelsForRemoval = this.selectedLabelsForRemoval.filter(item => item.className !== className);
        } else {
            labelDiv.classList.add('selected');
            const className = labelDiv.dataset.className;
            const fileNames = JSON.parse(labelDiv.dataset.fileNames);
            this.selectedLabelsForRemoval.push({ className, fileNames });
        }
        
        this.updateRemoveLabelButton();
    }

    showRemoveLabelButton() {
        const removeBtn = document.getElementById('modal-remove-labels');
        if (removeBtn) {
            removeBtn.style.display = 'block';
        }
    }

    hideRemoveLabelButton() {
        const removeBtn = document.getElementById('modal-remove-labels');
        if (removeBtn) {
            removeBtn.style.display = 'none';
        }
    }

    updateRemoveLabelButton() {
        const removeBtn = document.getElementById('modal-remove-labels');
        if (removeBtn) {
            const count = this.selectedLabelsForRemoval ? this.selectedLabelsForRemoval.length : 0;
            removeBtn.textContent = count > 0 ? `Remove Selected (${count})` : 'Remove Selected';
            removeBtn.disabled = count === 0;
        }
    }

    async removeSelectedLabels() {
        if (!this.selectedLabelsForRemoval || this.selectedLabelsForRemoval.length === 0) {
            alert('Please select labels to remove');
            return;
        }

        const totalToRemove = this.selectedLabelsForRemoval.reduce((sum, item) => sum + item.fileNames.length, 0);
        
        if (!confirm(`Remove ${totalToRemove} labels from ${this.selectedLabelsForRemoval.length} classes?`)) {
            return;
        }

        try {
            // 선택된 라벨들 제거
            for (const labelGroup of this.selectedLabelsForRemoval) {
                for (const fileName of labelGroup.fileNames) {
                    await fetch('/api/classify/delete', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ 
                            class_name: labelGroup.className, 
                            image_name: fileName 
                        })
                    });
                }
            }

            alert(`Successfully removed ${totalToRemove} labels!`);
            
            // 기존 라벨 목록 새로고침
            const selectedImages = this.getSelectedImagesForModal();
            const existingLabelsList = document.getElementById('existing-labels-list');
            await this.loadExistingLabels(existingLabelsList, selectedImages);
            
            // UI 업데이트
            this.updateLabelExplorerContent();
            
        } catch (error) {
            console.error('Failed to remove labels:', error);
            alert('Failed to remove labels');
        }
    }

    async openAddLabelModal() {
        const modal = document.getElementById('add-label-modal');
        const classSelect = document.getElementById('modal-class-select');
        const newClassInput = document.getElementById('modal-new-class-input');
        const currentImageInfo = document.getElementById('current-image-info');
        const existingLabelsList = document.getElementById('existing-labels-list');
        
        // 선택된 이미지들 정보 표시
        const selectedImages = this.getSelectedImagesForModal();
        if (selectedImages.length > 0) {
            if (selectedImages.length === 1) {
                const fileName = selectedImages[0].split('/').pop();
                currentImageInfo.textContent = fileName;
            } else {
                currentImageInfo.textContent = `${selectedImages.length} images selected`;
                currentImageInfo.innerHTML = `<strong>${selectedImages.length} images selected:</strong><br>` +
                    selectedImages.slice(0, 3).map(path => path.split('/').pop()).join(', ') +
                    (selectedImages.length > 3 ? ` and ${selectedImages.length - 3} more...` : '');
            }
        } else {
            currentImageInfo.textContent = 'No image selected';
        }
        
        // 클래스 목록 로드
        try {
            const res = await fetch('/api/classes');
            const data = await res.json();
            const classes = (data.classes || []).sort();
            
            classSelect.innerHTML = '<option value="">-- Select a class --</option>';
            classes.forEach(cls => {
                const option = document.createElement('option');
                option.value = cls;
                option.textContent = cls;
                if (cls === this.selectedClass) {
                    option.selected = true;
                }
                classSelect.appendChild(option);
            });
        } catch (error) {
            console.error('Failed to load classes:', error);
        }
        
        // 새 클래스 입력 필드 초기화
        newClassInput.value = '';
        
        // 기존 라벨 목록 로드
        await this.loadExistingLabels(existingLabelsList, selectedImages);
        
        modal.style.display = 'flex';
    }
    
    async loadExistingLabels(container, selectedImages) {
        if (!selectedImages || selectedImages.length === 0) {
            container.textContent = 'No image selected';
            return;
        }
        
        try {
            // 모든 클래스에서 선택된 이미지들의 라벨 찾기
            const res = await fetch('/api/classes');
            const data = await res.json();
            const classes = (data.classes || []).sort();
            
            const existingLabels = [];
            
            for (const imagePath of selectedImages) {
                const fileName = imagePath.split('/').pop();
                
                for (const cls of classes) {
                    try {
                        const filesRes = await fetch(`/api/files?path=classification/${encodeURIComponent(cls)}`);
                        const filesData = await filesRes.json();
                        const files = filesData.items || [];
                        
                        if (files.some(file => file.name === fileName)) {
                            existingLabels.push({
                                className: cls,
                                fileName: fileName,
                                imagePath: imagePath
                            });
                        }
                    } catch (err) {
                        // 클래스 폴더가 없을 수 있음
                    }
                }
            }
            
            if (existingLabels.length === 0) {
                container.textContent = selectedImages.length === 1 
                    ? 'No labels found for this image'
                    : 'No labels found for selected images';
                this.hideRemoveLabelButton();
            } else {
                container.innerHTML = '';
                
                // 클래스별로 그룹화
                const groupedLabels = {};
                existingLabels.forEach(label => {
                    if (!groupedLabels[label.className]) {
                        groupedLabels[label.className] = [];
                    }
                    groupedLabels[label.className].push(label.fileName);
                });
                
                // 그룹화된 라벨 표시 (선택 가능)
                Object.entries(groupedLabels).forEach(([className, fileNames]) => {
                    const labelDiv = document.createElement('div');
                    labelDiv.className = 'label-item selectable';
                    labelDiv.innerHTML = `<strong>${className}:</strong> ${fileNames.join(', ')}`;
                    labelDiv.dataset.className = className;
                    labelDiv.dataset.fileNames = JSON.stringify(fileNames);
                    
                    // 클릭 이벤트 추가
                    labelDiv.onclick = () => this.toggleLabelSelection(labelDiv);
                    
                    container.appendChild(labelDiv);
                });
                
                this.showRemoveLabelButton();
            }
            
            // 선택된 라벨 목록 초기화
            this.selectedLabelsForRemoval = [];
            this.updateRemoveLabelButton();
            
        } catch (error) {
            console.error('Failed to load existing labels:', error);
            container.textContent = 'Error loading labels';
            this.hideRemoveLabelButton();
        }
    }
    
    closeAddLabelModal() {
        const modal = document.getElementById('add-label-modal');
        const actionRadios = document.querySelectorAll('input[name="label-action"]');
        const newClassInput = document.getElementById('modal-new-class-input');
        const classSelect = document.getElementById('modal-class-select');
        
        // 모달 상태 초기화
        modal.style.display = 'none';
        
        // 라디오 버튼 초기화 (첫 번째 옵션 선택)
        actionRadios.forEach((radio, index) => {
            radio.checked = index === 0; // 'add-all' 옵션을 기본으로 선택
        });
        
        if (newClassInput) newClassInput.value = '';
        if (classSelect) classSelect.value = '';
        
        // 선택된 라벨 목록 초기화
        this.selectedLabelsForRemoval = [];
        
        // 기존 라벨 선택 상태 초기화
        const labelItems = document.querySelectorAll('#existing-labels-list .label-item.selected');
        labelItems.forEach(item => item.classList.remove('selected'));
        
        this.hideRemoveLabelButton();
    }
    
    async addLabelFromModal() {
        const classSelect = document.getElementById('modal-class-select');
        const newClassInput = document.getElementById('modal-new-class-input');
        const actionRadios = document.querySelectorAll('input[name="label-action"]');
        const selectedAction = Array.from(actionRadios).find(radio => radio.checked)?.value || 'add-all';
        
        // 선택된 클래스 또는 새 클래스명 확인
        const selectedClass = classSelect.value.trim();
        const newClassName = newClassInput.value.trim();
        
        let finalClassName = '';
        if (selectedClass && newClassName) {
            alert('Please select either an existing class or enter a new class name, not both');
            return;
        } else if (selectedClass) {
            finalClassName = selectedClass;
        } else if (newClassName) {
            finalClassName = newClassName;
        } else {
            alert('Please select a class or enter a new class name');
            return;
        }
        
        // 선택된 이미지들 가져오기
        const selectedImages = this.getSelectedImagesForModal();
        if (selectedImages.length === 0) {
            alert('Please select at least one image');
            return;
        }
        
        try {
            // 새 클래스인 경우 먼저 클래스 생성
            if (newClassName) {
                await fetch('/api/classes', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ name: finalClassName })
                });
            }
            
            let imagesToProcess = selectedImages;
            let removedCount = 0;
            let skippedCount = 0;
            
            // 액션에 따른 처리
            if (selectedAction === 'skip-existing') {
                // "존재하지 않는 라벨만 추가" 
                try {
                    const filesRes = await fetch(`/api/files?path=classification/${encodeURIComponent(finalClassName)}`);
                    const filesData = await filesRes.json();
                    const existingFiles = filesData.items ? filesData.items.map(f => f.name) : [];
                    
                    // 이미 라벨이 있는 이미지들 제외
                    imagesToProcess = selectedImages.filter(imagePath => {
                        const fileName = imagePath.split('/').pop();
                        return !existingFiles.includes(fileName);
                    });
                    
                    skippedCount = selectedImages.length - imagesToProcess.length;
                    
                    if (imagesToProcess.length === 0) {
                        alert(`All selected images already have the "${finalClassName}" label!`);
                        return;
                    }
                } catch (err) {
                    // 클래스 폴더가 없으면 모든 이미지 처리
                    console.log(`Class folder not found, processing all images`);
                }
            } else if (selectedAction === 'remove-and-add') {
                // "기존 라벨 제거 후 새 라벨 추가"
                
                // 먼저 모든 클래스에서 선택된 이미지들의 기존 라벨 제거
                const res = await fetch('/api/classes');
                const data = await res.json();
                const allClasses = (data.classes || []).sort();
                
                for (const cls of allClasses) {
                    if (cls === finalClassName) continue; // 추가할 클래스는 제외
                    
                    try {
                        const filesRes = await fetch(`/api/files?path=classification/${encodeURIComponent(cls)}`);
                        const filesData = await filesRes.json();
                        const files = filesData.items || [];
                        
                        for (const imagePath of selectedImages) {
                            const fileName = imagePath.split('/').pop();
                            if (files.some(file => file.name === fileName)) {
                                await fetch('/api/classify/delete', {
                                    method: 'POST',
                                    headers: { 'Content-Type': 'application/json' },
                                    body: JSON.stringify({ 
                                        class_name: cls, 
                                        image_name: fileName 
                                    })
                                });
                                removedCount++;
                            }
                        }
                    } catch (err) {
                        // 클래스 폴더가 없을 수 있음
                    }
                }
            }
            // selectedAction === 'add-all'인 경우는 모든 이미지에 추가 (기본 동작)
            
            // 처리할 이미지들에 라벨 추가
            const promises = imagesToProcess.map(imagePath =>
                fetch('/api/classify', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        class_name: finalClassName,
                        image_path: imagePath
                    })
                })
            );
            
            await Promise.all(promises);
            
            // 성공 메시지
            const processedCount = imagesToProcess.length;
            let message = `Label "${finalClassName}" added to ${processedCount} image${processedCount > 1 ? 's' : ''} successfully!`;
            
            if (selectedAction === 'skip-existing' && skippedCount > 0) {
                message += ` (Skipped ${skippedCount} image${skippedCount > 1 ? 's' : ''} that already had this label)`;
            } else if (selectedAction === 'remove-and-add' && removedCount > 0) {
                message += ` (Removed ${removedCount} existing label${removedCount > 1 ? 's' : ''} from other classes)`;
            }
            
            alert(message);
            
            // 모달 닫기
            this.closeAddLabelModal();
            
            // UI 업데이트
            this.updateLabelExplorerContent();
            await this.refreshClassList();
            
        } catch (error) {
            console.error('Failed to add label:', error);
            alert('Failed to add label');
        }
    }

    // --- LABEL EXPLORER ---
    async refreshLabelExplorer() {
        const container = document.getElementById('label-explorer-list');
        const scrollTop = container ? container.scrollTop : 0;
        
        // 기존 내용을 임시로 저장하여 스크롤 위치 유지
        const existingContent = container.innerHTML;
        
        const batchLabelBtn = document.getElementById('label-explorer-batch-label-btn');
        const batchDeleteBtn = document.getElementById('label-explorer-batch-delete-btn');
        const res = await fetch('/api/classes');
        const data = await res.json();
        const classes = Array.isArray(data.classes) ? data.classes.sort() : [];
        if (!this.labelSelection) this.labelSelection = { selected: [], lastClicked: null, openFolders: {}, selectedClasses: [] };
        const labelSelection = this.labelSelection;
        
        console.log('Label Explorer 초기화:', {
            labelSelection: labelSelection,
            classes: classes.length,
            gridMode: this.gridMode
        });
        // 기본: 모든 클래스 폴더 open
        for (const cls of classes) {
            if (labelSelection.openFolders[cls] === undefined) labelSelection.openFolders[cls] = true;
        }
        // --- 모든 이미지의 flat 리스트 생성 ---
        let flatImageButtons = [];
        let classToImgList = {};
        await Promise.all(classes.map(async cls => {
            const imgRes = await fetch(`/api/files?path=classification/${encodeURIComponent(cls)}`);
            const imgData = await imgRes.json();
            const imgList = Array.isArray(imgData.items) ? imgData.items : [];
            classToImgList[cls] = imgList;
        }));
        
        // --- 빈 곳 클릭 시 Label Explorer만 선택 해제 (Wafer Map Explorer 선택 유지) ---
        container.onclick = (e) => {
            // 빈 영역을 클릭했을 때만 (버튼이나 다른 요소가 아닌)
            if (e.target === container || 
                (e.target.tagName === 'UL' && e.target.closest('#label-explorer-list'))) {
                
                // Ctrl/Shift 없이 클릭: Label Explorer만 선택 해제 (Wafer Map Explorer 선택 유지)
                if (!e.ctrlKey && !e.shiftKey) {
                    labelSelection.selected = [];
                    labelSelection.selectedClasses = [];
                    this.updateLabelExplorerSelection();
                    // Wafer Map Explorer 선택은 유지하도록 clearWaferMapExplorerSelection() 호출 제거
                    console.log('Label Explorer: 빈 영역 클릭으로 Label Explorer만 선택 해제 (Wafer Map Explorer 선택 유지)');
                }
            }
        };
        
        // --- 우클릭으로 Label Explorer만 선택 해제 ---
        container.oncontextmenu = (e) => {
            e.preventDefault();
            labelSelection.selected = [];
            labelSelection.selectedClasses = [];
            this.updateLabelExplorerSelection();
            // Wafer Map Explorer 선택은 유지하도록 clearWaferMapExplorerSelection() 호출 제거
            console.log('Label Explorer: 우클릭으로 Label Explorer만 선택 해제 (Wafer Map Explorer 선택 유지)');
        };
        
        // --- 키보드 단축키 (Label Explorer 전용) ---
        this.setupLabelExplorerKeyboardShortcuts(classes, classToImgList, labelSelection);
        // Label Explorer 프레임(여백) 클릭 시 전체 선택 해제 (Windows 탐색기 스타일)
        const frame = document.querySelector('.label-explorer-frame');
        if (frame && !frame.hasAttribute('data-click-bound')) {
            frame.setAttribute('data-click-bound', 'true');
            frame.onclick = (e) => {
                // 프레임 자체를 클릭하고, Ctrl/Shift가 없을 때만 Label Explorer만 선택 해제
                if (e.target === frame && !e.ctrlKey && !e.shiftKey) {
                    labelSelection.selected = [];
                    labelSelection.selectedClasses = [];
                    this.updateLabelExplorerSelection();
                    // Wafer Map Explorer 선택은 유지하도록 clearWaferMapExplorerSelection() 호출 제거
                    console.log('Label Explorer 프레임: 빈 영역 클릭으로 Label Explorer만 선택 해제 (Wafer Map Explorer 선택 유지)');
                }
            };
            
            // 프레임 우클릭도 추가 (Windows 탐색기와 일관성)
            frame.oncontextmenu = (e) => {
                if (e.target === frame) {
                    e.preventDefault();
                    labelSelection.selected = [];
                    labelSelection.selectedClasses = [];
                    this.updateLabelExplorerSelection();
                    // Wafer Map Explorer 선택은 유지하도록 clearWaferMapExplorerSelection() 호출 제거
                    console.log('Label Explorer 프레임: 우클릭으로 Label Explorer만 선택 해제 (Wafer Map Explorer 선택 유지)');
                }
            };
        }
        // Add Label 버튼: 모달 창 열기
        batchLabelBtn.disabled = false;
        batchLabelBtn.onclick = async () => {
            await this.openAddLabelModal();
        };
        // Delete Label 버튼: 항상 활성화
        batchDeleteBtn.disabled = false;
        batchDeleteBtn.onclick = async () => {
            if (labelSelection.selectedClasses.length === 0 && labelSelection.selected.length === 0) {
                alert('삭제할 라벨을 선택해주세요.');
                return;
            }
            
            let deleted = false;
            let totalToDelete = 0;
            
            // 클래스 선택: 해당 클래스 폴더 안의 모든 라벨 삭제 (클래스는 유지)
            if (labelSelection.selectedClasses.length) {
                for (const cls of labelSelection.selectedClasses) {
                    const imgRes = await fetch(`/api/files?path=classification/${encodeURIComponent(cls)}`);
                    const imgData = await imgRes.json();
                    const imgList = Array.isArray(imgData.items) ? imgData.items : [];
                    const files = imgList.filter(f => f.type === 'file');
                    totalToDelete += files.length;
                }
                
                if (totalToDelete > 0) {
                    if (!confirm(`Delete ${totalToDelete} labels from selected classes? (Classes will remain)`)) return;
                    
                    for (const cls of labelSelection.selectedClasses) {
                        const imgRes = await fetch(`/api/files?path=classification/${encodeURIComponent(cls)}`);
                        const imgData = await imgRes.json();
                        const imgList = Array.isArray(imgData.items) ? imgData.items : [];
                        const files = imgList.filter(f => f.type === 'file');
                        
                        for (const img of files) {
                            await fetch('/api/classify/delete', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ class_name: cls, image_name: img.name })
                            });
                        }
                    }
                    deleted = true;
                }
                labelSelection.selectedClasses = [];
            }
            
            // 이미지 선택: 해당 라벨만 삭제
            if (labelSelection.selected.length) {
                if (!deleted && !confirm(`Delete ${labelSelection.selected.length} labels?`)) return;
                for (const key of labelSelection.selected) {
                    const [delCls, delImg] = key.split('/');
                    await fetch('/api/classify/delete', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ class_name: delCls, image_name: delImg })
                    });
                }
                labelSelection.selected = [];
                deleted = true;
            }
            
            if (deleted) {
                this.updateLabelExplorerContent();
            }
        };
        
        // 전체 내용을 다시 렌더링하되 스크롤 위치 유지
        this.renderLabelExplorerContent(container, classes, classToImgList, labelSelection);
        
        // 스크롤 위치 복원
        if (container) container.scrollTop = scrollTop;
    }

    renderLabelExplorerContent(container, classes, classToImgList, labelSelection) {
        container.innerHTML = '';
        
        // 전체 이미지들의 평평한 리스트 생성 (shift 선택용)
        let flatImageList = [];
        for (const cls of classes) {
            const imgList = classToImgList[cls] || [];
            for (const img of imgList) {
                if (img.type === 'file') {
                    flatImageList.push({ key: `${cls}/${img.name}`, className: cls, imgName: img.name });
                }
            }
        }
        
        // 트리 구조 렌더링
        const ul = document.createElement('ul');
        ul.style.listStyle = 'none';
        ul.style.paddingLeft = '0';
        for (const cls of classes) {
            const li = document.createElement('li');
            li.style.marginBottom = '4px';
            // 폴더 summary
            const folderSummary = document.createElement('div');
            folderSummary.style.cursor = 'pointer';
            folderSummary.style.display = 'flex';
            folderSummary.style.alignItems = 'center';
            folderSummary.style.userSelect = 'none';
            folderSummary.style.fontWeight = 'bold';
            folderSummary.style.fontSize = '15px';
            folderSummary.style.color = '#fff';
            folderSummary.style.padding = '2px 0';
            // 선택 강조
            const isClassSelected = labelSelection.selectedClasses.includes(cls);
            if (isClassSelected) {
                folderSummary.style.background = '#09f';
                folderSummary.style.color = '#fff';
                folderSummary.style.borderRadius = '6px';
            }
            const isOpen = labelSelection.openFolders[cls];
            folderSummary.innerHTML = `<span style=\"font-size:16px; margin-right:4px;\">${isOpen ? '▾' : '▸'}</span>${cls}`;
            folderSummary.onclick = (e) => {
                const isCtrl = e.ctrlKey || e.metaKey;
                const isShift = e.shiftKey;
                
                // 다른 Explorer 선택 해제
                try {
                    this.clearWaferMapExplorerSelection();
                } catch (error) {
                    console.warn('clearWaferMapExplorerSelection error:', error);
                }
                
                // 아무 modifier 없이 클릭: 열기/닫기 토글만
                if (!isCtrl && !isShift) {
                    labelSelection.openFolders[cls] = !isOpen;
                    this.updateLabelExplorerContent();
                    return;
                }
                
                // Ctrl/Shift로 클릭: 클래스 선택 (이미지 선택은 해제)
                labelSelection.selected = []; // 이미지 선택 해제
                
                if (isShift && labelSelection.lastClickedClass !== null) {
                    // Shift+클릭: 범위 선택
                    const all = classes;
                    const lastIdx = all.indexOf(labelSelection.lastClickedClass);
                    const thisIdx = all.indexOf(cls);
                    if (lastIdx !== -1 && thisIdx !== -1) {
                        const [from, to] = [lastIdx, thisIdx].sort((a,b)=>a-b);
                        const range = all.slice(from, to+1);
                        labelSelection.selectedClasses = Array.from(new Set([...labelSelection.selectedClasses, ...range]));
                    }
                } else if (isCtrl) {
                    // Ctrl+클릭: 토글 선택
                    if (labelSelection.selectedClasses.includes(cls)) {
                        labelSelection.selectedClasses = labelSelection.selectedClasses.filter(k => k !== cls);
                    } else {
                        labelSelection.selectedClasses = [...labelSelection.selectedClasses, cls];
                    }
                    labelSelection.lastClickedClass = cls;
                }
                
                // 클래스 선택에 따른 그리드 모드 전환
                if (labelSelection.selectedClasses.length === 1) {
                    // 단일 클래스 선택: 해당 클래스의 모든 이미지를 그리드로 표시
                    const selectedClass = labelSelection.selectedClasses[0];
                    console.log(`Label Explorer: 클래스 '${selectedClass}' → 그리드 모드`);
                    this.showGridFromClass(selectedClass);
                } else if (labelSelection.selectedClasses.length > 1) {
                    // 다중 클래스 선택: 모든 선택된 클래스의 이미지를 그리드로 표시
                    console.log(`Label Explorer: ${labelSelection.selectedClasses.length}개 클래스 → 그리드 모드`);
                    this.showGridFromMultipleClasses(labelSelection.selectedClasses);
                } else {
                    // 클래스 선택 없음: 그리드 모드 해제
                    if (this.gridMode) {
                        console.log('Label Explorer: 클래스 선택 해제 → 그리드 모드 종료');
                        this.hideGrid();
                    }
                }
                
                this.updateLabelExplorerContent();
            };
            li.appendChild(folderSummary);
            // 이미지 리스트(펼쳐진 경우만)
            if (isOpen) {
                const imgUl = document.createElement('ul');
                imgUl.style.listStyle = 'none';
                imgUl.style.paddingLeft = '18px';
                imgUl.style.margin = '0';
                // robust: ul 내부 어디든(버튼/텍스트 제외) 클릭 시 선택 해제
                imgUl.addEventListener('click', (e) => {
                    // 버튼/텍스트/이미지 아닌 곳만
                    if (e.target === imgUl) {
                        labelSelection.selected = [];
                        labelSelection.selectedClasses = [];
                        
                        // 그리드 모드 해제
                        if (this.gridMode) {
                            console.log('Label Explorer: 선택 해제 → 그리드 모드 종료');
                            this.hideGrid();
                        }
                        
                        this.updateLabelExplorerContent();
                    }
                }, true); // capture phase로 등록
                const imgList = classToImgList[cls] || [];
                for (let i = 0; i < imgList.length; ++i) {
                    const img = imgList[i];
                    if (img.type !== 'file') continue;
                    const imgLi = document.createElement('li');
                    imgLi.style.display = 'flex';
                    imgLi.style.alignItems = 'center';
                    imgLi.style.margin = '2px 0';
                    const imgBtn = document.createElement('button');
                    imgBtn.textContent = img.name;
                    imgBtn.className = 'label-img-name';
                    imgBtn.style.cursor = 'pointer';
                    imgBtn.style.padding = '4px 12px';
                    imgBtn.style.background = labelSelection.selected.includes(`${cls}/${img.name}`) ? '#09f' : '#222';
                    imgBtn.style.color = '#fff';
                    imgBtn.style.border = labelSelection.selected.includes(`${cls}/${img.name}`) ? '2px solid #09f' : '1px solid #444';
                    imgBtn.style.borderRadius = '6px';
                    imgBtn.style.marginRight = '4px';
                    imgBtn.style.fontSize = '13px';
                    imgBtn.onclick = (e) => {
                        const isCtrl = e.ctrlKey || e.metaKey;
                        const isShift = e.shiftKey;
                        const key = `${cls}/${img.name}`;
                        
                        // 다른 Explorer 선택 해제
                        try {
                            this.clearWaferMapExplorerSelection();
                        } catch (error) {
                            console.warn('clearWaferMapExplorerSelection error:', error);
                        }
                        
                        if (isShift && labelSelection.lastClicked !== null) {
                            // Shift+클릭: 범위 선택
                            const lastIdx = flatImageList.findIndex(item => item.key === labelSelection.lastClicked);
                            const thisIdx = flatImageList.findIndex(item => item.key === key);
                            if (lastIdx !== -1 && thisIdx !== -1) {
                                const [from, to] = [lastIdx, thisIdx].sort((a,b)=>a-b);
                                const range = flatImageList.slice(from, to+1).map(item => item.key);
                                labelSelection.selected = Array.from(new Set([...labelSelection.selected, ...range]));
                            }
                        } else if (isCtrl) {
                            // Ctrl+클릭: 토글 선택
                            if (labelSelection.selected.includes(key)) {
                                labelSelection.selected = labelSelection.selected.filter(k => k !== key);
                            } else {
                                labelSelection.selected = [...labelSelection.selected, key];
                            }
                            labelSelection.lastClicked = key;
                        } else {
                            // 단일 클릭: 이미 선택된 항목이면 해제, 다른 항목이면 새로 선택
                            if (labelSelection.selected.includes(key) && labelSelection.selected.length === 1) {
                                // 유일하게 선택된 항목을 다시 클릭: 해제
                                labelSelection.selected = [];
                                labelSelection.lastClicked = null;
                            } else {
                                // 새로운 항목 클릭 또는 다중 선택 상태: 기존 선택 해제 후 새로 선택
                                labelSelection.selected = [key];
                                labelSelection.lastClicked = key;
                            }
                        }
                        
                        // 선택된 이미지에 따라 단일/그리드 모드 결정
                        if (labelSelection.selected.length > 0) {
                            if (labelSelection.selected.length === 1) {
                                // 단일 선택: 단일 이미지 모드
                                const selectedKey = labelSelection.selected[0];
                                
                                console.log(`Label Explorer: 단일 이미지 모드 - ${selectedKey}`);
                                
                                // grid mode 해제하고 single image mode로 전환
                                if (this.gridMode) {
                                    this.hideGrid();
                                }
                                
                                this.loadImage(`classification/${selectedKey}`);
                            } else {
                                // 다수 선택: 그리드 모드
                                console.log(`Label Explorer: 그리드 모드 - ${labelSelection.selected.length}개 이미지`);
                                
                                this.showGridFromLabelExplorer(labelSelection.selected);
                            }
                        } else {
                            // 선택 없음: 그리드 모드 해제
                            if (this.gridMode) {
                                console.log('Label Explorer: 선택 해제 → 그리드 모드 종료');
                                this.hideGrid();
                            }
                        }
                        
                        // 강제로 업데이트 (약간의 지연 후)
                        setTimeout(() => {
                            this.updateLabelExplorerSelection();
                        }, 10);
                        
                        console.log('Label Explorer 선택 후 상태:', {
                            selected: labelSelection.selected,
                            selectedClasses: labelSelection.selectedClasses,
                            lastClicked: labelSelection.lastClicked
                        });
                    };
                    imgLi.appendChild(imgBtn);
                    const delBtn = document.createElement('button');
                    delBtn.textContent = '🗑️';
                    delBtn.className = 'label-img-del-btn';
                    delBtn.style.marginLeft = '4px';
                    delBtn.onclick = async (e) => {
                        e.stopPropagation();
                        let toDelete = [`${cls}/${img.name}`];
                        if (labelSelection.selected.includes(`${cls}/${img.name}`)) {
                            toDelete = labelSelection.selected;
                        }
                        for (const key of toDelete) {
                            const [delCls, delImg] = key.split('/');
                            await fetch('/api/classify/delete', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ class_name: delCls, image_name: delImg })
                            });
                        }
                        labelSelection.selected = [];
                        // 해당 클래스의 이미지 리스트만 다시 fetch해서 ul만 갱신
                        const imgRes = await fetch(`/api/files?path=classification/${encodeURIComponent(cls)}`);
                        const imgData = await imgRes.json();
                        const imgList = Array.isArray(imgData.items) ? imgData.items : [];
                        // ul 내부만 갱신
                        imgUl.innerHTML = '';
                        for (let i = 0; i < imgList.length; ++i) {
                            const img = imgList[i];
                            if (img.type !== 'file') continue;
                            const labelKey = `${cls}/${img.name}`;
                            const imgLi = document.createElement('li');
                            imgLi.style.display = 'flex';
                            imgLi.style.alignItems = 'center';
                            imgLi.style.margin = '2px 0';
                            const imgBtn = document.createElement('button');
                            imgBtn.textContent = img.name;
                            imgBtn.className = 'label-img-name';
                            imgBtn.style.cursor = 'pointer';
                            imgBtn.style.padding = '4px 12px';
                            imgBtn.style.background = labelSelection.selected.includes(labelKey) ? '#09f' : '#222';
                            imgBtn.style.color = '#fff';
                            imgBtn.style.border = labelSelection.selected.includes(labelKey) ? '2px solid #09f' : '1px solid #444';
                            imgBtn.style.borderRadius = '6px';
                            imgBtn.style.marginRight = '4px';
                            imgBtn.style.fontSize = '13px';
                            imgBtn.onclick = (e) => {
                                const isCtrl = e.ctrlKey || e.metaKey;
                                const isShift = e.shiftKey;
                                const key = `${cls}/${img.name}`;
                                
                                // 다른 Explorer 선택 해제
                                try {
                                    this.clearWaferMapExplorerSelection();
                                } catch (error) {
                                    console.warn('clearWaferMapExplorerSelection error:', error);
                                }
                                
                                if (isShift && labelSelection.lastClicked !== null) {
                                    // Shift+클릭: 현재 클래스 내에서 범위 선택
                                    const allKeys = imgList.filter(f => f.type === 'file').map(f => `${cls}/${f.name}`);
                                    const lastIdx = allKeys.indexOf(labelSelection.lastClicked);
                                    const thisIdx = allKeys.indexOf(key);
                                    if (lastIdx !== -1 && thisIdx !== -1) {
                                        const [from, to] = [lastIdx, thisIdx].sort((a,b)=>a-b);
                                        const range = allKeys.slice(from, to+1);
                                        labelSelection.selected = Array.from(new Set([...labelSelection.selected, ...range]));
                                    }
                                } else if (isCtrl) {
                                    // Ctrl+클릭: 토글 선택
                                    if (labelSelection.selected.includes(key)) {
                                        labelSelection.selected = labelSelection.selected.filter(k => k !== key);
                                    } else {
                                        labelSelection.selected = [...labelSelection.selected, key];
                                    }
                                    labelSelection.lastClicked = key;
                                } else {
                                    // 단일 클릭: 이미 선택된 항목이면 해제, 다른 항목이면 새로 선택
                                    if (labelSelection.selected.includes(key) && labelSelection.selected.length === 1) {
                                        // 유일하게 선택된 항목을 다시 클릭: 해제
                                        labelSelection.selected = [];
                                        labelSelection.lastClicked = null;
                                    } else {
                                        // 새로운 항목 클릭 또는 다중 선택 상태: 기존 선택 해제 후 새로 선택
                                        labelSelection.selected = [key];
                                        labelSelection.lastClicked = key;
                                    }
                                }
                                
                                // 선택된 이미지에 따라 단일/그리드 모드 결정
                                if (labelSelection.selected.length > 0) {
                                    if (labelSelection.selected.length === 1) {
                                        // 단일 선택: 단일 이미지 모드
                                        const selectedKey = labelSelection.selected[0];
                                        
                                        console.log(`Label Explorer (동적): 단일 이미지 모드 - ${selectedKey}`);
                                        
                                        // grid mode 해제하고 single image mode로 전환
                                        if (this.gridMode) {
                                            this.hideGrid();
                                        }
                                        
                                        this.loadImage(`classification/${selectedKey}`);
                                    } else {
                                        // 다수 선택: 그리드 모드
                                        console.log(`Label Explorer (동적): 그리드 모드 - ${labelSelection.selected.length}개 이미지`);
                                        
                                        this.showGridFromLabelExplorer(labelSelection.selected);
                                    }
                                } else {
                                    // 선택 없음: 그리드 모드 해제
                                    if (this.gridMode) {
                                        console.log('Label Explorer (동적): 선택 해제 → 그리드 모드 종료');
                                        this.hideGrid();
                                    }
                                }
                                
                                // 강제로 업데이트 (약간의 지연 후)
                                setTimeout(() => {
                                    this.updateLabelExplorerSelection();
                                }, 10);
                                
                                console.log('Label Explorer 선택 후 상태 (동적):', {
                                    selected: labelSelection.selected,
                                    selectedClasses: labelSelection.selectedClasses,
                                    lastClicked: labelSelection.lastClicked
                                });
                            };
                            imgLi.appendChild(imgBtn);
                            const delBtn = document.createElement('button');
                            delBtn.textContent = '🗑️';
                            delBtn.className = 'label-img-del-btn';
                            delBtn.style.marginLeft = '4px';
                            delBtn.onclick = async (e) => {
                                e.stopPropagation();
                                let toDelete = [labelKey];
                                if (labelSelection.selected.includes(labelKey)) {
                                    toDelete = labelSelection.selected;
                                }
                                for (const key of toDelete) {
                                    const [delCls, delImg] = key.split('/');
                                    await fetch('/api/classify/delete', {
                                        method: 'POST',
                                        headers: { 'Content-Type': 'application/json' },
                                        body: JSON.stringify({ class_name: delCls, image_name: delImg })
                                    });
                                }
                                labelSelection.selected = [];
                                this.updateLabelExplorerContent();
                            };
                            imgLi.appendChild(delBtn);
                            imgUl.appendChild(imgLi);
                        }
                    };
                    imgLi.appendChild(delBtn);
                    imgUl.appendChild(imgLi);
                }
                li.appendChild(imgUl);
            }
            ul.appendChild(li);
        }
        container.appendChild(ul);
    }

    updateLabelExplorerContent() {
        // 전체 내용을 다시 렌더링하되 스크롤 위치 유지
        const container = document.getElementById('label-explorer-list');
        const scrollTop = container ? container.scrollTop : 0;
        
        // 클래스 목록과 이미지 목록을 다시 가져와서 렌더링
        this.refreshLabelExplorer();
        
        // 스크롤 위치 복원
        if (container) container.scrollTop = scrollTop;
    }

    updateLabelExplorerSelection() {
        // 선택 상태만 업데이트 (전체 재렌더링 없음)
        const container = document.getElementById('label-explorer-list');
        if (!container) return;
        
        // 이미지 버튼 선택 상태 업데이트
        const imgButtons = container.querySelectorAll('button.label-img-name');
        imgButtons.forEach(btn => {
            // 버튼이 속한 클래스를 찾기
            const li = btn.closest('li');
            const classLi = li?.parentElement?.closest('li');
            if (!classLi) return;
            
            const folderSummary = classLi.querySelector('div');
            if (!folderSummary) return;
            
            const cls = folderSummary.textContent.replace(/[▾▸]/g, '').trim();
            const imgName = btn.textContent;
            const key = `${cls}/${imgName}`;
            
            const isSelected = this.labelSelection.selected.includes(key);
            btn.style.background = isSelected ? '#09f' : '#222';
            btn.style.border = isSelected ? '2px solid #09f' : '1px solid #444';
            btn.style.color = '#fff';
        });
        
        // 폴더 선택 상태 업데이트
        const folderSummaries = container.querySelectorAll('div');
        folderSummaries.forEach(summary => {
            // 폴더 summary만 처리 (이미지 버튼의 부모 div 제외)
            if (summary.style.fontWeight === 'bold') {
                const cls = summary.textContent.replace(/[▾▸]/g, '').trim();
                const isSelected = this.labelSelection.selectedClasses.includes(cls);
                summary.style.background = isSelected ? '#09f' : 'transparent';
                summary.style.color = '#fff';
                summary.style.borderRadius = isSelected ? '6px' : '0';
                summary.style.padding = isSelected ? '4px 8px' : '2px 0';
            }
        });
        
        // 버튼 활성화 상태 업데이트 (항상 활성화)
        const batchLabelBtn = document.getElementById('label-explorer-batch-label-btn');
        const batchDeleteBtn = document.getElementById('label-explorer-batch-delete-btn');
        if (batchLabelBtn) {
            batchLabelBtn.disabled = false;
        }
        if (batchDeleteBtn) {
            batchDeleteBtn.disabled = false;
        }
        
        console.log('Label Explorer 선택 상태 업데이트:', {
            selected: this.labelSelection.selected,
            selectedClasses: this.labelSelection.selectedClasses
        });
    }

    handleRightDown(e) {
        e.preventDefault();
        document.addEventListener('mousemove', this.boundHandleRightMove);
        document.addEventListener('mouseup', this.boundHandleRightUp);
    }
    handleRightMove(e) {
        const minWidth = 260;
        const maxWidth = 600;
        const totalWidth = window.innerWidth;
        const newWidth = totalWidth - e.clientX;
        if (newWidth > minWidth && newWidth < maxWidth) {
            this.dom.wrapperRight.style.width = newWidth + 'px';
            this.handleResize();
        }
    }
    handleRightUp() {
        document.removeEventListener('mousemove', this.boundHandleRightMove);
        document.removeEventListener('mouseup', this.boundHandleRightUp);
    }

    /**
     * minimap 클릭 시 해당 위치로 메인 뷰 이동
     */
    handleMinimapClick(e) {
        if (!this.currentImage) return;
        const rect = this.dom.minimapCanvas.getBoundingClientRect();
        const mapW = rect.width, mapH = rect.height;
        const imgW = this.currentImage.width, imgH = this.currentImage.height;
        const scale = Math.min(mapW / imgW, mapH / imgH);
        const padX = (mapW - imgW * scale) / 2;
        const padY = (mapH - imgH * scale) / 2;
        
        // 클릭 좌표 → 미니맵 좌표
        const mx = e.clientX - rect.left;
        const my = e.clientY - rect.top;
        
        // 미니맵 전체 영역에서 이미지 좌표로 변환 (패딩 영역 포함)
        let imgX, imgY;
        if (mx < padX) {
            // 왼쪽 패딩 영역
            imgX = (mx / padX - 1) * imgW * 0.5; // 이미지 왼쪽 영역으로 확장
        } else if (mx > padX + imgW * scale) {
            // 오른쪽 패딩 영역
            imgX = imgW + ((mx - padX - imgW * scale) / padX) * imgW * 0.5; // 이미지 오른쪽 영역으로 확장
        } else {
            // 이미지 영역
            imgX = (mx - padX) / scale;
        }
        
        if (my < padY) {
            // 위쪽 패딩 영역
            imgY = (my / padY - 1) * imgH * 0.5; // 이미지 위쪽 영역으로 확장
        } else if (my > padY + imgH * scale) {
            // 아래쪽 패딩 영역
            imgY = imgH + ((my - padY - imgH * scale) / padY) * imgH * 0.5; // 이미지 아래쪽 영역으로 확장
        } else {
            // 이미지 영역
            imgY = (my - padY) / scale;
        }
        
        // 메인 뷰의 중심이 imgX, imgY가 되도록 transform.dx, dy 조정
        const { width: viewW, height: viewH } = this.dom.viewerContainer.getBoundingClientRect();
        this.transform.dx = -(imgX - viewW / (2 * this.transform.scale)) * this.transform.scale;
        this.transform.dy = -(imgY - viewH / (2 * this.transform.scale)) * this.transform.scale;
        this.scheduleDraw();
    }

    /**
     * 뷰포트 드래그 시작
     */
    handleViewportDragStart(e) {
        if (!this.currentImage) return;
        e.preventDefault();
        e.stopPropagation();
        
        this.isViewportDragging = true;
        
        // 드래그 시작 위치 저장
        const rect = this.dom.minimapCanvas.getBoundingClientRect();
        this.viewportDragStart = {
            x: e.clientX - rect.left,
            y: e.clientY - rect.top
        };
        
        // 현재 뷰포트 위치 저장
        const vpStyle = this.dom.minimapViewport.style;
        this.viewportDragStartPos = {
            x: parseFloat(vpStyle.left) || 0,
            y: parseFloat(vpStyle.top) || 0
        };
        
        // 이벤트 리스너 추가
        document.addEventListener('mousemove', this.boundHandleViewportDrag);
        document.addEventListener('mouseup', this.boundHandleViewportDragEnd);
        
        // 커서 변경
        this.dom.minimapViewport.style.cursor = 'grabbing';
        document.body.style.userSelect = 'none';
    }

    /**
     * 뷰포트 드래그 중
     */
    handleViewportDrag(e) {
        if (!this.isViewportDragging || !this.currentImage) return;
        
        // 현재 마우스 위치
        const rect = this.dom.minimapCanvas.getBoundingClientRect();
        const currentX = e.clientX - rect.left;
        const currentY = e.clientY - rect.top;
        
        // 드래그 거리 계산
        const deltaX = currentX - this.viewportDragStart.x;
        const deltaY = currentY - this.viewportDragStart.y;
        
        // 새로운 뷰포트 위치
        const newVpX = this.viewportDragStartPos.x + deltaX;
        const newVpY = this.viewportDragStartPos.y + deltaY;
        
        // 미니맵 전체 영역으로 경계 확장
        const mapW = rect.width;
        const mapH = rect.height;
        const imgW = this.currentImage.width;
        const imgH = this.currentImage.height;
        const scale = Math.min(mapW / imgW, mapH / imgH);
        const padX = (mapW - imgW * scale) / 2;
        const padY = (mapH - imgH * scale) / 2;
        
        const vpW = parseFloat(this.dom.minimapViewport.style.width) || 0;
        const vpH = parseFloat(this.dom.minimapViewport.style.height) || 0;
        
        // 미니맵 전체 영역 내로 제한 (패딩 영역 포함)
        const clampedX = Math.max(0, Math.min(newVpX, mapW - vpW));
        const clampedY = Math.max(0, Math.min(newVpY, mapH - vpH));
        
        // 뷰포트 위치 업데이트
        this.dom.minimapViewport.style.left = `${clampedX}px`;
        this.dom.minimapViewport.style.top = `${clampedY}px`;
        
        // 메인 뷰 동기화 (확장된 좌표계 사용)
        this.syncMainViewFromViewportExtended(clampedX, clampedY, padX, padY, scale, mapW, mapH);
    }

    /**
     * 뷰포트 드래그 종료
     */
    handleViewportDragEnd(e) {
        if (!this.isViewportDragging) return;
        
        this.isViewportDragging = false;
        
        // 이벤트 리스너 제거
        document.removeEventListener('mousemove', this.boundHandleViewportDrag);
        document.removeEventListener('mouseup', this.boundHandleViewportDragEnd);
        
        // 커서 복원
        this.dom.minimapViewport.style.cursor = 'grab';
        document.body.style.userSelect = '';
    }

    /**
     * 뷰포트 위치를 기반으로 메인 뷰 동기화
     */
    syncMainViewFromViewport(vpX, vpY, padX, padY, scale) {
        if (!this.currentImage) return;
        
        // 뷰포트 중심점을 이미지 좌표로 변환
        const vpW = parseFloat(this.dom.minimapViewport.style.width) || 0;
        const vpH = parseFloat(this.dom.minimapViewport.style.height) || 0;
        const vpCenterX = vpX + vpW / 2;
        const vpCenterY = vpY + vpH / 2;
        
        const imgX = (vpCenterX - padX) / scale;
        const imgY = (vpCenterY - padY) / scale;
        
        // 메인 뷰의 중심이 해당 이미지 좌표가 되도록 transform 조정
        const { width: viewW, height: viewH } = this.dom.viewerContainer.getBoundingClientRect();
        this.transform.dx = -(imgX - viewW / (2 * this.transform.scale)) * this.transform.scale;
        this.transform.dy = -(imgY - viewH / (2 * this.transform.scale)) * this.transform.scale;
        
        this.scheduleDraw();
    }

    /**
     * 확장된 뷰포트 위치를 기반으로 메인 뷰 동기화 (패딩 영역 포함)
     */
    syncMainViewFromViewportExtended(vpX, vpY, padX, padY, scale, mapW, mapH) {
        if (!this.currentImage) return;
        
        // 뷰포트 중심점
        const vpW = parseFloat(this.dom.minimapViewport.style.width) || 0;
        const vpH = parseFloat(this.dom.minimapViewport.style.height) || 0;
        const vpCenterX = vpX + vpW / 2;
        const vpCenterY = vpY + vpH / 2;
        
        const imgW = this.currentImage.width;
        const imgH = this.currentImage.height;
        
        // 미니맵 전체 영역에서 이미지 좌표로 변환 (패딩 영역 포함)
        let imgX, imgY;
        
        if (vpCenterX < padX) {
            // 왼쪽 패딩 영역
            imgX = (vpCenterX / padX - 1) * imgW * 0.5;
        } else if (vpCenterX > padX + imgW * scale) {
            // 오른쪽 패딩 영역
            imgX = imgW + ((vpCenterX - padX - imgW * scale) / padX) * imgW * 0.5;
        } else {
            // 이미지 영역
            imgX = (vpCenterX - padX) / scale;
        }
        
        if (vpCenterY < padY) {
            // 위쪽 패딩 영역
            imgY = (vpCenterY / padY - 1) * imgH * 0.5;
        } else if (vpCenterY > padY + imgH * scale) {
            // 아래쪽 패딩 영역
            imgY = imgH + ((vpCenterY - padY - imgH * scale) / padY) * imgH * 0.5;
        } else {
            // 이미지 영역
            imgY = (vpCenterY - padY) / scale;
        }
        
        // 메인 뷰의 중심이 해당 이미지 좌표가 되도록 transform 조정
        const { width: viewW, height: viewH } = this.dom.viewerContainer.getBoundingClientRect();
        this.transform.dx = -(imgX - viewW / (2 * this.transform.scale)) * this.transform.scale;
        this.transform.dy = -(imgY - viewH / (2 * this.transform.scale)) * this.transform.scale;
        
        this.scheduleDraw();
    }

    // 2. Grid rendering
    showGrid(images) {
        this.gridMode = true;
        this.selectedImages = images;
        if (!this.gridSelectedIdxs) this.gridSelectedIdxs = [];
        const grid = document.getElementById('image-grid');
        const gridControls = document.getElementById('grid-controls');
        if (gridControls) gridControls.style.display = '';
        const gridColsRange = document.getElementById('grid-cols-range');
        if (gridColsRange) {
            gridColsRange.value = this.gridCols;
            document.documentElement.style.setProperty('--grid-cols', this.gridCols);
        }
        const viewControls = document.querySelector('.view-controls');
        if (viewControls) viewControls.style.display = 'none';
        
        // 그리드 모드 클래스 추가 및 요소들 숨기기
        this.dom.viewerContainer.classList.add('grid-mode');
        this.dom.viewerContainer.classList.remove('single-image-mode');
        this.dom.minimapContainer.style.display = 'none';
        this.dom.imageCanvas.style.display = 'none';
        this.dom.overlayCanvas.style.display = 'none';
        
        grid.innerHTML = '';
        // grid 모드에서는 cursor를 default로
        this.dom.viewerContainer.style.cursor = 'default';
        this.showGridImmediately(images);
        setTimeout(() => {
            this.loadCurrentFolderThumbnails(images);
        }, 100);
        grid.classList.add('active');
        setTimeout(() => this.updateGridSquaresPixel(), 0);
        if (!this.gridResizeObserver) {
            this.gridResizeObserver = new ResizeObserver(() => this.updateGridSquaresPixel());
            this.gridResizeObserver.observe(grid);
        }
    }

    showGridImmediately(images) {
        const grid = document.getElementById('image-grid');
        images.forEach((imgPath, idx) => {
            const wrap = document.createElement('div');
            wrap.className = 'grid-thumb-wrap' + (this.gridSelectedIdxs.includes(idx) ? ' selected' : '');
            // 클릭 이벤트는 onMouseUp에서 처리하므로 여기서는 제거
            // wrap.onclick = e => { e.stopPropagation(); this.toggleGridImageSelect(idx, e); };
            wrap.ondblclick = e => { e.stopPropagation(); this.enterSingleImageMode(idx); };
            
            // 우클릭 컨텍스트 메뉴 표시
            wrap.oncontextmenu = e => {
                e.preventDefault();
                e.stopPropagation();
                this.showContextMenu(e, idx);
            };
            // 썸네일 이미지 컨테이너
            const thumbBox = document.createElement('div');
            thumbBox.className = 'grid-thumb-imgbox';
            const img = document.createElement('img');
            img.className = 'grid-thumb-img';
            img.alt = imgPath.split('/').pop();
            img.loading = 'lazy';
            img.decoding = 'async';
            img.style.opacity = '0';
            
            // 고품질 이미지 렌더링 설정
            img.style.imageRendering = 'high-quality';
            img.style.imageRendering = 'crisp-edges';
            img.style.imageRendering = '-webkit-optimize-contrast';
            
            // 브라우저 기본 drag&drop 방지
            img.ondragstart = e => e.preventDefault();
            
            // 이미지 로드 핸들러
            img.onload = () => {
                img.style.opacity = '1';
                
                // 썸네일로 교체 (더 안정적인 타이밍)
                // 이미지 로드 완료 후 다음 프레임에서 썸네일 교체
                requestAnimationFrame(() => {
                    // DOM에 아직 존재하는지 확인
                    if (img.parentElement) {
                        this.replaceWithThumbnail(img, imgPath);
                    }
                });
            };
            
            img.onerror = () => {
                // 실패시 기본 스타일 적용
                img.style.backgroundColor = '#333';
                img.style.opacity = '0.5';
                
                // 실패 후에도 썸네일 시도 (서버에서 썸네일이 생성되었을 수 있음)
                setTimeout(() => {
                    if (img.parentElement) {
                        this.replaceWithThumbnail(img, imgPath);
                    }
                }, 500);
            };
            
            // 이미지 소스 설정 (즉시 로드 시작)
            img.src = `/api/image?path=${encodeURIComponent(imgPath)}`;
            thumbBox.appendChild(img);
            wrap.appendChild(thumbBox);
            // Checkmark
            if (this.gridSelectedIdxs.includes(idx)) {
                const check = document.createElement('div');
                check.className = 'grid-thumb-check';
                check.textContent = '✔';
                thumbBox.appendChild(check);
            }
            // 파일명
            const label = document.createElement('div');
            label.className = 'grid-thumb-label';
            label.textContent = imgPath.split('/').pop();
            wrap.appendChild(label);
            grid.appendChild(wrap);
        });
    }

    async replaceWithThumbnail(img, imgPath) {
        if (!img || !img.parentElement) return; // 이미지가 DOM에서 제거되었으면 중단
        
        // 이미 썸네일로 교체되었거나 진행 중이면 중단
        if (img.dataset.thumbnailUrl || img.dataset.thumbnailLoading === 'true') {
            return;
        }
        
        img.dataset.thumbnailLoading = 'true';
        
        try {
            const thumbnailUrl = await this.thumbnailManager.loadThumbnail(imgPath);
            if (thumbnailUrl && img.parentElement && !img.dataset.thumbnailUrl) {
                // 이전 blob URL 정리 (원본 이미지 URL은 제외)
                const oldSrc = img.src;
                if (oldSrc && oldSrc.startsWith('blob:') && oldSrc !== thumbnailUrl) {
                    URL.revokeObjectURL(oldSrc);
                }
                
                img.src = thumbnailUrl;
                img.dataset.thumbnailUrl = thumbnailUrl;
                
                // 썸네일 로드 성공시 추가 스타일
                img.style.transition = 'opacity 0.2s ease';
                img.style.opacity = '1';
            }
        } catch (error) {
            console.warn('썸네일 교체 실패:', imgPath, error);
        } finally {
            img.dataset.thumbnailLoading = 'false';
        }
    }

    async loadCurrentFolderThumbnails(images) {
        if (images.length === 0) return;
        
        // 배치 크기 제한
        const batchSize = THUMB_BATCH_SIZE || 50;
        const currentImages = images.slice(0, batchSize);
        
        try {
            await this.thumbnailManager.preloadBatch(currentImages);
        } catch (error) {
            // 조용히 실패 처리
        }
    }

    async loadAllThumbnailsAtOnce(images) {
        if (images.length === 0) return;
        
        const startTime = Date.now();
        
        // 배치 프리로드 (대량 처리 시 자동 분할)
        await this.thumbnailManager.preloadBatch(images);
        
        // 썸네일 적용 - 병렬 처리
        const grid = document.getElementById('image-grid');
        if (!grid) return;
        
        const thumbWraps = Array.from(grid.querySelectorAll('.grid-thumb-wrap'));
        const loadPromises = thumbWraps.map(async (wrap, idx) => {
            if (idx >= images.length) return;
            
            const img = wrap.querySelector('.grid-thumb-img');
            const imgPath = images[idx];
            
            if (!img || !imgPath) return;
            
            try {
                const thumbnailUrl = await this.thumbnailManager.loadThumbnail(imgPath);
                if (thumbnailUrl && img.src !== thumbnailUrl) {
                    img.src = thumbnailUrl;
                    img.style.opacity = '1';
                }
            } catch (error) {
                // 조용히 실패 처리
            }
        });
        
        await Promise.allSettled(loadPromises);
        
        const elapsed = Date.now() - startTime;
        if (elapsed > 500) { // 500ms 이상일 때만 로그
            console.log(`썸네일 로딩: ${images.length}개, ${elapsed}ms`);
        }
    }

    async checkWorkerStats() {
        // 워커 통계 체크 비활성화 (성능 최적화)
        return;
    }

    hideGrid() {
        this.gridMode = false;
        const grid = document.getElementById('image-grid');
        
        // 그리드 상태 초기화
        if (this.gridSelectedIdxs) {
            this.gridSelectedIdxs = [];
        }
        
        // 그리드 정리 및 메모리 해제
        if (grid) {
            grid.classList.remove('active');
            
            // 이미지 URL 정리 (썸네일 캐시는 ThumbnailManager가 관리)
            const images = grid.querySelectorAll('.grid-thumb-img');
            images.forEach(img => {
                // 원본 이미지 blob URL만 해제 (썸네일은 캐시에서 관리됨)
                if (img.src && img.src.startsWith('blob:') && !img.dataset.thumbnailUrl) {
                    URL.revokeObjectURL(img.src);
                }
                // 모든 데이터 속성 정리
                delete img.dataset.thumbnailUrl;
                delete img.dataset.thumbnailLoading;
                // 스타일 초기화
                img.style.transition = '';
            });
            
            grid.innerHTML = '';
        }
        
        // 화면 모드 전환
        this.dom.viewerContainer.classList.remove('grid-mode');
        this.dom.viewerContainer.classList.add('single-image-mode');
        this.dom.imageCanvas.style.display = 'block';
        this.dom.overlayCanvas.style.display = 'block';
        this.dom.minimapContainer.style.display = 'block';
        
        // 컨트롤 전환
        const gridControls = document.getElementById('grid-controls');
        if (gridControls) gridControls.style.display = 'none';
        const viewControls = document.querySelector('.view-controls');
        if (viewControls) viewControls.style.display = 'flex';
        
        // ResizeObserver 정리
        if (this.gridResizeObserver) {
            this.gridResizeObserver.disconnect();
            this.gridResizeObserver = null;
        }
        
        this.scheduleDraw();
        this.dom.viewerContainer.style.cursor = 'grab';
    }

    toggleGridImageSelect(idx, e) {
        if (!this.gridSelectedIdxs) this.gridSelectedIdxs = [];
        
        const isCtrl = e && (e.ctrlKey || e.metaKey);
        const isShift = e && e.shiftKey;
        
        if (isShift && this.gridLastClickedIdx !== undefined) {
            // Shift+클릭: 범위 선택
            const [from, to] = [this.gridLastClickedIdx, idx].sort((a, b) => a - b);
            const range = [];
            for (let i = from; i <= to; ++i) range.push(i);
            this.gridSelectedIdxs = Array.from(new Set([...this.gridSelectedIdxs, ...range]));
        } else if (isCtrl) {
            // Ctrl/Cmd+클릭: 토글 선택 (추가/제거)
            if (this.gridSelectedIdxs.includes(idx)) {
                this.gridSelectedIdxs = this.gridSelectedIdxs.filter(i => i !== idx);
            } else {
                this.gridSelectedIdxs.push(idx);
            }
        } else {
            // 단일 클릭: 기존 선택 해제하고 현재 항목만 선택
            this.gridSelectedIdxs = [idx];
        }
        
        this.gridLastClickedIdx = idx;
        this.updateGridSelection();
    }

    updateGridSelection() {
        // 그리드의 선택 상태만 업데이트 (전체 재렌더링 없음)
        const grid = document.getElementById('image-grid');
        const wraps = grid.querySelectorAll('.grid-thumb-wrap');
        wraps.forEach((wrap, idx) => {
            const isSelected = this.gridSelectedIdxs.includes(idx);
            wrap.className = 'grid-thumb-wrap' + (isSelected ? ' selected' : '');
            
            // 체크마크 업데이트
            let check = wrap.querySelector('.grid-thumb-check');
            if (isSelected && !check) {
                check = document.createElement('div');
                check.className = 'grid-thumb-check';
                check.textContent = '✔';
                wrap.querySelector('.grid-thumb-imgbox').appendChild(check);
            } else if (!isSelected && check) {
                check.remove();
            }
        });
    }

    enterSingleImageMode(idx) {
        this.hideGrid();
        this.loadImage(this.selectedImages[idx]);
        this.selectedImagePath = this.selectedImages[idx];
        this.singleImageFromGrid = true;
        document.addEventListener('keydown', this.boundGridEscapeHandler = (e) => {
            if (e.key === 'Escape') this.exitSingleImageMode();
        });
        this.dom.imageCanvas.onclick = null;
        this.dom.imageCanvas.ondblclick = () => this.exitSingleImageMode();
    }

    exitSingleImageMode() {
        if (!this.singleImageFromGrid) return;
        this.showGrid(this.selectedImages);
        this.singleImageFromGrid = false;
        document.removeEventListener('keydown', this.boundGridEscapeHandler);
        this.dom.imageCanvas.onclick = null;
        this.dom.imageCanvas.ondblclick = null;
    }

    updateGridSquaresPixel() {
        const grid = document.getElementById('image-grid');
        if (!grid) return;
        const colCount = this.gridCols;
        const gap = 8; // 간격 줄임
        const gridWidth = grid.clientWidth;
        const gridHeight = grid.clientHeight;
        let cellWidth, cellHeight;
        const cells = grid.querySelectorAll('.grid-thumb-wrap');
        if (colCount === 1 && cells.length === 1) {
            // column이 1개이고 이미지도 1개면 썸네일이 grid 전체를 채움 (정사각형)
            cellWidth = gridWidth;
            cellHeight = gridWidth; // 정사각형
        } else {
            cellWidth = Math.floor((gridWidth - gap * (colCount - 1)) / colCount);
            cellHeight = cellWidth; // 정사각형
        }
        
        // 극한 최적화: 한번에 스타일 설정
        const gridStyle = `repeat(${colCount}, ${cellWidth}px)`;
        if (grid.style.gridTemplateColumns !== gridStyle) {
            grid.style.gridTemplateColumns = gridStyle;
        }
        
        // 극한 최적화: 배치로 스타일 설정
        const cellStyle = `${cellWidth}px`;
        cells.forEach(cell => {
            if (cell.style.width !== cellStyle) {
                cell.style.width = cellStyle;
                cell.style.height = cellStyle;
            }
        });
    }

    scheduleShowGrid() {
        if (this._showGridScheduled) return;
        this._showGridScheduled = true;
        setTimeout(() => {
            this._showGridScheduled = false;
            this.showGrid(this.selectedImages);
        }, 0);
    }

    // Label Explorer에서 그리드 모드 전환
    showGridFromLabelExplorer(imagePaths) {
        if (!imagePaths || imagePaths.length === 0) return;
        
        // classification/ 접두사를 가진 경로들을 실제 이미지 경로로 변환
        const actualPaths = imagePaths.map(path => {
            return path.startsWith('classification/') ? path : `classification/${path}`;
        });
        
        console.log('Label Explorer → Grid Mode:', {
            originalPaths: imagePaths,
            actualPaths: actualPaths,
            count: actualPaths.length
        });
        
        // Wafer Map Explorer 선택 해제
        this.clearWaferMapExplorerSelection();
        
        // 그리드 모드로 전환
        this.selectedImages = actualPaths;
        this.showGrid(actualPaths);
    }

    // 클래스의 모든 이미지로 그리드 모드 전환
    async showGridFromClass(className) {
        try {
            const response = await fetch(`/api/files?path=classification/${encodeURIComponent(className)}`);
            const data = await response.json();
            const imageFiles = (data.items || [])
                .filter(item => item.type === 'file' && this.isImageFile(item.name))
                .map(item => `classification/${className}/${item.name}`);
            
            if (imageFiles.length === 0) {
                console.log(`클래스 '${className}'에 이미지가 없습니다.`);
                return;
            }
            
            console.log(`클래스 '${className}' → Grid Mode:`, {
                className: className,
                imageCount: imageFiles.length,
                images: imageFiles
            });
            
            // Wafer Map Explorer 선택 해제
            this.clearWaferMapExplorerSelection();
            
            // 그리드 모드로 전환
            this.selectedImages = imageFiles;
            this.showGrid(imageFiles);
            
        } catch (error) {
            console.error(`클래스 '${className}' 이미지 로드 실패:`, error);
        }
    }

    // 다중 클래스의 모든 이미지로 그리드 모드 전환
    async showGridFromMultipleClasses(classNames) {
        try {
            console.log('다중 클래스 그리드 모드:', classNames);
            
            let allImageFiles = [];
            
            // 각 클래스의 이미지들을 병렬로 가져오기
            const fetchPromises = classNames.map(async (className) => {
                try {
                    const response = await fetch(`/api/files?path=classification/${encodeURIComponent(className)}`);
                    const data = await response.json();
                    const imageFiles = (data.items || [])
                        .filter(item => item.type === 'file' && this.isImageFile(item.name))
                        .map(item => `classification/${className}/${item.name}`);
                    
                    return { className, images: imageFiles };
                } catch (error) {
                    console.error(`클래스 '${className}' 로드 실패:`, error);
                    return { className, images: [] };
                }
            });
            
            const results = await Promise.all(fetchPromises);
            
            // 모든 이미지를 하나의 배열로 합치기
            results.forEach(result => {
                allImageFiles.push(...result.images);
                console.log(`클래스 '${result.className}': ${result.images.length}개 이미지`);
            });
            
            if (allImageFiles.length === 0) {
                console.log('선택된 클래스들에 이미지가 없습니다.');
                return;
            }
            
            console.log(`다중 클래스 → Grid Mode:`, {
                classes: classNames,
                totalImages: allImageFiles.length,
                imagesPerClass: results.map(r => ({ class: r.className, count: r.images.length }))
            });
            
            // Wafer Map Explorer 선택 해제
            this.clearWaferMapExplorerSelection();
            
            // 그리드 모드로 전환
            this.selectedImages = allImageFiles;
            this.showGrid(allImageFiles);
            
        } catch (error) {
            console.error('다중 클래스 이미지 로드 실패:', error);
        }
    }

    // 주기적인 메모리 정리
    performCleanup() {
        try {
            // 썸네일 캐시 정리
            const cleaned = this.thumbnailManager.cleanupOldCache();
            
            // 가비지 컬렉션 힌트 (브라우저가 지원하는 경우)
            if (window.gc && typeof window.gc === 'function') {
                window.gc();
            }
            
            if (cleaned > 0) {
                console.log(`메모리 정리: ${cleaned}개 썸네일 캐시 제거`);
            }
        } catch (error) {
            console.warn('메모리 정리 중 오류:', error);
        }
    }

    // 전체 정리 (페이지 종료시)
    cleanup() {
        try {
            // 인터벌 정리
            if (this.cleanupInterval) {
                clearInterval(this.cleanupInterval);
                this.cleanupInterval = null;
            }
            
            // 썸네일 캐시 정리
            this.thumbnailManager.clearCache();
            
            // ResizeObserver 정리
            if (this.gridResizeObserver) {
                this.gridResizeObserver.disconnect();
                this.gridResizeObserver = null;
            }
            
            // 전역 변수 정리
            if (window.lastMouseEvent) {
                window.lastMouseEvent = null;
            }
            
        } catch (error) {
            console.warn('정리 중 오류:', error);
        }
    }
}

window.addEventListener('wheel', function(e) {
    if (e.ctrlKey) {
        e.preventDefault();
        if (window.viewer && window.viewer.gridMode) {
            let newCols = window.viewer.gridCols - Math.sign(e.deltaY);
            newCols = Math.max(1, Math.min(10, newCols));
            window.viewer.gridCols = newCols;
            document.getElementById('grid-cols-range').value = newCols;
            document.documentElement.style.setProperty('--grid-cols', newCols);
            if (window.viewer.selectedImages && window.viewer.selectedImages.length > 1) {
                window.viewer.showGrid(window.viewer.selectedImages);
            }
        }
    }
}, { passive: false });

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { window.viewer = new WaferMapViewer(); });
} else {
    window.viewer = new WaferMapViewer();
}

async function fetchJson(url, options = {}) {
    const res = await fetch(url, options);
    if (!res.ok) {
        let err = await res.json().catch(() => ({}));
        throw new Error(err.error || res.statusText);
    }
    return res.json();
} 

// 성능 모니터링 및 디버그 도구 (개발자용)
if (window.location.hash === '#debug') {
    let stats = document.createElement('div');
    stats.id = 'performance-stats';
    stats.style.cssText = `
        position: fixed;
        top: 10px;
        right: 10px;
        background: rgba(0,0,0,0.8);
        color: white;
        padding: 10px;
        font-family: monospace;
        font-size: 12px;
        z-index: 10000;
        border-radius: 5px;
    `;
    document.body.appendChild(stats);
    
    setInterval(() => {
        if (window.viewer && window.viewer.thumbnailManager) {
            const cacheStats = window.viewer.thumbnailManager.getCacheStats();
            const memInfo = window.performance && window.performance.memory ? 
                `RAM: ${Math.round(window.performance.memory.usedJSHeapSize / 1024 / 1024)}MB` : 'RAM: N/A';
            
            // DOM의 썸네일 상태 확인
            const gridImages = document.querySelectorAll('.grid-thumb-img');
            const thumbnailImages = Array.from(gridImages).filter(img => img.dataset.thumbnailUrl);
            const loadingImages = Array.from(gridImages).filter(img => img.dataset.thumbnailLoading === 'true');
            
            stats.innerHTML = `
                <div><strong>🚀 성능 최적화 상태</strong></div>
                <div>썸네일 캐시: ${cacheStats.loaded}/${cacheStats.total}</div>
                <div>로딩 중: ${cacheStats.loading}</div>
                <div>대기 중: ${cacheStats.queued}</div>
                <div>DOM 썸네일: ${thumbnailImages.length}/${gridImages.length}</div>
                <div>교체 중: ${loadingImages.length}</div>
                <div>${memInfo}</div>
                <div>그리드 모드: ${window.viewer.gridMode ? 'ON' : 'OFF'}</div>
            `;
        }
    }, 1000);
}

console.log('🎉 WaferMapViewer 최적화 완료!');
console.log('성능 모니터링: URL에 #debug 추가');