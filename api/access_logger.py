#!/usr/bin/env python3
# -*- coding: utf-8 -*-

import json
import time
import hashlib
from datetime import datetime, date
from pathlib import Path
from typing import Dict, Any, Optional
from fastapi import Request
import logging

# 로그 디렉터리 생성
LOG_DIR = Path("logs")
LOG_DIR.mkdir(exist_ok=True)

# 접속자 로그 파일
ACCESS_LOG_FILE = LOG_DIR / "access.log"
STATS_LOG_FILE = LOG_DIR / "user_stats.json"

# 로거 설정
access_logger = logging.getLogger("access")
access_logger.setLevel(logging.INFO)

# 파일 핸들러 설정
handler = logging.FileHandler(ACCESS_LOG_FILE, encoding='utf-8')
formatter = logging.Formatter('%(asctime)s - %(message)s')
handler.setFormatter(formatter)
access_logger.addHandler(handler)

# 콘솔 핸들러도 추가
console_handler = logging.StreamHandler()
console_handler.setFormatter(formatter)
access_logger.addHandler(console_handler)

class AccessLogger:
    def __init__(self):
        self.user_stats: Dict[str, Dict[str, Any]] = self.load_stats()
    
    def generate_user_id(self, ip: str, user_agent: str) -> str:
        """IP와 User-Agent 기반으로 고유 사용자 ID 생성"""
        combined = f"{ip}:{user_agent}"
        return hashlib.md5(combined.encode()).hexdigest()[:12]
    
    def set_user_display_name(self, user_id: str, display_name: str):
        """사용자 표시 이름 설정"""
        if user_id in self.user_stats:
            self.user_stats[user_id]["display_name"] = display_name
            self.save_stats()
    
    def load_stats(self) -> Dict[str, Dict[str, Any]]:
        """사용자 통계 로드"""
        try:
            if STATS_LOG_FILE.exists():
                with open(STATS_LOG_FILE, 'r', encoding='utf-8') as f:
                    return json.load(f)
        except Exception as e:
            print(f"통계 로드 실패: {e}")
        return {}
    
    def save_stats(self):
        """사용자 통계 저장"""
        try:
            with open(STATS_LOG_FILE, 'w', encoding='utf-8') as f:
                json.dump(self.user_stats, f, ensure_ascii=False, indent=2, default=str)
        except Exception as e:
            print(f"통계 저장 실패: {e}")
    
    def log_access(self, request: Request, user_id: str, endpoint: str):
        """접속 로그 기록"""
        client_ip = self.get_client_ip(request)
        user_agent = request.headers.get("user-agent", "Unknown")
        method = request.method
        
        # 표시 이름 가져오기
        display_name = ""
        if user_id in self.user_stats:
            display_name = self.user_stats[user_id].get("display_name", "")
        
        # 콘솔 및 파일 로그
        if display_name:
            log_message = f"🔗 {client_ip} | {display_name} (ID:{user_id}) | {method} {endpoint}"
        else:
            log_message = f"🔗 {client_ip} | ID:{user_id} | {method} {endpoint}"
        access_logger.info(log_message)
        
        # 통계 업데이트
        self.update_stats(user_id, client_ip, endpoint, user_agent)
    
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
    
    def update_stats(self, user_id: str, ip: str, endpoint: str, user_agent: str):
        """사용자 통계 업데이트"""
        today = date.today().isoformat()
        
        # 사용자 정보 초기화
        if user_id not in self.user_stats:
            self.user_stats[user_id] = {
                "first_seen": today,
                "last_seen": today,
                "ip_addresses": set(),
                "user_agents": set(),
                "daily_requests": {},
                "total_requests": 0,
                "unique_days": set(),
                "endpoints": {},
                "display_name": ""  # 사용자 표시 이름
            }
        
        user_data = self.user_stats[user_id]
        
        # 기본 정보 업데이트
        user_data["last_seen"] = today
        
        # Set이 list로 변환된 경우 다시 set으로 변환
        if isinstance(user_data["ip_addresses"], list):
            user_data["ip_addresses"] = set(user_data["ip_addresses"])
        if isinstance(user_data["user_agents"], list):
            user_data["user_agents"] = set(user_data["user_agents"])
        if isinstance(user_data["unique_days"], list):
            user_data["unique_days"] = set(user_data["unique_days"])
            
        user_data["ip_addresses"].add(ip)
        user_data["user_agents"].add(user_agent[:100])  # 길이 제한
        user_data["unique_days"].add(today)
        
        # 일일 요청 수 업데이트
        if today not in user_data["daily_requests"]:
            user_data["daily_requests"][today] = 0
        user_data["daily_requests"][today] += 1
        
        # 총 요청 수 증가
        user_data["total_requests"] += 1
        
        # 엔드포인트별 요청 수 업데이트
        if endpoint not in user_data["endpoints"]:
            user_data["endpoints"][endpoint] = 0
        user_data["endpoints"][endpoint] += 1
        
        # Set을 list로 변환 (JSON 직렬화를 위해)
        user_data["ip_addresses"] = list(user_data["ip_addresses"])
        user_data["user_agents"] = list(user_data["user_agents"])
        user_data["unique_days"] = list(user_data["unique_days"])
        
        # 통계 저장
        self.save_stats()
    
    def get_user_summary(self, user_id: str) -> Dict[str, Any]:
        """특정 사용자 요약 정보"""
        if user_id not in self.user_stats:
            return {}
        
        user_data = self.user_stats[user_id]
        return {
            "user_id": user_id,
            "first_seen": user_data["first_seen"],
            "last_seen": user_data["last_seen"],
            "total_requests": user_data["total_requests"],
            "unique_days": len(user_data["unique_days"]),
            "unique_ips": len(user_data["ip_addresses"]),
            "most_used_endpoint": max(user_data["endpoints"].items(), key=lambda x: x[1]) if user_data["endpoints"] else None
        }
    
    def get_daily_stats(self) -> Dict[str, Any]:
        """일별 전체 통계"""
        today = date.today().isoformat()
        daily_stats = {
            "today": today,
            "total_users": len(self.user_stats),
            "active_today": 0,
            "new_users_today": 0,
            "total_requests_today": 0
        }
        
        for user_id, user_data in self.user_stats.items():
            # 오늘 활성 사용자
            if user_data["last_seen"] == today:
                daily_stats["active_today"] += 1
            
            # 오늘 신규 사용자
            if user_data["first_seen"] == today:
                daily_stats["new_users_today"] += 1
            
            # 오늘 총 요청 수
            if today in user_data["daily_requests"]:
                daily_stats["total_requests_today"] += user_data["daily_requests"][today]
        
        return daily_stats
    
    def get_daily_trend(self, days: int = 7) -> Dict[str, Any]:
        """일별 트렌드 (최근 N일)"""
        from datetime import datetime, timedelta
        
        trend_data = {}
        base_date = datetime.now().date()
        
        for i in range(days):
            target_date = (base_date - timedelta(days=i)).isoformat()
            
            day_stats = {
                "date": target_date,
                "active_users": 0,
                "new_users": 0,
                "total_requests": 0,
                "user_list": []
            }
            
            for user_id, user_data in self.user_stats.items():
                # 해당 날짜에 활성
                if target_date in user_data["daily_requests"]:
                    day_stats["active_users"] += 1
                    day_stats["total_requests"] += user_data["daily_requests"][target_date]
                    day_stats["user_list"].append({
                        "user_id": user_id,
                        "requests": user_data["daily_requests"][target_date],
                        "ip": list(user_data["ip_addresses"])[0] if user_data["ip_addresses"] else "unknown"
                    })
                
                # 해당 날짜에 신규
                if user_data["first_seen"] == target_date:
                    day_stats["new_users"] += 1
            
            trend_data[target_date] = day_stats
        
        return trend_data
    
    def get_monthly_trend(self, months: int = 3) -> Dict[str, Any]:
        """월별 트렌드 (최근 N개월)"""
        from datetime import datetime, timedelta
        import calendar
        
        trend_data = {}
        base_date = datetime.now().date()
        
        for i in range(months):
            # 해당 월의 첫째 날
            if i == 0:
                target_date = base_date.replace(day=1)
            else:
                # 이전 월로 이동
                if target_date.month == 1:
                    target_date = target_date.replace(year=target_date.year - 1, month=12, day=1)
                else:
                    target_date = target_date.replace(month=target_date.month - 1, day=1)
            
            month_key = target_date.strftime('%Y-%m')
            
            month_stats = {
                "month": month_key,
                "month_name": target_date.strftime('%Y년 %m월'),
                "active_users": set(),
                "new_users": 0,
                "total_requests": 0,
                "daily_breakdown": {}
            }
            
            # 해당 월의 모든 날짜 확인
            for user_id, user_data in self.user_stats.items():
                for date_str, requests in user_data["daily_requests"].items():
                    if date_str.startswith(month_key):
                        month_stats["active_users"].add(user_id)
                        month_stats["total_requests"] += requests
                        
                        if date_str not in month_stats["daily_breakdown"]:
                            month_stats["daily_breakdown"][date_str] = {"users": set(), "requests": 0}
                        
                        month_stats["daily_breakdown"][date_str]["users"].add(user_id)
                        month_stats["daily_breakdown"][date_str]["requests"] += requests
                
                # 신규 사용자 확인
                if user_data["first_seen"].startswith(month_key):
                    month_stats["new_users"] += 1
            
            # Set을 숫자로 변환
            month_stats["active_users"] = len(month_stats["active_users"])
            
            # daily_breakdown의 set을 숫자로 변환
            for day_key in month_stats["daily_breakdown"]:
                month_stats["daily_breakdown"][day_key]["users"] = len(month_stats["daily_breakdown"][day_key]["users"])
            
            trend_data[month_key] = month_stats
        
        return trend_data

# 전역 인스턴스
logger_instance = AccessLogger()
