# Wafer Map Viewer

고성능 웨이퍼 맵 이미지 뷰어 및 라벨링 도구입니다.

## 🚀 주요 기능

- **이미지 뷰어**: 고해상도 이미지 확대/축소, 팬, 미니맵
- **그리드 썸네일 모드**: 다수 이미지 동시 비교 및 선택
- **드래그 선택**: Windows Explorer 스타일 다중 선택
- **라벨링 시스템**: 이미지 분류 및 배치 라벨링
- **실시간 썸네일**: 빠른 이미지 미리보기

## 📦 설치 및 실행

### 1. 필요 조건
- Python 3.7 이상
- 웹 브라우저 (Chrome, Firefox, Edge 등)

### 2. 설치
```bash
# 저장소 클론
git clone https://github.com/hogil/l3tracker.git
cd l3tracker
cd wafer-map-viewer

# Python 패키지 설치
pip install -r requirements.txt
```

### 3. 이미지 폴더 설정

**방법 1: 환경변수 설정** (권장)
```bash
# Windows
set PROJECT_ROOT=C:\Your\Image\Folder
python -m uvicorn api.main:app --host 0.0.0.0 --port 8000

# Linux/Mac
export PROJECT_ROOT=/path/to/your/images
python -m uvicorn api.main:app --host 0.0.0.0 --port 8000
```

**방법 2: 설정 파일 수정**
`llmapp/app/config.py` 파일에서 4번째 줄 수정:
```python
ROOT_DIR = Path(os.getenv("PROJECT_ROOT", "C:/Your/Image/Folder")).resolve()
```

### 4. 서버 실행
```bash
python -m uvicorn api.main:app --host 0.0.0.0 --port 8000
```

### 5. 웹 앱 접속
웹 브라우저에서 `http://localhost:8000` 접속

## 🎯 사용법

### Wafer Map Explorer
- 폴더 트리에서 이미지 파일 탐색
- **클릭**: 단일 이미지 선택
- **Ctrl+클릭**: 다중 선택
- **Shift+클릭**: 범위 선택
- **Ctrl+폴더클릭**: 폴더 내 모든 이미지 선택
- **우클릭**: 전체 선택 해제

### 그리드 모드
- **2개 이상 선택 시**: 자동으로 그리드 썸네일 모드
- **드래그 선택**: 마우스로 영역 드래그하여 다중 선택
- **Ctrl+드래그**: 기존 선택에 추가
- **더블클릭**: 단일 이미지 모드로 전환

### 이미지 뷰어
- **마우스 휠**: 확대/축소
- **드래그**: 이미지 이동
- **Shift+휠**: 수평 이동
- **미니맵**: 클릭하여 빠른 위치 이동

### Label Explorer
- **이미지 다중 선택**: 그리드 모드로 자동 전환
- **Ctrl+클래스**: 클래스의 모든 이미지를 그리드로 표시
- **Ctrl+A**: 전체 이미지 선택 및 그리드 모드
- **ESC**: 선택 해제 및 그리드 모드 종료

### 라벨링
- **클래스 생성**: Class Manager에서 새 클래스 추가
- **단일 라벨링**: 이미지 선택 후 클래스 버튼 클릭
- **배치 라벨링**: 그리드에서 다중 선택 후 클래스 버튼 클릭
- **라벨 삭제**: Label Explorer에서 🗑️ 버튼 클릭

## 🔧 성능 최적화

- **썸네일 캐시**: 자동으로 썸네일 생성 및 캐싱
- **지연 로딩**: 뷰포트 내 이미지만 로딩
- **메모리 관리**: 자동 캐시 정리 (5분 주기)
- **배치 처리**: 대량 이미지 효율적 처리

## 🐛 디버깅

URL에 `#debug`를 추가하면 실시간 성능 통계를 확인할 수 있습니다:
```
http://localhost:8000#debug
```

## 📁 폴더 구조

```
wafer-map-viewer/
├── api/                 # FastAPI 백엔드 서버
│   ├── main.py          # 서버 엔트리포인트
│   ├── config.py        # 설정 파일
│   └── ...
│
├── frontend/            # (선택) Streamlit 대시보드
├── index.html           # 웹 앱 메인 페이지
├── main.js             # 프론트엔드 로직
├── requirements.txt     # Python 패키지
└── README.md           # 사용법
```

## 🤝 지원되는 이미지 형식

- JPEG (.jpg, .jpeg)
- PNG (.png)
- BMP (.bmp)
- GIF (.gif)
- TIFF (.tiff)
- WebP (.webp)

---

**문제가 발생하면 브라우저 개발자 도구(F12)의 콘솔을 확인해주세요.** 