/**
 * main.js 이미지 피라미드 패치
 * 
 * 이 파일은 main.js에 추가/수정할 코드입니다.
 * 4000x4000 이미지의 줌 레벨별 피라미드 구조를 구현하고
 * 픽셀 정보를 표시하는 기능을 추가합니다.
 */

// ========================================
// 1. WaferMapViewer 클래스에 추가할 메소드들
// ========================================

/**
 * 이미지 로드 함수 개선 (이미지 피라미드 지원)
 * main.js의 loadImage 함수를 다음과 같이 수정
 */
async function loadImageWithPyramid(imgPath) {
    try {
        // 이미지 로드
        const response = await fetch(`/api/image?path=${encodeURIComponent(imgPath)}`);
        if (!response.ok) throw new Error('이미지 로드 실패');
        
        const blob = await response.blob();
        const img = new Image();
        
        await new Promise((resolve, reject) => {
            img.onload = resolve;
            img.onerror = reject;
            img.src = URL.createObjectURL(blob);
        });
        
        // ImageBitmap 생성 (성능 향상)
        const imageBitmap = await createImageBitmap(img);
        this.currentImage = img;
        this.currentImageBitmap = imageBitmap;
        
        // 반도체 렌더러가 있으면 이미지 피라미드 생성
        if (this.semiconductorRenderer) {
            console.log('이미지 피라미드 생성 시작...');
            await this.semiconductorRenderer.loadImage(img);
            console.log('이미지 피라미드 생성 완료');
        }
        
        // 초기 렌더링
        this.resetView();
        this.draw();
        this.updateMinimapViewport();
        
        // 파일명 표시
        this.showFileName(imgPath);
        
        // 줌 컨트롤 표시
        const viewControls = document.querySelector('.view-controls');
        if (viewControls) {
            viewControls.style.display = 'flex';
        }
        
        // 픽셀 정보 표시
        this.updatePixelInfo();
        
    } catch (error) {
        console.error('이미지 로드 실패:', error);
        alert('이미지 로드에 실패했습니다.');
    }
}

/**
 * draw 함수 개선 (이미지 피라미드 활용)
 */
function drawWithPyramid() {
    if (!this.currentImage) return;
    
    const { scale, dx, dy } = this.transform;
    const canvas = this.dom.imageCanvas;
    const ctx = this.imageCtx;
    
    // 반도체 렌더러 사용 시
    if (this.semiconductorRenderer && this.semiconductorRenderer.options.usePyramid) {
        // 줌 레벨 설정
        this.semiconductorRenderer.setScale(scale);
        
        // 렌더러의 캔버스 내용을 메인 캔버스로 복사
        const rendererCanvas = this.semiconductorRenderer.canvas;
        if (rendererCanvas.width > 0 && rendererCanvas.height > 0) {
            // 뷰어 컨테이너 크기에 맞춰 캔버스 설정
            canvas.width = this.dom.viewerContainer.clientWidth;
            canvas.height = this.dom.viewerContainer.clientHeight;
            
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            
            // 픽셀 완벽 렌더링 설정
            ctx.imageSmoothingEnabled = false;
            ctx.webkitImageSmoothingEnabled = false;
            ctx.mozImageSmoothingEnabled = false;
            ctx.msImageSmoothingEnabled = false;
            ctx.oImageSmoothingEnabled = false;
            
            // 중앙 정렬 및 이동 적용
            const displayWidth = Math.floor(this.currentImage.width * scale);
            const displayHeight = Math.floor(this.currentImage.height * scale);
            const x = (canvas.width - displayWidth) / 2 + dx;
            const y = (canvas.height - displayHeight) / 2 + dy;
            
            // 렌더러 캔버스 내용 복사
            ctx.drawImage(rendererCanvas, x, y);
            
            // 픽셀 정보 업데이트
            this.updatePixelInfo();
        }
    } else {
        // 기존 방식 (폴백)
        const img = this.currentImageBitmap || this.currentImage;
        const imgW = img.width;
        const imgH = img.height;
        const canvasW = canvas.width;
        const canvasH = canvas.height;
        
        ctx.save();
        ctx.clearRect(0, 0, canvasW, canvasH);
        
        // 변환 적용
        ctx.translate(canvasW / 2, canvasH / 2);
        ctx.scale(scale, scale);
        ctx.translate(-canvasW / 2, -canvasH / 2);
        
        const x = (canvasW - imgW) / 2 + dx;
        const y = (canvasH - imgH) / 2 + dy;
        
        // 줌 레벨에 따른 스무딩 설정
        if (scale <= 0.75) {
            ctx.imageSmoothingEnabled = true;
            ctx.imageSmoothingQuality = 'high';
        } else {
            ctx.imageSmoothingEnabled = false;
        }
        
        ctx.drawImage(img, x, y);
        ctx.restore();
    }
    
    // 미니맵 업데이트
    this.updateMinimap();
}

