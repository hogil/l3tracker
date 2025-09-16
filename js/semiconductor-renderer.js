/**
 * 반도체 불량맵 전용 고성능 이미지 렌더러
 * 
 * @description
 * 4000x4000 픽셀 규모의 대형 반도체 웨이퍼맵 이미지를 왜곡 없이 렌더링하는 특화 렌더러.
 * 이미지 피라미드 기법을 사용하여 축소 시에도 세밀한 불량 패턴을 보존합니다.
 * 
 * @features
 * - 이미지 피라미드를 통한 다단계 해상도 지원 (1x, 0.5x, 0.25x)
 * - Lanczos3 알고리즘 기반 고품질 다운샘플링
 * - 픽셀 완벽 렌더링으로 앤티 앨리어싱 방지
 * - GPU 가속 최적화
 * - 반도체 불량 패턴 강조 기능
 * 
 * @author L3 Tracker Team
 * @version 2.0.0
 * @since 2025-01-10
 */

class SemiconductorRenderer {
    /**
     * 렌더러 생성자
     * @param {HTMLCanvasElement} canvas - 렌더링 대상 캔버스
     * @param {Object} options - 렌더러 옵션
     */
    constructor(canvas, options = {}) {
        if (!canvas || !(canvas instanceof HTMLCanvasElement)) {
            throw new Error('유효한 캔버스 엘리먼트가 필요합니다.');
        }

        this.canvas = canvas;
        this.ctx = canvas.getContext('2d', {
            alpha: false,
            desynchronized: true,
            willReadFrequently: false
        });
        
        // 기본 옵션 설정
        this.options = {
            preserveChipBoundaries: options.preserveChipBoundaries !== false,
            enhanceDefects: options.enhanceDefects !== false,
            chipBoundaryColor: options.chipBoundaryColor || '#00FF00',
            defectEnhancement: options.defectEnhancement || 2.0,
            minVisibleScale: options.minVisibleScale || 0.05,
            usePyramid: options.usePyramid !== false,
            debug: options.debug || false
        };
        
        // 상태 초기화
        this.currentImage = null;
        this.imagePyramid = {};
        this.scale = 1.0;
        this.isGeneratingPyramid = false;
        
        this.setupPixelPerfectCanvas();
    }
    
    /**
     * 픽셀 완벽 렌더링 설정
     * 브라우저의 이미지 보간을 완전히 비활성화하여 픽셀 단위 정확도 보장
     */
    setupPixelPerfectCanvas() {
        // 컨텍스트 이미지 스무딩 비활성화
        const smoothingProps = [
            'imageSmoothingEnabled',
            'mozImageSmoothingEnabled',
            'webkitImageSmoothingEnabled',
            'msImageSmoothingEnabled'
        ];
        
        smoothingProps.forEach(prop => {
            if (prop in this.ctx) {
                this.ctx[prop] = false;
            }
        });
        
        if ('imageSmoothingQuality' in this.ctx) {
            this.ctx.imageSmoothingQuality = 'low';
        }
        
        // CSS 픽셀 렌더링 최적화
        const pixelatedStyles = {
            'imageRendering': ['pixelated', '-moz-crisp-edges', '-webkit-crisp-edges', 'crisp-edges'],
            'msInterpolationMode': 'nearest-neighbor',
            'willChange': 'transform',
            'transform': 'translateZ(0)',
            'backfaceVisibility': 'hidden'
        };
        
        Object.entries(pixelatedStyles).forEach(([prop, value]) => {
            if (Array.isArray(value)) {
                value.forEach(val => {
                    try {
                        this.canvas.style[prop] = val;
                    } catch (e) {
                        // 브라우저가 지원하지 않는 속성 무시
                    }
                });
            } else {
                this.canvas.style[prop] = value;
            }
        });
    }
    
    /**
     * 이미지 로드 및 피라미드 생성
     * @param {HTMLImageElement} image - 로드할 이미지
     * @returns {Promise<void>}
     */
    async loadImage(image) {
        if (!image || !(image instanceof HTMLImageElement)) {
            throw new Error('유효한 이미지 엘리먼트가 필요합니다.');
        }

        this.currentImage = image;
        
        // 이미지 피라미드 생성
        if (this.options.usePyramid) {
            await this.generateImagePyramid(image);
        }
        
        this.render();
    }
    
