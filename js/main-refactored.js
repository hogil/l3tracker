/**
 * Wafer Map Viewer - 리팩토링된 메인 파일
 * 모듈화된 구조로 재구성
 */

import { 
    isImageFile, 
    debounce, 
    setButtonLoading, 
    copyToClipboard,
    extractFolderName,
    extractFileName,
    splitFileName 
} from './utils.js';

import { 
    fastFileNameSearch, 
    matchesSearchQuery, 
    SearchHistory 
} from './search.js';

import { GridManager } from './grid.js';
import { ContextMenuManager } from './context-menu.js';
import { LabelManager } from './labels.js';

/**
 * 썸네일 매니저 클래스 (기존 코드 유지)
 */
class ThumbnailManager {
    constructor() {
        this.cache = new Map();
        this.maxCacheSize = 100;
        this.preloadQueue = [];
        this.isPreloading = false;
    }

    getCacheStats() {
        return {
            size: this.cache.size,
            maxSize: this.maxCacheSize,
            queueLength: this.preloadQueue.length,
            isPreloading: this.isPreloading
        };
    }
}

/**
 * 메인 Wafer Map Viewer 클래스 (리팩토링된 버전)
 */
class WaferMapViewer {
    constructor() {
        // DOM 캐싱
        this.cacheDom();
        
        // 상태 초기화
        this.initState();
        
        // 모듈 매니저들 초기화
        this.initManagers();
        
        // 이벤트 바인딩
        this.bindEvents();
        
        // 초기화
        this.init();
        
        // 정리 작업 설정
        this.setupCleanup();
    }
    
    /**
     * DOM 요소 캐싱
     */
    cacheDom() {
        this.dom = {
            // 메인 컨테이너들
            viewerContainer: document.getElementById('viewer-container'),
            gridContainer: document.getElementById('grid-container'),
            fileExplorer: document.getElementById('file-explorer'),
            
            // 검색 관련
            fileSearch: document.getElementById('file-search'),
            searchBtn: document.getElementById('search-btn'),
            
            // 그리드 컨트롤
            gridControls: document.getElementById('grid-controls'),
            gridZoomSlider: document.getElementById('grid-zoom-slider'),
            gridDownloadSelected: document.getElementById('grid-download-selected'),
            
            // 이미지 뷰어
            imageViewer: document.getElementById('image-viewer'),
            currentImage: document.getElementById('current-image'),
            
            // 미니맵
            minimapCanvas: document.getElementById('minimap-canvas'),
            minimapContainer: document.getElementById('minimap-container'),
            
            // 줌 컨트롤
            zoomSlider: document.getElementById('zoom-slider'),
            zoomValue: document.getElementById('zoom-value'),
            
            // 클래스 관리 (LabelManager에서 사용)
            newClassInput: document.getElementById('new-class-input'),
            addClassBtn: document.getElementById('add-class-btn'),
            deleteClassBtn: document.getElementById('delete-class-btn'),
            classList: document.getElementById('class-list'),
            
            // 라벨 탐색기
            labelExplorerList: document.getElementById('label-explorer-list'),
            batchLabelBtn: document.getElementById('label-explorer-batch-label-btn'),
            batchDeleteBtn: document.getElementById('label-explorer-batch-delete-btn'),
            
            // 모달
            addLabelModal: document.getElementById('add-label-modal')
        };
    }
    
    /**
     * 상태 초기화
     */
    initState() {
        // 이미지 관련 상태
        this.selectedImages = [];
        this.selectedImagePath = '';
        this.currentImagePath = '';
        
        // 선택 상태
        this.selectedFolders = new Set();
        this.lastSelectedFolder = null;
        this.gridSelectedIdxs = [];
        
        // 모드 상태
        this.gridMode = false;
        
        // 줌 및 팬 상태
        this.zoomLevel = 1;
        this.panX = 0;
        this.panY = 0;
        this.isDragging = false;
        this.dragStartX = 0;
        this.dragStartY = 0;
        
        // 검색 상태
        this.searchHistory = new SearchHistory();
        
        // 썸네일 매니저
        this.thumbnailManager = new ThumbnailManager();
        
        // 디바운싱된 함수들
        this._showGridScheduled = false;
        this.debouncedSearch = debounce((query) => this.performSearch(query), 300);
    }
    
