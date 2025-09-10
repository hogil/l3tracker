/**
 * Pixel-Perfect Image Renderer for Wafer Maps
 * 대용량 반도체 불량맵을 왜곡 없이 축소/확대하는 렌더러
 */

class PixelPerfectRenderer {
    constructor(canvas, options = {}) {
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d', {
            alpha: false,
            desynchronized: true,
            willReadFrequently: false
        });
        
        // 옵션 설정
        this.options = {
            minScale: options.minScale || 0.05,
            maxScale: options.maxScale || 5.0,
            pixelSampling: options.pixelSampling !== false, // 기본값 true
            renderMode: options.renderMode || 'pixelated' // pixelated, crisp, smooth, auto
        };
        
        // 상태 변수
        this.currentImage = null;
        this.scale = 1.0;
        this.offsetX = 0;
        this.offsetY = 0;
        
        // 픽셀 완벽 렌더링 설정
        this.setupPixelPerfectRendering();
    }
    
    /**
     * 픽셀 완벽 렌더링 설정
     */
    setupPixelPerfectRendering() {
        // Canvas 2D 컨텍스트 설정
        this.ctx.imageSmoothingEnabled = false;
        this.ctx.imageSmoothingQuality = 'low';
        this.ctx.mozImageSmoothingEnabled = false;
        this.ctx.webkitImageSmoothingEnabled = false;
        this.ctx.msImageSmoothingEnabled = false;
        
        // Canvas 엘리먼트 CSS 설정
        this.setRenderMode(this.options.renderMode);
        
        // GPU 가속 및 성능 최적화
        this.canvas.style.willChange = 'transform';
        this.canvas.style.transform = 'translateZ(0)';
        this.canvas.style.backfaceVisibility = 'hidden';
        this.canvas.style.webkitBackfaceVisibility = 'hidden';
    }
    
    /**
     * 렌더링 모드 설정
     */
    setRenderMode(mode) {
        this.options.renderMode = mode;
        
        switch(mode) {
            case 'pixelated':
                this.canvas.style.imageRendering = 'pixelated';
                this.canvas.style.imageRendering = '-moz-crisp-edges';
                this.canvas.style.imageRendering = '-webkit-crisp-edges';
                this.canvas.style.imageRendering = 'crisp-edges';
                this.canvas.style.msInterpolationMode = 'nearest-neighbor';
                this.ctx.imageSmoothingEnabled = false;
                break;
                
            case 'crisp':
                this.canvas.style.imageRendering = 'crisp-edges';
                this.ctx.imageSmoothingEnabled = false;
                break;
                
            case 'smooth':
                this.canvas.style.imageRendering = 'auto';
                this.ctx.imageSmoothingEnabled = true;
                this.ctx.imageSmoothingQuality = 'high';
                break;
                
            case 'auto':
                this.canvas.style.imageRendering = 'auto';
                this.ctx.imageSmoothingEnabled = false;
                break;
        }
    }
    
    /**
     * 이미지 로드
     */
    loadImage(image) {
        this.currentImage = image;
        this.render();
    }
    
    /**
     * 렌더링 메인 함수
     */
    render() {
        if (!this.currentImage) return;
        
        // 표시 크기 계산 (정수로 반올림)
        const displayWidth = Math.floor(this.currentImage.width * this.scale);
        const displayHeight = Math.floor(this.currentImage.height * this.scale);
        
        // 캔버스 크기 설정
        this.canvas.width = displayWidth;
        this.canvas.height = displayHeight;
        
        // 스타일 크기도 동일하게 설정 (픽셀 완벽 매칭)
        this.canvas.style.width = displayWidth + 'px';
        this.canvas.style.height = displayHeight + 'px';
        
        // 컨텍스트 재설정 (캔버스 크기 변경 후 필요)
        this.setupContextAfterResize();
        
        // 배경을 검은색으로
        this.ctx.fillStyle = '#000';
        this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
        
        // 이미지 그리기
        if (this.scale < 1 && this.options.pixelSampling) {
            // 축소 시: 픽셀 샘플링 방식 (왜곡 최소화)
            this.drawPixelSampled();
        } else {
            // 확대 시 또는 픽셀 샘플링 비활성화 시: 일반 그리기
            this.ctx.drawImage(this.currentImage, 0, 0, displayWidth, displayHeight);
        }
    }
    
    /**
     * 캔버스 크기 변경 후 컨텍스트 재설정
     */
    setupContextAfterResize() {
        this.ctx.imageSmoothingEnabled = false;
        this.ctx.imageSmoothingQuality = 'low';
        this.ctx.mozImageSmoothingEnabled = false;
        this.ctx.webkitImageSmoothingEnabled = false;
        this.ctx.msImageSmoothingEnabled = false;
    }
    
    /**
     * 픽셀 샘플링 방식으로 축소 (왜곡 최소화)
     * Nearest Neighbor 알고리즘 사용
     */
    drawPixelSampled() {
        const srcWidth = this.currentImage.width;
        const srcHeight = this.currentImage.height;
        const dstWidth = Math.floor(srcWidth * this.scale);
        const dstHeight = Math.floor(srcHeight * this.scale);
        
        // 대용량 이미지의 경우 청크 단위로 처리
        if (srcWidth * srcHeight > 16000000) { // 4000x4000 이상
            this.drawPixelSampledChunked();
            return;
        }
        
        // 임시 캔버스에 원본 이미지 그리기
        const tempCanvas = document.createElement('canvas');
        tempCanvas.width = srcWidth;
        tempCanvas.height = srcHeight;
        const tempCtx = tempCanvas.getContext('2d');
        tempCtx.drawImage(this.currentImage, 0, 0);
        
        // 원본 이미지 데이터 가져오기
        const srcData = tempCtx.getImageData(0, 0, srcWidth, srcHeight);
        const srcPixels = srcData.data;
        
        // 대상 이미지 데이터 생성
        const dstData = this.ctx.createImageData(dstWidth, dstHeight);
        const dstPixels = dstData.data;
        
        // 스케일 비율
        const scaleRatio = 1 / this.scale;
        
        // 픽셀 샘플링 (Nearest Neighbor)
        for (let y = 0; y < dstHeight; y++) {
            for (let x = 0; x < dstWidth; x++) {
                // 원본 좌표 계산 (가장 가까운 픽셀)
                const srcX = Math.floor(x * scaleRatio);
                const srcY = Math.floor(y * scaleRatio);
                
                // 경계 체크
                if (srcX >= 0 && srcX < srcWidth && srcY >= 0 && srcY < srcHeight) {
                    // 원본 픽셀 인덱스
                    const srcIdx = (srcY * srcWidth + srcX) * 4;
                    
                    // 대상 픽셀 인덱스
                    const dstIdx = (y * dstWidth + x) * 4;
                    
                    // 픽셀 복사 (정확한 색상 유지)
                    dstPixels[dstIdx] = srcPixels[srcIdx];         // R
                    dstPixels[dstIdx + 1] = srcPixels[srcIdx + 1]; // G
                    dstPixels[dstIdx + 2] = srcPixels[srcIdx + 2]; // B
                    dstPixels[dstIdx + 3] = srcPixels[srcIdx + 3]; // A
                }
            }
        }
        
        // 결과 그리기
        this.ctx.putImageData(dstData, 0, 0);
    }
    
    /**
     * 대용량 이미지를 청크 단위로 픽셀 샘플링
     */
    drawPixelSampledChunked() {
        const srcWidth = this.currentImage.width;
        const srcHeight = this.currentImage.height;
        const dstWidth = Math.floor(srcWidth * this.scale);
        const dstHeight = Math.floor(srcHeight * this.scale);
        
        // 청크 크기 (메모리 효율성을 위해)
        const chunkSize = 500;
        const scaleRatio = 1 / this.scale;
        
        // 전체 결과 캔버스
        this.ctx.clearRect(0, 0, dstWidth, dstHeight);
        
        // 청크 단위로 처리
        for (let chunkY = 0; chunkY < dstHeight; chunkY += chunkSize) {
            for (let chunkX = 0; chunkX < dstWidth; chunkX += chunkSize) {
                const chunkW = Math.min(chunkSize, dstWidth - chunkX);
                const chunkH = Math.min(chunkSize, dstHeight - chunkY);
                
                // 원본 영역 계산
                const srcX = Math.floor(chunkX * scaleRatio);
                const srcY = Math.floor(chunkY * scaleRatio);
                const srcW = Math.ceil(chunkW * scaleRatio);
                const srcH = Math.ceil(chunkH * scaleRatio);
                
                // 임시 캔버스에 원본 청크 그리기
                const tempCanvas = document.createElement('canvas');
                tempCanvas.width = srcW;
                tempCanvas.height = srcH;
                const tempCtx = tempCanvas.getContext('2d');
                tempCtx.drawImage(this.currentImage, srcX, srcY, srcW, srcH, 0, 0, srcW, srcH);
                
                // 청크 픽셀 샘플링
                const srcData = tempCtx.getImageData(0, 0, srcW, srcH);
                const srcPixels = srcData.data;
                const dstData = this.ctx.createImageData(chunkW, chunkH);
                const dstPixels = dstData.data;
                
                for (let y = 0; y < chunkH; y++) {
                    for (let x = 0; x < chunkW; x++) {
                        const localSrcX = Math.floor(x * scaleRatio);
                        const localSrcY = Math.floor(y * scaleRatio);
                        
                        if (localSrcX < srcW && localSrcY < srcH) {
                            const srcIdx = (localSrcY * srcW + localSrcX) * 4;
                            const dstIdx = (y * chunkW + x) * 4;
                            
                            dstPixels[dstIdx] = srcPixels[srcIdx];
                            dstPixels[dstIdx + 1] = srcPixels[srcIdx + 1];
                            dstPixels[dstIdx + 2] = srcPixels[srcIdx + 2];
                            dstPixels[dstIdx + 3] = srcPixels[srcIdx + 3];
                        }
                    }
                }
                
                // 청크 결과 그리기
                this.ctx.putImageData(dstData, chunkX, chunkY);
            }
        }
    }
    
    /**
     * 줌 인
     */
    zoomIn(factor = 1.2) {
        this.setScale(this.scale * factor);
    }
    
    /**
     * 줌 아웃
     */
    zoomOut(factor = 0.8) {
        this.setScale(this.scale * factor);
    }
    
    /**
     * 스케일 설정
     */
    setScale(newScale) {
        this.scale = Math.max(this.options.minScale, Math.min(this.options.maxScale, newScale));
        this.render();
        return this.scale;
    }
    
    /**
     * 화면에 맞춤
     */
    fitToContainer(containerWidth, containerHeight, margin = 0.9) {
        if (!this.currentImage) return;
        
        const scaleX = containerWidth / this.currentImage.width;
        const scaleY = containerHeight / this.currentImage.height;
        
        this.scale = Math.min(scaleX, scaleY) * margin;
        this.render();
        return this.scale;
    }
    
    /**
     * 100% 크기로 리셋
     */
    resetScale() {
        this.scale = 1.0;
        this.render();
        return this.scale;
    }
    
    /**
     * 특정 퍼센트로 설정 (예: 0.19 = 19%)
     */
    setScalePercent(percent) {
        this.scale = percent;
        this.render();
        return this.scale;
    }
    
    /**
     * 현재 상태 정보 반환
     */
    getInfo() {
        if (!this.currentImage) {
            return {
                originalWidth: 0,
                originalHeight: 0,
                displayWidth: 0,
                displayHeight: 0,
                scale: this.scale,
                scalePercent: Math.round(this.scale * 100),
                pixelRatio: 0
            };
        }
        
        const displayWidth = Math.floor(this.currentImage.width * this.scale);
        const displayHeight = Math.floor(this.currentImage.height * this.scale);
        
        return {
            originalWidth: this.currentImage.width,
            originalHeight: this.currentImage.height,
            displayWidth: displayWidth,
            displayHeight: displayHeight,
            scale: this.scale,
            scalePercent: Math.round(this.scale * 100),
            pixelRatio: 1 / this.scale
        };
    }
}

// 내보내기 (CommonJS 스타일 - main.js와 호환)
if (typeof module !== 'undefined' && module.exports) {
    module.exports = PixelPerfectRenderer;
}

// 전역 변수로도 사용 가능
if (typeof window !== 'undefined') {
    window.PixelPerfectRenderer = PixelPerfectRenderer;
}
