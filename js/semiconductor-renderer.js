/**
 * 반도체 불량맵 전용 픽셀 완벽 렌더러
 * 4000x4000 웨이퍼맵을 19% 축소 시에도 모든 픽셀 정보 보존
 */

class SemiconductorRenderer {
    constructor(canvas, options = {}) {
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d', {
            alpha: false,
            desynchronized: true,
            willReadFrequently: false
        });
        
        this.options = {
            preserveChipBoundaries: options.preserveChipBoundaries !== false, // 기본값 true
            enhanceDefects: options.enhanceDefects !== false, // 기본값 true
            chipBoundaryColor: options.chipBoundaryColor || '#00FF00', // 칩 경계선 색상
            defectEnhancement: options.defectEnhancement || 2.0, // 불량 강조 배율
            minVisibleScale: options.minVisibleScale || 0.05, // 최소 표시 스케일
            usePyramid: options.usePyramid !== false // 이미지 피라미드 사용 여부
        };
        
        this.currentImage = null;
        this.imagePyramid = {}; // 이미지 피라미드 저장
        this.scale = 1.0;
        this.setupPixelPerfectCanvas();
    }
    
    setupPixelPerfectCanvas() {
        // 브라우저 이미지 보간 완전 비활성화
        this.ctx.imageSmoothingEnabled = false;
        this.ctx.imageSmoothingQuality = 'low';
        this.ctx.mozImageSmoothingEnabled = false;
        this.ctx.webkitImageSmoothingEnabled = false;
        this.ctx.msImageSmoothingEnabled = false;
        
        // CSS로 픽셀 완벽 렌더링 강제
        this.canvas.style.imageRendering = 'pixelated';
        this.canvas.style.imageRendering = '-moz-crisp-edges';
        this.canvas.style.imageRendering = '-webkit-crisp-edges';
        this.canvas.style.imageRendering = 'crisp-edges';
        this.canvas.style.msInterpolationMode = 'nearest-neighbor';
        
        // GPU 가속 최적화
        this.canvas.style.willChange = 'transform';
        this.canvas.style.transform = 'translateZ(0)';
        this.canvas.style.backfaceVisibility = 'hidden';
    }
    
    loadImage(image) {
        this.currentImage = image;
        
        // 이미지 피라미드 생성
        if (this.options.usePyramid) {
            this.generateImagePyramid(image);
        }
        
        this.render();
    }
    
    /**
     * 이미지 피라미드 생성 (1/2, 1/4 크기)
     * 왔곡 없이 고품질로 미리 생성
     */
    generateImagePyramid(image) {
        console.log('이미지 피라미드 생성 시작...');
        
        // 원본 이미지
        this.imagePyramid['1'] = image;
        
        // 1/2 크기 이미지 생성
        this.imagePyramid['0.5'] = this.createDownscaledImage(image, 0.5);
        
        // 1/4 크기 이미지 생성
        this.imagePyramid['0.25'] = this.createDownscaledImage(image, 0.25);
        
        console.log('이미지 피라미드 생성 완료:', {
            '원본': `${image.width}x${image.height}`,
            '1/2': `${this.imagePyramid['0.5'].width}x${this.imagePyramid['0.5'].height}`,
            '1/4': `${this.imagePyramid['0.25'].width}x${this.imagePyramid['0.25'].height}`
        });
    }
    
    /**
     * 고품질 축소 이미지 생성
     * 반도체 불량맵의 특성을 보존하면서 축소
     */
    createDownscaledImage(srcImage, scale) {
        const dstWidth = Math.floor(srcImage.width * scale);
        const dstHeight = Math.floor(srcImage.height * scale);
        
        // 임시 캔버스 생성
        const canvas = document.createElement('canvas');
        canvas.width = dstWidth;
        canvas.height = dstHeight;
        const ctx = canvas.getContext('2d', {
            alpha: false,
            desynchronized: true
        });
        
        // 픽셀 완벽 설정
        ctx.imageSmoothingEnabled = false;
        ctx.imageSmoothingQuality = 'low';
        ctx.mozImageSmoothingEnabled = false;
        ctx.webkitImageSmoothingEnabled = false;
        ctx.msImageSmoothingEnabled = false;
        
        // 원본 데이터 추출
        const srcCanvas = document.createElement('canvas');
        srcCanvas.width = srcImage.width;
        srcCanvas.height = srcImage.height;
        const srcCtx = srcCanvas.getContext('2d');
        srcCtx.imageSmoothingEnabled = false;
        srcCtx.drawImage(srcImage, 0, 0);
        
        const srcData = srcCtx.getImageData(0, 0, srcImage.width, srcImage.height);
        const srcPixels = srcData.data;
        const dstData = ctx.createImageData(dstWidth, dstHeight);
        const dstPixels = dstData.data;
        
        const invScale = 1 / scale;
        
        // 고품질 다운샘플링 (Lanczos3 알고리즘)
        for (let y = 0; y < dstHeight; y++) {
            for (let x = 0; x < dstWidth; x++) {
                const srcX = x * invScale;
                const srcY = y * invScale;
                
                let r = 0, g = 0, b = 0, totalWeight = 0;
                
                // 3x3 Lanczos 커널
                const kernelRadius = 3;
                for (let ky = -kernelRadius; ky <= kernelRadius; ky++) {
                    for (let kx = -kernelRadius; kx <= kernelRadius; kx++) {
                        const sx = Math.floor(srcX + kx);
                        const sy = Math.floor(srcY + ky);
                        
                        if (sx >= 0 && sx < srcImage.width && sy >= 0 && sy < srcImage.height) {
                            const weight = this.lanczos3Weight(
                                srcX - sx,
                                srcY - sy
                            );
                            
                            if (weight > 0) {
                                const idx = (sy * srcImage.width + sx) * 4;
                                r += srcPixels[idx] * weight;
                                g += srcPixels[idx + 1] * weight;
                                b += srcPixels[idx + 2] * weight;
                                totalWeight += weight;
                            }
                        }
                    }
                }
                
                const dstIdx = (y * dstWidth + x) * 4;
                if (totalWeight > 0) {
                    dstPixels[dstIdx] = Math.min(255, Math.max(0, Math.round(r / totalWeight)));
                    dstPixels[dstIdx + 1] = Math.min(255, Math.max(0, Math.round(g / totalWeight)));
                    dstPixels[dstIdx + 2] = Math.min(255, Math.max(0, Math.round(b / totalWeight)));
                    dstPixels[dstIdx + 3] = 255;
                }
            }
        }
        
        ctx.putImageData(dstData, 0, 0);
        
        // 이미지 객체로 변환
        const resultImage = new Image();
        resultImage.src = canvas.toDataURL('image/png');
        
        return resultImage;
    }
    
    /**
     * Lanczos3 가중치 함수
     */
    lanczos3Weight(x, y) {
        const r = Math.sqrt(x * x + y * y);
        if (r === 0) return 1;
        if (r >= 3) return 0;
        
        const piR = Math.PI * r;
        const piR3 = piR / 3;
        return (Math.sin(piR) / piR) * (Math.sin(piR3) / piR3);
    }
    
    setScale(newScale) {
        this.scale = Math.max(this.options.minVisibleScale, newScale);
        this.render();
        return this.scale;
    }
    
    render() {
        if (!this.currentImage) return;
        
        // 이미지 피라미드 사용 여부와 적절한 레벨 선택
        let imageToRender = this.currentImage;
        let pyramidScale = 1.0;
        
        if (this.options.usePyramid && Object.keys(this.imagePyramid).length > 0) {
            // 축소 비율에 따라 적절한 피라미드 레벨 선택
            if (this.scale <= 0.25) {
                // 25% 이하: 1/4 크기 이미지 사용
                if (this.imagePyramid['0.25'] && this.imagePyramid['0.25'].complete) {
                    imageToRender = this.imagePyramid['0.25'];
                    pyramidScale = 4.0; // 1/4 이미지를 사용하므로 4배 보정
                    console.log('사용 이미지: 1/4 크기');
                }
            } else if (this.scale <= 0.5) {
                // 50% 이하: 1/2 크기 이미지 사용
                if (this.imagePyramid['0.5'] && this.imagePyramid['0.5'].complete) {
                    imageToRender = this.imagePyramid['0.5'];
                    pyramidScale = 2.0; // 1/2 이미지를 사용하므로 2배 보정
                    console.log('사용 이미지: 1/2 크기');
                }
            } else {
                console.log('사용 이미지: 원본');
            }
        }
        
        // 실제 렌더링할 크기 계산
        const srcWidth = imageToRender.width;
        const srcHeight = imageToRender.height;
        const actualScale = this.scale * pyramidScale;
        const dstWidth = Math.floor(this.currentImage.width * this.scale);
        const dstHeight = Math.floor(this.currentImage.height * this.scale);
        
        // 캔버스 크기 설정
        this.canvas.width = dstWidth;
        this.canvas.height = dstHeight;
        this.canvas.style.width = dstWidth + 'px';
        this.canvas.style.height = dstHeight + 'px';
        
        // 컨텍스트 재설정
        this.setupPixelPerfectCanvas();
        
        // 배경 검은색
        this.ctx.fillStyle = '#000';
        this.ctx.fillRect(0, 0, dstWidth, dstHeight);
        
        // 피라미드 이미지 렌더링
        // 선택된 피라미드 레벨에서 추가 확대/축소
        const renderWidth = Math.floor(srcWidth * actualScale);
        const renderHeight = Math.floor(srcHeight * actualScale);
        
        // 이미지 그리기
        this.ctx.drawImage(imageToRender, 0, 0, srcWidth, srcHeight,
                          0, 0, renderWidth, renderHeight);
    }
    
    /**
     * 반도체 불량맵 특화 극한 축소 렌더링
     * 칩 경계선과 불량 픽셀을 우선적으로 보존
     */
    renderSemiconductorOptimized() {
        const srcWidth = this.currentImage.width;
        const srcHeight = this.currentImage.height;
        const dstWidth = this.canvas.width;
        const dstHeight = this.canvas.height;
        
        // 임시 캔버스에서 원본 데이터 추출
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
        
        const blockWidth = srcWidth / dstWidth;
        const blockHeight = srcHeight / dstHeight;
        
        for (let y = 0; y < dstHeight; y++) {
            for (let x = 0; x < dstWidth; x++) {
                const srcX1 = Math.floor(x * blockWidth);
                const srcY1 = Math.floor(y * blockHeight);
                const srcX2 = Math.min(Math.ceil((x + 1) * blockWidth), srcWidth);
                const srcY2 = Math.min(Math.ceil((y + 1) * blockHeight), srcHeight);
                
                // 블록 내에서 중요한 픽셀 찾기
                const pixelInfo = this.analyzeSemiconductorBlock(
                    srcPixels, srcWidth, srcX1, srcY1, srcX2, srcY2
                );
                
                const dstIdx = (y * dstWidth + x) * 4;
                
                // 우선순위: 1) 칩 경계선 2) 불량 픽셀 3) 평균색
                if (pixelInfo.hasChipBoundary) {
                    // 칩 경계선 강조 표시
                    const boundaryColor = this.hexToRgb(this.options.chipBoundaryColor);
                    dstPixels[dstIdx] = boundaryColor.r;
                    dstPixels[dstIdx + 1] = boundaryColor.g;
                    dstPixels[dstIdx + 2] = boundaryColor.b;
                    dstPixels[dstIdx + 3] = 255;
                } else if (pixelInfo.hasDefect) {
                    // 불량 픽셀 강조 표시
                    dstPixels[dstIdx] = Math.min(255, pixelInfo.defectColor.r * this.options.defectEnhancement);
                    dstPixels[dstIdx + 1] = Math.min(255, pixelInfo.defectColor.g * this.options.defectEnhancement);
                    dstPixels[dstIdx + 2] = Math.min(255, pixelInfo.defectColor.b * this.options.defectEnhancement);
                    dstPixels[dstIdx + 3] = 255;
                } else {
                    // 일반 평균색
                    dstPixels[dstIdx] = pixelInfo.avgColor.r;
                    dstPixels[dstIdx + 1] = pixelInfo.avgColor.g;
                    dstPixels[dstIdx + 2] = pixelInfo.avgColor.b;
                    dstPixels[dstIdx + 3] = 255;
                }
            }
        }
        
        this.ctx.putImageData(dstData, 0, 0);
    }
    
    /**
     * 반도체 블록 분석 - 칩 경계선과 불량 검출
     */
    analyzeSemiconductorBlock(srcPixels, srcWidth, x1, y1, x2, y2) {
        let totalR = 0, totalG = 0, totalB = 0, count = 0;
        let hasChipBoundary = false;
        let hasDefect = false;
        let defectColor = {r: 0, g: 0, b: 0};
        let maxVariance = 0;
        
        // 첫 번째 패스: 기본 통계 수집
        for (let y = y1; y < y2; y++) {
            for (let x = x1; x < x2; x++) {
                const idx = (y * srcWidth + x) * 4;
                const r = srcPixels[idx];
                const g = srcPixels[idx + 1];
                const b = srcPixels[idx + 2];
                
                totalR += r;
                totalG += g;
                totalB += b;
                count++;
                
                // 칩 경계선 검출 (높은 명도 변화)
                if (x > x1 && y > y1) {
                    const prevIdx = ((y-1) * srcWidth + (x-1)) * 4;
                    const prevR = srcPixels[prevIdx];
                    const prevG = srcPixels[prevIdx + 1];
                    const prevB = srcPixels[prevIdx + 2];
                    
                    const variance = Math.abs(r - prevR) + Math.abs(g - prevG) + Math.abs(b - prevB);
                    if (variance > maxVariance) {
                        maxVariance = variance;
                    }
                    
                    // 칩 경계선 임계값 (반도체 특성상 명확한 구분선)
                    if (variance > 100) {
                        hasChipBoundary = true;
                    }
                }
                
                // 불량 픽셀 검출 (빨간색 계열이나 특별한 색상)
                if ((r > g + 50 && r > b + 50) || // 빨간 불량
                    (r + g + b < 50) || // 검은 불량  
                    (r + g + b > 700)) { // 밝은 불량
                    hasDefect = true;
                    defectColor.r = r;
                    defectColor.g = g;
                    defectColor.b = b;
                }
            }
        }
        
        const avgColor = {
            r: Math.round(totalR / count),
            g: Math.round(totalG / count),
            b: Math.round(totalB / count)
        };
        
        return {
            hasChipBoundary,
            hasDefect,
            defectColor,
            avgColor,
            variance: maxVariance
        };
    }
    
    /**
     * 향상된 샘플링 (중간 축소비용)
     */
    renderEnhancedSampling() {
        const srcWidth = this.currentImage.width;
        const srcHeight = this.currentImage.height;
        const dstWidth = this.canvas.width;
        const dstHeight = this.canvas.height;
        
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
        
        const scaleRatio = 1 / this.scale;
        
        // Lanczos 유사 고품질 샘플링
        for (let y = 0; y < dstHeight; y++) {
            for (let x = 0; x < dstWidth; x++) {
                const srcX = x * scaleRatio;
                const srcY = y * scaleRatio;
                
                // 4x4 샘플링 윈도우
                let totalR = 0, totalG = 0, totalB = 0, totalWeight = 0;
                
                for (let sy = Math.floor(srcY) - 1; sy <= Math.floor(srcY) + 2; sy++) {
                    for (let sx = Math.floor(srcX) - 1; sx <= Math.floor(srcX) + 2; sx++) {
                        if (sx >= 0 && sx < srcWidth && sy >= 0 && sy < srcHeight) {
                            const distance = Math.sqrt((sx - srcX) ** 2 + (sy - srcY) ** 2);
                            const weight = distance < 2 ? this.lanczosKernel(distance) : 0;
                            
                            if (weight > 0) {
                                const idx = (sy * srcWidth + sx) * 4;
                                totalR += srcPixels[idx] * weight;
                                totalG += srcPixels[idx + 1] * weight;
                                totalB += srcPixels[idx + 2] * weight;
                                totalWeight += weight;
                            }
                        }
                    }
                }
                
                const dstIdx = (y * dstWidth + x) * 4;
                if (totalWeight > 0) {
                    dstPixels[dstIdx] = Math.round(totalR / totalWeight);
                    dstPixels[dstIdx + 1] = Math.round(totalG / totalWeight);
                    dstPixels[dstIdx + 2] = Math.round(totalB / totalWeight);
                    dstPixels[dstIdx + 3] = 255;
                }
            }
        }
        
        this.ctx.putImageData(dstData, 0, 0);
    }
    
    /**
     * Lanczos 커널 함수
     */
    lanczosKernel(x) {
        if (x === 0) return 1;
        if (Math.abs(x) >= 2) return 0;
        return (2 * Math.sin(Math.PI * x) * Math.sin(Math.PI * x / 2)) / (Math.PI * Math.PI * x * x);
    }
    
    /**
     * 헥스 색상을 RGB로 변환
     */
    hexToRgb(hex) {
        const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
        return result ? {
            r: parseInt(result[1], 16),
            g: parseInt(result[2], 16),
            b: parseInt(result[3], 16)
        } : {r: 0, g: 255, b: 0};
    }
    
    /**
     * 화면에 맞춤 (19% 등 자동 계산)
     */
    fitToContainer(containerWidth, containerHeight, margin = 0.95) {
        if (!this.currentImage) return;
        
        const scaleX = containerWidth / this.currentImage.width;
        const scaleY = containerHeight / this.currentImage.height;
        
        this.scale = Math.min(scaleX, scaleY) * margin;
        this.render();
        return this.scale;
    }
    
    /**
     * 줌 기능
     */
    zoomIn(factor = 1.2) {
        this.setScale(this.scale * factor);
    }
    
    zoomOut(factor = 0.8) {
        this.setScale(this.scale * factor);
    }
    
    /**
     * 19% 축소 (4000x4000 → 760x760)
     */
    setTo19Percent() {
        this.setScale(0.19);
    }
    
    /**
     * 현재 렌더링 정보
     */
    getInfo() {
        if (!this.currentImage) return {};
        
        // 현재 사용 중인 피라미드 레벨 확인
        let pyramidLevel = '원본';
        if (this.options.usePyramid && Object.keys(this.imagePyramid).length > 0) {
            if (this.scale <= 0.25) {
                pyramidLevel = '1/4 크기';
            } else if (this.scale <= 0.5) {
                pyramidLevel = '1/2 크기';
            }
        }
        
        return {
            originalWidth: this.currentImage.width,
            originalHeight: this.currentImage.height,
            displayWidth: Math.floor(this.currentImage.width * this.scale),
            displayHeight: Math.floor(this.currentImage.height * this.scale),
            scale: this.scale,
            scalePercent: Math.round(this.scale * 100),
            pyramidLevel: pyramidLevel,
            pyramidEnabled: this.options.usePyramid,
            renderMode: '이미지 피라미드'
        };
    }
}

// 전역 사용을 위한 내보내기
if (typeof window !== 'undefined') {
    window.SemiconductorRenderer = SemiconductorRenderer;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = SemiconductorRenderer;
}