/**
 * 픽셀 정보 업데이트 함수
 */
function updatePixelInfo() {
    const info = this.semiconductorRenderer?.getInfo();
    if (!info) return;
    
    // 줌 레벨 표시 업데이트
    const zoomLevelInput = this.dom.zoomLevelInput;
    if (zoomLevelInput) {
        const percent = Math.round(this.transform.scale * 100);
        zoomLevelInput.value = `${percent}%`;
    }
    
    // 피라미드 정보 표시 (새로운 UI 요소 필요)
    let pyramidInfo = document.getElementById('pyramid-info');
    if (!pyramidInfo) {
        // 피라미드 정보 표시 요소 생성
        pyramidInfo = document.createElement('div');
        pyramidInfo.id = 'pyramid-info';
        pyramidInfo.style.cssText = `
            position: fixed;
            top: 60px;
            right: 20px;
            background: rgba(0, 0, 0, 0.8);
            color: #00ff00;
            padding: 10px 15px;
            border-radius: 6px;
            font-family: monospace;
            font-size: 12px;
            z-index: 1000;
            border: 1px solid #00ff00;
            display: none;
        `;
        document.body.appendChild(pyramidInfo);
    }
    
    // 단일 이미지 모드에서만 표시
    if (this.gridMode) {
        pyramidInfo.style.display = 'none';
    } else if (this.currentImage) {
        pyramidInfo.style.display = 'block';
        pyramidInfo.innerHTML = `
            <div style="margin-bottom: 8px; font-weight: bold; border-bottom: 1px solid #00ff00; padding-bottom: 5px;">
                🔬 이미지 피라미드 상태
            </div>
            <div style="display: grid; grid-template-columns: auto auto; gap: 5px 15px;">
                <span style="color: #888;">원본 크기:</span>
                <span>${info.originalWidth} × ${info.originalHeight}</span>
                
                <span style="color: #888;">표시 크기:</span>
                <span>${info.displayWidth} × ${info.displayHeight}</span>
                
                <span style="color: #888;">줌 배율:</span>
                <span>${info.scalePercent}%</span>
                
                <span style="color: #888;">피라미드 레벨:</span>
                <span style="color: ${info.pyramidLevel === '원본' ? '#ff0' : '#0ff'};">
                    ${info.pyramidLevel}
                </span>
                
                <span style="color: #888;">렌더 모드:</span>
                <span>${info.pyramidEnabled ? '피라미드 활성' : '기본'}</span>
            </div>
        `;
    }
}

/**
 * 줌 동작 개선 (피라미드 레벨 전환 부드럽게)
 */
function handleWheelWithPyramid(event) {
    event.preventDefault();
    
    if (this.gridMode || !this.currentImage) return;
    
    const rect = this.dom.viewerContainer.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    
    // Ctrl 키로 미세 조정
    const delta = event.deltaY < 0 ? 1 : -1;
    const factor = event.ctrlKey ? 1.05 : 1.2;
    const zoomFactor = delta > 0 ? factor : 1 / factor;
    
    // 줌 적용
    this.zoomAt(x, y, zoomFactor);
    
    // 피라미드 정보 즉시 업데이트
    this.updatePixelInfo();
}

