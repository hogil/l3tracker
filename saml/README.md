# SAML 설정 파일 가이드

## 파일 설명

### settings.json (개발 환경)
- 개발용 ADFS 서버: `stsds-dev.secsso.net`
- 현재 활성화된 설정 파일
- 개발 및 테스트 용도

### settings.prod.json (프로덕션 환경)
- 운영용 ADFS 서버: `stsds.secsso.net`
- 프로덕션 배포 시 사용
- `settings.json`을 이 파일로 교체하여 사용

### advanced_settings.json
- SAML 보안 설정
- 개발/프로덕션 공통 사용

## 환경별 설정 방법

### 개발 환경으로 전환
```bash
# 현재 개발 환경 설정이 기본값
# 별도 작업 불필요
```

### 프로덕션 환경으로 전환
```bash
# 현재 설정을 백업
cp saml/settings.json saml/settings.dev.json

# 프로덕션 설정으로 교체
cp saml/settings.prod.json saml/settings.json

# 환경변수도 프로덕션용으로 변경
export DEV_SAML=0
export DEFAULT_ORG_URL="stsds.secsso.net"
```

## 주요 차이점

| 항목 | 개발 환경 | 프로덕션 환경 |
|-----|---------|-------------|
| ADFS 서버 | stsds-dev.secsso.net | stsds.secsso.net |
| EntityID | l3tracker-sp | l3tracker-sp |
| NameIDFormat | unspecified | unspecified |
| SP URL | 개발 도메인 | 운영 도메인 |
| 인증서 | 개발용 인증서 | 운영용 인증서 |

## 주의사항

1. **인증서 업데이트**: 실제 사내 ADFS 인증서로 교체 필요
2. **SP URL 변경**: 실제 운영 도메인으로 변경 필요
3. **환경변수 동기화**: 설정 파일과 환경변수가 일치해야 함
4. **백업**: 설정 변경 전 항상 백업 생성