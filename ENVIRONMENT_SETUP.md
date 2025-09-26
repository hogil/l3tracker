# L3Tracker 설치 및 설정 가이드

## 개요
L3Tracker 웨이퍼맵 뷰어의 설치, 환경변수 설정 및 배포 방법을 설명합니다.

## 1. 프로젝트 다운로드 및 설치

### GitHub에서 프로젝트 다운로드
```bash
# Git 클론
git clone https://github.com/your-org/l3tracker.git
cd l3tracker

# 또는 ZIP 다운로드 후 압축 해제
```

### 의존성 설치
```bash
# Python 의존성 설치
pip install -r requirements.txt

# 또는 가상환경 사용 (권장)
python -m venv venv
source venv/bin/activate  # Ubuntu
# venv\Scripts\activate   # Windows
pip install -r requirements.txt
```

## 2. 환경변수 설정

### Ubuntu 24 (모든 환경변수 한번에 설정)

#### 필수 환경변수
```bash
# ~/.bashrc에 모든 환경변수 추가
cat >> ~/.bashrc << 'EOF'

# L3Tracker 환경변수
export UVICORN_WORKERS=16
export PROJECT_ROOT="/appdata/appuser/images"
export HOST="0.0.0.0"
export PORT="8080"
export SSL_ENABLED="1"
export HTTPS_PORT="8443"
export SSL_CERTFILE="cert/fullchain.pem"
export SSL_KEYFILE="cert/server.key"

# SAML 설정 (개발 환경)
export DEV_SAML=1
export AUTO_LOGIN=1
export DEFAULT_ORG_URL="stsds-dev.secsso.net"

# SAML 설정 (프로덕션 환경 - 위 개발 설정 대신 사용)
# export DEV_SAML=0
# export AUTO_LOGIN=1
# export DEFAULT_ORG_URL="stsds.secsso.net"

# 썸네일 설정
export THUMBNAIL_SIZE="512"
export THUMBNAIL_FORMAT="WEBP"
export THUMBNAIL_QUALITY="100"

# 성능 튜닝
export IO_THREADS="16"
export THUMBNAIL_SEM="32"
export DIRLIST_CACHE_SIZE="1024"

# 디버그/개발 설정
export RELOAD="1"
EOF

# 환경변수 적용
source ~/.bashrc
```

#### 시스템 전체 설정 (선택사항)
```bash
# 시스템 전체 환경변수 (관리자 권한 필요)
sudo tee -a /etc/environment << 'EOF'
UVICORN_WORKERS=16
PROJECT_ROOT=/appdata/appuser/images
HOST=0.0.0.0
PORT=8080
SSL_ENABLED=1
HTTPS_PORT=8443
SSL_CERTFILE=cert/fullchain.pem
SSL_KEYFILE=cert/server.key
DEV_SAML=1
AUTO_LOGIN=1
DEFAULT_ORG_URL=stsds.secsso.net
THUMBNAIL_SIZE=512
THUMBNAIL_FORMAT=WEBP
THUMBNAIL_QUALITY=100
IO_THREADS=16
THUMBNAIL_SEM=32
DIRLIST_CACHE_SIZE=1024
RELOAD=1
EOF
```

### Windows 11 (모든 환경변수 한번에 설정)

#### PowerShell 스크립트로 일괄 설정
```powershell
# 관리자 권한으로 PowerShell 실행 후
$envVars = @{
    "UVICORN_WORKERS" = "16"
    "PROJECT_ROOT" = "D:\project\data\wm-811k"
    "HOST" = "0.0.0.0"
    "PORT" = "8080"
    "SSL_ENABLED" = "1"
    "HTTPS_PORT" = "8443"
    "SSL_CERTFILE" = "cert/fullchain.pem"
    "SSL_KEYFILE" = "cert/server.key"
    "DEV_SAML" = "1"
    "AUTO_LOGIN" = "1"
    "DEFAULT_ORG_URL" = "stsds-dev.secsso.net"  # 개발: stsds-dev.secsso.net, 프로덕션: stsds.secsso.net
    "THUMBNAIL_SIZE" = "512"
    "THUMBNAIL_FORMAT" = "WEBP"
    "THUMBNAIL_QUALITY" = "100"
    "IO_THREADS" = "16"
    "THUMBNAIL_SEM" = "32"
    "DIRLIST_CACHE_SIZE" = "1024"
    "RELOAD" = "1"
}

# 사용자 환경변수로 설정
foreach ($var in $envVars.GetEnumerator()) {
    [Environment]::SetEnvironmentVariable($var.Key, $var.Value, "User")
    Write-Host "Set $($var.Key) = $($var.Value)"
}

# 현재 세션에 즉시 적용
foreach ($var in $envVars.GetEnumerator()) {
    Set-Item -Path "env:$($var.Key)" -Value $var.Value
}
```

## 3. SAML 서버 설정

### SAML IdP(Identity Provider) 설정 요구사항

#### 1. 사내 ADFS 서버 정보
- **개발 환경**: `stsds-dev.secsso.net`
- **프로덕션 환경**: `stsds.secsso.net`

