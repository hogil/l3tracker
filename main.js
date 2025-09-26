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
const DEFAULT_THUMB_SIZE = 512;
const MIN_SIDEBAR_WIDTH = 200;
const MAX_SIDEBAR_WIDTH_RATIO = 0.5;
const MIN_DRAG_DISTANCE = 5;
const ZOOM_FACTOR = 1.2;
const THUMB_BATCH_SIZE = 20;
const DEBOUNCE_DELAY = 0;
// 초기 맞춤 여유 (상대 비율)
const FIT_RELATIVE_MARGIN = 0.95; // 초기 로드 시 5% 여유 (미세하게 더 작게)
// 리셋 시 절대 퍼센트포인트 오프셋 (예: -0.02 => 2%p 더 작게)
const RESET_ABSOLUTE_PERCENT_OFFSET = -0.02;

/**
 * Thumbnail Manager
 * 썸네일 로딩과 캐싱을 관리하는 클래스
 */
class ThumbnailManager {
    constructor() {
        this.cache = new Map(); // path -> { url, loading, timestamp, priority }
        this.maxCacheSize = 1000; // 캐시 크기 증가
        this.cacheTimeout = 15 * 60 * 1000; // 15분으로 증가
        this.concurrentLoads = 0;
        this.maxConcurrentLoads = 24; // 동시 로딩 상향 (가시영역 우선 처리 가속)
        this.loadQueue = [];
        this.viewportQueue = []; // viewport 우선순위 큐
        this.backgroundQueue = []; // 백그라운드 큐
        this.isProcessingQueue = false;
        this.backgroundRunning = false; // 백그라운드 스트리밍 상태
        
        // Intersection Observer 설정 (뷰포트 감지)
        this.setupIntersectionObserver();
    }

    // 진행 중/예약된 썸네일 작업 즉시 취소(백그라운드 스트림/큐/옵저버)
    cancelPendingRequests() {
        try { this.backgroundRunning = false; } catch (_) {}
        try { this.loadQueue.length = 0; } catch (_) {}
        try {
            if (this.observer) {
                this.observer.disconnect();
                this.observer = null;
            }
        } catch (_) {}
        try {
            // 아직 로드되지 않은 placeholder 이미지들의 src를 비워 브라우저 요청 중단 유도
            const grid = document.getElementById('image-grid');
            if (grid) {
                const imgs = grid.querySelectorAll('.grid-thumb-wrap img.grid-thumb-img');
                imgs.forEach(img => {
                    if (img.src && (img.src.startsWith('data:') || img.dataset.thumbnailLoading === 'true')) {
                        img.removeAttribute('src');
                    }
                });
            }
        } catch (_) {}
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
        // 우선순위에 따라 동시 로딩 상한을 가변 적용 (urgent일수록 상향)
        const isUrgent = (typeof imgPath === 'string' && imgPath.includes('__urgent__'));
        const dynamicCap = isUrgent ? Math.max(this.maxConcurrentLoads, 16) : this.maxConcurrentLoads;
        if (this.concurrentLoads >= dynamicCap) {
            await new Promise(resolve => this.loadQueue.push(resolve));
        }
        
        this.concurrentLoads++;
        
        try {
            // blob URL 대신 서버 캐시 가능한 정적 썸네일 URL을 직접 사용하여
            // blob revoke로 인한 net::ERR_FILE_NOT_FOUND 문제를 원천 차단
            const url = `/api/thumbnail?path=${encodeURIComponent(imgPath)}&size=${DEFAULT_THUMB_SIZE}`;
            // 사전 핑 제거: 서버가 HEAD를 허용하지 않아 405가 발생하므로 생략
            return url;
        } finally {
            this.concurrentLoads--;
            // 대기 중인 요청 처리
            if (this.loadQueue.length > 0) {
                const resolve = this.loadQueue.shift();
                resolve();
            }
        }
    }

    // Intersection Observer 설정
    setupIntersectionObserver() {
        const scrollRoot = document.querySelector('.grid-scroll-wrapper') || document.getElementById('image-grid');
        this.observer = new IntersectionObserver((entries) => {
            // 뷰포트에 들어오는 항목들을 우선순위별로 정렬
            const visibleEntries = entries.filter(entry => entry.isIntersecting);
            const hiddenEntries = entries.filter(entry => !entry.isIntersecting);
            
            // 뷰포트에 들어온 이미지들을 intersection ratio 순으로 정렬하여 우선 처리
            visibleEntries
                .sort((a, b) => b.intersectionRatio - a.intersectionRatio)
                .forEach(entry => {
                    const imgPath = entry.target.getAttribute('data-img-path');
                    if (!imgPath) return;
                    
                    // 가시영역 가까울수록, 위쪽보다는 현재 뷰 우선
                    const priority = entry.intersectionRatio > 0.4 ? 'urgent' : 'high';
                    this.loadThumbnailAndDisplay(imgPath, entry.target, priority);
                });
            
            // 뷰포트에서 나간 이미지들 우선순위 낮춤
            hiddenEntries.forEach(entry => {
                const imgPath = entry.target.getAttribute('data-img-path');
                if (imgPath && entry.intersectionRatio === 0) {
                    this.adjustPriority(imgPath, 'low');
                }
            });
        }, {
            root: scrollRoot,
            // 보일 영역을 더 일찍 감지해 선제 로드 강화 (상/하/좌/우)
            rootMargin: '300px 800px 800px 800px',
            threshold: [0, 0.25, 0.5, 0.75, 1.0]
        });
    }
    
    // 썸네일 로드 후 실제 이미지에 적용
    async loadThumbnailAndDisplay(imgPath, element, priority = 'high') {
        try {
            const thumbnailUrl = await this.loadThumbnailWithPriority(imgPath, priority);
            if (thumbnailUrl) {
                // 실제 img 엘리먼트 찾기
                const img = element.querySelector('img.grid-thumb-img') || 
                           (element.classList.contains('grid-thumb-img') ? element : null);
                
                if (img && img.getAttribute('data-img-path') === imgPath) {
                    // priority 힌트 부여 (브라우저 힌트)
                    try { img.fetchPriority = (priority === 'urgent' ? 'high' : priority); } catch(e) {}
                    img.loading = 'eager';
                    img.decoding = 'async';
                    img.src = thumbnailUrl;
                    // onload에서 opacity가 변경됨
                }
            }
        } catch (error) {
            console.warn(`썸네일 로드 실패: ${imgPath}`, error);
        }
    }
    
    // 스크롤 시 즉시 보이는 이미지들을 감지하고 우선 로드
    checkVisibleThumbnails() {
        const grid = document.getElementById('image-grid');
        const scrollRoot = document.querySelector('.grid-scroll-wrapper') || grid;
        if (!grid) return;
        
        const gridRect = scrollRoot.getBoundingClientRect();
        // 현재 구조에 맞게 선택자 수정: placeholder(data:)가 설정된 항목이 미로드 상태
        const images = grid.querySelectorAll('.grid-thumb-wrap img.grid-thumb-img[data-img-path]');
        
        images.forEach(img => {
            if (img.src && !img.src.startsWith('data:')) return; // 이미 로드됨
            const rect = img.getBoundingClientRect();
            const isVisible = rect.top < gridRect.bottom && rect.bottom > gridRect.top &&
                             rect.left < gridRect.right && rect.right > gridRect.left;
            
            if (isVisible) {
                const imgPath = img.getAttribute('data-img-path');
                if (imgPath) {
                    // 즉시 로드 (wrapper는 grid-thumb-wrap)
                    this.loadThumbnailAndDisplay(imgPath, img.closest('.grid-thumb-wrap'), 'urgent');
                }
            }
        });

        // 가시 영역 처리 후, 남은 항목은 백그라운드로 부드럽게 순차 로딩
        this.streamBackground();
    }
    
    // 엘리먼트 관찰 시작
    observeElement(element) {
        if (this.observer && element) {
            this.observer.observe(element);
        }
    }
    
    // 엘리먼트 관찰 중단
    unobserveElement(element) {
        if (this.observer && element) {
            this.observer.unobserve(element);
        }
    }
    
    // 우선순위별 썸네일 로딩 (기존 loadThumbnail 사용)
    async loadThumbnailWithPriority(imgPath, priority = 'normal') {
        // 기존 loadThumbnail 메소드 사용하되, 우선순위 정보만 저장
        const result = await this.loadThumbnail(imgPath);
        
        // 우선순위 정보 저장
        const cached = this.cache.get(imgPath);
        if (cached) {
            cached.priority = priority;
        }
        
        return result;
    }
    
    // 우선순위 조정
    adjustPriority(imgPath, newPriority) {
        const cached = this.cache.get(imgPath);
        if (cached) {
            cached.priority = newPriority;
        }
    }
    
    // 큐 처리는 단순화 - 기존 시스템 활용
    async processQueue() {
        // 기존 로딩 시스템 사용으로 단순화됨
    }