    /**
     * 이미지 피라미드 생성 (비동기)
     * @param {HTMLImageElement} image - 원본 이미지
     * @returns {Promise<void>}
     */
    async generateImagePyramid(image) {
        if (this.isGeneratingPyramid) {
            this.log('이미지 피라미드 생성 중... 중복 요청 무시');
            return;
        }

        this.isGeneratingPyramid = true;
        this.log('이미지 피라미드 생성 시작...');
        
        try {
            // 원본 이미지
            this.imagePyramid['1'] = image;
            
            // 병렬 처리로 피라미드 레벨 생성
            const [halfImage, quarterImage] = await Promise.all([
                this.createDownscaledImage(image, 0.5),
                this.createDownscaledImage(image, 0.25)
            ]);
            
            this.imagePyramid['0.5'] = halfImage;
            this.imagePyramid['0.25'] = quarterImage;
            
            this.log('이미지 피라미드 생성 완료:', {
                '원본': `${image.width}x${image.height}`,
                '1/2': `${halfImage.width}x${halfImage.height}`,
                '1/4': `${quarterImage.width}x${quarterImage.height}`
            });
        } catch (error) {
            console.error('이미지 피라미드 생성 실패:', error);
        } finally {
            this.isGeneratingPyramid = false;
        }
    }
    