#### 2. 서비스 제공자(SP) 정보
- **Entity ID**: `l3tracker-sp` (또는 사내 정책에 따라 조정)
- **ACS URL**: `https://your-domain.com:8443/saml/acs`
- **Single Logout URL**: `https://your-domain.com:8443/saml/sls`
- **Metadata URL**: `https://your-domain.com:8443/saml/metadata`

#### 3. ADFS 엔드포인트 패턴
사내 ADFS 서버의 표준 엔드포인트:
- **Entity ID**: `https://stsds.secsso.net/adfs/services/trust`
- **SSO Service**: `https://stsds.secsso.net/adfs/ls`
- **SLO Service**: `https://stsds.secsso.net/adfs/ls/?wa=wsignoutcleanup1.0`
- **Metadata**: `https://stsds.secsso.net/FederationMetadata/2007-06/FederationMetadata.xml`

#### 4. 필요한 SAML 속성 매핑
```xml
<!-- 필수 속성 -->
<saml:Attribute Name="email">
    <saml:AttributeValue>user@company.com</saml:AttributeValue>
</saml:Attribute>

<saml:Attribute Name="name">
    <saml:AttributeValue>사용자이름</saml:AttributeValue>
</saml:Attribute>

<saml:Attribute Name="department">
    <saml:AttributeValue>부서명</saml:AttributeValue>
</saml:Attribute>

<saml:Attribute Name="employeeId">
    <saml:AttributeValue>직원번호</saml:AttributeValue>
</saml:Attribute>
```

#### 5. IdP 메타데이터 설정
SAML IdP의 메타데이터 XML을 `saml/idp_metadata.xml` 파일로 저장하거나, 환경변수로 IdP 메타데이터 URL을 설정:

```bash
# Ubuntu
echo 'export IDP_METADATA_URL="https://your-idp.com/metadata"' >> ~/.bashrc

# Windows
[Environment]::SetEnvironmentVariable("IDP_METADATA_URL", "https://your-idp.com/metadata", "User")
```

#### 6. 인증서 설정
SAML 통신용 인증서 준비:
```bash
# 인증서 디렉토리 생성
mkdir -p saml/certs

# 자체 서명 인증서 생성 (개발용)
openssl req -new -x509 -days 365 -nodes -out saml/certs/sp.crt -keyout saml/certs/sp.key

# 프로덕션 환경에서는 CA 서명 인증서 사용
```

### SAML 설정 파일 예시 (saml_settings.json)

#### 개발 환경용
```json
{
    "sp": {
        "entityId": "l3tracker-sp",
        "assertionConsumerService": {
            "url": "https://your-domain.com:8443/saml/acs",
            "binding": "urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST"
        },
        "singleLogoutService": {
            "url": "https://your-domain.com:8443/saml/sls",
            "binding": "urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect"
        },
        "NameIDFormat": "urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified",
        "x509cert": "",
        "privateKey": ""
    },
    "idp": {
        "entityId": "https://stsds-dev.secsso.net/adfs/services/trust",
        "singleSignOnService": {
            "url": "https://stsds-dev.secsso.net/adfs/ls",
            "binding": "urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect"
        },
        "singleLogoutService": {
            "url": "https://stsds-dev.secsso.net/adfs/ls/?wa=wsignoutcleanup1.0",
            "binding": "urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect"
        },
        "x509cert": "개발_ADFS_인증서_내용"
    }
}
```

#### 프로덕션 환경용
```json
{
    "sp": {
        "entityId": "l3tracker-sp",
        "assertionConsumerService": {
            "url": "https://your-production-domain.com:8443/saml/acs",
            "binding": "urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST"
        },
        "singleLogoutService": {
            "url": "https://your-production-domain.com:8443/saml/sls",
            "binding": "urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect"
        },
        "NameIDFormat": "urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified",
        "x509cert": "",
        "privateKey": ""
    },
    "idp": {
        "entityId": "https://stsds.secsso.net/adfs/services/trust",
        "singleSignOnService": {
            "url": "https://stsds.secsso.net/adfs/ls",
            "binding": "urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect"
        },
        "singleLogoutService": {
            "url": "https://stsds.secsso.net/adfs/ls/?wa=wsignoutcleanup1.0",
            "binding": "urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect"
        },
        "x509cert": "운영_ADFS_인증서_내용"
    }
}
```

## 4. SSL 인증서 설정

### 1. 인증서 디렉토리 생성
```bash
mkdir -p cert
```

### 2. 자체 서명 인증서 생성 (개발용)
```bash
# Ubuntu
openssl req -new -x509 -days 365 -nodes -out cert/fullchain.pem -keyout cert/server.key

# 인증서 권한 설정
chmod 600 cert/*.pem cert/*.key
```

### 3. 프로덕션 인증서 (Let's Encrypt 등)
```bash
# Let's Encrypt 인증서 예시
sudo certbot certonly --standalone -d your-domain.com
sudo cp /etc/letsencrypt/live/your-domain.com/fullchain.pem cert/
sudo cp /etc/letsencrypt/live/your-domain.com/privkey.pem cert/server.key
```