    // 배경에서 가시영역 아래부터 우선 → 상단 방향 순차 로딩 (멈춤 없이 지속)
    streamBackground() {
        if (this.backgroundRunning) return;
        const grid = document.getElementById('image-grid');
        if (!grid) return;
        this.backgroundRunning = true;
        const step = async () => {
            const gridEl = document.getElementById('image-grid');
            if (!gridEl) { this.backgroundRunning = false; return; }

            // 아직 로드되지 않은 이미지들 수집
            const nodes = gridEl.querySelectorAll('.grid-thumb-wrap img.grid-thumb-img[data-img-path]');
            const pending = [];
            nodes.forEach(img => { if (!img.src || img.src.startsWith('data:')) pending.push(img); });

            if (pending.length === 0) { this.backgroundRunning = false; return; }

            const gridRect = gridEl.getBoundingClientRect();
            // 한 스텝에 여러 개를 순차 처리해 체감 속도 상승(메인스레드 점유 최소화)
            const pickTargets = [];
            // 1) 뷰포트 아래쪽에서 가까운 순 2~3개
            const below = pending.filter(img => img.getBoundingClientRect().top >= gridRect.bottom).slice(0, 3);
            pickTargets.push(...below);
            // 2) 부족하면 상단부터 보충
            if (pickTargets.length < 3) {
                const fill = pending.slice(0, 3 - pickTargets.length);
                pickTargets.push(...fill);
            }

            for (const target of pickTargets) {
                const path = target.getAttribute('data-img-path');
                try { await this.loadThumbnailAndDisplay(path, target.closest('.grid-thumb-wrap'), 'low'); } catch (e) {}
            }

            // 다음 스텝: 약 60fps 간격 유지
            setTimeout(step, 16);
        };
        // 첫 스텝 시작
        setTimeout(step, 0);
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
        
        // 가시영역 체크를 더 정확하게
        let batch = uncachedPaths.slice(0, batchSize);
        try {
            const grid = document.getElementById('image-grid');
            if (grid) {
                const gridRect = grid.getBoundingClientRect();
                const children = Array.from(grid.querySelectorAll('[data-img-path]'));
                
                // 현재 보이는 영역과 곧 보일 영역을 구분
                const visible = new Set();
                const nearVisible = new Set();
                
                children.forEach(el => {
                    const rect = el.getBoundingClientRect();
                    const path = el.getAttribute('data-img-path');
                    
                    if (rect.bottom >= gridRect.top && rect.top <= gridRect.bottom) {
                        visible.add(path); // 현재 보이는 영역
                    } else if (rect.bottom >= gridRect.top - 400 && rect.top <= gridRect.bottom + 400) {
                        nearVisible.add(path); // 곧 보일 영역
                    }
                });
                
                // 우선순위 정렬: 보이는 것 > 곧 보일 것 > 나머지
                batch.sort((a, b) => {
                    const aVisible = visible.has(a);
                    const bVisible = visible.has(b);
                    const aNear = nearVisible.has(a);
                    const bNear = nearVisible.has(b);
                    
                    if (aVisible && !bVisible) return -1;
                    if (!aVisible && bVisible) return 1;
                    if (aNear && !bNear) return -1;
                    if (!aNear && bNear) return 1;
                    return 0;
                });
            }
        } catch (e) {
            console.warn('가시영역 계산 실패:', e);
        }
        
        // 서버 배치 프리로드 비활성화: 대량 선택 시 서버/네트워크 폭주 방지
        // 즉시 개별 로딩으로 큐에만 적재하여 IntersectionObserver가 제어
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

/**
 * 픽셀 완벽 렌더링을 위한 유틸리티 함수
 * 모든 브라우저에서 이미지 스무딩을 완전히 비활성화
 */
function setPixelPerfectRendering(ctx) {
    // 표준 속성
    ctx.imageSmoothingEnabled = false;
    
    // 벤더별 속성들 (브라우저 호환성)
    ctx.webkitImageSmoothingEnabled = false;
    ctx.mozImageSmoothingEnabled = false;
    ctx.msImageSmoothingEnabled = false;
    ctx.oImageSmoothingEnabled = false;
    
    // 고해상도 디스플레이를 위한 추가 설정
    if (ctx.imageSmoothingQuality) {
        ctx.imageSmoothingQuality = 'low';
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
        
        // 반도체 특화 렌더러 초기화
        this.semiconductorRenderer = null;
        this.initSemiconductorRenderer();
        
        // 주기적인 메모리 정리 (5분마다)
        this.cleanupInterval = setInterval(() => {
            this.performCleanup();
        }, 5 * 60 * 1000);
        
        // 페이지 언로드시 정리
        window.addEventListener('beforeunload', () => {
            this.cleanup();
        });
    }
    
    initSemiconductorRenderer() {
        if (typeof SemiconductorRenderer !== 'undefined' && this.dom?.imageCanvas) {
            this.semiconductorRenderer = new SemiconductorRenderer(this.dom.imageCanvas, {
                preserveChipBoundaries: true,
                enhanceDefects: true,
                chipBoundaryColor: '#00FF00',
                defectEnhancement: 2.0,
                usePyramid: true // 이미지 피라미드 활성화
            });
            console.log('반도체 특화 렌더러 초기화 완료 (이미지 피라미드 활성화)');
        } else {
            console.warn('SemiconductorRenderer 또는 imageCanvas가 준비되지 않았습니다');
        }
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
            fileNameDisplay: document.getElementById('file-name-display'),
            fileNameText: document.getElementById('file-name-text'),
            filePathText: document.getElementById('file-path-text'),
            subfolderSelect: document.getElementById('subfolder-select'),
            subfolderSearch: document.getElementById('subfolder-search'),
            subfolderDropdown: document.getElementById('subfolder-dropdown'),
            // 제거됨: browseFolderBtn, refreshBtn
            addClassBtn: document.getElementById('add-class-btn'),
            newClassInput: document.getElementById('new-class-input'),
            classList: document.getElementById('class-list'),
            labelStatus: document.getElementById('label-status'),
            deleteClassBtn: document.getElementById('delete-class-btn'),
            fileSearch: document.getElementById('file-search'),
            searchBtn: document.getElementById('search-btn'),
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
        this.currentFolderPath = '';
        this.selectedFolderForBrowser = '';
        this.selectedProductName = null; // 현재 선택된 제품명
        this.subfolderOptions = []; // 검색 가능한 폴더 옵션들
        this.selectedSubfolderIndex = -1; // 현재 선택된 인덱스
        this.isSearchMode = false; // 검색 모드 여부

        // 전역 파일 인덱스 (폴더를 열지 않아도 검색 가능)
        this.allFilesIndex = null; // string[] (ROOT 기준 상대경로, posix)
        this.allFilesIndexLoaded = false;

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
        // 싱글 이미지 모드에서 우클릭 시 원본 파일을 바로 저장
        if (this.dom.viewerContainer)
            this.dom.viewerContainer.addEventListener('contextmenu', e => {
                if (this.gridMode) return; // 그리드 모드에서는 기존 컨텍스트 사용
                if (!this.selectedImagePath) return;
                e.preventDefault();
                this.showSingleContextMenu(e);
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
            this.dom.resetViewBtn.addEventListener('click', () => this.resetViewWithAbsoluteOffset());
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
            // 드래그 멀티 선택 초기화
            this.setupFileExplorerDragSelect();
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
        // 단일 이미지 모드만 해제 (상단 패널/줌바는 유지)
        if (this.dom.imageCanvas) this.dom.imageCanvas.style.display = 'none';
        if (this.dom.overlayCanvas) this.dom.overlayCanvas.style.display = 'none';
        if (this.dom.minimapContainer) this.dom.minimapContainer.style.display = 'none';
        
        // 뷰어 컨테이너 클래스 제거
        if (this.dom.viewerContainer) {
            this.dom.viewerContainer.classList.remove('single-image-mode');
        }
        
        // 파일명 표시 및 현재 선택 이미지 경로 초기화
        if (this.dom.fileNameDisplay) this.dom.fileNameDisplay.style.display = 'none';
        if (this.dom.fileNameText) this.dom.fileNameText.textContent = '';
        if (this.dom.filePathText) this.dom.filePathText.textContent = '';
        this.selectedImagePath = '';
        this.currentImage = null;
        this.currentImageBitmap = null;

        // 상단 패널과 줌바는 항상 표시
        const viewControls = document.querySelector('.view-controls');
        if (viewControls) viewControls.style.display = 'flex';
    }

    // 파일명 표시
    showFileName(path) {
        if (this.dom.fileNameDisplay && this.dom.fileNameText && this.dom.filePathText) {
            const fileName = path.split('/').pop() || path.split('\\').pop() || path;
            this.dom.fileNameText.textContent = fileName;
            
            // 이미지폴더 root부터 상대경로로 표시
            const relativePath = this.getRelativePathFromImageFolder(path);
            this.dom.filePathText.textContent = relativePath;
            this.dom.fileNameDisplay.style.display = 'block';
            // 상단 바가 보이도록 캔버스 높이는 CSS 변수로 이미 확보됨
        }
    }

    // 이미지폴더 root부터 상대경로 계산
    getRelativePathFromImageFolder(fullPath) {
        if (!this.currentFolderPath) return fullPath;
        
        try {
            const fullPathObj = new URL(fullPath, 'file://').pathname;
            const currentPathObj = new URL(this.currentFolderPath, 'file://').pathname;
            
            if (fullPathObj.startsWith(currentPathObj)) {
                return fullPathObj.substring(currentPathObj.length).replace(/^[\/\\]/, '');
            }
        } catch (e) {
            // URL 파싱 실패 시 단순 문자열 처리
            const normalizedFull = fullPath.replace(/\\/g, '/');
            const normalizedCurrent = this.currentFolderPath.replace(/\\/g, '/');
            
            if (normalizedFull.startsWith(normalizedCurrent)) {
                return normalizedFull.substring(normalizedCurrent.length).replace(/^[\/\\]/, '');
            }
        }
        
        return fullPath;
    }

    // 현재 경로 업데이트
    async updateCurrentPath() {
        try {
            const response = await fetch('/api/current-folder');
            const data = await response.json();
            this.currentFolderPath = data.current_folder;
            
            // 하위폴더 목록 업데이트
            await this.updateSubfolderList();
        } catch (error) {
            console.error('현재 경로 업데이트 실패:', error);
        }
    }

    // 하위 폴더 목록 업데이트
    async updateSubfolderList() {
        try {
            // 항상 파일 탐색기에서 직접 가져오기
            await this.loadSubfoldersFromFileExplorer();
        } catch (error) {
            console.error('하위 폴더 목록 업데이트 실패:', error);
        }
    }

    // 파일 탐색기에서 하위 폴더 목록 로드 (항상 이미지 폴더 최상위 기준)
    async loadSubfoldersFromFileExplorer() {
        try {
            // 설정된 루트 이미지 폴더 경로를 API에서 가져오기
            const rootResponse = await fetch('/api/root-folder');
            if (!rootResponse.ok) {
                throw new Error(`Failed to get root folder: ${rootResponse.status}`);
            }
            const rootData = await rootResponse.json();
            const imageRootPath = rootData.root_folder;
            
            const response = await fetch(`/api/browse-folders?path=${encodeURIComponent(imageRootPath)}`);
            
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }
            
            const data = await response.json();
            console.log('Browse folders response:', data); // 디버깅용
            
            const folders = data.folders || [];
            
            // 폴더 필터링 (API에서 이미 내림차순 정렬됨)
            const filteredFolders = folders
                .filter(folder => 
                    folder.name !== 'classification' && 
                    folder.name !== 'thumbnails' &&
                    folder.name !== 'labels'
                );
            
            if (this.dom.subfolderSelect) {
                // 현재 선택된 제품명을 유지
                const currentText = this.selectedProductName || '제품 선택';
                
                this.dom.subfolderSelect.innerHTML = `<option value="">${currentText}</option>`;
                
                // 최상위 폴더로 가기 옵션 추가
                const rootOption = document.createElement('option');
                rootOption.value = imageRootPath;
                rootOption.textContent = '🏠 최상위 폴더';
                rootOption.style.backgroundColor = '#444';
                rootOption.style.color = '#fff';
                this.dom.subfolderSelect.appendChild(rootOption);
                
                // 구분선 추가
                const separatorOption = document.createElement('option');
                separatorOption.disabled = true;
                separatorOption.textContent = '──────────────';
                separatorOption.style.color = '#666';
                this.dom.subfolderSelect.appendChild(separatorOption);
                
                filteredFolders.forEach(folder => {
                    const option = document.createElement('option');
                    // folder.path를 사용 (API에서 반환하는 전체 경로)
                    option.value = folder.path;
                    option.textContent = folder.name;
                    this.dom.subfolderSelect.appendChild(option);
                });
                
                console.log(`하위 폴더 ${filteredFolders.length}개 로드됨`); // 디버깅용
            }
        } catch (error) {
            console.error('파일 탐색기에서 폴더 로드 실패:', error);
        }
    }

    // 하위 폴더 선택 처리
    async onSubfolderSelect(event) {
        const selectedPath = event.target.value;
        const selectedText = event.target.options[event.target.selectedIndex].text;
        
        if (!selectedPath) {
            // 기본 선택으로 돌아갔을 때
            this.selectedProductName = null;
            return;
        }
        
        // 선택된 제품명 저장 (최상위 폴더인 경우 특별 처리)
        if (selectedText === '🏠 최상위 폴더') {
            this.selectedProductName = '최상위 폴더';
        } else {
            this.selectedProductName = selectedText;
        }
        
        // 폴더 변경
        await this.changeFolder(selectedPath);
    }

    // 제품 검색 기능 설정 (기존 select 요소 유지하면서 검색 모드 추가)
    setupProductSearch() {
        if (!this.dom.subfolderSelect || !this.dom.subfolderSearch || !this.dom.subfolderDropdown) return;

        // select 요소 클릭 시 검색 모드로 전환
        this.dom.subfolderSelect.addEventListener('click', (e) => {
            // 기본 드롭다운이 열리기 전에 검색 모드로 전환
            e.preventDefault();
            this.enterSearchMode();
        });

        // 검색 입력 필드 이벤트
        this.dom.subfolderSearch.addEventListener('input', (e) => {
            const query = e.target.value.toLowerCase().trim();
            this.filterSubfolderOptions(query);
            this.showDropdown();
        });

        // 검색 필드 포커스 아웃 시 원래 모드로 복귀 (선택되지 않은 경우)
        this.dom.subfolderSearch.addEventListener('blur', (e) => {
            // 드롭다운 클릭이 아닌 경우에만 검색 모드 종료
            setTimeout(() => {
                if (!this.dom.subfolderDropdown.matches(':hover')) {
                    this.exitSearchMode();
                }
            }, 150);
        });

        // 키보드 네비게이션
        this.dom.subfolderSearch.addEventListener('keydown', (e) => {
            if (!this.isSearchMode) return;

            switch (e.key) {
                case 'ArrowDown':
                    e.preventDefault();
                    this.navigateDropdown(1);
                    break;
                case 'ArrowUp':
                    e.preventDefault();
                    this.navigateDropdown(-1);
                    break;
                case 'Enter':
                    e.preventDefault();
                    this.selectCurrentOption();
                    break;
                case 'Escape':
                    this.exitSearchMode();
                    break;
            }
        });

        // 외부 클릭 시 검색 모드 종료
        document.addEventListener('click', (e) => {
            if (!e.target.closest('#folder-selection')) {
                this.exitSearchMode();
            }
        });

        // 앱 시작 시 제품 폴더 목록 로드
        this.loadAllProductFolders();
    }

    // 검색 모드로 전환
    enterSearchMode() {
        this.isSearchMode = true;
        this.dom.subfolderSelect.style.display = 'none';
        this.dom.subfolderSearch.style.display = 'block';
        this.dom.subfolderSearch.focus();
        this.dom.subfolderSearch.value = '';
        this.showDropdown();
    }

    // 검색 모드 종료
    exitSearchMode() {
        this.isSearchMode = false;
        this.dom.subfolderSearch.style.display = 'none';
        this.dom.subfolderSelect.style.display = 'block';
        this.hideDropdown();
    }

    // 드롭다운 옵션 필터링
    filterSubfolderOptions(query) {
        const dropdown = this.dom.subfolderDropdown;
        dropdown.innerHTML = '';

        const filteredOptions = this.subfolderOptions.filter(option => 
            option.text.toLowerCase().includes(query)
        );

        if (filteredOptions.length === 0) {
            const noResults = document.createElement('div');
            noResults.className = 'subfolder-dropdown-item';
            noResults.textContent = '검색 결과가 없습니다';
            noResults.style.color = '#999';
            dropdown.appendChild(noResults);
            return;
        }

        filteredOptions.forEach((option, index) => {
            const item = document.createElement('div');
            item.className = 'subfolder-dropdown-item';
            item.textContent = option.text;
            item.dataset.value = option.value;
            item.dataset.index = index;

            item.addEventListener('click', () => {
                this.selectSearchOption(option);
            });

            dropdown.appendChild(item);
        });

        this.selectedSubfolderIndex = -1;
    }

    // 드롭다운 표시
    showDropdown() {
        if (this.subfolderOptions.length === 0) return;
        
        this.filterSubfolderOptions(this.dom.subfolderSearch.value.toLowerCase().trim());
        this.dom.subfolderDropdown.style.display = 'block';
    }

    // 드롭다운 숨기기
    hideDropdown() {
        this.dom.subfolderDropdown.style.display = 'none';
        this.selectedSubfolderIndex = -1;
    }

    // 키보드로 드롭다운 네비게이션
    navigateDropdown(direction) {
        const items = this.dom.subfolderDropdown.querySelectorAll('.subfolder-dropdown-item');
        if (items.length === 0) return;

        // 현재 선택 해제
        items.forEach(item => item.classList.remove('selected'));

        // 새 인덱스 계산
        this.selectedSubfolderIndex += direction;
        if (this.selectedSubfolderIndex < 0) {
            this.selectedSubfolderIndex = items.length - 1;
        } else if (this.selectedSubfolderIndex >= items.length) {
            this.selectedSubfolderIndex = 0;
        }

        // 새 선택 적용
        items[this.selectedSubfolderIndex].classList.add('selected');
        items[this.selectedSubfolderIndex].scrollIntoView({ block: 'nearest' });
    }

    // 현재 선택된 옵션 선택
    selectCurrentOption() {
        const selectedItem = this.dom.subfolderDropdown.querySelector('.subfolder-dropdown-item.selected');
        if (selectedItem && selectedItem.dataset.value) {
            const option = this.subfolderOptions.find(opt => opt.value === selectedItem.dataset.value);
            if (option) {
                this.selectSearchOption(option);
            }
        }
    }

    // 검색에서 옵션 선택 처리
    async selectSearchOption(option) {
        this.selectedProductName = option.text.includes('🏠') ? '전체' : option.text;
        this.exitSearchMode();
        
        // 기존 select 요소 업데이트
        const selectOption = Array.from(this.dom.subfolderSelect.options).find(opt => opt.value === option.value);
        if (selectOption) {
            this.dom.subfolderSelect.value = option.value;
        }
        
        if (option.value) {
            await this.changeFolder(option.value);
        }
    }

    // 전체 제품 폴더 목록 미리 로드
    async loadAllProductFolders() {
        try {
            // 루트 폴더 정보 가져오기
            const rootResponse = await fetch('/api/root-folder');
            if (!rootResponse.ok) return;
            
            const rootData = await rootResponse.json();
            const imageRootPath = rootData.root_folder;
            
            // 루트 폴더의 하위 폴더들 가져오기
            const foldersResponse = await fetch(`/api/browse-folders?path=${encodeURIComponent(imageRootPath)}`);
            if (!foldersResponse.ok) return;
            
            const foldersData = await foldersResponse.json();
            const allFolders = foldersData.folders || [];
            
            // 시스템 폴더 제외
            const productFolders = allFolders.filter(folder => 
                folder.name !== 'classification' && 
                folder.name !== 'thumbnails' &&
                folder.name !== 'labels'
            );
            
            // 검색 옵션 초기화
            this.subfolderOptions = [];
            
            // 최상위 폴더 옵션 추가 (항상 첫 번째)
            this.subfolderOptions.push({
                value: imageRootPath,
                text: '🏠 최상위 폴더'
            });
            
            // 모든 제품 폴더 추가
            productFolders.forEach(folder => {
                this.subfolderOptions.push({
                    value: folder.path,
                    text: folder.name
                });
            });
            
            // 알파벳 순으로 정렬 (최상위 폴더는 항상 첫 번째)
            this.subfolderOptions.sort((a, b) => {
                if (a.text.includes('🏠')) return -1;
                if (b.text.includes('🏠')) return 1;
                return a.text.localeCompare(b.text);
            });
            
            console.log('전체 제품 폴더 로드 완료:', this.subfolderOptions.length, '개');
            
        } catch (error) {
            console.error('전체 제품 폴더 로드 실패:', error);
        }
    }

    // 폴더 변경
    async changeFolder(newPath) {
        try {
            const response = await fetch('/api/change-folder', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ path: newPath })
            });
            
            const result = await response.json();
            if (result.success) {
                // 폴더 변경 시 선택된 이미지들과 그리드 상태 초기화
                this.selectedImages = [];
                this.gridSelectedIdxs = [];
                this.selectedImagePath = '';
                
                // 현재 표시 비우기
                this.hideGrid();
                this.hideImage();
                this.hideFileName();
                
                await this.updateCurrentPath();
                this.loadDirectoryContents(null, this.dom.fileExplorer);
                await this.refreshClassList();
                await this.refreshLabelExplorer();
                // 초기 상태로 전환(검색창/그리드 컨트롤 표시)
                this.showInitialState();
                // 폴더 변경 메시지 제거
            } else {
                this.showToast('폴더 변경에 실패했습니다.');
            }
        } catch (error) {
            console.error('폴더 변경 실패:', error);
            this.showToast('폴더 변경에 실패했습니다.');
        }
    }