    /**
     * 모듈 매니저들 초기화
     */
    initManagers() {
        // 그리드 매니저
        this.gridManager = new GridManager(this);
        this.gridManager.init();
        
        // 컨텍스트 메뉴 매니저
        this.contextMenuManager = new ContextMenuManager(this);
        
        // 라벨 매니저
        this.labelManager = new LabelManager(this);
    }
    
    /**
     * 이벤트 바인딩
     */
    bindEvents() {
        this.bindViewerEvents();
        this.bindSearchEvents();
        this.bindFileExplorerEvents();
        this.bindZoomEvents();
        this.bindKeyboardEvents();
    }
    
    /**
     * 뷰어 이벤트 바인딩
     */
    bindViewerEvents() {
        if (!this.dom.viewerContainer) return;
        
        // 마우스 이벤트
        this.dom.viewerContainer.addEventListener('mousedown', (e) => this.handleMouseDown(e));
        this.dom.viewerContainer.addEventListener('mousemove', (e) => this.handleMouseMove(e));
        this.dom.viewerContainer.addEventListener('mouseup', (e) => this.handleMouseUp(e));
        this.dom.viewerContainer.addEventListener('wheel', (e) => this.handleWheel(e));
        
        // 터치 이벤트 (모바일 지원)
        this.dom.viewerContainer.addEventListener('touchstart', (e) => this.handleTouchStart(e));
        this.dom.viewerContainer.addEventListener('touchmove', (e) => this.handleTouchMove(e));
        this.dom.viewerContainer.addEventListener('touchend', (e) => this.handleTouchEnd(e));
    }
    