/**
 * 마우스 이동 시 픽셀 좌표 표시 (선택적)
 */
function handleMouseMoveWithPixelInfo(event) {
    if (this.gridMode || !this.currentImage) return;
    
    const rect = this.dom.imageCanvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    
    // 이미지 좌표로 변환
    const { scale, dx, dy } = this.transform;
    const imgX = Math.floor((x - this.dom.imageCanvas.width / 2 - dx) / scale + this.currentImage.width / 2);
    const imgY = Math.floor((y - this.dom.imageCanvas.height / 2 - dy) / scale + this.currentImage.height / 2);
    
    // 픽셀 좌표 표시 (선택적 UI 요소)
    let pixelCoord = document.getElementById('pixel-coord');
    if (!pixelCoord) {
        pixelCoord = document.createElement('div');
        pixelCoord.id = 'pixel-coord';
        pixelCoord.style.cssText = `
            position: fixed;
            bottom: 20px;
            right: 20px;
            background: rgba(0, 0, 0, 0.8);
            color: #0f0;
            padding: 5px 10px;
            border-radius: 4px;
            font-family: monospace;
            font-size: 12px;
            z-index: 1000;
            border: 1px solid #0f0;
        `;
        document.body.appendChild(pixelCoord);
    }
    
    // 범위 체크
    if (imgX >= 0 && imgX < this.currentImage.width && 
        imgY >= 0 && imgY < this.currentImage.height) {
        pixelCoord.style.display = 'block';
        pixelCoord.textContent = `픽셀: (${imgX}, ${imgY})`;
    } else {
        pixelCoord.style.display = 'none';
    }
}

// ========================================
// 2. 초기화 코드 수정
// ========================================

/**
 * semiconductorRenderer 초기화 개선
 * initSemiconductorRenderer 함수 수정
 */
function initSemiconductorRendererImproved() {
    if (typeof SemiconductorRenderer !== 'undefined') {
        // 별도의 오프스크린 캔버스 생성
        const offscreenCanvas = document.createElement('canvas');
        offscreenCanvas.id = 'semiconductor-canvas';
        offscreenCanvas.style.display = 'none';
        document.body.appendChild(offscreenCanvas);
        
        this.semiconductorRenderer = new SemiconductorRenderer(offscreenCanvas, {
            preserveChipBoundaries: true,
            enhanceDefects: true,
            chipBoundaryColor: '#00FF00',
            defectEnhancement: 2.0,
            usePyramid: true,
            debug: true // 디버깅 활성화
        });
        
        console.log('반도체 특화 렌더러 초기화 완료 (이미지 피라미드 활성화)');
        
        // 이벤트 리스너 추가
        if (this.dom.imageCanvas) {
            this.dom.imageCanvas.addEventListener('mousemove', 
                this.handleMouseMoveWithPixelInfo.bind(this));
        }
    } else {
        console.warn('SemiconductorRenderer를 찾을 수 없습니다');
    }
}

// ========================================
// 3. 적용 가이드
// ========================================

/*
main.js 파일에 다음과 같이 수정사항을 적용하세요:

1. loadImage 함수를 loadImageWithPyramid 내용으로 교체
2. draw 함수를 drawWithPyramid 내용으로 교체  
3. handleWheel 함수를 handleWheelWithPyramid 내용으로 교체
4. initSemiconductorRenderer 함수를 initSemiconductorRendererImproved 내용으로 교체
5. updatePixelInfo 함수 추가
6. handleMouseMoveWithPixelInfo 함수 추가 (선택적)

주의사항:
- this 컨텍스트를 올바르게 바인딩하세요
- 기존 함수 이름을 유지하면서 내용만 교체하세요
- 이미지가 4000x4000 이상일 때 가장 효과적입니다
*/
