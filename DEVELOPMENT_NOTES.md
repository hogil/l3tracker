# Development Notes - 2024-12-28

## 최근 주요 개발 사항

### 1. 폴더 브라우저 시스템 구현
- **목적**: 사용자가 이미지 폴더를 쉽게 변경하고 하위폴더를 탐색할 수 있도록 함
- **구현 요소**:
  - 제품 선택 드롭다운 (상단 바)
  - 폴더 선택 모달창 (돋보기 버튼)
  - 폴더 브라우저 내비게이션 (위로, 루트 이동)

### 2. UI/UX 개선 사항

#### 이미지 크게보기 최적화
```javascript
// 이미지 스케일 조정 (main.js)
this.transform.scale = fitScale * FIT_RELATIVE_MARGIN * 0.96;

// 이미지 위치 조정 (파일명 패널 고려)
this.transform.dy = (containerRect.height - this.currentImage.height * this.transform.scale) / 2 + (filenameBarHeight * 0.4);
```

#### CSS 개선
```css
/* 그리드 보기 파일명 글자크기 증가 */
.grid-thumb-label {
    font-size: 13px; /* 11px에서 증가 */
}

/* z-index 조정으로 레이어 순서 최적화 */
.view-controls, #minimap-container {
    z-index: 20; /* 파일명 패널보다 위에 표시 */
}
```

### 3. 기술적 해결책

#### 폴더 변경 후 상태 초기화
```javascript
// changeFolder 함수에서 상태 완전 초기화
this.selectedImages = [];
this.gridSelectedIdxs = [];
this.selectedImagePath = '';
this.hideGrid();
this.hideImage();
```

#### 상대경로 표시 로직
```javascript
// 이미지 폴더를 루트로 하는 상대경로 계산
const imageRoot = (this.currentFolderPath || '').replace(/\\/g, '/');
const currentPath = path.replace(/\\/g, '/');
if (currentPath === imageRoot) {
    currentFolderText.textContent = '/';
} else if (currentPath.startsWith(imageRoot)) {
    const relativePath = currentPath.substring(imageRoot.length).replace(/^\//, '');
    currentFolderText.textContent = relativePath ? `/${relativePath}` : '/';
}
```

### 4. API 개선

#### 폴더 정렬 보장
```python
# api/main.py - list_dir_fast 함수
directories = [x for x in items if x["type"] == "directory"]
files = [x for x in items if x["type"] == "file"]

directories.sort(key=lambda x: x["name"].lower(), reverse=True)
files.sort(key=lambda x: x["name"].lower(), reverse=True)

items = directories + files
```

### 5. 사용자 경험 개선

#### 동적 텍스트 업데이트
- 제품 선택 드롭다운에서 선택한 폴더명이 표시되도록 구현
- `selectedProductName` 상태 변수로 선택된 제품명 추적
- 최상위 폴더 옵션 추가 (🏠 아이콘 포함)

#### 불필요한 알림 제거
- "폴더가 변경되었습니다" 토스트 메시지 제거
- 사용자 액션에 대한 즉각적인 시각적 피드백 제공

### 6. 버그 수정

#### 주요 수정 사항
1. **IndentationError**: Python 코드의 들여쓰기 오류 수정
2. **우클릭 메뉴 작동 안 됨**: 폴더 변경 후 상태 초기화로 해결
3. **이미지 겹침**: 파일명 패널과 이미지 캔버스 겹침 방지
4. **경로 표시**: 절대경로 대신 사용자 친화적 상대경로 표시

### 7. 성능 최적화

#### 메모리 관리
- 폴더 변경 시 불필요한 이미지 선택 상태 정리
- 그리드 모드 해제로 메모리 사용량 감소

#### 사용자 인터페이스
- z-index 최적화로 레이어 순서 명확화
- 폰트 크기 조정으로 가독성 향상

## 다음 개발 계획

### 단기 목표
- [ ] 폴더 브라우저 성능 최적화
- [ ] 키보드 단축키 추가 (폴더 네비게이션)
- [ ] 즐겨찾기 폴더 기능

### 장기 목표
- [ ] 폴더별 설정 저장
- [ ] 사용자 커스텀 레이아웃
- [ ] 고급 검색 필터

## 코드 품질

### 유지보수성
- 명확한 함수명과 변수명 사용
- 상태 관리 로직 중앙화
- 에러 처리 강화

### 확장성
- 모듈화된 폴더 브라우저 시스템
- 재사용 가능한 UI 컴포넌트
- API 엔드포인트 표준화

---

**작성자**: AI Assistant  
**작성일**: 2024-12-28  
**버전**: 2.5.0
