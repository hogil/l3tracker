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
     * 개선된 Nearest Neighbor + Area Averaging 알고리즘 사용
     */
    drawPixelSampled() {
        const srcWidth = this.currentImage.width;
        const srcHeight = this.currentImage.height;
        const dstWidth = Math.floor(srcWidth * this.scale);
        const dstHeight = Math.floor(srcHeight * this.scale);
        
        // 매우 작은 축소비(10% 이하)인 경우 특별 처리
        if (this.scale <= 0.1) {
            this.drawPixelSampledHighCompression();
            return;
        }
        
        // 대용량 이미지의 경우 청크 단위로 처리
        if (srcWidth * srcHeight > 4000000) { // 2000x2000 이상
            this.drawPixelSampledChunked();
            return;
        }
        
        // 임시 캔버스에 원본 이미지 그리기
        const tempCanvas = document.createElement('canvas');
        tempCanvas.width = srcWidth;
        tempCanvas.height = srcHeight;
        const tempCtx = tempCanvas.getContext('2d');
        tempCtx.imageSmoothingEnabled = false;
        tempCtx.drawImage(this.currentImage, 0, 0);
        
        // 원본 이미지 데이터 가져오기
        const srcData = tempCtx.getImageData(0, 0, srcWidth, srcHeight);
        const srcPixels = srcData.data;
        
        // 대상 이미지 데이터 생성
        const dstData = this.ctx.createImageData(dstWidth, dstHeight);
        const dstPixels = dstData.data;
        
        // 스케일 비율
        const scaleRatio = 1 / this.scale;
        
        // 10% ~ 50% 축소 시: Area Averaging으로 더 선명한 결과
        if (this.scale >= 0.1 && this.scale < 0.5) {
            this.drawAreaAveraged(srcPixels, srcWidth, srcHeight, dstPixels, dstWidth, dstHeight, scaleRatio);
        } else {
            // 기존 Nearest Neighbor (50% 이상)
            for (let y = 0; y < dstHeight; y++) {
                for (let x = 0; x < dstWidth; x++) {
                    // 원본 좌표 계산 (가장 가까운 픽셀)
                    const srcX = Math.floor(x * scaleRatio + 0.5);
                    const srcY = Math.floor(y * scaleRatio + 0.5);
                    
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
        }
        
        // 결과 그리기
        this.ctx.putImageData(dstData, 0, 0);
    }
    
    /**
     * 극한 축소비(10% 이하)에서의 특별 처리
     */
    drawPixelSampledHighCompression() {
        const srcWidth = this.currentImage.width;
        const srcHeight = this.currentImage.height;
        const dstWidth = Math.max(1, Math.floor(srcWidth * this.scale));
        const dstHeight = Math.max(1, Math.floor(srcHeight * this.scale));
        
        // 임시 캔버스 생성
        const tempCanvas = document.createElement('canvas');
        tempCanvas.width = srcWidth;
        tempCanvas.height = srcHeight;
        const tempCtx = tempCanvas.getContext('2d');
        tempCtx.imageSmoothingEnabled = false;
        tempCtx.drawImage(this.currentImage, 0, 0);
        
        const srcData = tempCtx.getImageData(0, 0, srcWidth, srcHeight);
        const srcPixels = srcData.data;
        const dstData = this.ctx.createImageData(dstWidth, dstHeight);
        const dstPixels = dstData.data;
        
        // 큰 영역을 대표하는 픽셀을 선택하는 대신 중요한 픽셀들의 평균을 계산
        const blockWidth = Math.ceil(srcWidth / dstWidth);
        const blockHeight = Math.ceil(srcHeight / dstHeight);
        
        for (let y = 0; y < dstHeight; y++) {
            for (let x = 0; x < dstWidth; x++) {
                let totalR = 0, totalG = 0, totalB = 0, totalA = 0;
                let count = 0;
                
                // 블록 내의 모든 픽셀을 평균화
                const startX = x * blockWidth;
                const startY = y * blockHeight;
                const endX = Math.min(startX + blockWidth, srcWidth);
                const endY = Math.min(startY + blockHeight, srcHeight);
                
                for (let sy = startY; sy < endY; sy++) {
                    for (let sx = startX; sx < endX; sx++) {
                        const srcIdx = (sy * srcWidth + sx) * 4;
                        totalR += srcPixels[srcIdx];
                        totalG += srcPixels[srcIdx + 1];
                        totalB += srcPixels[srcIdx + 2];
                        totalA += srcPixels[srcIdx + 3];
                        count++;
                    }
                }
                
                if (count > 0) {
                    const dstIdx = (y * dstWidth + x) * 4;
                    dstPixels[dstIdx] = Math.round(totalR / count);
                    dstPixels[dstIdx + 1] = Math.round(totalG / count);
                    dstPixels[dstIdx + 2] = Math.round(totalB / count);
                    dstPixels[dstIdx + 3] = Math.round(totalA / count);
                }
            }
        }
        
        this.ctx.putImageData(dstData, 0, 0);
    }
    
    /**
     * Area Averaging 알고리즘으로 중간 축소비에서 더 선명한 결과
     */
    drawAreaAveraged(srcPixels, srcWidth, srcHeight, dstPixels, dstWidth, dstHeight, scaleRatio) {
        for (let y = 0; y < dstHeight; y++) {
            for (let x = 0; x < dstWidth; x++) {
                // 소스 영역 계산
                const srcX1 = x * scaleRatio;
                const srcY1 = y * scaleRatio;
                const srcX2 = (x + 1) * scaleRatio;
                const srcY2 = (y + 1) * scaleRatio;
                
                // 정수 경계 계산
                const x1 = Math.floor(srcX1);
                const y1 = Math.floor(srcY1);
                const x2 = Math.min(Math.ceil(srcX2), srcWidth);
                const y2 = Math.min(Math.ceil(srcY2), srcHeight);
                
                let totalR = 0, totalG = 0, totalB = 0, totalA = 0;
                let totalWeight = 0;
                
                // 영역 내 픽셀들의 가중 평균 계산
                for (let sy = y1; sy < y2; sy++) {
                    for (let sx = x1; sx < x2; sx++) {
                        if (sx >= 0 && sx < srcWidth && sy >= 0 && sy < srcHeight) {
                            // 가중치 계산 (픽셀이 얼마나 포함되는지)
                            const weightX = Math.min(sx + 1, srcX2) - Math.max(sx, srcX1);
                            const weightY = Math.min(sy + 1, srcY2) - Math.max(sy, srcY1);
                            const weight = weightX * weightY;
                            
                            const srcIdx = (sy * srcWidth + sx) * 4;
                            totalR += srcPixels[srcIdx] * weight;
                            totalG += srcPixels[srcIdx + 1] * weight;
                            totalB += srcPixels[srcIdx + 2] * weight;
                            totalA += srcPixels[srcIdx + 3] * weight;
                            totalWeight += weight;
                        }
                    }
                }
                
                if (totalWeight > 0) {
                    const dstIdx = (y * dstWidth + x) * 4;
                    dstPixels[dstIdx] = Math.round(totalR / totalWeight);
                    dstPixels[dstIdx + 1] = Math.round(totalG / totalWeight);
                    dstPixels[dstIdx + 2] = Math.round(totalB / totalWeight);
                    dstPixels[dstIdx + 3] = Math.round(totalA / totalWeight);
                }
            }
        }
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
