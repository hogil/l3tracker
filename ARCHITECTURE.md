# L3Tracker - 프로젝트 구조 및 아키텍처

## 📁 프로젝트 구조

```
l3tracker/
├── 🖥️ 프론트엔드
│   ├── index.html          # 메인 HTML 페이지
│   ├── main.js             # 핵심 JavaScript 로직
│   └── js/                 # 모듈화된 JavaScript
│       ├── grid.js         # 그리드 뷰 기능
│       ├── labels.js       # 라벨링 시스템
│       ├── search.js       # 검색 기능
│       ├── context-menu.js # 컨텍스트 메뉴
│       └── utils.js        # 유틸리티 함수
│
├── 🚀 백엔드 API
│   └── api/
│       ├── main.py         # FastAPI 서버
│       ├── config.py       # 설정 파일
│       └── __init__.py
│
├── 📱 Streamlit 앱
│   └── frontend/
│       └── app.py          # 대시보드 (선택사항)
│
├── 📋 문서
│   ├── README.md           # 프로젝트 설명
│   ├── ARCHITECTURE.md     # 이 파일
│   └── CHANGELOG.md        # 변경사항 기록
│
└── 📊 데이터
    └── data/wm-811k/       # 웨이퍼 맵 이미지
```

## 🏗️ 시스템 아키텍처

### **웹 기반 3계층 구조**
```
┌─────────────────┐    HTTP/WebSocket    ┌──────────────────┐    File I/O    ┌─────────────────┐
│   프론트엔드     │ ◄──────────────────► │    백엔드 API     │ ◄─────────────► │   파일 시스템    │
│   (브라우저)     │                      │   (FastAPI)      │                │ (이미지/썸네일)  │
└─────────────────┘                      └──────────────────┘                └─────────────────┘
```

### **주요 컴포넌트**

#### 🎨 **프론트엔드**
- **단일 페이지 애플리케이션 (SPA)**
- **3패널 레이아웃**: 파일탐색기 | 이미지뷰어 | 클래스관리
- **모드 전환**: 단일 이미지 ↔ 그리드 모드
- **실시간 썸네일 로딩**

#### ⚡ **백엔드**
- **RESTful API** 설계
- **비동기 처리** (async/await)
- **백그라운드 썸네일 생성**
- **파일 시스템 추상화**

## 🔄 주요 동작 흐름

### **1. 애플리케이션 시작**
```
브라우저 접속 → HTML/JS 로드 → WaferMapViewer 초기화 → 이벤트 바인딩 → 파일 탐색기 로드
```

### **2. 파일 선택 및 표시**
```
파일 클릭 → 선택된 파일 수 확인 → 그리드 모드 전환 → 썸네일 로드 → 이미지 표시
```

### **3. 썸네일 생성**
```
이미지 요청 → 썸네일 존재 확인 → 없으면 생성 → 512x512 리사이즈 → WebP 저장 → 반환
```

## 🧩 핵심 클래스 및 함수

### **JavaScript (main.js)**

#### **WaferMapViewer 클래스** (메인 컨트롤러)
```javascript
class WaferMapViewer {
    constructor()               // 초기화
    initializeEventListeners() // 이벤트 바인딩
    loadFileExplorer()         // 파일 탐색기 로드
    handleFileClick()          // 파일 클릭 처리
    switchToGridMode()         // 그리드 모드 전환
    performSearch()            // 검색 실행
    addClass()                 // 클래스 추가
    addLabel()                 // 라벨 추가
}
```

#### **주요 메서드**
- `loadFileExplorer()`: 폴더 구조 로드 및 표시
- `handleFileClick()`: 파일/폴더 선택 처리
- `switchToGridMode()`: 그리드 모드로 전환
- `performSearch()`: 파일명 기반 검색
- `addClass()`: 새로운 클래스 생성
- `addLabel()`: 이미지에 라벨 적용

### **Python (api/main.py)**

#### **FastAPI 애플리케이션**
```python
app = FastAPI()

@app.get("/api/files")
async def get_files(path: str = "")

@app.get("/api/thumbnail/{file_path:path}")
async def get_thumbnail(file_path: str)

@app.post("/api/classes")
async def create_class(class_data: ClassCreate)

@app.post("/api/labels")
async def create_label(label_data: LabelCreate)
```

## 🔧 기술적 특징

### **프론트엔드**
- **모듈화**: 기능별 JavaScript 파일 분리
- **이벤트 기반**: 사용자 상호작용 중심 설계
- **반응형**: 다양한 화면 크기 지원
- **성능**: 지연 로딩 및 캐싱

### **백엔드**
- **비동기**: FastAPI async/await 활용
- **백그라운드**: 썸네일 생성 작업 분리
- **캐싱**: 생성된 썸네일 재사용
- **에러 처리**: 견고한 예외 처리

### **데이터 처리**
- **이미지**: PIL/Pillow로 썸네일 생성
- **파일 시스템**: 경로 기반 파일 탐색
- **메타데이터**: JSON 형식으로 저장
- **확장성**: 새로운 이미지 형식 추가 용이

## 📊 성능 최적화

### **썸네일 시스템**
- **크기**: 512x512px (고품질)
- **형식**: WebP (압축률 우수)
- **백그라운드**: 사용자 작업 방해 없음
- **캐싱**: 생성된 썸네일 재사용

### **검색 시스템**
- **클라이언트 사이드**: API 호출 최소화
- **정규식**: 고급 검색 패턴 지원
- **실시간**: 타이핑과 동시 검색

### **UI/UX**
- **즉시 피드백**: 버튼 상태 및 진행 표시
- **키보드 단축키**: Ctrl/Shift 조합 지원
- **컨텍스트 메뉴**: 우클릭으로 빠른 액세스

## 🔮 확장성 및 미래 계획

### **단기 계획**
- **이미지 형식**: 추가 이미지 형식 지원
- **검색 기능**: 메타데이터 기반 검색
- **UI 개선**: 다크 모드, 테마 지원

### **장기 계획**
- **데이터베이스**: SQLite/PostgreSQL 연동
- **사용자 관리**: 로그인/권한 시스템
- **API 확장**: 외부 시스템 연동

## 🛠️ 개발 환경

### **필수 도구**
- Python 3.7+
- Node.js (개발 시)
- 웹 브라우저 (Chrome, Firefox, Safari, Edge)

### **의존성**
- **백엔드**: FastAPI, Pillow, uvicorn
- **프론트엔드**: HTML5, CSS3, JavaScript ES6+
- **개발 도구**: Git, VS Code (권장)

---

이 아키텍처를 통해 L3Tracker는 확장 가능하고 유지보수가 용이한 웨이퍼 맵 뷰어 및 라벨링 도구로 발전할 수 있습니다.