    // 절대경로를 이미지 폴더 기준 상대경로로 변환
    async getRelativePath(absolutePath) {
        try {
            const rootResponse = await fetch('/api/root-folder');
            if (rootResponse.ok) {
                const rootData = await rootResponse.json();
                const imageRoot = rootData.root_folder.replace(/\\/g, '/');
                const currentPath = absolutePath.replace(/\\/g, '/');
                
                // 이미지 폴더명 추출
                const imageFolderName = imageRoot.split('/').pop() || 'root';
                
                if (currentPath === imageRoot) {
                    return imageFolderName;
                } else if (currentPath.startsWith(imageRoot)) {
                    const relativePath = currentPath.substring(imageRoot.length).replace(/^\//, '');
                    return relativePath ? `${imageFolderName}/${relativePath}` : imageFolderName;
                } else {
                    return imageFolderName;
                }
            }
        } catch (error) {
            console.error('상대경로 변환 실패:', error);
        }
        // 폴백: 경로의 마지막 부분만 반환
        return absolutePath.replace(/\\/g, '/').split('/').pop() || absolutePath;
    }

    // 폴더 브라우저 표시
    async showFolderBrowser() {
        const modal = document.getElementById('folder-browser-modal');
        if (!modal) return;
        modal.style.display = 'flex';
        
        try {
            // 설정된 루트 폴더에서 시작
            const rootResponse = await fetch('/api/root-folder');
            if (rootResponse.ok) {
                const rootData = await rootResponse.json();
                const imageRoot = rootData.root_folder;
                const input = modal.querySelector('#folder-path-input');
                if (input) {
                    const relativePath = await this.getRelativePath(imageRoot);
                    input.value = relativePath;
                }
                this.currentBrowserPath = imageRoot;
                this.loadFolderBrowser(imageRoot);
            } else {
                // 폴백: 현재 폴더 사용
                const input = modal.querySelector('#folder-path-input');
                if (input) {
                    const relativePath = await this.getRelativePath(this.currentFolderPath || '');
                    input.value = relativePath;
                }
                this.currentBrowserPath = this.currentFolderPath || '';
                this.loadFolderBrowser(this.currentFolderPath);
            }
        } catch (error) {
            console.error('폴더 브라우저 초기화 실패:', error);
            // 폴백: 현재 폴더 사용
            const input = modal.querySelector('#folder-path-input');
            if (input) {
                const relativePath = await this.getRelativePath(this.currentFolderPath || '');
                input.value = relativePath;
            }
            this.currentBrowserPath = this.currentFolderPath || '';
            this.loadFolderBrowser(this.currentFolderPath);
        }
    }
    // 폴더 브라우저 이벤트 설정
    setupFolderBrowserEvents() {
        const modal = document.getElementById('folder-browser-modal');
        if (!modal) return;

        // 모달 닫기
        modal.querySelector('.modal-close').addEventListener('click', () => {
            modal.style.display = 'none';
        });

        modal.querySelector('#folder-browser-cancel').addEventListener('click', () => {
            modal.style.display = 'none';
        });

        // 폴더 선택
        modal.querySelector('#folder-browser-select').addEventListener('click', async () => {
            if (this.selectedFolderForBrowser) {
                await this.changeFolder(this.selectedFolderForBrowser);
                modal.style.display = 'none';
            }
        });

        // 경로 입력으로 이동
        modal.querySelector('#go-to-folder-btn').addEventListener('click', () => {
            const pathInput = modal.querySelector('#folder-path-input');
            const path = pathInput.value.trim();
            if (path) {
                this.loadFolderBrowser(path);
            }
        });

        // 루트로 이동 (설정된 이미지폴더)
        const rootBtn = modal.querySelector('#folder-root-btn');
        if (rootBtn) {
            rootBtn.addEventListener('click', async () => {
                try {
                    // 설정된 루트 폴더 경로 가져오기
                    const rootResponse = await fetch('/api/root-folder');
                    if (rootResponse.ok) {
                        const rootData = await rootResponse.json();
                        const imageRoot = rootData.root_folder;
                        this.loadFolderBrowser(imageRoot);
                        const input = modal.querySelector('#folder-path-input');
                        if (input) {
                            const relativePath = await this.getRelativePath(imageRoot);
                            input.value = relativePath;
                        }
                    }
                } catch (error) {
                    console.error('루트 이동 실패:', error);
                }
            });
        }

        // 상위 폴더로 이동 (이미지폴더보다 위로는 제한)
        const upBtn = modal.querySelector('#folder-up-btn');
        if (upBtn) {
            upBtn.addEventListener('click', async () => {
                try {
                    // 설정된 루트 폴더 경로 가져오기
                    const rootResponse = await fetch('/api/root-folder');
                    if (!rootResponse.ok) {
                        console.error('루트 폴더 정보를 가져올 수 없습니다');
                        return;
                    }
                    const rootData = await rootResponse.json();
                    const imageRoot = rootData.root_folder.replace(/\\/g, '/');
                    
                    const currentPath = this.currentBrowserPath || '';
                    const current = currentPath.replace(/\\/g, '/');
                    
                    if (!current || current === imageRoot) {
                        // 루트에서는 위로 갈 수 없음 - 아무 변화 없음
                        return;
                    }
                    
                    const parent = current.replace(/\/$/,'').split('/').slice(0,-1).join('/');
                    
                    // 이미지 루트보다 위로는 갈 수 없음
                    if (parent.length < imageRoot.length || !parent.startsWith(imageRoot)) {
                        this.loadFolderBrowser(imageRoot);
                        const input = modal.querySelector('#folder-path-input');
                        if (input) {
                            const relativePath = await this.getRelativePath(imageRoot);
                            input.value = relativePath;
                        }
                    } else {
                        this.loadFolderBrowser(parent);
                        const input = modal.querySelector('#folder-path-input');
                        if (input) {
                            const relativePath = await this.getRelativePath(parent);
                            input.value = relativePath;
                        }
                    }
                } catch (error) {
                    console.error('위로 이동 실패:', error);
                }
            });
        }

        // Enter 키로 이동
        modal.querySelector('#folder-path-input').addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                const pathInput = modal.querySelector('#folder-path-input');
                const path = pathInput.value.trim();
                if (path) {
                    this.loadFolderBrowser(path);
                }
            }
        });
    }

    // 폴더 브라우저 로드
    async loadFolderBrowser(path = '') {
        try {
            // path가 없으면 설정된 루트 이미지폴더의 하위폴더들을 가져오기
            if (!path) {
                // 설정된 루트 폴더 사용
                const rootResponse = await fetch('/api/root-folder');
                if (rootResponse.ok) {
                    const rootData = await rootResponse.json();
                    const imageRoot = rootData.root_folder;
                    
                    const response = await fetch(`/api/browse-folders?path=${encodeURIComponent(imageRoot)}`);
                    const data = await response.json();
                    const folders = (data.folders || [])
                        .filter(folder => 
                            folder.name !== 'classification' && 
                            folder.name !== 'thumbnails' &&
                            folder.name !== 'labels'
                        )
                        .sort((a, b) => b.name.toLowerCase().localeCompare(a.name.toLowerCase()));
                    
                    this.displayFoldersAsIcons(folders);
                    
                    // 루트 경로 표시 (이미지 폴더명)
                    const currentFolderText = document.getElementById('current-folder-text');
                    if (currentFolderText) {
                        const imageFolderName = imageRoot.split('/').pop() || 'root';
                        currentFolderText.textContent = imageFolderName;
                    }
                    this.currentBrowserPath = imageRoot;
                    return;
                } else {
                    // 폴백: 기존 방식
                    const response = await fetch('/api/files');
                    const data = await response.json();
                    const items = data.items || [];
                    
                    const folders = items
                        .filter(item => item.type === 'directory')
                        .filter(folder => 
                            folder.name !== 'classification' && 
                            folder.name !== 'thumbnails' &&
                            folder.name !== 'labels'
                        )
                        .sort((a, b) => b.name.toLowerCase().localeCompare(a.name.toLowerCase()));
                    
                    this.displayFoldersAsIcons(folders);
                    
                    // 루트 경로 표시 (폴백)
                    const currentFolderText = document.getElementById('current-folder-text');
                    if (currentFolderText) {
                        const folderName = (this.currentFolderPath || '').replace(/\\/g, '/').split('/').pop() || 'root';
                        currentFolderText.textContent = folderName;
                    }
                    this.currentBrowserPath = this.currentFolderPath || '';
                    return;
                }
            }
            
            const response = await fetch(`/api/browse-folders?path=${encodeURIComponent(path)}`);
            const data = await response.json();
            const folders = data.folders || [];
            
            folders.sort((a,b)=> (b.name||'').toLowerCase().localeCompare((a.name||'').toLowerCase()));
            this.displayFoldersAsIcons(folders);
            
            // 현재 경로를 이미지 폴더명부터 표시
            const currentFolderText = document.getElementById('current-folder-text');
            if (currentFolderText) {
                // 설정된 루트 폴더 경로 가져오기
                const rootResponse = await fetch('/api/root-folder');
                if (rootResponse.ok) {
                    const rootData = await rootResponse.json();
                    const imageRoot = rootData.root_folder.replace(/\\/g, '/');
                    const currentPath = path.replace(/\\/g, '/');
                    
                    // 이미지 폴더명 추출 (경로의 마지막 부분)
                    const imageFolderName = imageRoot.split('/').pop() || 'root';
                    
                    if (currentPath === imageRoot) {
                        currentFolderText.textContent = imageFolderName;
                    } else if (currentPath.startsWith(imageRoot)) {
                        const relativePath = currentPath.substring(imageRoot.length).replace(/^\//, '');
                        currentFolderText.textContent = relativePath ? `${imageFolderName}/${relativePath}` : imageFolderName;
                    } else {
                        currentFolderText.textContent = imageFolderName;
                    }
                } else {
                    // 폴백: 경로의 마지막 부분만 표시
                    const folderName = path.replace(/\\/g, '/').split('/').pop() || path;
                    currentFolderText.textContent = folderName;
                }
            }
            this.currentBrowserPath = path;
            
        } catch (error) {
            console.error('폴더 브라우저 로드 실패:', error);
            const folderList = document.getElementById('folder-list');
            if (folderList) {
                folderList.innerHTML = '<p style="color: #ff6b6b; text-align: center; padding: 20px;">폴더 로드에 실패했습니다.</p>';
            }
        }
    }

    // 폴더들을 아이콘 방식으로 표시
    displayFoldersAsIcons(folders) {
        const folderList = document.getElementById('folder-list');
        if (!folderList) return;
        
        folderList.innerHTML = '';
        
        if (folders.length === 0) {
            folderList.innerHTML = '<p style="color: var(--text-secondary-color); text-align: center; padding: 20px;">폴더가 없습니다.</p>';
            return;
        }
        
        // 그리드 레이아웃으로 아이콘 표시
        folderList.style.cssText = `
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
            gap: 12px;
            padding: 10px;
        `;
        
        folders.forEach(folder => {
            const folderItem = document.createElement('div');
            folderItem.className = 'folder-item';
            folderItem.style.cssText = `
                display: flex;
                flex-direction: column;
                align-items: center;
                padding: 16px 8px;
                background: var(--panel-color);
                border-radius: 8px;
                cursor: pointer;
                border: 2px solid transparent;
                transition: all 0.2s ease;
                text-align: center;
                min-height: 80px;
                justify-content: center;
            `;
            folderItem.innerHTML = `
                <div style="font-size: 32px; margin-bottom: 8px;">📁</div>
                <div style="font-size: 12px; font-weight: bold; word-break: break-word; line-height: 1.2;">${folder.name}</div>
            `;
            
            const openFolder = () => {
                // 이전 선택 제거
                folderList.querySelectorAll('.folder-item').forEach(item => {
                    item.style.background = 'var(--panel-color)';
                    item.style.borderColor = 'transparent';
                });
                
                // 현재 선택 표시
                folderItem.style.background = 'var(--accent-color)';
                folderItem.style.borderColor = 'var(--hover-color)';
                
                this.selectedFolderForBrowser = folder.path || (this.currentFolderPath ? `${(this.currentFolderPath.replace(/\\/g,'/')).replace(/\/$/,'')}/${folder.name}` : folder.name);
                // 더블클릭 시 즉시 해당 폴더로 들어가서 하위 폴더 표시
                this.loadFolderBrowser(this.selectedFolderForBrowser);
                const input = document.getElementById('folder-path-input');
                if (input) {
                    this.getRelativePath(this.selectedFolderForBrowser).then(relativePath => {
                        input.value = relativePath;
                    });
                }
            };

            folderItem.addEventListener('click', openFolder);
            folderItem.addEventListener('dblclick', async () => {
                this.selectedFolderForBrowser = folder.path || (this.currentFolderPath ? `${(this.currentFolderPath.replace(/\\/g,'/')).replace(/\/$/,'')}/${folder.name}` : folder.name);
                await this.changeFolder(this.selectedFolderForBrowser);
                const modal = document.getElementById('folder-browser-modal');
                if (modal) modal.style.display = 'none';
            });
            
            folderItem.addEventListener('mouseenter', () => {
                if (folderItem.style.background !== 'var(--accent-color)') {
                    folderItem.style.background = 'var(--hover-color)';
                }
            });
            
            folderItem.addEventListener('mouseleave', () => {
                if (folderItem.style.background !== 'var(--accent-color)') {
                    folderItem.style.background = 'var(--panel-color)';
                }
            });
            
            folderList.appendChild(folderItem);
        });
    }

    // 파일명 표시 숨기기
    hideFileName() {
        if (this.dom.fileNameDisplay) {
            this.dom.fileNameDisplay.style.display = 'none';
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
        

    }
    /**
     * Initial application entry point.
     */
    init() {
        this._drawScheduled = false; // draw() 스케줄링 플래그
        
        // 먼저 이미지 폴더 최상위로 이동
        this.resetToImageFolder().then(() => {
            this.loadDirectoryContents(null, this.dom.fileExplorer);
            this.initClassification();
            this.refreshLabelExplorer();
            
            // 현재 경로 업데이트
            this.updateCurrentPath();
            
            // 초기 실행 시 안내 메시지 표시
            this.showInitialState();

            // 전역 파일 인덱스 비동기 로드 (폴더 오픈 없이 검색 가능하도록)
            this.loadAllFilesIndex();
        });
    }

    // 이미지 폴더 최상위로 리셋
    async resetToImageFolder() {
        try {
            // 설정된 루트 이미지 폴더 경로를 API에서 가져오기
            const rootResponse = await fetch('/api/root-folder');
            if (!rootResponse.ok) {
                throw new Error(`Failed to get root folder: ${rootResponse.status}`);
            }
            const rootData = await rootResponse.json();
            const imageRootPath = rootData.root_folder;
            
            const response = await fetch('/api/change-folder', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ path: imageRootPath })
            });
            
            const result = await response.json();
            if (result.success) {
                console.log('이미지 폴더 최상위로 초기화됨');
            }
        } catch (error) {
            console.error('이미지 폴더 초기화 실패:', error);
        }
    }

    // =====================
    // 파일 탐색기/그리드/이미지 로딩/뷰어/라벨링 등 주요 함수
    // =====================
    async loadAllFilesIndex() {
        try {
            const res = await fetch('/api/files/all');
            if (!res.ok) throw new Error('HTTP ' + res.status);
            const data = await res.json();
            if (data && data.success && Array.isArray(data.files)) {
                this.allFilesIndex = data.files;
                this.allFilesIndexLoaded = true;
                // 콘솔 로그로 파일 수만 표시 (과도한 로그 방지)
                console.log(`전역 파일 인덱스 로드 완료: ${this.allFilesIndex.length}개`);
            } else {
                console.warn('전역 파일 인덱스 응답 형식이 올바르지 않음');
            }
        } catch (error) {
            console.warn('전역 파일 인덱스 로드 실패:', error);
            this.allFilesIndexLoaded = false;
        }
    }
    async loadDirectoryContents(path, containerElement) {
        console.log("[DEBUG] loadDirectoryContents called with path:", path);
        try {
            // 루트 경로이고 첫 로딩이면 우선순위 API 사용
            if (!path && containerElement === this.dom.fileExplorer) {
                await this.loadDirectoryWithPriority(path, containerElement);
                return;
            }
            
            const url = path ? `/api/files?path=${encodeURIComponent(path)}` : '/api/files';
            console.log("[DEBUG] Fetching URL:", url);
            const data = await fetchJson(url);
            const files = Array.isArray(data.items) ? data.items : [];
            containerElement.innerHTML = this.createFileTreeHtml(files, path || '');
            
        } catch (error) {
            containerElement.innerHTML = `<p style=\"color: #ff5555; padding: 10px;\">Error loading files.</p>`;
            console.error("[DEBUG] loadDirectoryContents error:", error);
        }
    }
    
    // 우선순위 기반 폴더 로딩 (classification 우선)
    async loadDirectoryWithPriority(path, containerElement) {
        console.log("[DEBUG] loadDirectoryWithPriority called with path:", path);
        try {
            // 1단계: 우선순위 폴더들 먼저 로드 (classification 우선)
            const priorityUrl = path ? `/api/files/priority?path=${encodeURIComponent(path)}` : '/api/files/priority';
            console.log("[DEBUG] Fetching priority URL:", priorityUrl);
            
            const priorityData = await fetchJson(priorityUrl);
            const priorityFiles = Array.isArray(priorityData.items) ? priorityData.items : [];
            
            // 우선순위 폴더들 먼저 표시
            containerElement.innerHTML = this.createFileTreeHtml(priorityFiles, path || '');
            console.log("[DEBUG] Priority folders loaded:", priorityFiles.length);
            
            // 2단계: 남은 폴더들을 백그라운드에서 lazy loading
            if (priorityData.has_more) {
                setTimeout(async () => {
                    try {
                        const remainingUrl = path ? `/api/files/remaining?path=${encodeURIComponent(path)}` : '/api/files/remaining';
                        console.log("[DEBUG] Fetching remaining URL:", remainingUrl);
                        
                        const remainingData = await fetchJson(remainingUrl);
                        const remainingFiles = Array.isArray(remainingData.items) ? remainingData.items : [];
                        
                        // 기존 우선순위 폴더에 남은 폴더들 추가
                        const allFiles = [...priorityFiles, ...remainingFiles];
                        containerElement.innerHTML = this.createFileTreeHtml(allFiles, path || '');
                        console.log("[DEBUG] Remaining folders loaded:", remainingFiles.length);
                        
                    } catch (error) {
                        console.warn("[DEBUG] Failed to load remaining folders:", error);
                    }
                }, 100); // 100ms 후에 남은 폴더들 로드
            }
            
        } catch (error) {
            console.error("[DEBUG] loadDirectoryWithPriority error:", error);
            // 폴백: 일반 로딩 방식 사용
            this.loadDirectoryContents(path, containerElement);
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
            
            // 전역 인덱스 미로딩 시 즉시 로드하여 사용자 요청 우선
            if (!this.allFilesIndexLoaded) {
                await this.loadAllFilesIndex();
            }

            // 서버 검색 API 사용 (빠름) → 실패 시 인덱스/DOM 폴백
            let matchedImages = [];
            try {
                const res = await fetch(`/api/search?q=${encodeURIComponent(fileQuery)}`);
                if (res.ok) {
                    const data = await res.json();
                    if (data && data.success && Array.isArray(data.results)) {
                        matchedImages = data.results;
                    }
                }
            } catch (e) {
                // ignore and fallback
            }

            if (matchedImages.length === 0) {
                if (this.allFilesIndexLoaded && Array.isArray(this.allFilesIndex)) {
                    const q = fileQuery.toLowerCase();
                    matchedImages = this.allFilesIndex.filter(p => {
                        const name = p.split('/').pop().toLowerCase();
                        return this.matchesSearchQuery(name, q);
                    });
                } else {
                    matchedImages = this.fastFileNameSearch(fileQuery);
                }
            }
            
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
                }, index * 150); // 더 빠르게
            });

            // 진행 안내는 방해 없이 토스트로 간단히 표시
            this.showToast(`${selectedImagePaths.length}개 파일 다운로드 시작`, 1800);
        } catch (error) {
            console.error('선택된 이미지 다운로드 실패:', error);
            alert('선택된 이미지 다운로드에 실패했습니다.');
        }
    }

    // 심플 토스트
    showToast(message, duration = 1500) {
        try {
            const toast = document.createElement('div');
            toast.textContent = message;
            toast.style.cssText = `
                position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%);
                background: rgba(0,0,0,0.85); color: #fff; padding: 8px 14px;
                border-radius: 6px; z-index: 10000; font-size: 13px; box-shadow: 0 2px 10px rgba(0,0,0,0.3);
            `;
            document.body.appendChild(toast);
            setTimeout(() => toast.remove(), duration);
        } catch {}
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
        const mergeSaveItem = document.getElementById('context-merge-save');
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

        if (mergeSaveItem) {
            mergeSaveItem.onclick = () => {
                this.hideContextMenu();
                this.mergeAndSaveImages();
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
            // 최적 그리드 계산 (남는 칸 최소)
            let cols = Math.ceil(Math.sqrt(selectedCount));
            let rows = Math.ceil(selectedCount / cols);

            // Canvas 생성
            const canvas = document.createElement('canvas');
            const ctx = canvas.getContext('2d');
            
            // 픽셀 완벽한 렌더링을 위해 이미지 스무딩 비활성화
            setPixelPerfectRendering(ctx);
            
            // 각 이미지 크기 (512px로 설정)
            const imageSize = 512;
            canvas.width = cols * imageSize;
            canvas.height = rows * imageSize;
            
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
                        const row = Math.floor(index / cols);
                        const col = index % cols;
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
                    // 클립보드 권한 확인 및 요청
                    const hasPermission = await this.ensureClipboardPermission();
                    
                    if (hasPermission && navigator.clipboard && navigator.clipboard.write) {
                        const item = new ClipboardItem({ 'image/png': blob });
                        await navigator.clipboard.write([item]);
                        this.showToast(`${selectedCount}개 이미지 클립보드 복사 완료 (${cols}x${rows})`);
                    } else {
                        throw new Error('클립보드 권한이 없거나 API를 지원하지 않습니다.');
                    }
                } catch (error) {
                    console.error('클립보드 복사 실패:', error);
                    
                    // 폴백: 다운로드 링크 생성
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.href = url;
                    a.download = `merged_images_${cols}x${rows}.png`;
                    document.body.appendChild(a);
                    a.click();
                    document.body.removeChild(a);
                    URL.revokeObjectURL(url);
                    
                    this.showToast('클립보드 실패 → 파일로 저장 완료');
                }
            }, 'image/png');

        } catch (error) {
            console.error('이미지 합치기 실패:', error);
            alert('이미지 합치기에 실패했습니다.');
        }
    }

    async mergeAndSaveImages() {
        try {
            if (!this.gridSelectedIdxs || this.gridSelectedIdxs.length === 0) {
                alert('합칠 이미지를 선택해주세요.');
                return;
            }

            const selectedCount = this.gridSelectedIdxs.length;
            let cols = Math.ceil(Math.sqrt(selectedCount));
            let rows = Math.ceil(selectedCount / cols);

            const canvas = document.createElement('canvas');
            const ctx = canvas.getContext('2d');
            
            // 픽셀 완벽한 렌더링을 위해 이미지 스무딩 비활성화
            setPixelPerfectRendering(ctx);
            
            const imageSize = 512;
            canvas.width = cols * imageSize;
            canvas.height = rows * imageSize;
            ctx.fillStyle = '#000000';
            ctx.fillRect(0, 0, canvas.width, canvas.height);

            const imagePromises = this.gridSelectedIdxs.map(async (idx, index) => {
                const imagePath = this.selectedImages[idx];
                const response = await fetch(`/api/image?path=${encodeURIComponent(imagePath)}`);
                const blob = await response.blob();
                const img = new Image();
                return new Promise((resolve, reject) => {
                    img.onload = () => {
                        const row = Math.floor(index / cols);
                        const col = index % cols;
                        const x = col * imageSize;
                        const y = row * imageSize;
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

            canvas.toBlob((blob) => {
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = `merged_images_${cols}x${rows}.png`;
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                URL.revokeObjectURL(url);
                this.showToast(`합친 이미지 저장 완료 (${cols}x${rows})`);
            }, 'image/png');
        } catch (e) {
            console.error(e);
            alert('합친 이미지 저장에 실패했습니다.');
        }
    }

    showSingleContextMenu(event) {
        let menu = document.getElementById('single-context-menu');
        if (!menu) {
            menu = document.createElement('div');
            menu.id = 'single-context-menu';
            menu.style.cssText = 'position:absolute; display:none; background:#333; border:1px solid #555; border-radius:4px; padding:4px 0; z-index:10000; min-width:180px; color:#fff;';
            menu.innerHTML = `
                <div id="single-save" class="context-menu-item" style="padding:8px 12px; cursor:pointer; font-size:14px;">📥 원본 저장</div>
                <div id="single-copy" class="context-menu-item" style="padding:8px 12px; cursor:pointer; font-size:14px;">📋 이미지 클립보드 복사</div>
            `;
            document.body.appendChild(menu);
            menu.querySelector('#single-save').addEventListener('click', () => {
                if (this.selectedImagePath) this.downloadImage(this.selectedImagePath);
                this.hideSingleContextMenu();
            });
            menu.querySelector('#single-copy').addEventListener('click', async () => {
                await this.copyCurrentImageToClipboard();
                this.hideSingleContextMenu();
            });
        }
        menu.style.left = event.pageX + 'px';
        menu.style.top = event.pageY + 'px';
        menu.style.display = 'block';
        this._singleMenuOutsideHandler = (e) => {
            if (!menu.contains(e.target)) this.hideSingleContextMenu();
        };
        document.addEventListener('click', this._singleMenuOutsideHandler);
    }

    hideSingleContextMenu() {
        const menu = document.getElementById('single-context-menu');
        if (menu) menu.style.display = 'none';
        if (this._singleMenuOutsideHandler) {
            document.removeEventListener('click', this._singleMenuOutsideHandler);
            this._singleMenuOutsideHandler = null;
        }
    }
    async copyCurrentImageToClipboard() {
        try {
            if (!this.selectedImagePath) return;
            const res = await fetch(`/api/image?path=${encodeURIComponent(this.selectedImagePath)}`);
            const blob = await res.blob();
            const img = await createImageBitmap(blob);
            const canvas = document.createElement('canvas');
            canvas.width = img.width;
            canvas.height = img.height;
            const ctx = canvas.getContext('2d');
            
            // 픽셀 완벽한 렌더링을 위해 이미지 스무딩 비활성화
            setPixelPerfectRendering(ctx);
            
            ctx.drawImage(img, 0, 0);
            canvas.toBlob(async (out) => {
                try {
                    const hasPermission = await this.ensureClipboardPermission();
                    if (hasPermission && navigator.clipboard && navigator.clipboard.write) {
                        const item = new ClipboardItem({ 'image/png': out });
                        await navigator.clipboard.write([item]);
                        this.showToast('이미지 클립보드 복사 완료');
                    } else {
                        throw new Error('no clipboard');
                    }
                } catch (err) {
                    // 폴백: 다운로드
                    const url = URL.createObjectURL(out);
                    const a = document.createElement('a');
                    a.href = url; a.download = (this.selectedImagePath.split('/').pop() || 'image') + '.png';
                    document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
                    this.showToast('클립보드 실패 → 파일로 저장');
                }
            }, 'image/png');
        } catch (e) {
            console.error(e);
            alert('이미지 클립보드 복사에 실패했습니다.');
        }
    }

    async copyFileList() {
        try {
            if (!this.gridSelectedIdxs || this.gridSelectedIdxs.length === 0) {
                alert('복사할 파일을 선택해주세요.');
                return;
            }

            const selectedFiles = this.gridSelectedIdxs.map(idx => this.selectedImages[idx]).filter(Boolean);
            const fileListText = selectedFiles.join('\n');

            // 클립보드 권한 확인 및 요청
            const hasPermission = await this.ensureClipboardPermission();
            
            if (hasPermission && navigator.clipboard && navigator.clipboard.writeText) {
                try {
                    await navigator.clipboard.writeText(fileListText);
                    alert(`${selectedFiles.length}개 파일 경로가 클립보드에 복사되었습니다!`);
                } catch (error) {
                    console.error('클립보드 복사 실패:', error);
                    this.fallbackCopyText(fileListText, selectedFiles.length);
                }
            } else {
                // 권한이 없거나 API를 지원하지 않는 경우 폴백 사용
                this.fallbackCopyText(fileListText, selectedFiles.length);
            }
        } catch (error) {
            console.error('파일 리스트 복사 실패:', error);
            alert('파일 리스트 복사에 실패했습니다.');
        }
    }

    fallbackCopyText(text, count, type = '파일 경로') {
        try {
            // 폴백: textarea 사용
            const textarea = document.createElement('textarea');
            textarea.value = text;
            textarea.style.position = 'fixed';
            textarea.style.opacity = '0';
            textarea.style.left = '-9999px';
            document.body.appendChild(textarea);
            textarea.select();
            document.execCommand('copy');
            document.body.removeChild(textarea);
            
            alert(`${count}개 ${type}가 클립보드에 복사되었습니다!`);
        } catch (error) {
            console.error('폴백 복사 실패:', error);
            alert('클립보드 복사에 실패했습니다. 데이터를 수동으로 복사해주세요.');
        }
    }

    async requestClipboardPermission() {
        try {
            // 이미 권한이 있는지 확인
            if (navigator.permissions && navigator.permissions.query) {
                const result = await navigator.permissions.query({ name: 'clipboard-write' });
                if (result.state === 'granted') {
                    return true;
                } else if (result.state === 'prompt') {
                    // 권한 요청 다이얼로그 표시
                    const permission = await navigator.permissions.request({ name: 'clipboard-write' });
                    return permission.state === 'granted';
                }
            }
            return false;
        } catch (error) {
            console.warn('클립보드 권한 확인 실패:', error);
            return false;
        }
    }

    async ensureClipboardPermission() {
        // 이미 권한이 있으면 true 반환
        if (navigator.clipboard && navigator.clipboard.writeText) {
            return true;
        }
        
        // 권한 요청 시도
        const hasPermission = await this.requestClipboardPermission();
        if (hasPermission) {
            // 권한 획득 후 클립보드 API 재시도
            return navigator.clipboard && navigator.clipboard.writeText;
        }
        
        return false;
    }

    async copyFileListAsTable() {
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

            // 클립보드 권한 확인 및 요청
            const hasPermission = await this.ensureClipboardPermission();
            
            if (hasPermission && navigator.clipboard && navigator.clipboard.writeText) {
                try {
                    await navigator.clipboard.writeText(tableText);
                    alert(`${selectedFiles.length}개 파일의 테이블 데이터가 클립보드에 복사되었습니다!\n(Excel에 붙여넣기 가능)`);
                } catch (error) {
                    console.error('클립보드 복사 실패:', error);
                    this.fallbackCopyText(tableText, selectedFiles.length, '테이블 데이터');
                }
            } else {
                // 권한이 없거나 API를 지원하지 않는 경우 폴백 사용
                this.fallbackCopyText(tableText, selectedFiles.length, '테이블 데이터');
            }

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
            // Ctrl/Shift 수정키 클릭 시 폴더가 펼쳐지지 않도록 기본 동작을 먼저 차단
            if (e.ctrlKey || (e.shiftKey && this.lastSelectedFolder)) {
                e.preventDefault();
                e.stopPropagation();
                // ctrl+클릭으로 폴더 선택/해제 (폴더 열리지 않음)
                if (e.ctrlKey) {
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
                    if (!this.selectedFolders) this.selectedFolders = new Set();
                    // 다른 Explorer 선택 해제
                    this.clearLabelExplorerSelection();
                    await this.selectFolderRange(this.lastSelectedFolder, target);
                    // UI 업데이트
                    this.updateFileExplorerSelection();
                    return;
                }
            }
            // 수정키가 아닐 때만 폴더 로드/펼침 처리
            const detailsElement = target.parentElement;
            if (!detailsElement.open && !detailsElement.dataset.loaded) {
                const path = target.dataset.path;
                const contentDiv = target.nextElementSibling;
                await this.loadDirectoryContents(path, contentDiv);
                detailsElement.dataset.loaded = 'true';
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

    // 파일 탐색기 드래그 멀티 선택
    setupFileExplorerDragSelect() {
        const container = this.dom.fileExplorer;
        if (!container) return;
        // 오버레이 준비
        container.style.position = container.style.position || 'relative';
        let overlay = document.getElementById('explorer-drag-select');
        if (!overlay) {
            overlay = document.createElement('div');
            overlay.id = 'explorer-drag-select';
            overlay.style.cssText = `
                position:absolute; left:0; top:0; width:0; height:0;
                border:2px solid #09f; background:rgba(0,153,255,0.15);
                border-radius:2px; pointer-events:none; display:none; z-index:1000;`;
            container.appendChild(overlay);
        }
        const getScrollAdjusted = (clientX, clientY) => {
            const rect = container.getBoundingClientRect();
            return {
                x: clientX - rect.left + container.scrollLeft,
                y: clientY - rect.top + container.scrollTop
            };
        };
        let dragging = false;
        let start = null;
        const onMouseDown = (e) => {
            if (e.button !== 0) return;
            // 파일/폴더 링크 위에서도 드래그 시작 허용
            dragging = true;
            start = getScrollAdjusted(e.clientX, e.clientY);
            overlay.style.left = start.x + 'px';
            overlay.style.top = start.y + 'px';
            overlay.style.width = '0px';
            overlay.style.height = '0px';
            overlay.style.display = 'block';
            e.preventDefault();
        };
        const onMouseMove = (e) => {
            if (!dragging || !start) return;
            const curr = getScrollAdjusted(e.clientX, e.clientY);
            const left = Math.min(start.x, curr.x);
            const top = Math.min(start.y, curr.y);
            const width = Math.abs(curr.x - start.x);
            const height = Math.abs(curr.y - start.y);
            overlay.style.left = left + 'px';
            overlay.style.top = top + 'px';
            overlay.style.width = width + 'px';
            overlay.style.height = height + 'px';
        };
        const intersects = (el, dragLeft, dragTop, dragRight, dragBottom) => {
            const elRect = el.getBoundingClientRect();
            const contRect = container.getBoundingClientRect();
            const left = elRect.left - contRect.left + container.scrollLeft;
            const top = elRect.top - contRect.top + container.scrollTop;
            const right = left + elRect.width;
            const bottom = top + elRect.height;
            return (
                dragRight >= left && dragLeft <= right && dragBottom >= top && dragTop <= bottom
            );
        };
        const onMouseUp = async (e) => {
            if (!dragging) return;
            dragging = false;
            overlay.style.display = 'none';
            const end = getScrollAdjusted(e.clientX, e.clientY);
            if (!start) return;
            const dragLeft = Math.min(start.x, end.x);
            const dragTop = Math.min(start.y, end.y);
            const dragRight = Math.max(start.x, end.x);
            const dragBottom = Math.max(start.y, end.y);
            // 최소 이동은 클릭으로 간주 → 기본 동작 유지
            if (Math.abs(end.x - start.x) + Math.abs(end.y - start.y) < 6) {
                start = null;
                return;
            }
            // 교차 요소 수집
            const fileLinks = Array.from(container.querySelectorAll('a[data-path]'));
            const folderSummaries = Array.from(container.querySelectorAll('summary.folder'));
            const hitFiles = fileLinks.filter(a => intersects(a, dragLeft, dragTop, dragRight, dragBottom)).map(a => a.dataset.path);
            const hitFolders = folderSummaries.filter(s => intersects(s, dragLeft, dragTop, dragRight, dragBottom));
            // 다른 Explorer 선택 해제
            this.clearLabelExplorerSelection();
            // Ctrl이면 토글, 아니면 교체
            if (e.ctrlKey) {
                // 파일 토글
                const current = new Set(this.selectedImages || []);
                for (const p of hitFiles) {
                    if (current.has(p)) current.delete(p); else current.add(p);
                }
                this.selectedImages = Array.from(current);
                // 폴더 토글 (파일 선택 반영 포함)
                if (!this.selectedFolders) this.selectedFolders = new Set();
                for (const s of hitFolders) {
                    const path = s.dataset.path;
                    if (s.classList.contains('selected')) {
                        s.classList.remove('selected');
                        this.selectedFolders.delete(path);
                        await this.deselectFolderFiles(path);
                    } else {
                        s.classList.add('selected');
                        this.selectedFolders.add(path);
                        await this.selectAllFolderFiles(path);
                    }
                }
            } else {
                // 교체 선택
                this.selectedImages = hitFiles;
                // 폴더 선택 교체
                this.selectedFolders = new Set();
                // 요약 선택 클래스 초기화
                container.querySelectorAll('summary.folder.selected').forEach(s => s.classList.remove('selected'));
                // 폴더 파일 추가 선택
                for (const s of hitFolders) {
                    const path = s.dataset.path;
                    s.classList.add('selected');
                    this.selectedFolders.add(path);
                    await this.selectAllFolderFiles(path);
                }
            }
            // UI 업데이트 및 그리드/이미지 표시 갱신
            this.updateFileExplorerSelection();
            start = null;
        };
        // 이벤트 등록
        container.addEventListener('mousedown', onMouseDown);
        document.addEventListener('mousemove', onMouseMove, { passive: true });
        document.addEventListener('mouseup', onMouseUp);
    }

    // --- IMAGE LOADING ---
    async loadImage(path) {
        try {
            const blob = await fetch(`/api/image?path=${encodeURIComponent(path)}`).then(r => r.blob());
            this.currentImageBitmap = await createImageBitmap(blob);
            this.currentImage = this.currentImageBitmap;
            this.selectedImagePath = path; // 단일 이미지 모드를 위한 경로 설정
            
            // SemiconductorRenderer가 있으면 현재 비트맵으로 직접 로드 (동일 소스 보장)
            if (this.semiconductorRenderer) {
                console.log(`🔍 [DEBUG] SemiconductorRenderer에 이미지 로드 시작 (ImageBitmap)`);
                await this.semiconductorRenderer.loadImage(this.currentImageBitmap);
                console.log(`🔍 [DEBUG] SemiconductorRenderer 이미지 로드 완료`);
                // 초기 zoom 설정
                this.semiconductorRenderer.setScale(this.transform.scale);
                this.resetView(false);
                // resetView가 scale을 재계산하므로 렌더러 스케일을 다시 동기화
                if (this.semiconductorRenderer) {
                    this.semiconductorRenderer.setScale(this.transform.scale);
                }
                this.scheduleDraw();
            } else {
                console.log(`🔍 [DEBUG] SemiconductorRenderer 없음 - 기존 방식 사용`);
                this.resetView(false);
                this.scheduleDraw();
            }
            
            this.dom.minimapContainer.style.display = 'block';
            this.dom.imageCanvas.style.display = 'block';
            this.dom.overlayCanvas.style.display = 'block';
            
            // 파일명 표시
            this.showFileName(path);
            
            // 줌 바 표시 (이미지가 로드되었을 때만)
            const viewControls = document.querySelector('.view-controls');
            if (viewControls) {
                viewControls.style.display = 'flex';
            }
            
            // 레이아웃 안정화 후 한 번 더 맞춤 (컨테이너 크기 반영)
            setTimeout(() => {
                // 이미지가 표시된 후 컨테이너 rect가 변하는 경우 재계산
                this.resetView(true);
                if (this.semiconductorRenderer) {
                    this.semiconductorRenderer.setScale(this.transform.scale);
                }
            }, 0);
            // 일부 레이아웃에서 늦게 적용되는 패딩/스크롤바 보정용 재맞춤 한 번 더
            setTimeout(() => {
                this.resetView(true);
                if (this.semiconductorRenderer) {
                    this.semiconductorRenderer.setScale(this.transform.scale);
                }
            }, 50);
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
        // 캔버스 z-index 기본값 유지 (상단 패널/줌바를 가리지 않도록 낮게 유지)
        this.dom.imageCanvas.style.zIndex = 1;
        this.dom.viewerContainer.style.position = 'relative';
        // Set canvas background to black
        this.imageCtx.save();
        this.imageCtx.setTransform(1, 0, 0, 1, 0, 0);
        this.imageCtx.globalAlpha = 1.0;
        this.imageCtx.fillStyle = '#000';
        this.imageCtx.fillRect(0, 0, width, height);
        this.imageCtx.restore();
        
        // SemiconductorRenderer 사용 시 - 가벼운 pixel 최적화
        if (this.semiconductorRenderer && this.semiconductorRenderer.currentImage) {
            // 렌더링 정보 로그
            const info = this.semiconductorRenderer.getInfo();
            console.log(`🔍 [DEBUG] Zoom: ${info.scalePercent}%, 피라미드: ${info.pyramidLevel}, 픽셀: ${info.pixelReduction}`);
            
            // 피라미드 이미지 선택
            const selectedImage = this.semiconductorRenderer.selectPyramidLevel();
            
            // 기존 방식대로 그리기
            this.imageCtx.save();
            setPixelPerfectRendering(this.imageCtx);
            this.imageCtx.translate(this.transform.dx, this.transform.dy);
            this.imageCtx.scale(this.transform.scale, this.transform.scale);
            
            // 선택된 피라미드 이미지를 원본 크기로 확대하여 그리기
            const scaleToOriginal = this.currentImage.width / selectedImage.width;
            this.imageCtx.scale(scaleToOriginal, scaleToOriginal);
            this.imageCtx.drawImage(selectedImage, 0, 0);
            
            this.imageCtx.restore();
        } else {
            // 기존 렌더링 코드 (폴백)
            this.imageCtx.save();
            setPixelPerfectRendering(this.imageCtx);
            this.imageCtx.translate(this.transform.dx, this.transform.dy);
            this.imageCtx.scale(this.transform.scale, this.transform.scale);
            this.imageCtx.drawImage(this.currentImage, 0, 0);
            this.imageCtx.restore();
        }
        this.updateMinimap();
    }
    
    resetView(shouldDraw = true) {
        if (!this.currentImage) return;
        const containerRect = this.dom.viewerContainer.getBoundingClientRect();
        // 컨테이너 경계선/스크롤 영향으로 인한 미세 클리핑 방지용 보정치(2px)
        const effectiveW = Math.max(0, containerRect.width - 2);
        const effectiveH = Math.max(0, containerRect.height - 2);
        const imgRatio = this.currentImage.width / this.currentImage.height;
        const containerRatio = effectiveW / effectiveH;
        const fitScale = (imgRatio > containerRatio)
            ? effectiveW / this.currentImage.width
            : effectiveH / this.currentImage.height;
        // 기본은 상대 여유 적용 (초기 로드 등 일반 맞춤)
        this.transform.scale = fitScale * FIT_RELATIVE_MARGIN;
        // 파일명 패널 높이 고려 (CSS 변수에서 가져오기)
        const filenameBarHeight = 56; // --filename-bar-height와 동일
        
        // 이미지 크기를 조정 (파일명 패널과 겹치지 않도록)
        this.transform.scale = fitScale * FIT_RELATIVE_MARGIN * 0.96; // 99%로 조정
        
        // 실제 센터링은 전체 컨테이너 크기 기준으로 적용 (시각적 중앙 정렬)
        this.transform.dx = (containerRect.width - this.currentImage.width * this.transform.scale) / 2;
        // 파일명 패널 높이를 고려하여 적절히 위치 조정 (위로 이동)
        this.transform.dy = (containerRect.height - this.currentImage.height * this.transform.scale) / 2 + (filenameBarHeight * 0.4);
        // 리셋 시 반영된 배율을 렌더러에도 즉시 전달하여 픽셀 감소 로직이 동작하도록 함
        if (this.semiconductorRenderer) {
            try {
                this.semiconductorRenderer.setScale(this.transform.scale);
                if (typeof this.semiconductorRenderer.getInfo === 'function') {
                    const info = this.semiconductorRenderer.getInfo();
                    console.debug('[ResetView] scale=', this.transform.scale.toFixed(3), info);
                } else {
                    console.debug('[ResetView] scale=', this.transform.scale.toFixed(3));
                }
            } catch (e) {
                console.warn('SemiconductorRenderer.setScale 실패:', e);
            }
        }

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

        // SemiconductorRenderer에 zoom 전달
        if (this.semiconductorRenderer) {
            this.semiconductorRenderer.setScale(this.transform.scale);
        }

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

    // 리셋 버튼 전용: 초기 이미지 크기와 배치와 동일하게 적용
    resetViewWithAbsoluteOffset() {
        if (!this.currentImage) return;
        const containerRect = this.dom.viewerContainer.getBoundingClientRect();
        const effectiveW = Math.max(0, containerRect.width - 2);
        const effectiveH = Math.max(0, containerRect.height - 2);
        const imgRatio = this.currentImage.width / this.currentImage.height;
        const containerRatio = effectiveW / effectiveH;
        const fitScale = (imgRatio > containerRatio)
            ? effectiveW / this.currentImage.width
            : effectiveH / this.currentImage.height;
        
        // 파일명 패널 높이 고려 (CSS 변수에서 가져오기)
        const filenameBarHeight = 56; // --filename-bar-height와 동일
        
        // 이미지 크기를 조정 (파일명 패널과 겹치지 않도록) - 초기 로드와 동일
        this.transform.scale = fitScale * FIT_RELATIVE_MARGIN * 0.96;
        
        // 실제 센터링은 전체 컨테이너 크기 기준으로 적용 (시각적 중앙 정렬)
        this.transform.dx = (containerRect.width - this.currentImage.width * this.transform.scale) / 2;
        // 파일명 패널 높이를 고려하여 적절히 위치 조정 (위로 이동) - 초기 로드와 동일
        this.transform.dy = (containerRect.height - this.currentImage.height * this.transform.scale) / 2 + (filenameBarHeight * 0.4);
        
        // 리셋 버튼 시에도 렌더러에 현재 배율을 즉시 전달하여 픽셀 감소 로직이 동작하도록 함
        if (this.semiconductorRenderer) {
            try {
                this.semiconductorRenderer.setScale(this.transform.scale);
                if (typeof this.semiconductorRenderer.getInfo === 'function') {
                    const info = this.semiconductorRenderer.getInfo();
                    console.debug('[ResetViewWithAbsoluteOffset] scale=', this.transform.scale.toFixed(3), info);
                } else {
                    console.debug('[ResetViewWithAbsoluteOffset] scale=', this.transform.scale.toFixed(3));
                }
            } catch (e) {
                console.warn('SemiconductorRenderer.setScale 실패:', e);
            }
        }
        
        this.updateZoomDisplay();
        this.scheduleDraw();
    }
    
    updateZoomDisplay() {
        this.dom.zoomLevelInput.value = `${Math.round(this.transform.scale * 100)}%`;
    }

    // --- MINIMAP ---
    updateMinimap() {
        if (!this.currentImage) return;
        // 미니맵 고정 해상도(고품질) 현재 대비 90% → 230x230
        const mapW = this.dom.minimapCanvas.width = 230;
        const mapH = this.dom.minimapCanvas.height = 230;
        // 컨테이너/스타일도 동일 크기로 고정하여 오프셋 불일치 제거
        if (this.dom.minimapContainer) {
            this.dom.minimapContainer.style.width = mapW + 'px';
            this.dom.minimapContainer.style.height = mapH + 'px';
            this.dom.minimapContainer.style.position = this.dom.minimapContainer.style.position || 'relative';
        }
        this.dom.minimapCanvas.style.width = mapW + 'px';
        this.dom.minimapCanvas.style.height = mapH + 'px';
        const imgW = this.currentImage.width;
        const imgH = this.currentImage.height;
        // 이미지 전체를 미니맵에 fit (pad 포함)
        const scale = Math.min(mapW / imgW, mapH / imgH);
        const padX = (mapW - imgW * scale) / 2;
        const padY = (mapH - imgH * scale) / 2;
        this.minimapCtx.clearRect(0, 0, mapW, mapH);
        
        // 픽셀 완벽한 렌더링을 위해 이미지 스무딩 비활성화
        this.minimapCtx.imageSmoothingEnabled = true;
        if ('imageSmoothingQuality' in this.minimapCtx) this.minimapCtx.imageSmoothingQuality = 'high';
        
        this.minimapCtx.drawImage(this.currentImage, padX, padY, imgW * scale, imgH * scale);
        // 메인 뷰의 영역(이미지 좌표계) → 미니맵 좌표계로 변환
        const { width: viewW, height: viewH } = this.dom.viewerContainer.getBoundingClientRect();
        const viewScale = this.transform.scale;
        const viewX = -this.transform.dx / viewScale;
        const viewY = -this.transform.dy / viewScale;
        const vpX = padX + viewX * scale;
        const vpY = padY + viewY * scale;
        let vpW = viewW / viewScale * scale;
        let vpH = viewH / viewScale * scale;
        // 뷰포트 10% → 90% 크기(= 10% 축소) 유지 요청 반영
        const shrink = 0.9;
        const newVpW = vpW * shrink;
        const newVpH = vpH * shrink;
        const dx = (vpW - newVpW) / 2;
        const dy = (vpH - newVpH) / 2;
        vpW = newVpW; vpH = newVpH;
        // 뷰포트 사각형 스타일 적용
        const vp = this.dom.minimapViewport.style;
        vp.left = `${vpX + dx}px`;
        vp.top = `${vpY + dy}px`;
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
        
        // 폴더 관련 이벤트 리스너
        this.dom.subfolderSelect.addEventListener('change', (e) => this.onSubfolderSelect(e));
        // 제거됨: 폴더 브라우저/새로고침 버튼 리스너
        
        // 검색 모드 기능 추가
        this.setupProductSearch();
        
        // 폴더 브라우저 모달 이벤트
        // 제거됨: 폴더 브라우저 모달 이벤트
    }

    async refreshClassList() {
        const container = this.dom.classList;
        const scrollTop = container ? container.scrollTop : 0;
        const res = await fetch('/api/classes');
        const data = await res.json();
        // 이름 순으로 정렬 (대소문자 구분 없이)
        const classes = Array.isArray(data.classes) ? data.classes.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase())) : [];
        
        // 기존 버튼들을 저장 (삭제 전에)
        const existingButtons = Array.from(container.querySelectorAll('button'));
        
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
        
        // 기존 버튼들 모두 제거하고 새로 생성 (정렬 문제 해결)
        container.innerHTML = '';
        
        // 모든 클래스에 대해 버튼 생성
        classes.forEach(cls => {
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
                            const requestBody = { class_name: this.selectedClass, image_path: path };
                            console.log('분류 요청 전송:', requestBody);
                            
                            const response = await fetch('/api/classify', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify(requestBody)
                            });
                            
                            if (!response.ok) {
                                const errorText = await response.text();
                                console.error('분류 실패:', response.status, errorText);
                            }
                        }
                        // 버튼 색상 피드백
                        const originalBg = btn.style.background;
                        btn.style.background = '#2ecc40';
                        setTimeout(() => {
                            btn.style.background = originalBg;
                            this.refreshLabelExplorer();
                            // 추가로 강제 새로고침
                            setTimeout(() => this.refreshLabelExplorer(), 100);
                        }, 200);
                        return;
                    }
                    // 단일 이미지 모드: 현재 표시된 이미지에 라벨링
                    if (!this.gridMode && this.selectedImagePath) {
                        this.selectedClass = cls;
                        if (this.dom.labelStatus) this.dom.labelStatus.textContent = '';
                        
                        console.log('단일 이미지 모드 라벨링:', { 
                            selectedImagePath: this.selectedImagePath, 
                            gridMode: this.gridMode 
                        });
                        
                        // 직접 API 호출
                        const requestBody = { class_name: cls, image_path: this.selectedImagePath };
                        console.log('단일 이미지 분류 요청 전송:', requestBody);
                        
                        const response = await fetch('/api/classify', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify(requestBody)
                        });
                        
                        if (!response.ok) {
                            const errorText = await response.text();
                            console.error('분류 실패:', response.status, errorText);
                        }
                        
                        // 버튼 색상 피드백
                        const originalBg = btn.style.background;
                        btn.style.background = '#2ecc40';
                        setTimeout(() => {
                            btn.style.background = originalBg;
                            this.refreshLabelExplorer();
                            // 추가로 강제 새로고침
                            setTimeout(() => this.refreshLabelExplorer(), 100);
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
        const existingClasses = existingButtons.map(btn => btn.textContent);
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

    // 전체 새로고침 함수
    async refreshAll() {
        console.log('전체 새로고침 시작...');
        try {
            // 현재 폴더 다시 로드
            await this.loadFiles();
            // 클래스 목록 새로고침
            await this.refreshClassList();
            // 라벨 탐색기 새로고침
            await this.refreshLabelExplorer();
            console.log('전체 새로고침 완료');
        } catch (error) {
            console.error('전체 새로고침 실패:', error);
        }
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
        
        // 클래스명 유효성 검사
        const invalidNames = names.filter(name => {
            // 한글 자모나 특수문자 체크
            return /[^\x20-\x7E]/.test(name) || !/^[A-Za-z0-9_-]+$/.test(name);
        });
        
        if (invalidNames.length > 0) {
            alert(`다음 클래스명이 유효하지 않습니다: ${invalidNames.join(', ')}\n\n클래스명은 A-Z, a-z, 0-9, _, - 만 사용 가능합니다.`);
            return;
        }
        
        // 즉시 버튼 피드백 제공
        const addBtn = this.dom.addClassBtn;
        const originalText = addBtn?.textContent || 'Add Class';
        if (addBtn) {
            addBtn.textContent = '추가 중...';
            addBtn.disabled = true;
            addBtn.style.opacity = '0.6';
        }
        
        const successfulClasses = []; // 성공한 클래스들을 추적
        
        try {
            console.log(`Adding classes: ${names.join(', ')}`);
            
            for (const name of names) {
                try {
                    const response = await fetch('/api/classes', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ name })
                    });
                    
                    if (!response.ok) {
                        console.error(`클래스 '${name}' 추가 실패: HTTP ${response.status}`);
                        continue; // 실패한 클래스는 건너뛰고 계속 진행
                    }
                    
                    const result = await response.json();
                    if (!result.success) {
                        console.error(`클래스 '${name}' 추가 실패: ${result.message || 'Unknown error'}`);
                        continue; // 실패한 클래스는 건너뛰고 계속 진행
                    }
                    
                    console.log(`클래스 '${name}' 추가 성공:`, result);
                    successfulClasses.push(name); // 성공한 클래스 추가
                    
                    // API 응답에서 refresh_required 확인 후 즉시 Label Explorer 강제 새로고침
                    if (result.refresh_required) {
                        console.log(`클래스 '${name}' 생성 완료 - Label Explorer 즉시 강제 새로고침`);
                        await this.refreshLabelExplorer();
                    }
                } catch (error) {
                    console.error(`클래스 '${name}' 추가 중 오류 발생:`, error);
                    continue; // 오류 발생한 클래스는 건너뛰고 계속 진행
                }
            }
            
            this.dom.newClassInput.value = '';
            await this.refreshClassList();
            await this.refreshLabelExplorer();
            
            // Label Explorer 강제 새로고침 (클래스 생성 후)
            setTimeout(() => {
                console.log('클래스 생성 후 Label Explorer 강제 새로고침');
                this.refreshLabelExplorer();
            }, 100);
            
            // 추가 지연 새로고침 (500ms)
            setTimeout(() => {
                console.log('클래스 생성 후 Label Explorer 추가 새로고침 (500ms)');
                this.refreshLabelExplorer();
            }, 500);
            
            // 최종 확인 새로고침 (1000ms)
            setTimeout(() => {
                console.log('클래스 생성 후 Label Explorer 최종 확인 새로고침 (1000ms)');
                this.refreshLabelExplorer();
            }, 1000);
            
            // 성공한 클래스 수 계산
            const successCount = successfulClasses.length;
            console.log(`클래스 추가 결과: 요청 ${names.length}개, 성공 ${successCount}개`);
            
            if (successCount > 0) {
                console.log(`성공적으로 ${successCount}개 클래스를 추가했습니다: ${successfulClasses.join(', ')}`);
                // 성공 메시지 표시 (선택사항)
                // alert(`성공적으로 ${successCount}개 클래스를 추가했습니다: ${successfulClasses.join(', ')}`);
            } else {
                console.log('추가된 클래스가 없습니다');
                alert('추가된 클래스가 없습니다. 클래스명을 확인해주세요.');
            }
        } catch (error) {
            console.error('클래스 추가 중 예상치 못한 오류 발생:', error);
            // 에러가 발생해도 성공한 클래스가 있으면 성공으로 처리
            if (successfulClasses && successfulClasses.length > 0) {
                console.log(`일부 클래스 추가 성공: ${successfulClasses.join(', ')}`);
                // alert(`일부 클래스 추가 성공: ${successfulClasses.join(', ')}`);
            } else {
                alert('클래스 추가 중 오류가 발생했습니다. 콘솔을 확인해주세요.');
            }
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
            const requestBody = { class_name: this.selectedClass, image_path: this.selectedImagePath };
            console.log('단일 이미지 분류 요청 전송:', requestBody);
            
            const res = await fetch('/api/classify', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(requestBody)
            });
            if (res.ok) {
                // Explorer에서 classification/클래스 폴더 자동 오픈
                const explorer = this.dom.fileExplorer;
                const classSummary = explorer.querySelector(`summary[data-path="classification/${this.selectedClass}"]`);
                if (classSummary) {
                    classSummary.parentElement.open = true;
                    this.loadDirectoryContents(`classification/${this.selectedClass}`, classSummary.nextElementSibling);
                }
                
                // UI 새로고침
                await this.refreshLabelExplorer();
                await this.refreshClassList();
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
        
        const response = await fetch('/api/classes/delete', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ names })
        });
        
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        
        const result = await response.json();
        if (!result.success) {
            throw new Error(result.message || 'Failed to delete classes');
        }
        
        // API 응답에서 refresh_required 확인 후 즉시 Label Explorer 강제 새로고침
        if (result.refresh_required) {
            console.log('클래스 삭제 완료 - Label Explorer 즉시 강제 새로고침');
            await this.refreshLabelExplorer();
        }
        
        // 텍스트박스도 클리어
        this.dom.newClassInput.value = '';
        this.selectedClass = null;
        this.classSelection.selected = [];
        this.classSelection.lastClicked = null;
        
        await this.refreshClassList();
        await this.refreshLabelExplorer();
        this.loadDirectoryContents(null, this.dom.fileExplorer);
        
        // Label Explorer 강제 새로고침 (클래스 삭제 후)
        setTimeout(() => {
            console.log('클래스 삭제 후 Label Explorer 강제 새로고침');
            this.refreshLabelExplorer();
        }, 100);
        
        // 추가 지연 새로고침 (500ms)
        setTimeout(() => {
            console.log('클래스 삭제 후 Label Explorer 추가 새로고침 (500ms)');
            this.refreshLabelExplorer();
        }, 500);
        
        // 최종 확인 새로고침 (1000ms)
        setTimeout(() => {
            console.log('클래스 삭제 후 Label Explorer 최종 확인 새로고침 (1000ms)');
            this.refreshLabelExplorer();
        }, 1000);
        
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
        // 그리드 모드가 해제되었더라도 이전 선택을 유지해 라벨 추가가 가능하도록 지원
        if (this.persistentSelectedImages && this.persistentSelectedImages.length > 0) {
            return [...this.persistentSelectedImages];
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
                    await fetch('/api/classify', {
                        method: 'DELETE',
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
            await this.refreshLabelExplorer();
            await this.refreshClassList();
            
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
            // 이름 순으로 정렬 (대소문자 구분 없이)
            const classes = (data.classes || []).sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
            
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
            // 이름 순으로 정렬 (대소문자 구분 없이)
            const classes = (data.classes || []).sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
            
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
                                await fetch('/api/classify', {
                                    method: 'DELETE',
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
            const promises = imagesToProcess.map(imagePath => {
                const requestBody = { class_name: finalClassName, image_path: imagePath };
                console.log('모달에서 라벨 추가 요청 전송:', requestBody);
                
                return fetch('/api/classify', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(requestBody)
                });
            });
            
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
            
            // UI 업데이트 - 강제 새로고침
            console.log('라벨 추가 완료, UI 새로고침 시작...');
            await this.refreshLabelExplorer();
            await this.refreshClassList();
            
            // 추가로 Label Explorer 강제 새로고침
            setTimeout(() => {
                console.log('Label Explorer 강제 새로고침 실행');
                this.refreshLabelExplorer();
            }, 100);
            
        } catch (error) {
            console.error('Failed to add label:', error);
            alert('Failed to add label');
        }
    }

    // --- LABEL EXPLORER ---
    async refreshLabelExplorer() {
        const container = document.getElementById('label-explorer-list');
        if (!container) {
            console.warn('Label Explorer container not found');
            return;
        }
        
        const scrollTop = container.scrollTop;
        
        // 기존 내용을 임시로 저장하여 스크롤 위치 유지
        const existingContent = container.innerHTML;
        
        console.log('Label Explorer 새로고침 시작...');
        
        const batchLabelBtn = document.getElementById('label-explorer-batch-label-btn');
        const batchDeleteBtn = document.getElementById('label-explorer-batch-delete-btn');
        
        try {
            const res = await fetch('/api/classes');
            const data = await res.json();
            
            if (!data.success) {
                console.error('클래스 목록 조회 실패:', data);
                return;
            }
            
            // 이름 순으로 정렬 (대소문자 구분 없이)
            const classes = Array.isArray(data.classes) ? data.classes.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase())) : [];
            if (!this.labelSelection) this.labelSelection = { selected: [], lastClicked: null, openFolders: {}, selectedClasses: [] };
            const labelSelection = this.labelSelection;
        
        console.log('Label Explorer 초기화:', {
            labelSelection: labelSelection,
            classes: classes.length,
            gridMode: this.gridMode
        });
        // 기본: 모든 클래스 폴더 closed (Wafer Map Explorer와 동일하게)
        for (const cls of classes) {
            if (labelSelection.openFolders[cls] === undefined) labelSelection.openFolders[cls] = false;
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
            // 선택 상태 초기화
            labelSelection.selected = [];
            labelSelection.selectedClasses = [];
            this.updateLabelExplorerSelection();

            // 그리드 모드였다면 종료하고 초기 화면으로 복귀
            if (this.gridMode) {
                this.hideGrid();
                this.showInitialState();
                console.log('Label Explorer: 우클릭 → 그리드 종료 및 초기화면 복귀');
                return;
            }

            // 단일 이미지 모드였다면 이미지 숨기고 초기 화면으로 복귀
            this.hideImage();
            this.showInitialState();
            console.log('Label Explorer: 우클릭 → 단일 이미지 숨김 및 초기화면 복귀');
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
                    // 선택 초기화
                    labelSelection.selected = [];
                    labelSelection.selectedClasses = [];
                    this.updateLabelExplorerSelection();

                    if (this.gridMode) {
                        this.hideGrid();
                        this.showInitialState();
                        console.log('Label Explorer 프레임: 우클릭 → 그리드 종료 및 초기화면 복귀');
                        return;
                    }
                    this.hideImage();
                    this.showInitialState();
                    console.log('Label Explorer 프레임: 우클릭 → 단일 이미지 숨김 및 초기화면 복귀');
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
                            await fetch('/api/classify', {
                                method: 'DELETE',
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
                    await fetch('/api/classify', {
                        method: 'DELETE',
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
        
        console.log('Label Explorer 새로고침 완료');
        } catch (error) {
            console.error('Label Explorer 새로고침 실패:', error);
            // 에러 발생 시 기존 내용 복원
            if (container) {
                container.innerHTML = existingContent;
                container.scrollTop = scrollTop;
            }
        }
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
                
                // Wafer Map Explorer 선택은 유지해야 함: 선택 해제 호출 제거
                
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
                        // 첫 진입 시에도 그리드 잔존 오버레이가 캔버스를 가리지 않도록 항상 정리
                        this.hideGrid();
                                
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
                            await fetch('/api/classify', {
                                method: 'DELETE',
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
                                        // 첫 진입 시에도 그리드 잔존 오버레이가 캔버스를 가리지 않도록 항상 정리
                                        this.hideGrid();
                                        
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
                                    await fetch('/api/classify', {
                                        method: 'DELETE',
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
        // 현재 스크롤 위치 저장 (그리드 복귀 시 사용)
        try {
            const scroller = document.querySelector('.grid-scroll-wrapper');
            this._gridScrollTop = scroller ? scroller.scrollTop : 0;
        } catch (_) { this._gridScrollTop = 0; }
        if (!this.gridSelectedIdxs) this.gridSelectedIdxs = [];
        const grid = document.getElementById('image-grid');
        const gridControls = document.getElementById('grid-controls');
        if (gridControls) gridControls.style.display = '';
        const gridColsRange = document.getElementById('grid-cols-range');
        if (gridColsRange) {
            gridColsRange.value = this.gridCols;
            document.documentElement.style.setProperty('--grid-cols', this.gridCols);
        }
        
        // 단일 이미지 전환 후 그리드로 돌아올 때 상단 파일명 패널은 숨긴다
        if (this.dom.fileNameDisplay) this.dom.fileNameDisplay.style.display = 'none';
        if (this.dom.fileNameText) this.dom.fileNameText.textContent = '';
        if (this.dom.filePathText) this.dom.filePathText.textContent = '';
        
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
        // 즉시 렌더링으로 최초 체감 로딩 지연 감소
        this.showGridImmediately(images);
        grid.classList.add('active');
        setTimeout(() => this.updateGridSquaresPixel(), 0);
        if (!this.gridResizeObserver) {
            this.gridResizeObserver = new ResizeObserver(() => this.updateGridSquaresPixel());
            this.gridResizeObserver.observe(grid);
        }
        // 이전 스크롤 위치 복원
        try {
            const scroller = document.querySelector('.grid-scroll-wrapper');
            if (scroller && typeof this._lastGridScrollTop === 'number') {
                scroller.scrollTop = this._lastGridScrollTop;
            }
        } catch (_) {}
        // 초기 배치만 가볍게 프리로드 (서버/클라이언트 부하 방지)
        setTimeout(() => {
            this.loadCurrentFolderThumbnails(images);
        }, 100);
    }
    // 즉시 DOM 구성 + 썸네일 직접 로드로 최초 표시 시간을 단축
    showGridImmediately(images) {
        const grid = document.getElementById('image-grid');
        if (!grid) return;
        grid.innerHTML = '';
        const initialChunk = Math.min(images.length, 60); // 최초 가시 영역 우선
        images.forEach((imgPath, idx) => {
            const wrap = document.createElement('div');
            wrap.className = 'grid-thumb-wrap' + (this.gridSelectedIdxs.includes(idx) ? ' selected' : '');
            wrap.setAttribute('data-img-path', imgPath);
            wrap.setAttribute('data-img-idx', idx);
            
        // 선택/열기/컨텍스트 메뉴 (선택 즉시 취소 시 네트워크 작업 중단)
        wrap.onclick = e => { 
            e.stopPropagation(); 
            if (e && (e.ctrlKey || e.shiftKey)) {
                // 멀티/범위 선택 해제 시 백그라운드 작업도 함께 중단
                if (this.thumbnailManager && this.gridSelectedIdxs && this.gridSelectedIdxs.length > 0) {
                    try { this.thumbnailManager.cancelPendingRequests(); } catch(_) {}
                }
            }
            this.toggleGridImageSelect(idx, e);
        };
            wrap.ondblclick = e => { e.stopPropagation(); this.enterSingleImageMode(idx); };
            wrap.oncontextmenu = e => { e.preventDefault(); e.stopPropagation(); this.showContextMenu(e, idx); };
            
            // 썸네일 컨테이너 + 이미지
            const thumbBox = document.createElement('div');
            thumbBox.className = 'grid-thumb-imgbox';
            const img = document.createElement('img');
            img.className = 'grid-thumb-img';
            img.alt = imgPath.split('/').pop();
            img.setAttribute('data-img-path', imgPath);
            img.loading = 'lazy';
            img.decoding = 'async';
            img.style.opacity = '0';
            img.style.imageRendering = 'high-quality';
            img.style.imageRendering = 'crisp-edges';
            img.style.imageRendering = '-webkit-optimize-contrast';
            img.ondragstart = e => e.preventDefault();

            // 기본은 placeholder로 두고 관찰 → 뷰포트 진입 시 로드
            img.src = 'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMSIgaGVpZ2h0PSIxIiB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciPjxyZWN0IHdpZHRoPSIxIiBoZWlnaHQ9IjEiIGZpbGw9IiMyMzIzMjMiLz48L3N2Zz4=';
            this.thumbnailManager && this.thumbnailManager.observeElement && this.thumbnailManager.observeElement(wrap);

            // 초기 청크만 즉시 로드해 첫 페인트 가속
            if (idx < initialChunk) {
                this.thumbnailManager && this.thumbnailManager.loadThumbnailAndDisplay && this.thumbnailManager.loadThumbnailAndDisplay(imgPath, wrap, 'urgent');
                img.onload = () => { img.style.opacity = '1'; };
                img.onerror = () => { img.style.backgroundColor = '#333'; img.style.opacity = '0.5'; };
            }

            thumbBox.appendChild(img);
            wrap.appendChild(thumbBox);

            // 선택 표시
            if (this.gridSelectedIdxs.includes(idx)) {
                const check = document.createElement('div');
                check.className = 'grid-thumb-check';
                check.textContent = '✓';
                thumbBox.appendChild(check);
            }

            // 파일명 라벨
            const label = document.createElement('div');
            label.className = 'grid-thumb-label';
            label.textContent = imgPath.split('/').pop();
            wrap.appendChild(label);

            grid.appendChild(wrap);
        });
    }

    // 그리드 스크롤 최적화 설정
    setupGridScrollOptimization() {
        const grid = document.getElementById('image-grid');
        if (!grid) return;
        
        // 기존 이벤트 리스너 제거
        if (this.gridScrollHandler) {
            grid.removeEventListener('scroll', this.gridScrollHandler);
        }
        
        // 스크롤 최적화를 위한 디바운스 및 쓰로틀
        let scrollTimeout;
        let lastScrollTime = 0;
        const scrollThrottle = 50; // 50ms 간격으로 처리
        
        this.gridScrollHandler = () => {
            const now = Date.now();
            
            // 쓰로틀링: 너무 빈번한 호출 방지
            if (now - lastScrollTime < scrollThrottle) {
                return;
            }
            lastScrollTime = now;
            
            // 즉시 보이는 썸네일 확인
            this.thumbnailManager.checkVisibleThumbnails();
            
            // 디바운스: 스크롤이 멈춘 후 전체 재검사
            if (scrollTimeout) {
                clearTimeout(scrollTimeout);
            }
            scrollTimeout = setTimeout(() => {
                this.thumbnailManager.checkVisibleThumbnails();
            }, 100);
        };
        
        // 스크롤 이벤트 리스너 추가 (passive 옵션으로 성능 향상)
        grid.addEventListener('scroll', this.gridScrollHandler, { passive: true });
        
        // 초기 로드 시에도 보이는 썸네일 확인
        setTimeout(() => {
            this.thumbnailManager.checkVisibleThumbnails();
        }, 200);
    }

    // 크고 많은 DOM을 여러 프레임에 나눠 점진 렌더링하여 스크롤/줌이 멈추지 않게 함
    showGridStream(images) {
        const grid = document.getElementById('image-grid');
        if (!grid) return;
        grid.innerHTML = '';
        const streamStart = performance.now();
        // 썸네일 실제 로드 성능 측정(이미지 onload 기준)
        this._thumbMetrics = { start: performance.now(), total: images.length, loaded: 0 };
        const total = images.length;
        // 화면 크기/성능에 따라 배치 크기 동적 조정
        const hwThreads = (navigator.hardwareConcurrency || 8);
        const batchSize = Math.min(240, Math.max(60, hwThreads * 20));
        let index = 0;
        const renderBatch = () => {
            if (!this.gridMode) return;
            const frag = document.createDocumentFragment();
            const end = Math.min(index + batchSize, total);
            for (let i = index; i < end; i++) {
                const imgPath = images[i];
                const wrap = document.createElement('div');
                wrap.className = 'grid-thumb-wrap' + (this.gridSelectedIdxs.includes(i) ? ' selected' : '');
                wrap.setAttribute('data-img-path', imgPath);
                wrap.setAttribute('data-img-idx', i);
                wrap.ondblclick = e => { e.stopPropagation(); this.enterSingleImageMode(i); };
                wrap.oncontextmenu = e => { e.preventDefault(); e.stopPropagation(); this.showContextMenu(e, i); };

                const thumbBox = document.createElement('div');
                thumbBox.className = 'grid-thumb-imgbox';
                const img = document.createElement('img');
                img.className = 'grid-thumb-img';
                img.alt = imgPath.split('/').pop();
                img.setAttribute('data-img-path', imgPath);
                img.src = 'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMSIgaGVpZ2h0PSIxIiB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciPjxyZWN0IHdpZHRoPSIxIiBoZWlnaHQ9IjEiIGZpbGw9IiNmNWY1ZjUiLz48L3N2Zz4=';
                img.loading = 'lazy';
                img.decoding = 'async';
                img.style.opacity = '0';
                img.style.backgroundColor = '#f5f5f5';
                img.style.imageRendering = 'high-quality';
                img.style.imageRendering = 'crisp-edges';
                img.style.imageRendering = '-webkit-optimize-contrast';
                img.ondragstart = e => e.preventDefault();
                this.thumbnailManager.observeElement(wrap);
                img.onload = () => {
                    if (img.src && !img.src.startsWith('data:')) {
                        img.style.opacity = '1';
                        img.style.backgroundColor = 'transparent';
                        // 로드 카운트 증가 및 완료시 성능 로그
                        if (this._thumbMetrics) {
                            this._thumbMetrics.loaded += 1;
                            if (this._thumbMetrics.loaded === this._thumbMetrics.total) {
                                const elapsedMs = performance.now() - this._thumbMetrics.start;
                                const perSec = (this._thumbMetrics.total / (elapsedMs / 1000)).toFixed(1);
                                console.log(`[THUMB] 로드 완료: ${this._thumbMetrics.total}개, ${elapsedMs.toFixed(0)}ms (${perSec}개/초)`);
                            }
                        }
                    }
                };
                img.onerror = () => { img.style.backgroundColor = '#333'; img.style.opacity = '0.5'; setTimeout(() => { if (img.parentElement) { this.replaceWithThumbnail(img, imgPath); } }, 500); };
                // 즉시 네트워크 요청을 시작하지 않고, IntersectionObserver가 보이는 항목부터 src 설정
                thumbBox.appendChild(img);
                wrap.appendChild(thumbBox);
                if (this.gridSelectedIdxs.includes(i)) {
                    const check = document.createElement('div');
                    check.className = 'grid-thumb-check';
                    check.textContent = '✔';
                    thumbBox.appendChild(check);
                }
                const label = document.createElement('div');
                label.className = 'grid-thumb-label';
                label.textContent = imgPath.split('/').pop();
                wrap.appendChild(label);
                frag.appendChild(wrap);
            }
            grid.appendChild(frag);
            index = end;
            this.updateGridSquaresPixel();
            this.thumbnailManager.checkVisibleThumbnails();
            if (index < total) {
                requestAnimationFrame(renderBatch);
            } else {
                const ms = performance.now() - streamStart;
                const rps = (total / (ms / 1000)).toFixed(1);
                console.log(`[THUMB] 스트리밍 완료: ${total}개, ${ms.toFixed(0)}ms (${rps}개/초)`);
                
                // 초고속 배치 사전 로드 트리거 (2000개 이상시)
                if (total > 2000) {
                    console.log('[THUMB] 대량 이미지 감지 - 고속 배치 모드 활성화');
                    setTimeout(() => {
                        this.preloadVisibleThumbnails();
                    }, 500); // 0.5초 후 사전 로드
                }
            }
        };
        requestAnimationFrame(renderBatch);
    }

    // 배치 사전 로드: 보이는 영역 우선 처리
    async preloadVisibleThumbnails() {
        const visibleImages = Array.from(document.querySelectorAll('.grid img[data-src]'))
            .filter(img => {
                const rect = img.getBoundingClientRect();
                return rect.top < window.innerHeight + 500 && rect.bottom > -500;
            })
            .slice(0, 100); // 최대 100개
            
        if (visibleImages.length < 20) return;
        
        const paths = visibleImages.map(img => img.dataset.src?.match(/path=([^&]+)/)?.[1])
            .filter(Boolean)
            .map(decodeURIComponent);
            
        if (paths.length > 0) {
            try {
                const response = await fetch('/api/thumbnails/batch?max_concurrent=256', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(paths)
                });
                const result = await response.json();
                console.log(`[PRELOAD] ${result.stats.throughput_per_second.toFixed(0)}/s (${result.stats.generated}개 생성)`);
            } catch (error) {
                console.warn('[PRELOAD] 실패:', error);
            }
        }
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
        
        const startTime = performance.now();
        
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
        
        const elapsedMs = performance.now() - startTime;
        const perSec = (images.length / (elapsedMs / 1000)).toFixed(1);
        console.debug(`[THUMB] 완료: ${images.length}개, ${elapsedMs.toFixed(0)}ms (${perSec}개/초)`);
    }

    async checkWorkerStats() {
        // 워커 통계 체크 비활성화 (성능 최적화)
        return;
    }

    hideGrid() {
        this.gridMode = false;
        const grid = document.getElementById('image-grid');
        
        // 그리드 관련 네트워크/백그라운드 작업 즉시 중단
        if (this.thumbnailManager && typeof this.thumbnailManager.cancelPendingRequests === 'function') {
            this.thumbnailManager.cancelPendingRequests();
        }

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
        
        // 현재 스크롤 위치 저장
        try {
            const scroller = document.querySelector('.grid-scroll-wrapper');
            this._lastGridScrollTop = scroller ? scroller.scrollTop : 0;
        } catch (_) { this._lastGridScrollTop = 0; }

        // 화면 모드 전환
        this.dom.viewerContainer.classList.remove('grid-mode');
        this.dom.viewerContainer.classList.add('single-image-mode');
        this.dom.imageCanvas.style.display = 'block';
        this.dom.overlayCanvas.style.display = 'block';
        this.dom.minimapContainer.style.display = 'block';
        // 캔버스가 항상 상단에 오도록 보장 (그리드 DOM보다 높은 z-index)
        this.dom.imageCanvas.style.zIndex = 100;
        this.dom.overlayCanvas.style.zIndex = 2;
        
        // 컨트롤 전환
        const gridControls = document.getElementById('grid-controls');
        if (gridControls) gridControls.style.display = 'none';
        const viewControls = document.querySelector('.view-controls');
        if (viewControls) viewControls.style.display = 'flex';
        
        // 파일명 표시 숨기기 (그리드 모드에서는 파일명을 표시하지 않음)
        this.hideFileName();
        
        // ResizeObserver 정리
        if (this.gridResizeObserver) {
            this.gridResizeObserver.disconnect();
            this.gridResizeObserver = null;
        }
        
        // 이전 그리드 선택 유지: 라벨 추가 모달에서 사용할 수 있도록 저장
        if (Array.isArray(this.selectedImages) && Array.isArray(this.gridSelectedIdxs)) {
            this.persistentSelectedImages = this.gridSelectedIdxs.map(i => this.selectedImages[i]).filter(Boolean);
        } else {
            this.persistentSelectedImages = [];
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
console.log('성능 모니터링: URL에 #debug 추가');