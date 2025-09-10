#!/usr/bin/env python3
# -*- coding: utf-8 -*-

import logging
from datetime import datetime
from pathlib import Path
from fastapi import Request

# 로그 디렉터리 생성
LOG_DIR = Path("logs")
LOG_DIR.mkdir(exist_ok=True)

# 접속자 로그 파일
ACCESS_LOG_FILE = LOG_DIR / "access.log"

# 로거 설정
access_logger = logging.getLogger("access")
access_logger.setLevel(logging.INFO)

# 파일 핸들러 설정
handler = logging.FileHandler(ACCESS_LOG_FILE, encoding='utf-8')
formatter = logging.Formatter('%(message)s')
handler.setFormatter(formatter)
access_logger.addHandler(handler)

# 콘솔 핸들러 추가
console_handler = logging.StreamHandler()
console_handler.setFormatter(formatter)
access_logger.addHandler(console_handler)

class AccessLogger:
    def __init__(self):
        pass
    
    def log_access(self, request: Request, endpoint: str):
        """접속 로그 기록 (IP만 표시)"""
        client_ip = self.get_client_ip(request)
        method = request.method
        
        # 메서드별 색상 구분
        method_colors = {
            'GET': '\033[96m',     # 밝은 청록색
            'POST': '\033[95m',    # 밝은 마젠타색
            'PUT': '\033[94m',     # 밝은 파란색
            'DELETE': '\033[91m'   # 밝은 빨간색
        }
        method_color = method_colors.get(method, '\033[97m')  # 기본: 밝은 흰색
        
        # IP를 15자리로 맞춰서 정렬 (INFO 로그와 맞춤)
        formatted_ip = f"{client_ip:<15}"  # 왼쪽 정렬, 15자리
        timestamp = datetime.now().strftime('%Y-%m-%d %H:%M:%S\t%f')[:-3]  # 탭으로 구분
        
        log_message = f"\033[93mACCESS\033[0m: {timestamp} \033[90m{formatted_ip}\033[0m - \"{method_color}{method}\033[0m {endpoint} HTTP/1.1\" \033[93m200\033[0m"
        access_logger.info(log_message)
    
    def get_client_ip(self, request: Request) -> str:
        """실제 클라이언트 IP 추출 (프록시 고려)"""
        # X-Forwarded-For 헤더 확인 (프록시 뒤에 있는 경우)
        forwarded_for = request.headers.get("x-forwarded-for")
        if forwarded_for:
            return forwarded_for.split(",")[0].strip()
        
        # X-Real-IP 헤더 확인
        real_ip = request.headers.get("x-real-ip")
        if real_ip:
            return real_ip
        
        # 기본 클라이언트 IP
        return request.client.host if request.client else "unknown"

# 전역 인스턴스
logger_instance = AccessLogger()