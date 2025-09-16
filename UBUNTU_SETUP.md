# Ubuntu 자동 서버 실행 가이드

## 🚀 **포트 8080 + 자동 재시작 완성!**

### **⚡ 빠른 시작 (개발용)**

```bash
# 1. 프로젝트 디렉토리로 이동
cd /path/to/l3tracker

# 2. 실행 권한 부여 (처음만)
chmod +x run.sh

# 3. 개발 서버 시작 (파일 변경 감지 + 자동 재시작)
./run.sh
```

### **🔧 개별 스크립트 사용**

#### **개발 환경 (권장)**
```bash
# 파일 변경 시 자동 재시작 + 포트 8080
./start_dev.sh
```

#### **프로덕션 환경**
```bash
# 멀티 워커 + 로그 설정
./start_prod.sh
```

### **🏗️ 시스템 전체 설치 (프로덕션)**

```bash
# root 권한으로 전체 시스템 설치
sudo ./install_ubuntu.sh
```

**설치 후 자동 설정:**
- ✅ systemd 서비스 등록
- ✅ Nginx 리버스 프록시 (포트 80 → 8080)
- ✅ 부팅 시 자동 시작
- ✅ 로그 로테이션
- ✅ 방화벽 설정

### **📊 서비스 관리 (설치 후)**

```bash
# 서비스 제어
sudo systemctl start l3tracker      # 시작
sudo systemctl stop l3tracker       # 중지
sudo systemctl restart l3tracker    # 재시작
sudo systemctl status l3tracker     # 상태 확인

# 로그 확인
sudo journalctl -u l3tracker -f     # 실시간 로그
sudo tail -f /opt/l3tracker/logs/access.log   # 액세스 로그
sudo tail -f /opt/l3tracker/logs/error.log    # 에러 로그
```

### **🌐 접속 방법**

#### **개발 환경**
```
(개발) http://localhost:8080
```

#### **프로덕션 환경 (설치 후)**
```
https://서버도메인   # Nginx(HTTPS) 리버스 프록시 권장
http://서버IP:8080   # 백엔드 직접 접속(개발/점검용)
```

> 운영에서는 Nginx로 TLS 종단(443) → 백엔드 8080/8443 프록시를 권장합니다.
> 자체 인증서 사용 시 uvicorn에 --ssl-*- 옵션 또는 `python -m api.main`(Windows) 사용.

### **🔄 자동 재시작 기능**

**감지 파일 타입:**
- `.py` (Python 파일)
- `.js` (JavaScript 파일)  
- `.html` (HTML 파일)
- `.css` (CSS 파일)

**동작 방식:**
1. 파일 변경 감지
2. 서버 자동 재시작
3. 브라우저 자동 새로고침 (개발용)

### **⚙️ 설정 파일들**

| 파일 | 용도 |
|------|------|
| `run.sh` | 가장 간단한 실행 |
| `start_dev.sh` | 개발용 (자동 재시작) |
| `start_prod.sh` | 프로덕션용 |
| `install_ubuntu.sh` | 시스템 설치 |
| `l3tracker.service` | systemd 서비스 |
| `logging.conf` | 로그 설정 |

### **🛠️ 문제 해결**

#### **포트 충돌**
```bash
# 포트 8080 사용 중인 프로세스 확인
sudo lsof -i :8080

# 프로세스 종료
sudo kill -9 <PID>
```

#### **권한 문제**
```bash
# 실행 권한 부여
chmod +x *.sh

# 소유권 변경 (필요시)
sudo chown -R $USER:$USER .
```

#### **의존성 문제**
```bash
# Python 패키지 재설치
pip install -r requirements.txt --force-reinstall
```

### **📈 성능 최적화**

**백그라운드 썸네일 생성:**
- 사용자 요청 우선 처리
- 4개 워커로 제한
- 0.1초마다 CPU 양보

**Nginx 설정 (프로덕션):**
- 정적 파일 직접 서빙
- 썸네일 1일 캐시
- gzip 압축

---

## ✅ **완성된 기능**

🎯 **포트 8080** 기본 설정  
🔄 **파일 변경 감지** 자동 재시작  
🚀 **부팅 시 자동 시작** systemd  
🌐 **Nginx 리버스 프록시**  
📊 **로그 관리** 자동 로테이션  
🔒 **보안 설정** 최소 권한  
⚡ **성능 최적화** 멀티 워커  

**이제 Ubuntu에서 `./run.sh` 한 번만 실행하면 모든 것이 자동으로 동작합니다!** 🎉