## 5. 서버 실행

### Ubuntu 24
```bash
cd /path/to/l3tracker
python -m api.main
```

### Windows 11
```powershell
cd D:\project\l3tracker
python -m api.main
```

### 서비스로 등록 (Ubuntu)
```bash
# systemd 서비스 파일 생성
sudo tee /etc/systemd/system/l3tracker.service << 'EOF'
[Unit]
Description=L3Tracker Wafer Map Viewer
After=network.target

[Service]
Type=simple
User=l3tracker
WorkingDirectory=/path/to/l3tracker
Environment=PATH=/path/to/l3tracker/venv/bin
ExecStart=/path/to/l3tracker/venv/bin/python -m api.main
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF

# 서비스 활성화 및 시작
sudo systemctl enable l3tracker
sudo systemctl start l3tracker
sudo systemctl status l3tracker
```

## 6. 환경변수 확인

### Ubuntu 24
```bash
# 모든 L3Tracker 환경변수 확인
env | grep -E "(UVICORN|PROJECT|SSL|HOST|PORT|SAML|AUTO_LOGIN|DEFAULT_ORG_URL|THUMBNAIL|IO_THREADS|RELOAD)"
```

### Windows 11
```powershell
# 모든 L3Tracker 환경변수 확인
Get-ChildItem Env: | Where-Object {$_.Name -match "(UVICORN|PROJECT|SSL|HOST|PORT|SAML|AUTO_LOGIN|DEFAULT_ORG_URL|THUMBNAIL|IO_THREADS|RELOAD)"}
```

## 7. 배포 및 운영

### 권장 설정값

#### 개발 환경
- `UVICORN_WORKERS=4`
- `RELOAD=1`
- `SSL_ENABLED=0` (HTTP만 사용)
- `DEV_SAML=1`

#### 프로덕션 환경
- `UVICORN_WORKERS=16` (CPU 코어 수의 50-75%)
- `RELOAD=0`
- `SSL_ENABLED=1`
- `DEV_SAML=0`
- `AUTO_LOGIN=1`

### 서버 모니터링 (Ubuntu)
```bash
# 서비스 상태 확인
sudo systemctl status l3tracker

# 로그 확인
sudo journalctl -u l3tracker -f

# 성능 모니터링
htop
```

### 방화벽 설정
```bash
# Ubuntu - UFW
sudo ufw allow 8080/tcp
sudo ufw allow 8443/tcp

# CentOS/RHEL - firewalld
sudo firewall-cmd --permanent --add-port=8080/tcp
sudo firewall-cmd --permanent --add-port=8443/tcp
sudo firewall-cmd --reload
```

## 8. 문제 해결

### 1. 서버가 시작되지 않는 경우
- Python 경로 확인: `python --version`
- 의존성 설치: `pip install -r requirements.txt`
- 포트 사용 중 확인: 
  ```bash
  # Windows
  netstat -an | findstr :8443
  
  # Ubuntu
  netstat -tulpn | grep :8443
  ```

### 2. HTTPS 인증서 오류
- 인증서 파일 존재 확인
- 파일 권한 확인 (Ubuntu: `chmod 600 cert/*.pem`)
- 인증서 유효성 확인: `openssl x509 -in cert/fullchain.pem -text -noout`

### 3. SAML 인증 실패
- IdP 메타데이터 확인
- SP 메타데이터가 IdP에 등록되었는지 확인
- 시계 동기화 확인 (SAML은 시간에 민감)
- 네트워크 연결 및 방화벽 확인

### 4. 이미지 로드 실패
- `PROJECT_ROOT` 경로 확인
- 이미지 파일 권한 확인
- 지원되는 파일 형식 확인 (jpg, png, tiff 등)
- 디스크 용량 및 메모리 확인

### 5. 성능 문제
- `UVICORN_WORKERS` 수 조정
- `IO_THREADS`, `THUMBNAIL_SEM` 값 튜닝
- 썸네일 캐시 확인
- 시스템 리소스 모니터링

## 9. 보안 고려사항

### 1. 네트워크 보안
- 방화벽 설정으로 필요한 포트만 개방
- 리버스 프록시 사용 권장 (nginx, apache)
- SSL/TLS 인증서 정기 갱신

### 2. 파일 시스템 보안
- 적절한 파일 권한 설정
- 웹 서버 전용 사용자 계정 사용
- 로그 파일 로테이션 설정

### 3. SAML 보안
- SP 인증서 안전한 보관
- IdP와의 통신 암호화
- 세션 타임아웃 설정

## 10. 참고사항

- 환경변수 변경 후 서버 재시작 필요
- Windows에서는 관리자 권한으로 실행해야 시스템 환경변수 설정 가능
- Ubuntu에서는 `sudo` 권한으로 시스템 전체 설정 가능
- 개발 시에는 `.env` 파일 사용도 가능 (python-dotenv 패키지 필요)
- 대용량 이미지 처리 시 메모리 사용량 모니터링 필요
- 정기적인 백업 및 복구 계획 수립 권장