    /**
     * 검색 이벤트 바인딩
     */
    bindSearchEvents() {
        // 검색 버튼
        if (this.dom.searchBtn) {
            this.dom.searchBtn.addEventListener('click', () => this.handleSearchClick());
        }
        
        // 검색 입력 필드
        if (this.dom.fileSearch) {
            this.dom.fileSearch.addEventListener('input', (e) => {
                this.debouncedSearch(e.target.value);
            });
            
            this.dom.fileSearch.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    this.handleSearchClick();
                }
            });
        }
    }
    
    /**
     * 파일 탐색기 이벤트 바인딩
     */
    bindFileExplorerEvents() {
        if (!this.dom.fileExplorer) return;
        
        // 이벤트 위임으로 파일/폴더 클릭 처리
        this.dom.fileExplorer.addEventListener('click', (e) => {
            const link = e.target.closest('a[data-path]');
            if (link) {
                e.preventDefault();
                const path = link.getAttribute('data-path');
                this.handleFileClick(path, e);
            }
        });
    }
    
    /**
     * 줌 이벤트 바인딩
     */
    bindZoomEvents() {
        if (this.dom.zoomSlider) {
            this.dom.zoomSlider.addEventListener('input', (e) => {
                this.setZoom(parseFloat(e.target.value));
            });
        }
        
        if (this.dom.gridZoomSlider) {
            this.dom.gridZoomSlider.addEventListener('input', (e) => {
                this.updateGridZoom(parseFloat(e.target.value));
            });
        }
    }
    
    /**
     * 키보드 이벤트 바인딩
     */
    bindKeyboardEvents() {
        document.addEventListener('keydown', (e) => this.handleKeyDown(e));
    }
    
    /**
     * 초기화
     */
    async init() {
        try {
            // 파일 탐색기 로드
            await this.loadDirectoryContents('');
            
            // 라벨 매니저 초기화
            await this.labelManager.refreshAll();
            
            console.log('Wafer Map Viewer 초기화 완료');
            
        } catch (error) {
            console.error('초기화 오류:', error);
        }
    }
    
    /**
     * 정리 작업 설정
     */
    setupCleanup() {
        // 주기적인 메모리 정리 (5분마다)
        this.cleanupInterval = setInterval(() => {
            this.performCleanup();
        }, 5 * 60 * 1000);
        
        // 페이지 언로드시 정리
        window.addEventListener('beforeunload', () => {
            this.cleanup();
        });
    }
    
    // ========== 파일 처리 메서드들 ==========
    
    /**
     * 디렉터리 내용 로드
     */
    async loadDirectoryContents(path = '') {
        try {
            const response = await fetch(`/api/files?path=${encodeURIComponent(path)}`);
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }
            
            const data = await response.json();
            if (!data.success) {
                throw new Error(data.error || '파일 목록 조회 실패');
            }
            
            this.renderFileExplorer(data.items, path);
            
        } catch (error) {
            console.error('디렉터리 로드 오류:', error);
            if (this.dom.fileExplorer) {
                this.dom.fileExplorer.innerHTML = '<p style="color: #f00;">파일 목록을 불러올 수 없습니다.</p>';
            }
        }
    }
    
    /**
     * 파일 탐색기 렌더링
     */
    renderFileExplorer(items, currentPath) {
        if (!this.dom.fileExplorer) return;
        
        const fragment = document.createDocumentFragment();
        
        // 상위 디렉터리로 가기 링크
        if (currentPath) {
            const parentPath = currentPath.split('/').slice(0, -1).join('/');
            const parentLink = this.createFileExplorerItem('..', 'directory', parentPath, true);
            fragment.appendChild(parentLink);
        }
        
        // 디렉터리들 먼저 표시
        const directories = items.filter(item => item.type === 'directory');
        const files = items.filter(item => item.type === 'file');
        
        [...directories, ...files].forEach(item => {
            const itemPath = currentPath ? `${currentPath}/${item.name}` : item.name;
            const element = this.createFileExplorerItem(item.name, item.type, itemPath);
            fragment.appendChild(element);
        });
        
        this.dom.fileExplorer.innerHTML = '';
        this.dom.fileExplorer.appendChild(fragment);
    }
    
    /**
     * 파일 탐색기 아이템 생성
     */
    createFileExplorerItem(name, type, path, isParent = false) {
        const item = document.createElement('div');
        item.className = `file-item ${type}`;
        
        const link = document.createElement('a');
        link.href = '#';
        link.dataset.path = path;
        link.dataset.type = type;
        
        // 아이콘
        const icon = document.createElement('span');
        icon.className = 'file-icon';
        icon.textContent = isParent ? '↖' : (type === 'directory' ? '📁' : '📄');
        
        // 이름
        const nameSpan = document.createElement('span');
        nameSpan.className = 'file-name';
        nameSpan.textContent = name;
        
        link.appendChild(icon);
        link.appendChild(nameSpan);
        item.appendChild(link);
        
        return item;
    }
    
    /**
     * 파일/폴더 클릭 처리
     */
    async handleFileClick(path, event) {
        const isDirectory = event.target.closest('a').dataset.type === 'directory';
        
        if (isDirectory) {
            if (event.ctrlKey) {
                // Ctrl+클릭: 폴더 선택 (열지 않음)
                this.toggleFolderSelection(path, event);
            } else if (event.shiftKey && this.lastSelectedFolder) {
                // Shift+클릭: 범위 선택
                await this.selectFolderRange(this.lastSelectedFolder, path);
            } else {
                // 일반 클릭: 폴더 열기
                await this.loadDirectoryContents(path);
            }
        } else {
            // 파일 클릭 처리
            if (event.ctrlKey || event.shiftKey) {
                this.toggleImageSelection(path, event);
            } else {
                // 단일 이미지 선택
                this.selectedImages = [path];
                this.selectedImagePath = path;
                
                if (isImageFile(path)) {
                    this.hideGrid();
                    this.loadImage(path);
                } else {
                    this.showGrid(this.selectedImages);
                }
            }
        }
    }
    
    // ========== 검색 메서드들 ==========
    
    /**
     * 검색 버튼 클릭 처리
     */
    handleSearchClick() {
        const query = this.dom.fileSearch?.value?.trim();
        if (!query) return;
        
        // 검색 히스토리에 추가
        this.searchHistory.add(query);
        
        // 즉시 검색 수행
        this.performSearch(query);
    }
    
    /**
     * 검색 수행
     */
    performSearch(query) {
        if (!query || !query.trim()) {
            return;
        }
        
        console.log('검색 수행:', query);
        
        // 버튼 로딩 상태
        const button = this.dom.searchBtn;
        const originalText = button?.textContent || '';
        if (button) {
            setButtonLoading(button, true, originalText, '검색 중...');
        }
        
        try {
            // 빠른 파일명 검색
            const matchedFiles = fastFileNameSearch(query, this.dom.fileExplorer);
            
            if (matchedFiles.length === 0) {
                alert('검색 결과가 없습니다.');
                return;
            }
            
            // 검색 결과를 그리드로 표시
            this.selectedImages = matchedFiles;
            this.showGrid(matchedFiles);
            
            console.log(`검색 완료: ${matchedFiles.length}개 파일 발견`);
            
        } catch (error) {
            console.error('검색 오류:', error);
            alert('검색 중 오류가 발생했습니다.');
        } finally {
            // 버튼 로딩 상태 해제
            if (button) {
                setButtonLoading(button, false, originalText);
            }
        }
    }
    
    // ========== 그리드 모드 메서드들 ==========
    
    /**
     * 그리드 모드 표시
     */
    showGrid(images) {
        this.gridMode = true;
        this.gridManager.show(images);
        
        // UI 상태 업데이트
        if (this.dom.gridContainer) {
            this.dom.gridContainer.style.display = 'block';
        }
        if (this.dom.imageViewer) {
            this.dom.imageViewer.style.display = 'none';
        }
    }
    
    /**
     * 그리드 모드 숨기기
     */
    hideGrid() {
        this.gridMode = false;
        this.gridManager.hide();
        
        // UI 상태 업데이트
        if (this.dom.gridContainer) {
            this.dom.gridContainer.style.display = 'none';
        }
    }
    
    /**
     * 그리드 모드 표시 (UI 업데이트 포함)
     */
    showGridMode() {
        if (this.dom.gridControls) {
            this.dom.gridControls.style.display = 'flex';
        }
        if (this.dom.viewerContainer) {
            this.dom.viewerContainer.style.display = 'none';
        }
    }
    
    /**
     * 그리드 선택 인덱스 업데이트
     */
    updateGridSelectedIndices(indices) {
        this.gridSelectedIdxs = indices;
    }
    
    // ========== 이미지 뷰어 메서드들 ==========
    
    /**
     * 이미지 로드
     */
    async loadImage(imagePath) {
        if (!this.dom.currentImage) return;
        
        try {
            this.currentImagePath = imagePath;
            
            // 이미지 URL 설정
            const imageUrl = `/api/image?path=${encodeURIComponent(imagePath)}`;
            this.dom.currentImage.src = imageUrl;
            
            // 뷰어 표시
            this.showImageViewer();
            
            // 줌 리셋
            this.resetZoom();
            
            console.log('이미지 로드:', imagePath);
            
        } catch (error) {
            console.error('이미지 로드 오류:', error);
        }
    }
    
    /**
     * 이미지 뷰어 표시
     */
    showImageViewer() {
        if (this.dom.imageViewer) {
            this.dom.imageViewer.style.display = 'block';
        }
        if (this.dom.gridContainer) {
            this.dom.gridContainer.style.display = 'none';
        }
        if (this.dom.gridControls) {
            this.dom.gridControls.style.display = 'none';
        }
        if (this.dom.viewerContainer) {
            this.dom.viewerContainer.style.display = 'block';
        }
    }
    
    // ========== 줌 및 팬 메서드들 ==========
    
    /**
     * 줌 설정
     */
    setZoom(level) {
        this.zoomLevel = Math.max(0.1, Math.min(5, level));
        this.updateImageTransform();
        this.updateZoomDisplay();
    }
    
    /**
     * 줌 리셋
     */
    resetZoom() {
        this.zoomLevel = 1;
        this.panX = 0;
        this.panY = 0;
        this.updateImageTransform();
        this.updateZoomDisplay();
    }
    
    /**
     * 이미지 변환 업데이트
     */
    updateImageTransform() {
        if (this.dom.currentImage) {
            this.dom.currentImage.style.transform = 
                `scale(${this.zoomLevel}) translate(${this.panX}px, ${this.panY}px)`;
        }
    }
    
    /**
     * 줌 표시 업데이트
     */
    updateZoomDisplay() {
        if (this.dom.zoomValue) {
            this.dom.zoomValue.textContent = `${Math.round(this.zoomLevel * 100)}%`;
        }
        if (this.dom.zoomSlider) {
            this.dom.zoomSlider.value = this.zoomLevel;
        }
    }
    
    // ========== 마우스 및 터치 이벤트 처리 ==========
    
    handleMouseDown(e) {
        this.isDragging = true;
        this.dragStartX = e.clientX - this.panX;
        this.dragStartY = e.clientY - this.panY;
        e.preventDefault();
    }
    
    handleMouseMove(e) {
        if (!this.isDragging) return;
        
        this.panX = e.clientX - this.dragStartX;
        this.panY = e.clientY - this.dragStartY;
        this.updateImageTransform();
    }
    
    handleMouseUp(e) {
        this.isDragging = false;
    }
    
    handleWheel(e) {
        e.preventDefault();
        
        const delta = e.deltaY > 0 ? 0.9 : 1.1;
        this.setZoom(this.zoomLevel * delta);
    }
    
    handleTouchStart(e) {
        if (e.touches.length === 1) {
            const touch = e.touches[0];
            this.isDragging = true;
            this.dragStartX = touch.clientX - this.panX;
            this.dragStartY = touch.clientY - this.panY;
        }
    }
    
    handleTouchMove(e) {
        if (e.touches.length === 1 && this.isDragging) {
            const touch = e.touches[0];
            this.panX = touch.clientX - this.dragStartX;
            this.panY = touch.clientY - this.dragStartY;
            this.updateImageTransform();
        }
        e.preventDefault();
    }
    
    handleTouchEnd(e) {
        this.isDragging = false;
    }
    
    // ========== 키보드 이벤트 처리 ==========
    
    handleKeyDown(e) {
        // ESC: 모달 닫기, 선택 해제 등
        if (e.key === 'Escape') {
            this.handleEscapeKey();
        }
        
        // Ctrl+A: 전체 선택 (그리드 모드에서)
        if (e.key === 'a' && e.ctrlKey && this.gridMode) {
            e.preventDefault();
            this.gridManager.selectAll();
        }
        
        // 화살표 키: 이미지 네비게이션
        if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) {
            this.handleArrowKeys(e.key);
        }
    }
    
    handleEscapeKey() {
        // 모달이 열려있으면 닫기
        if (this.dom.addLabelModal && this.dom.addLabelModal.style.display === 'block') {
            this.dom.addLabelModal.style.display = 'none';
            return;
        }
        
        // 컨텍스트 메뉴가 열려있으면 닫기
        if (this.contextMenuManager.isVisible) {
            this.contextMenuManager.hide();
            return;
        }
        
        // 그리드 선택 해제
        if (this.gridMode) {
            this.gridManager.clearSelection();
        }
    }
    
    handleArrowKeys(key) {
        // 이미지 네비게이션 로직
        if (!this.gridMode && this.selectedImages.length > 1) {
            const currentIndex = this.selectedImages.indexOf(this.currentImagePath);
            let newIndex = currentIndex;
            
            switch (key) {
                case 'ArrowLeft':
                    newIndex = Math.max(0, currentIndex - 1);
                    break;
                case 'ArrowRight':
                    newIndex = Math.min(this.selectedImages.length - 1, currentIndex + 1);
                    break;
            }
            
            if (newIndex !== currentIndex) {
                this.loadImage(this.selectedImages[newIndex]);
            }
        }
    }
    
    // ========== 유틸리티 메서드들 ==========
    
    /**
     * 선택된 이미지들 반환 (모달용)
     */
    getSelectedImagesForModal() {
        if (this.gridMode && this.gridSelectedIdxs.length > 0) {
            return this.gridSelectedIdxs.map(idx => this.selectedImages[idx]).filter(Boolean);
        }
        if (this.selectedImagePath) {
            return [this.selectedImagePath];
        }
        return [];
    }
    
    /**
     * 폴더 선택 토글
     */
    toggleFolderSelection(folderPath, event) {
        if (this.selectedFolders.has(folderPath)) {
            this.selectedFolders.delete(folderPath);
        } else {
            this.selectedFolders.add(folderPath);
            this.lastSelectedFolder = event.target.closest('a');
        }
        this.updateFileExplorerSelection();
    }
    
    /**
     * 이미지 선택 토글
     */
    toggleImageSelection(imagePath, event) {
        const index = this.selectedImages.indexOf(imagePath);
        if (index > -1) {
            this.selectedImages.splice(index, 1);
        } else {
            this.selectedImages.push(imagePath);
        }
        
        if (this.selectedImages.length > 0) {
            this.showGrid(this.selectedImages);
        }
    }
    
    /**
     * 파일 탐색기 선택 상태 업데이트
     */
    updateFileExplorerSelection() {
        if (!this.dom.fileExplorer) return;
        
        const links = this.dom.fileExplorer.querySelectorAll('a[data-path]');
        links.forEach(link => {
            const path = link.getAttribute('data-path');
            const isSelected = this.selectedFolders.has(path);
            link.classList.toggle('selected', isSelected);
        });
    }
    
    /**
     * 폴더 범위 선택
     */
    async selectFolderRange(startElement, endPath) {
        // 복잡한 로직이므로 기본 구현만 제공
        console.log('폴더 범위 선택:', startElement, endPath);
    }
    
    /**
     * 그리드 줌 업데이트
     */
    updateGridZoom(zoomLevel) {
        if (this.dom.gridContainer) {
            this.dom.gridContainer.style.setProperty('--grid-zoom', zoomLevel);
        }
    }
    
    /**
     * 메모리 정리
     */
    performCleanup() {
        // 썸네일 캐시 정리
        if (this.thumbnailManager.cache.size > this.thumbnailManager.maxCacheSize) {
            const entries = Array.from(this.thumbnailManager.cache.entries());
            const toRemove = entries.slice(0, entries.length - this.thumbnailManager.maxCacheSize);
            toRemove.forEach(([key]) => this.thumbnailManager.cache.delete(key));
        }
        
        console.log('메모리 정리 완료');
    }
    
    /**
     * 전체 정리
     */
    cleanup() {
        // 인터벌 정리
        if (this.cleanupInterval) {
            clearInterval(this.cleanupInterval);
        }
        
        // 매니저들 정리
        this.gridManager?.cleanup();
        this.contextMenuManager?.hide();
        this.labelManager?.cleanup();
        
        console.log('Wafer Map Viewer 정리 완료');
    }
}

// 전역 변수 (기존 코드와의 호환성을 위해)
let viewer;

// DOM 로드 완료 후 초기화
document.addEventListener('DOMContentLoaded', () => {
    viewer = new WaferMapViewer();
    window.waferMapViewer = viewer; // 디버깅용
});

// 모듈 내보내기 (필요한 경우)
export { WaferMapViewer };
