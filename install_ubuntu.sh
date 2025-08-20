#!/bin/bash

# Ubuntu용 L3Tracker 설치 및 설정 스크립트

set -e

# 색상 정의
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# 설정
PROJECT_NAME="L3Tracker"
INSTALL_DIR="/opt/l3tracker"
SERVICE_NAME="l3tracker"
USER="www-data"
GROUP="www-data"

echo -e "${BLUE}🚀 ${PROJECT_NAME} Ubuntu 설치 시작${NC}"

# root 권한 확인
if [[ $EUID -ne 0 ]]; then
   echo -e "${RED}❌ 이 스크립트는 root 권한으로 실행해야 합니다.${NC}"
   echo -e "${YELLOW}사용법: sudo ./install_ubuntu.sh${NC}"
   exit 1
fi

# 시스템 업데이트
echo -e "${YELLOW}📦 시스템 업데이트 중...${NC}"
apt update && apt upgrade -y

# 필수 패키지 설치
echo -e "${YELLOW}📦 필수 패키지 설치 중...${NC}"
apt install -y python3 python3-pip python3-venv nginx supervisor git curl wget

# 프로젝트 디렉토리 생성
echo -e "${YELLOW}📁 프로젝트 디렉토리 설정 중...${NC}"
mkdir -p $INSTALL_DIR
mkdir -p $INSTALL_DIR/logs
mkdir -p $INSTALL_DIR/data

# 현재 디렉토리의 파일들을 설치 디렉토리로 복사
echo -e "${YELLOW}📋 프로젝트 파일 복사 중...${NC}"
cp -r . $INSTALL_DIR/
cd $INSTALL_DIR

# 권한 설정
chown -R $USER:$GROUP $INSTALL_DIR
chmod +x $INSTALL_DIR/start_dev.sh
chmod +x $INSTALL_DIR/start_prod.sh

# 가상환경 생성 (www-data 사용자로)
echo -e "${YELLOW}🐍 가상환경 생성 중...${NC}"
sudo -u $USER python3 -m venv $INSTALL_DIR/venv

# 의존성 설치
echo -e "${YELLOW}📋 Python 의존성 설치 중...${NC}"
sudo -u $USER $INSTALL_DIR/venv/bin/pip install --upgrade pip
sudo -u $USER $INSTALL_DIR/venv/bin/pip install -r $INSTALL_DIR/requirements.txt
sudo -u $USER $INSTALL_DIR/venv/bin/pip install uvicorn[standard] gunicorn

# systemd 서비스 설치
echo -e "${YELLOW}⚙️  systemd 서비스 설치 중...${NC}"
cp $INSTALL_DIR/l3tracker.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable $SERVICE_NAME

# Nginx 설정
echo -e "${YELLOW}🌐 Nginx 설정 중...${NC}"
cat > /etc/nginx/sites-available/l3tracker << 'EOF'
server {
    listen 80;
    server_name _;
    
    client_max_body_size 100M;
    
    # 정적 파일 직접 서빙
    location /static/ {
        alias /opt/l3tracker/static/;
        expires 1y;
        add_header Cache-Control "public, immutable";
    }
    
    # 썸네일 파일 직접 서빙
    location /thumbnails/ {
        alias /opt/l3tracker/data/thumbnails/;
        expires 1d;
        add_header Cache-Control "public";
    }
    
    # API 및 애플리케이션
    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        
        # WebSocket 지원
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        
        # 타임아웃 설정
        proxy_connect_timeout 60s;
        proxy_send_timeout 60s;
        proxy_read_timeout 60s;
    }
}
EOF

# Nginx 사이트 활성화
ln -sf /etc/nginx/sites-available/l3tracker /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl restart nginx

# 방화벽 설정
echo -e "${YELLOW}🔥 방화벽 설정 중...${NC}"
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 8080/tcp
ufw --force enable

# 서비스 시작
echo -e "${YELLOW}🚀 서비스 시작 중...${NC}"
systemctl start $SERVICE_NAME
systemctl start nginx

# 설치 완료
echo -e "${GREEN}✅ ${PROJECT_NAME} 설치 완료!${NC}"
echo -e "${GREEN}🌐 웹 접속: http://$(hostname -I | awk '{print $1}')${NC}"
echo -e "${GREEN}📊 서비스 상태: systemctl status $SERVICE_NAME${NC}"
echo -e "${GREEN}📝 로그 확인: journalctl -u $SERVICE_NAME -f${NC}"

# 상태 확인
echo -e "\n${BLUE}📊 서비스 상태:${NC}"
systemctl status $SERVICE_NAME --no-pager -l
echo -e "\n${BLUE}📊 Nginx 상태:${NC}"
systemctl status nginx --no-pager -l
