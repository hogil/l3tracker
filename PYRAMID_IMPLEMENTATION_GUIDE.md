# L3 Tracker 이미지 피라미드 구현 가이드

## 문제 진단
현재 `main.js`에서 4000x4000 이미지가 깨지는 이유:
1. **반도체 렌더러를 초기화했지만 실제로 사용하지 않음**
2. **이미지 피라미드 기능이 활성화되어 있지 않음**
3. **줌 레벨에 따른 적응형 렌더링이 구현되지 않음**
4. **픽셀 정보 표시 기능이 없음**

## 해결 방법

### 1. 즉시 테스트 (test-pyramid.html)
```bash
# 브라우저에서 열기
http://localhost:8000/test-pyramid.html
```
- 이 페이지는 **정상 작동**합니다 (4000x4000 이미지도 깨지지 않음)
- 샘플 이미지 자동 생성 및 피라미드 테스트 가능

### 2. main.js 패치 적용

#### 방법 1: 수동 패치
`main-pyramid-patch.js` 파일의 내용을 참고하여 `main.js`의 다음 함수들을 수정:

1. **loadImage 함수 수정**
   - 반도체 렌더러에 이미지 로드 추가
   - 이미지 피라미드 생성

2. **draw/render 함수 찾아서 수정**
   - semiconductorRenderer 사용하도록 변경
   - 줌 레벨에 따른 피라미드 레벨 선택

3. **새 함수 추가**
   - `updatePixelInfo()` - 픽셀 정보 업데이트
   - `handleMouseMoveWithPixelInfo()` - 마우스 좌표 추적

#### 방법 2: 백업 후 전체 교체
```bash
# 백업
cp main.js backup/main.js.backup

# 수정된 버전 적용 (직접 수정 필요)
# main-pyramid-patch.js의 코드를 main.js에 통합
```

### 3. HTML 업데이트

#### 옵션 1: 향상된 HTML 사용
```bash
# 백업
cp index.html backup/index.html.backup

# 새 버전 사용
cp index-pyramid-enhanced.html index.html
```

#### 옵션 2: 기존 index.html에 추가
다음 요소들을 `index.html`에 추가:

```html
<!-- <head> 태그 안에 추가 -->
<style>
    /* 피라미드 정보 표시 */
    #pyramid-info {
        position: fixed;
        top: 70px;
        right: 20px;
        background: rgba(0, 0, 0, 0.9);
        color: #00ff00;
        padding: 12px 16px;
        border-radius: 8px;
        font-family: monospace;
        font-size: 12px;
        z-index: 1000;
        border: 1px solid #00ff00;
        display: none;
    }
</style>

<!-- <body> 끝나기 전에 추가 -->
<div id="pyramid-info">
    <div>원본: <span id="info-original"></span></div>
    <div>표시: <span id="info-display"></span></div>
    <div>줌: <span id="info-zoom"></span></div>
    <div>피라미드: <span id="info-level"></span></div>
</div>
```

### 4. 핵심 코드 수정 예시

#### main.js의 이미지 렌더링 부분 찾기
```javascript
// 기존 코드 (문제가 있는 부분)
ctx.drawImage(img, x, y);

// 수정된 코드 (피라미드 사용)
if (this.semiconductorRenderer) {
    this.semiconductorRenderer.setScale(scale);
    const rendererCanvas = this.semiconductorRenderer.canvas;
    ctx.drawImage(rendererCanvas, x, y);
}
```

### 5. 디버깅 및 확인

#### 콘솔에서 확인
```javascript
// 브라우저 개발자 도구 콘솔에서 실행
console.log(window.semiconductorRenderer); // undefined가 아니어야 함
console.log(window.semiconductorRenderer?.options.usePyramid); // true여야 함
```

#### 피라미드 상태 확인
```javascript
// 이미지 로드 후 실행
window.semiconductorRenderer?.getInfo();
```

### 6. 주요 파일 설명

- **semiconductor-renderer.js**: 이미지 피라미드 핵심 구현 (정상)
- **test-pyramid.html**: 작동하는 테스트 페이지 (참고용)
- **main-pyramid-patch.js**: main.js 수정 가이드
- **index-pyramid-enhanced.html**: 향상된 UI 포함 HTML

### 7. 트러블슈팅

#### 문제: 여전히 이미지가 깨짐
- 브라우저 캐시 삭제 (Ctrl+Shift+R)
- semiconductorRenderer가 제대로 초기화되었는지 확인
- 이미지 피라미드가 생성되었는지 확인

#### 문제: 속도가 느림
- 첫 로드 시 피라미드 생성으로 2-3초 걸림 (정상)
- 이후 줌은 빨라야 함

#### 문제: 메모리 사용량 증가
- 4000x4000 이미지는 약 60MB 메모리 사용 (정상)
- 피라미드 포함 시 약 80MB (1.5배)

### 8. 최적화 팁

1. **프리로드**: 이미지 로드 시 바로 피라미드 생성
2. **캐싱**: 생성된 피라미드 레벨 재사용
3. **적응형 렌더링**: 줌 레벨에 따라 적절한 피라미드 레벨 선택

## 결론

현재 `test-pyramid.html`은 정상 작동하므로, 같은 방식을 `main.js`에 적용하면 해결됩니다.

주요 수정 사항:
1. ✅ semiconductor-renderer.js 이미 구현됨
2. ⚠️ main.js에서 실제로 사용하도록 수정 필요
3. 🎯 draw/render 함수에서 semiconductorRenderer 활용
4. 📊 픽셀 정보 표시 UI 추가

테스트 순서:
1. test-pyramid.html에서 정상 작동 확인
2. main.js 수정
3. 4000x4000 이미지로 테스트
4. 줌 인/아웃 시 깨짐 현상 해결 확인
