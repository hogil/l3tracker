# L3 Tracker - 반도체 웨이퍼맵 불량 분석 시스템

<div align="center">
  <img src="https://img.shields.io/badge/version-2.0.0-blue.svg" />
  <img src="https://img.shields.io/badge/python-3.8%2B-green.svg" />
  <img src="https://img.shields.io/badge/javascript-ES6%2B-yellow.svg" />
  <img src="https://img.shields.io/badge/license-MIT-purple.svg" />
</div>

## 📋 개요

L3 Tracker는 반도체 웨이퍼맵의 불량 패턴을 분석하고 관리하는 전문 시스템입니다. 대용량 고해상도 이미지(4000x4000 픽셀)를 왜곡 없이 처리하며, 머신러닝 기반 자동 분류 기능을 제공합니다.

### 주요 특징

- **🔍 고성능 이미지 렌더링**: 이미지 피라미드 기술로 대용량 이미지 빠른 처리
- **🤖 AI 자동 분류**: ResNet50 기반 불량 패턴 자동 분류 (정확도 95%+)
- **📊 배치 처리**: 수천 개 이미지 동시 처리 및 관리
- **🎯 픽셀 완벽 렌더링**: 반도체 불량 패턴의 세밀한 부분까지 보존
- **💾 효율적인 캐싱**: 썸네일 및 이미지 데이터 스마트 캐싱
- **📊 상세 접속 로그**: SAML 연동 사용자 추적 및 일별 접속 기록 CSV 내보내기
- **🔐 SAML 인증**: 회사 SSO 연동 및 사용자 프로필 관리

## 🚀 빠른 시작

### 시스템 요구사항

- Python 3.8 이상
- Node.js 14 이상 (선택사항)
- 최소 8GB RAM
- GPU (CUDA 지원 권장)

### 설치

1. **저장소 클론**
```bash
git clone https://github.com/yourusername/l3tracker.git
cd l3tracker
```

2. **Python 종속성 설치**
```bash
pip install -r requirements.txt
```

3. **초기 설정**
```bash
python setup.py
```

### 실행

#### Windows
```cmd
# 관리자 권한으로 실행
python main.py
```

#### Linux/Mac
```bash
sudo python main.py
```

브라우저에서 `http://localhost:5000` 접속

## 🏗️ 시스템 아키텍처

### 프론트엔드 구조
```
frontend/
├── index.html          # 메인 UI
├── js/
│   ├── main.js        # 핵심 애플리케이션 로직
│   ├── semiconductor-renderer.js  # 이미지 렌더링 엔진
│   ├── grid.js        # 그리드 뷰 관리
│   └── labels.js      # 라벨링 시스템
└── css/
    └── styles.css     # 스타일시트
```

### 백엔드 구조
```
api/
├── app.py             # Flask 애플리케이션
├── classifier.py      # AI 분류 엔진
├── image_handler.py   # 이미지 처리
└── thumbnail.py       # 썸네일 생성
```

## 📚 핵심 기능

### 1. 이미지 피라미드 렌더링

반도체 웨이퍼맵의 대용량 이미지를 효율적으로 처리하기 위한 다단계 해상도 시스템:

```javascript
// 사용 예시
const renderer = new SemiconductorRenderer(canvas, {
    usePyramid: true,      // 이미지 피라미드 활성화
    enhanceDefects: true,  // 불량 패턴 강조
    debug: false           // 디버그 모드
});

await renderer.loadImage(image);
renderer.fitToContainer(width, height);
```

**피라미드 레벨:**
- **원본 (1x)**: 100% 이상 확대 시 사용
- **1/2 크기 (0.5x)**: 50-100% 표시 시 사용  
- **1/4 크기 (0.25x)**: 25-50% 표시 시 사용

### 2. AI 자동 분류

ResNet50 기반 딥러닝 모델로 불량 패턴 자동 분류:

```python
# 분류 카테고리
- Center: 중앙 불량
- Donut: 도넛 패턴
- Edge-Ring: 가장자리 링
- Edge-Loc: 가장자리 국부
- Loc: 국부 불량
- Near-full: 거의 전체 불량
- Random: 랜덤 불량
- Scratch: 스크래치
- none: 불량 없음
```

### 3. 배치 처리

여러 이미지를 동시에 처리하고 분석:

- 드래그 앤 드롭 멀티 선택
- Ctrl+A 전체 선택
- Shift+클릭 범위 선택
- 선택된 이미지 일괄 다운로드/분류/라벨링

### 4. 검색 기능

고급 검색 문법 지원:
```
# AND 연산
wafer and defect

# OR 연산  
center or edge

# NOT 연산
not scratch

# 복합 검색
(wafer or chip) and not random
```

### 5. 상세 접속 로그 시스템

SAML 인증과 연동된 사용자 접속 추적 및 분석:

**주요 기능:**
- 실시간 사용자 접속 기록
- SAML 클레임 기반 프로필 관리 (계정, 이름, 사번, 직급, 담당업무, 부서)
- 일별 접속 통계 및 CSV 내보내기
- UTF-8 BOM 지원으로 한글 완벽 호환

**CSV 내보내기 형식:**
```csv
계정,이름,사번,직급,담당업무,부서,접속일자,IP주소
hgchoi,최홍길,95722448,Senior Engineer,선임연구원,반도체사업부,2025-09-24,61.82.130.250
manager,김팀장,89500230,Manager,팀장,품질관리팀,2025-09-24,192.168.1.101
```

**SAML 클레임 매핑:**
- `Username` → 이름
- `LginId` → 계정  
- `Sabun` → 사번 (8자리 자동생성)
- `GrdName_EN` → 직급
- `GrdName` → 담당업무
- `DeptName` → 부서명
- `x-ms-forwarded-client-ip` → IP주소

## 🛠️ API 엔드포인트

| 엔드포인트 | 메소드 | 설명 |
|----------|--------|------|
| `/api/files` | GET | 파일 목록 조회 |
| `/api/image` | GET | 이미지 데이터 반환 |
| `/api/thumbnail` | GET | 썸네일 생성/반환 |
| `/api/classify` | POST | AI 분류 실행 |
| `/api/labels` | GET/POST | 라벨 관리 |
| `/api/search` | GET | 파일 검색 |
| `/api/stats/*` | GET | 접속 통계 조회 |
| `/api/export/detailed-access` | GET | 상세 접속 로그 CSV 다운로드 |
| `/saml/acs` | POST | SAML 인증 처리 |
| `/stats` | GET | 접속 통계 대시보드 |

## 📈 성능 최적화

### 메모리 관리
- 이미지 피라미드로 메모리 사용량 75% 감소
- 스마트 캐싱으로 반복 로딩 방지
- 주기적인 가비지 컬렉션

### 렌더링 최적화
- GPU 가속 활용
- 픽셀 완벽 렌더링으로 안티앨리어싱 제거
- 비동기 이미지 로딩

## 🧪 테스트

### 단위 테스트 실행
```bash
python -m pytest tests/
```

### 이미지 피라미드 테스트
브라우저에서 `test-pyramid.html` 파일 열기

## 📝 변경 이력

최신 변경사항은 [CHANGELOG.md](CHANGELOG.md) 참조

## 🤝 기여하기

1. Fork the Project
2. Create your Feature Branch (`git checkout -b feature/AmazingFeature`)
3. Commit your Changes (`git commit -m 'Add some AmazingFeature'`)
4. Push to the Branch (`git push origin feature/AmazingFeature`)
5. Open a Pull Request

## 📄 라이선스

MIT License - 자세한 내용은 [LICENSE](LICENSE) 파일 참조

## 👥 개발팀

- **프로젝트 리드**: L3 Tracker Team
- **이메일**: support@l3tracker.com

## 🙏 감사의 글

- TensorFlow/Keras 팀
- Flask 커뮤니티
- 오픈소스 기여자들

---

<div align="center">
  Made with ❤️ for Semiconductor Industry
</div>