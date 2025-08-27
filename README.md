# L3Tracker - Wafer Map Viewer & Labeling Tool

웨이퍼 맵 이미지를 탐색하고 라벨링할 수 있는 웹 기반 도구입니다.

## 🚀 주요 기능

- **이미지 탐색**: 폴더 기반 이미지 탐색 및 미리보기
- **그리드 뷰**: 다중 이미지 선택 시 자동 그리드 모드 전환
- **라벨링 시스템**: 클래스 기반 이미지 라벨링 및 관리
- **반응형 UI**: 모바일과 데스크톱 모두 지원
- **실시간 검색**: 이미지 파일명 기반 빠른 검색

## 📋 요구사항

- Python 3.7+
- 웨이퍼 맵 이미지 데이터셋 (wm-811k 등)

## 🛠️ 설치 및 실행

### 1. 저장소 클론
```bash
git clone https://github.com/yourusername/l3tracker.git
cd l3tracker
```

### 2. 의존성 설치
```bash
pip install -r requirements.txt
```

### 3. 데이터셋 준비
웨이퍼 맵 이미지를 다음 경로에 배치하세요:
```
data/wm-811k/
├── *.jpg
├── *.png
└── (기타 이미지 파일들)
```

### 4. 앱 실행
```bash
python -m uvicorn api.main:app --host 0.0.0.0 --port 8000
```

### 5. 웹 브라우저 접속
http://localhost:8000

## 📁 프로젝트 구조

```
l3tracker/
├── api/                 # FastAPI 백엔드
│   ├── main.py         # 메인 애플리케이션
│   ├── config.py       # 설정 파일
│   └── __init__.py
├── frontend/           # 프론트엔드 파일
│   └── app.py         # Streamlit 앱 (선택사항)
├── js/                 # JavaScript 모듈
│   ├── main.js        # 메인 애플리케이션 로직
│   ├── grid.js        # 그리드 뷰 기능
│   ├── labels.js      # 라벨링 시스템
│   ├── search.js      # 검색 기능
│   └── utils.js       # 유틸리티 함수
├── index.html          # 메인 HTML 파일
├── requirements.txt    # Python 의존성
├── README.md           # 프로젝트 문서
├── ARCHITECTURE.md     # 아키텍처 설명
└── CHANGELOG.md        # 변경 이력
```

## 🎯 사용법

### 이미지 탐색
1. 좌측 사이드바에서 이미지 폴더 탐색
2. 이미지 클릭으로 선택
3. Ctrl+클릭으로 다중 선택

### 그리드 모드
- 2개 이상 이미지 선택 시 자동 전환
- 마우스 휠로 확대/축소
- 드래그로 이미지 이동

### 라벨링
1. 우측 패널에서 클래스 추가
2. 이미지 선택 후 라벨 적용
3. 라벨 데이터 JSON 형식으로 내보내기

### 검색
- 파일명 기반 실시간 검색
- 정규식 패턴 지원

## 🔧 설정

`api/config.py`에서 다음 설정을 조정할 수 있습니다:
- 이미지 데이터셋 경로
- 지원 이미지 형식
- 서버 포트 및 호스트

## 📊 지원 형식

- **이미지**: JPG, PNG, BMP, GIF, TIFF, WebP
- **데이터**: JSON, CSV
- **브라우저**: Chrome, Firefox, Safari, Edge

## 🤝 기여하기

1. Fork the Project
2. Create your Feature Branch (`git checkout -b feature/AmazingFeature`)
3. Commit your Changes (`git commit -m 'Add some AmazingFeature'`)
4. Push to the Branch (`git push origin feature/AmazingFeature`)
5. Open a Pull Request

## 📝 라이선스

이 프로젝트는 MIT 라이선스 하에 배포됩니다. 자세한 내용은 `LICENSE` 파일을 참조하세요.

## 📞 지원

문제가 발생하거나 질문이 있으시면:
- [Issues](https://github.com/yourusername/l3tracker/issues) 페이지에 등록
- 프로젝트 문서 참조

---

⭐ 이 프로젝트가 도움이 되었다면 스타를 눌러주세요!