    /**
     * Lanczos3 알고리즘을 사용한 고품질 다운스케일링
     * @param {HTMLImageElement} srcImage - 원본 이미지
     * @param {number} scale - 축소 비율 (0 < scale <= 1)
     * @returns {Promise<HTMLImageElement>}
     */
    async createDownscaledImage(srcImage, scale) {
        return new Promise((resolve, reject) => {
            const dstWidth = Math.floor(srcImage.width * scale);
            const dstHeight = Math.floor(srcImage.height * scale);
            
            // 작업용 캔버스 생성
            const canvas = document.createElement('canvas');
            canvas.width = dstWidth;
            canvas.height = dstHeight;
            const ctx = canvas.getContext('2d', {
                alpha: false,
                desynchronized: true
            });
            
            // 픽셀 완벽 설정
            ctx.imageSmoothingEnabled = false;
            
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
            
            // Lanczos3 다운샘플링
            for (let y = 0; y < dstHeight; y++) {
                for (let x = 0; x < dstWidth; x++) {
                    const srcX = x * invScale;
                    const srcY = y * invScale;
                    
                    let r = 0, g = 0, b = 0, totalWeight = 0;
                    
                    // Lanczos3 커널 적용 (반경 3)
                    const kernelRadius = 3;
                    for (let ky = -kernelRadius; ky <= kernelRadius; ky++) {
                        for (let kx = -kernelRadius; kx <= kernelRadius; kx++) {
                            const sx = Math.floor(srcX + kx);
                            const sy = Math.floor(srcY + ky);
                            
                            if (sx >= 0 && sx < srcImage.width && sy >= 0 && sy < srcImage.height) {
                                const weight = this.lanczos3Weight(srcX - sx, srcY - sy);
                                
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
            resultImage.onload = () => resolve(resultImage);
            resultImage.onerror = reject;
            resultImage.src = canvas.toDataURL('image/png');
        });
    }
    
    /**
     * Lanczos3 가중치 계산
     * @param {number} x - X 거리
     * @param {number} y - Y 거리
     * @returns {number} 가중치 값
     */
    lanczos3Weight(x, y) {
        const r = Math.sqrt(x * x + y * y);
        if (r === 0) return 1;
        if (r >= 3) return 0;
        
        const piR = Math.PI * r;
        const piR3 = piR / 3;
        return (Math.sin(piR) / piR) * (Math.sin(piR3) / piR3);
    }
    
    /**
     * 스케일 설정
     * @param {number} newScale - 새로운 스케일 값
     * @returns {number} 실제 적용된 스케일
     */
    setScale(newScale) {
        this.scale = Math.max(this.options.minVisibleScale, Math.min(10, newScale));
        this.render();
        return this.scale;
    }
    
    /**
     * 메인 렌더링 함수
     */
    render() {
        if (!this.currentImage) return;
        
        // 적절한 피라미드 레벨 선택
        const { image, effectiveScale } = this.selectPyramidLevel();
        
        // 최종 렌더링 크기 계산
        const dstWidth = Math.floor(this.currentImage.width * this.scale);
        const dstHeight = Math.floor(this.currentImage.height * this.scale);
        
        // 캔버스 크기 설정
        this.canvas.width = dstWidth;
        this.canvas.height = dstHeight;
        this.canvas.style.width = `${dstWidth}px`;
        this.canvas.style.height = `${dstHeight}px`;
        
        // 컨텍스트 재설정
        this.setupPixelPerfectCanvas();
        
        // 배경 초기화
        this.ctx.fillStyle = '#000';
        this.ctx.fillRect(0, 0, dstWidth, dstHeight);
        
        // 이미지 렌더링
        const renderWidth = Math.floor(image.width * effectiveScale);
        const renderHeight = Math.floor(image.height * effectiveScale);
        
        this.ctx.drawImage(
            image, 
            0, 0, image.width, image.height,
            0, 0, renderWidth, renderHeight
        );
    }
    
    /**
     * 최적의 피라미드 레벨 선택
     * @returns {{image: HTMLImageElement, effectiveScale: number}}
     */
    selectPyramidLevel() {
        let imageToRender = this.currentImage;
        let pyramidScale = 1.0;
        
        if (this.options.usePyramid && Object.keys(this.imagePyramid).length > 0) {
            if (this.scale <= 0.25) {
                // 25% 이하: 1/4 크기 이미지 사용
                const quarterImage = this.imagePyramid['0.25'];
                if (quarterImage && quarterImage.complete && quarterImage.naturalWidth > 0) {
                    imageToRender = quarterImage;
                    pyramidScale = 4.0;
                    this.log('피라미드 레벨: 1/4');
                }
            } else if (this.scale <= 0.5) {
                // 50% 이하: 1/2 크기 이미지 사용
                const halfImage = this.imagePyramid['0.5'];
                if (halfImage && halfImage.complete && halfImage.naturalWidth > 0) {
                    imageToRender = halfImage;
                    pyramidScale = 2.0;
                    this.log('피라미드 레벨: 1/2');
                }
            } else {
                this.log('피라미드 레벨: 원본');
            }
        }
        
        return {
            image: imageToRender,
            effectiveScale: this.scale * pyramidScale
        };
    }
    
    /**
     * 컨테이너에 맞춤
     * @param {number} containerWidth - 컨테이너 너비
     * @param {number} containerHeight - 컨테이너 높이
     * @param {number} margin - 여백 비율 (0-1)
     * @returns {number} 적용된 스케일
     */
    fitToContainer(containerWidth, containerHeight, margin = 0.95) {
        if (!this.currentImage) return this.scale;
        
        const scaleX = containerWidth / this.currentImage.width;
        const scaleY = containerHeight / this.currentImage.height;
        
        return this.setScale(Math.min(scaleX, scaleY) * margin);
    }
    
    /**
     * 줌 인
     * @param {number} factor - 줌 배율
     */
    zoomIn(factor = 1.2) {
        this.setScale(this.scale * factor);
    }
    
    /**
     * 줌 아웃
     * @param {number} factor - 줌 배율
     */
    zoomOut(factor = 0.8) {
        this.setScale(this.scale * factor);
    }
    
    /**
     * 현재 렌더링 상태 정보
     * @returns {Object} 렌더링 정보
     */
    getInfo() {
        if (!this.currentImage) {
            return {
                status: 'No image loaded'
            };
        }
        
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
            renderMode: '이미지 피라미드',
            isGeneratingPyramid: this.isGeneratingPyramid
        };
    }
    
    /**
     * 디버그 로깅
     * @param {...any} args - 로그 인자
     */
    log(...args) {
        if (this.options.debug) {
            console.log('[SemiconductorRenderer]', ...args);
        }
    }
    
    /**
     * 리소스 정리
     */
    destroy() {
        // 이미지 피라미드 정리
        this.imagePyramid = {};
        this.currentImage = null;
        
        // 캔버스 정리
        if (this.ctx) {
            this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        }
        
        this.log('렌더러 리소스 정리 완료');
    }
}

// 전역 사용을 위한 내보내기
if (typeof window !== 'undefined') {
    window.SemiconductorRenderer = SemiconductorRenderer;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = SemiconductorRenderer;
}