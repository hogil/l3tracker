#!/usr/bin/env python3
# -*- coding: utf-8 -*-

import logging
import json
import time
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

# 로거 설정 - 로깅 시스템 충돌 방지
access_logger = logging.getLogger("access")
access_logger.setLevel(logging.INFO)
access_logger.propagate = False  # 상위 로거로 전파 방지

# 기존 핸들러 제거 (중복 방지)
access_logger.handlers.clear()

# 파일 핸들러 설정
file_handler = logging.FileHandler(ACCESS_LOG_FILE, encoding='utf-8')
file_formatter = logging.Formatter('%(message)s')
file_handler.setFormatter(file_formatter)
access_logger.addHandler(file_handler)

class AccessLogger:
    def __init__(self):
        self.stats_data: Dict[str, Any] = self._load_stats()
        self.recent_api_calls: Dict[str, float] = {}  # IP+endpoint -> timestamp 매핑
    
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
        
        # 추가 정보 추출
        extra_info = self._extract_extra_info(request, endpoint, method)
        
        # 테이블 형식 로그 생성
        self._log_table_format(timestamp, client_ip, method, endpoint, status_code, extra_info)
        
        # 통계 업데이트
        self._update_stats(client_ip, endpoint, method)
    
    def _extract_extra_info(self, request: Request, endpoint: str, method: str) -> str:
        """요청에서 파일명, 클래스명 등 추가 정보 추출"""
        import urllib.parse
        
        query_params = dict(request.query_params)
        
        # 이미지/썸네일 요청에서 파일명 추출
        if endpoint.startswith('/api/image') or endpoint.startswith('/api/thumbnail'):
            path = query_params.get('path', '')
            if path:
                # 파일명만 추출 (경로 제거)
                filename = path.split('/')[-1] if '/' in path else path
                return f"[{filename}]"
        
        # 클래스 관련 요청
        elif '/api/classes/' in endpoint:
            parts = endpoint.split('/api/classes/')
            if len(parts) > 1:
                class_info = parts[1].split('/')[0]
                return f"[{class_info}]"
        
        # POST 요청에서 body 정보 추출 (간단한 정보만)
        elif method in ['POST', 'DELETE']:
            if 'classify' in endpoint:
                return "[분류작업]"
            elif 'classes' in endpoint:
                return "[클래스관리]"
            elif 'labels' in endpoint:
                return "[라벨관리]"
        
        return ""
    
    def _log_table_format(self, timestamp: str, ip: str, method: str, endpoint: str, status_code: int, extra_info: str = ""):
        """완벽한 테이블 형식 로그 출력 - 요청 타입별 구분"""
        # 로그 타입 결정
        log_type_name = self._determine_log_type(endpoint, method)
        
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
        
        # 로그 타입별 색상
        type_colors = {
            'PAGE': '\033[92m',      # 초록색 - 페이지 접속
            'API': '\033[96m',       # 청록색 - API 호출
            'FILE': '\033[93m',      # 노란색 - 파일 요청
            'AUTH': '\033[95m',      # 마젠타색 - 인증 관련
            'ACTION': '\033[91m',    # 빨간색 - 사용자 액션 (클래스/라벨/분류)
            'IMAGE': '\033[94m',     # 파란색 - 이미지 조회
            'ERROR': '\033[91m'      # 빨간색 - 오류
        }
        type_color = type_colors.get(log_type_name, '\033[97m')
        
        # 컴팩트한 컬럼 정렬
        log_type = f"{log_type_name:<3}"     # 3자리 (API, PAGE, FILE 등)
        timestamp_col = timestamp            # 19자리 (YYYY-MM-DD HH:MM:SS)
        ip_col = f"{ip:<15}"                # 15자리
        method_col = f"{method:<4}"          # 4자리 (GET, POST, PUT, DEL)
        
        # 상위폴더+파일명 추출 (예: files→folder/image.png)
        endpoint_display = endpoint
        if endpoint.startswith('/api/'):
            endpoint_display = endpoint[5:]  # /api/ 제거
            if '?' in endpoint_display:
                base_endpoint = endpoint_display.split('?')[0]
                
                # path 파라미터에서 파일 정보 추출
                if 'path=' in endpoint:
                    import urllib.parse
                    try:
                        path_param = endpoint.split('path=')[1].split('&')[0]
                        decoded_path = urllib.parse.unquote(path_param)
                        # 경로 정보 표시 - 더 자세한 경로
                        path_parts = decoded_path.split('/')
                        if len(path_parts) >= 3:
                            # 3개 이상: 상위2개폴더/파일명
                            endpoint_display = f"{base_endpoint}→{path_parts[-3]}/{path_parts[-2]}/{path_parts[-1]}"
                        elif len(path_parts) == 2:
                            # 2개: 상위폴더/파일명
                            endpoint_display = f"{base_endpoint}→{path_parts[-2]}/{path_parts[-1]}"
                        elif len(path_parts) == 1:
                            # 1개: 파일명만
                            endpoint_display = f"{base_endpoint}→{path_parts[-1]}"
                    except:
                        endpoint_display = base_endpoint
                else:
                    endpoint_display = base_endpoint
        
        endpoint_col = f"{endpoint_display:<40}"  # 40자리로 증가 (경로 표시용)
        status_col = f"{status_code:>3}"         # 3자리 (우측 정렬)
        
        # 추가 정보가 있으면 표시
        extra_part = f" {extra_info}" if extra_info else ""
        
        # 컴팩트한 테이블 형식 로그
        message = (
            f"{type_color}{log_type}\033[0m {timestamp_col} "
            f"\033[90m{ip_col}\033[0m {method_color}{method_col}\033[0m "
            f"{endpoint_col} {status_color}{status_col}\033[0m{extra_part}"
        )
        
        # 콘솔에 테이블 형식으로 출력
        print(message)
        
        # 파일에는 단순한 형식으로 저장
        file_message = f"{log_type_name}: {timestamp} {ip:<15} {method:<6} {endpoint:<30} {status_code:>3}"
        access_logger.info(file_message)
    
    def _determine_log_type(self, endpoint: str, method: str) -> str:
        """엔드포인트와 메서드에 따라 로그 타입 결정"""
        # 메인 페이지 접속
        if endpoint in ['/', '/stats']:
            return 'PAGE'
        
        # JavaScript/CSS 파일
        elif endpoint.endswith(('.js', '.css', '.html')):
            return 'FILE'
        
        # 인증 관련
        elif any(auth_path in endpoint for auth_path in ['/api/set-username', '/register', '/login', '/auth']):
            return 'AUTH'
        
        # 사용자 액션 (클래스/라벨/분류 작업)
        elif self._is_user_action(endpoint, method):
            return 'ACTION'
        
        # 이미지 조회 (실제 사용자가 이미지를 보는 행위)
        elif endpoint.startswith('/api/image') or endpoint.startswith('/api/thumbnail'):
            return 'IMAGE'
        
        # 일반 API 호출
        elif endpoint.startswith('/api/'):
            return 'API'
        
        # 기타
        else:
            return 'FILE'
    
    def _is_user_action(self, endpoint: str, method: str) -> bool:
        """사용자 액션인지 판단"""
        # POST/DELETE 메서드인 클래스/라벨/분류 작업
        action_endpoints = [
            '/api/classes', '/api/labels', '/api/classify'
        ]
        
        if method in ['POST', 'DELETE']:
            return any(endpoint.startswith(action_ep) for action_ep in action_endpoints)
        
        # 특정 GET 액션들 (이미지 분류 조회 등)
        if method == 'GET':
            if '/api/classes/' in endpoint and '/images' in endpoint:  # 클래스별 이미지 조회
                return True
            if endpoint.startswith('/api/labels/') and len(endpoint) > len('/api/labels/'):  # 특정 이미지 라벨 조회
                return True
        
        return False
    
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
                "active_users": [],
                "new_users": [],
                "total_requests": 0
            }
        
        daily = self.stats_data["daily_stats"][today]
        
        # 중복 제거하며 추가
        if user_id not in daily["active_users"]:
            daily["active_users"].append(user_id)
        daily["total_requests"] += 1
        
        # 신규 사용자 체크
        if user_data["first_seen"] == today:
            if user_id not in daily["new_users"]:
                daily["new_users"].append(user_id)
        
        # 월별 통계
        month = today[:7]  # YYYY-MM
        if month not in self.stats_data["monthly_stats"]:
            self.stats_data["monthly_stats"][month] = {
                "active_users": [],
                "new_users": [],
                "total_requests": 0,
                "month_name": datetime.strptime(month + "-01", "%Y-%m-%d").strftime("%Y년 %m월")
            }
        
        monthly = self.stats_data["monthly_stats"][month]
        
        # 중복 제거하며 추가
        if user_id not in monthly["active_users"]:
            monthly["active_users"].append(user_id)
        monthly["total_requests"] += 1
        
        if user_data["first_seen"].startswith(month):
            if user_id not in monthly["new_users"]:
                monthly["new_users"].append(user_id)
        
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
    
    def should_log_frequent_api(self, client_ip: str, endpoint: str) -> bool:
        """자주 반복되는 API 호출 로깅 제한 (동일 IP+endpoint 조합을 5초간 한 번만 로깅)"""
        now = time.time()
        key = f"{client_ip}:{endpoint}"
        
        # 이전 호출 시간 확인
        last_call = self.recent_api_calls.get(key, 0)
        
        # 5초 내 중복 호출이면 로깅 스킵
        if now - last_call < 5.0:
            return False
        
        # 현재 시간 기록
        self.recent_api_calls[key] = now
        
        # 오래된 기록 정리 (10분 이상 된 것들)
        cutoff = now - 600  # 10분
        self.recent_api_calls = {k: v for k, v in self.recent_api_calls.items() if v > cutoff}
        
        return True
    
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