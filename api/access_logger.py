#!/usr/bin/env python3
# -*- coding: utf-8 -*-

import logging
import json
from datetime import datetime, timedelta
from pathlib import Path
from collections import defaultdict, Counter
from fastapi import Request
from typing import Dict, List, Any, Optional

# 로그 디렉터리 생성
LOG_DIR = Path("logs")
LOG_DIR.mkdir(exist_ok=True)

# 접속자 로그 파일
ACCESS_LOG_FILE = LOG_DIR / "access.log"
STATS_LOG_FILE = LOG_DIR / "stats.json"

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
        self.stats_data: Dict[str, Any] = self._load_stats()
    
    def _load_stats(self) -> Dict[str, Any]:
        """통계 데이터 로드"""
        if STATS_LOG_FILE.exists():
            try:
                with open(STATS_LOG_FILE, 'r', encoding='utf-8') as f:
                    return json.load(f)
            except Exception:
                pass
        return {
            "users": {},
            "daily_stats": {},
            "monthly_stats": {}
        }
    
    def _save_stats(self):
        """통계 데이터 저장"""
        try:
            with open(STATS_LOG_FILE, 'w', encoding='utf-8') as f:
                json.dump(self.stats_data, f, ensure_ascii=False, indent=2)
        except Exception as e:
            print(f"통계 저장 실패: {e}")
    
    def log_access(self, request: Request, endpoint: str, status_code: int = 200):
        """테이블 형식 접속 로그 기록"""
        client_ip = self.get_client_ip(request)
        method = request.method
        timestamp = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
        
        # 테이블 형식 로그 생성
        self._log_table_format(timestamp, client_ip, method, endpoint, status_code)
        
        # 통계 업데이트
        self._update_stats(client_ip, endpoint, method)
    
    def _log_table_format(self, timestamp: str, ip: str, method: str, endpoint: str, status_code: int):
        """테이블 형식 로그 출력"""
        # 메서드별 색상
        method_colors = {
            'GET': '\033[96m',     # 밝은 청록색
            'POST': '\033[95m',    # 밝은 마젠타색
            'PUT': '\033[94m',     # 밝은 파란색
            'DELETE': '\033[91m'   # 밝은 빨간색
        }
        method_color = method_colors.get(method, '\033[97m')
        
        # 상태 코드별 색상
        if 200 <= status_code < 300:
            status_color = '\033[92m'  # 초록색
        elif 300 <= status_code < 400:
            status_color = '\033[94m'  # 파란색
        elif 400 <= status_code < 500:
            status_color = '\033[93m'  # 노란색
        else:
            status_color = '\033[91m'  # 빨간색
        
        # 컬럼 너비 고정
        log_type = f"{'ACCESS:':<7}"
        timestamp_col = f"{timestamp:<19}"
        ip_col = f"{ip:<15}"
        method_col = f"{method:<6}"
        status_col = f"{status_code:<3}"
        
        # 테이블 형식 로그 메시지
        log_message = (
            f"\033[93m{log_type}\033[0m {timestamp_col} "
            f"\033[90m{ip_col}\033[0m {method_color}{method_col}\033[0m "
            f"{endpoint:<30} {status_color}{status_col}\033[0m"
        )
        
        access_logger.info(log_message)
        
        # INFO 로그도 동일한 형식으로 출력
        info_message = (
            f"\033[94mINFO:  \033[0m {timestamp_col} "
            f"\033[90m{ip_col}\033[0m {method_color}{method_col}\033[0m "
            f"{endpoint:<30} {status_color}{status_col}\033[0m"
        )
        access_logger.info(info_message)
    
    def _update_stats(self, ip: str, endpoint: str, method: str):
        """통계 업데이트"""
        today = datetime.now().strftime('%Y-%m-%d')
        user_id = ip  # IP를 사용자 ID로 사용
        
        # 사용자별 통계
        if user_id not in self.stats_data["users"]:
            self.stats_data["users"][user_id] = {
                "primary_ip": ip,
                "ip_addresses": [ip],
                "total_requests": 0,
                "unique_days": [],
                "first_seen": today,
                "last_seen": today,
                "daily_requests": {},
                "endpoints": {}
            }
        
        user_data = self.stats_data["users"][user_id]
        user_data["total_requests"] += 1
        user_data["last_seen"] = today
        
        if ip not in user_data["ip_addresses"]:
            user_data["ip_addresses"].append(ip)
        
        if today not in user_data["unique_days"]:
            user_data["unique_days"].append(today)
        
        if today not in user_data["daily_requests"]:
            user_data["daily_requests"][today] = 0
        user_data["daily_requests"][today] += 1
        
        if endpoint not in user_data["endpoints"]:
            user_data["endpoints"][endpoint] = 0
        user_data["endpoints"][endpoint] += 1
        
        # 일별 통계
        if today not in self.stats_data["daily_stats"]:
            self.stats_data["daily_stats"][today] = {
                "active_users": set(),
                "new_users": set(),
                "total_requests": 0
            }
        
        daily = self.stats_data["daily_stats"][today]
        daily["active_users"].add(user_id)
        daily["total_requests"] += 1
        
        # 신규 사용자 체크
        if user_data["first_seen"] == today:
            daily["new_users"].add(user_id)
        
        # 세트를 리스트로 변환 (JSON 직렬화용)
        daily["active_users"] = list(daily["active_users"])
        daily["new_users"] = list(daily["new_users"])
        
        # 월별 통계
        month = today[:7]  # YYYY-MM
        if month not in self.stats_data["monthly_stats"]:
            self.stats_data["monthly_stats"][month] = {
                "active_users": set(),
                "new_users": set(),
                "total_requests": 0,
                "month_name": datetime.strptime(month + "-01", "%Y-%m-%d").strftime("%Y년 %m월")
            }
        
        monthly = self.stats_data["monthly_stats"][month]
        monthly["active_users"].add(user_id)
        monthly["total_requests"] += 1
        
        if user_data["first_seen"].startswith(month):
            monthly["new_users"].add(user_id)
        
        # 세트를 리스트로 변환
        monthly["active_users"] = list(monthly["active_users"])
        monthly["new_users"] = list(monthly["new_users"])
        
        # 통계 저장
        self._save_stats()
    
    def get_client_ip(self, request: Request) -> str:
        """실제 클라이언트 IP 추출 (프록시 고려)"""
        forwarded_for = request.headers.get("x-forwarded-for")
        if forwarded_for:
            return forwarded_for.split(",")[0].strip()
        
        real_ip = request.headers.get("x-real-ip")
        if real_ip:
            return real_ip
        
        return request.client.host if request.client else "unknown"
    
    # 통계 API 메서드들
    def get_daily_stats(self) -> Dict[str, Any]:
        """일별 통계 조회"""
        today = datetime.now().strftime('%Y-%m-%d')
        today_data = self.stats_data["daily_stats"].get(today, {
            "active_users": [],
            "new_users": [],
            "total_requests": 0
        })
        
        return {
            "total_users": len(self.stats_data["users"]),
            "active_today": len(today_data["active_users"]),
            "new_users_today": len(today_data["new_users"]),
            "total_requests_today": today_data["total_requests"]
        }
    
    def get_daily_trend(self, days: int = 7) -> Dict[str, Any]:
        """일별 트렌드 통계"""
        end_date = datetime.now()
        trend_data = {}
        
        for i in range(days):
            date = (end_date - timedelta(days=i)).strftime('%Y-%m-%d')
            daily_data = self.stats_data["daily_stats"].get(date, {
                "active_users": [],
                "new_users": [],
                "total_requests": 0
            })
            
            trend_data[date] = {
                "active_users": len(daily_data["active_users"]),
                "new_users": len(daily_data["new_users"]),
                "total_requests": daily_data["total_requests"]
            }
        
        return trend_data
    
    def get_monthly_trend(self, months: int = 3) -> Dict[str, Any]:
        """월별 트렌드 통계"""
        end_date = datetime.now()
        trend_data = {}
        
        for i in range(months):
            date = end_date.replace(day=1) - timedelta(days=i*30)
            month = date.strftime('%Y-%m')
            monthly_data = self.stats_data["monthly_stats"].get(month, {
                "active_users": [],
                "new_users": [],
                "total_requests": 0,
                "month_name": date.strftime("%Y년 %m월")
            })
            
            trend_data[month] = {
                "active_users": len(monthly_data["active_users"]),
                "new_users": len(monthly_data["new_users"]),
                "total_requests": monthly_data["total_requests"],
                "month_name": monthly_data["month_name"]
            }
        
        return trend_data
    
    def get_users_stats(self) -> Dict[str, Any]:
        """사용자 통계"""
        users = []
        for user_id, data in self.stats_data["users"].items():
            users.append({
                "user_id": user_id,
                "display_name": user_id,
                "primary_ip": data["primary_ip"],
                "total_requests": data["total_requests"],
                "unique_days": len(data["unique_days"]),
                "last_seen": data["last_seen"]
            })
        
        # 총 요청 수로 정렬
        users.sort(key=lambda x: x["total_requests"], reverse=True)
        
        return {
            "total_users": len(users),
            "users": users[:50]  # 상위 50명
        }
    
    def get_recent_users(self) -> Dict[str, Any]:
        """최근 24시간 활성 사용자"""
        yesterday = (datetime.now() - timedelta(days=1)).strftime('%Y-%m-%d')
        today = datetime.now().strftime('%Y-%m-%d')
        
        recent_users = []
        for user_id, data in self.stats_data["users"].items():
            if data["last_seen"] >= yesterday:
                # 최근 접속 시간 계산
                last_access = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
                
                recent_users.append({
                    "user_id": user_id,
                    "display_name": user_id,
                    "primary_ip": data["primary_ip"],
                    "total_requests": data.get("daily_requests", {}).get(today, 0),
                    "last_access": last_access
                })
        
        # 요청 수로 정렬
        recent_users.sort(key=lambda x: x["total_requests"], reverse=True)
        
        return {
            "total_recent": len(recent_users),
            "recent_users": recent_users[:20]  # 상위 20명
        }
    
    def get_user_detail(self, user_id: str) -> Optional[Dict[str, Any]]:
        """특정 사용자 상세 정보"""
        if user_id not in self.stats_data["users"]:
            return None
        
        return self.stats_data["users"][user_id]

# 전역 인스턴스
logger_instance = AccessLogger()