# Wafer Map Viewer - 자동 설치 완료

이 프로젝트는 자동으로 설치되었습니다. 아래 단계를 따라 실행하세요.

## 🚀 빠른 시작

### 1. main.js 파일 다운로드 (필수)
현재 main.js는 임시 파일입니다. 실제 파일을 다운로드해주세요:

1. 다음 링크에서 파일 다운로드: https://raw.githubusercontent.com/hogil/l3tracker/main/main.js
2. 다운로드한 파일을 `D:\project\l3tracker\main.js`로 교체

### 2. 데이터셋 준비
wm-811k 데이터셋을 다음 경로에 준비하세요:
```
D:\project\data\wm-811k\
├── *.jpg
├── *.png
└── (기타 이미지 파일들)
```

### 3. Python 패키지 설치
```bash
cd D:\project\l3tracker
pip install -r requirements.txt
```

### 4. 앱 실행
`run_app.bat` 파일을 더블클릭하여 실행하거나:
```bash
python -m uvicorn api.main:app --host 0.0.0.0 --port 8000
```

### 5. 웹 브라우저 접속
http://localhost:8000

## 📁 프로젝트 구조

```
D:\project\l3tracker\
├── api\
│   ├── __init__.py
│   ├── main.py          # 수정됨 (정적 파일 경로)
│   ├── config.py        # 수정됨 (wm-811k 경로)
│   └── utils.py
├── index.html
├── main.js              # ⚠️ 실제 파일로 교체 필요
├── requirements.txt     # 업데이트됨
├── run_app.bat         # 실행 스크립트
└── README.md           # 이 파일
```

## ⚙️ 주요 수정사항

1. **config.py**: ROOT_DIR을 `D:/project/data/wm-811k`로 변경
2. **main.py**: 정적 파일 경로 수정 (PROJECT_ROOT 추가)
3. **requirements.txt**: 필요한 패키지 추가
4. **run_app.bat**: 편리한 실행을 위한 배치 파일

## 🔧 문제 해결

### main.js 파일 오류
- GitHub에서 최신 main.js 파일을 다운로드하여 교체하세요
- 파일 크기: 약 154KB (3554줄)

### 이미지가 보이지 않음
- `D:\project\data\wm-811k` 경로에 이미지가 있는지 확인
- 지원 형식: jpg, jpeg, png, bmp, gif, tiff, webp

### 모듈 오류
```bash
pip install -r requirements.txt
```

### 포트 충돌
```bash
python -m uvicorn api.main:app --host 0.0.0.0 --port 8001
```

## 📝 사용법

1. **파일 탐색**: 좌측 사이드바에서 이미지 폴더 탐색
2. **이미지 선택**: 클릭으로 단일 선택, Ctrl+클릭으로 다중 선택
3. **그리드 모드**: 2개 이상 선택 시 자동 전환
4. **라벨링**: 우측 패널에서 클래스 추가 및 라벨링
5. **확대/축소**: 마우스 휠 또는 컨트롤 버튼 사용

## 📞 지원

문제가 발생하면 다음을 확인하세요:
1. Python 3.7 이상 설치 여부
2. 모든 패키지 설치 완료 여부
3. main.js 파일 교체 완료 여부
4. 이미지 데이터셋 경로 확인

즐거운 이미지 뷰잉과 라벨링 되세요! 🎉
