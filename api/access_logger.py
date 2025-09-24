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
        self.active_sessions: Dict[str, Dict[str, Any]] = {}  # IP -> 세션 정보
        self.session_timeout = 300  # 5분 (초) - 테스트용으로 짧게 설정
    
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
        # stats 관련 요청은 로깅하지 않음
        if '/api/stats' in endpoint or endpoint == '/stats' or endpoint.endswith('/stats.html'):
            return
            
        client_ip = self.get_client_ip(request)
        user_cookie = request.cookies.get("session_user") or None
        user_meta = request.cookies.get("session_meta") or "{}"
        
        # 사용자 정보 추출 (계정 | 이름 | 부서)
        display_user = self._format_user_display(user_cookie, user_meta, client_ip)
        
        method = request.method
        timestamp = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
        
        # 추가 정보 추출
        extra_info = self._extract_extra_info(request, endpoint, method)
        
        # 테이블 형식 로그 생성 (사용자 정보 표시)
        self._log_table_format(timestamp, display_user, method, endpoint, status_code, extra_info)
        
        # 통계 업데이트 (계정 기준 우선)
        import json
        try:
            user_meta_dict = json.loads(user_meta) if user_meta and user_meta != "{}" else {}
        except:
            user_meta_dict = {}
        self._update_stats(client_ip, endpoint, method, user_id_override=user_cookie, meta=user_meta_dict)
    
    def _format_user_display(self, user_cookie: str, user_meta_json: str, client_ip: str) -> str:
        """사용자 정보를 '계정 | 이름 | 부서' 형태로 포맷"""
        try:
            import json
            user_meta = json.loads(user_meta_json) if user_meta_json and user_meta_json != "{}" else {}
            
            # 계정 정보 추출
            account = ""
            if user_cookie:
                # user_cookie가 "account@pc" 형태인 경우
                if "@" in user_cookie:
                    account = user_cookie.split("@")[0]
                else:
                    account = user_cookie
            
            # 메타데이터에서 계정이 더 정확할 수 있음
            if not account and user_meta:
                account = (user_meta.get("LoginId") or 
                          user_meta.get("account") or 
                          user_meta.get("employee_id") or "")
            
            # 이름 정보 추출
            name = ""
            if user_meta:
                name = (user_meta.get("Username") or 
                       user_meta.get("username") or 
                       user_meta.get("name") or 
                       user_meta.get("display_name") or "")
            
            # 부서 정보 추출
            department = ""
            if user_meta:
                department = (user_meta.get("DeptName") or 
                             user_meta.get("department_name") or 
                             user_meta.get("department") or "")
            
            # 직급 정보 추출
            position = ""
            if user_meta:
                position = (user_meta.get("GrdName_EN") or 
                           user_meta.get("position") or "")
            
            # 이름에 직급 정보 추가
            name_with_position = name
            if name and position:
                name_with_position = f"{name}({position})"
            
            # 형태별 표시 우선순위
            if account and name_with_position and department:
                return f"{account} | {name_with_position} | {department}"
            elif account and name_with_position:
                return f"{account} | {name_with_position}"
            elif account:
                return account
            else:
                return client_ip
                
        except Exception:
            return user_cookie or client_ip
    
    def _extract_extra_info(self, request: Request, endpoint: str, method: str) -> str:
        """요청에서 파일명, 클래스명 등 추가 정보 추출"""
        import urllib.parse
        
        query_params = dict(request.query_params)
        
        # 이미지/썸네일 요청에서 경로 정보 추출
        if endpoint.startswith('/api/image') or endpoint.startswith('/api/thumbnail'):
            path = query_params.get('path', '')
            if path:
                # 경로 정보 표시 - 최대 4개 폴더까지 표시
                path_parts = path.split('/')
                if len(path_parts) >= 5:
                    # 5개 이상: 상위3개폴더/파일명
                    path_display = f"{path_parts[-4]}/{path_parts[-3]}/{path_parts[-2]}/{path_parts[-1]}"
                elif len(path_parts) == 4:
                    # 4개: 상위2개폴더/파일명
                    path_display = f"{path_parts[-3]}/{path_parts[-2]}/{path_parts[-1]}"
                elif len(path_parts) == 3:
                    # 3개: 상위폴더/파일명
                    path_display = f"{path_parts[-2]}/{path_parts[-1]}"
                elif len(path_parts) == 2:
                    # 2개: 폴더/파일명
                    path_display = f"{path_parts[-2]}/{path_parts[-1]}"
                elif len(path_parts) == 1:
                    # 1개: 파일명만
                    path_display = path_parts[-1]
                else:
                    path_display = path
                
                return f"[{path_display}]"
        
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
        
        # 완벽한 테이블 정렬 - 모든 컬럼 고정 너비
        log_type = f"{log_type_name:<3}"     # 3자리 (API, PAGE, FILE 등)
        timestamp_col = f"{timestamp:<19}"   # 19자리 (YYYY-MM-DD HH:MM:SS)
        user_col = f"{ip:<30}"              # 30자리 (계정 | 이름 | 부서)
        method_col = f"{method:<4}"          # 4자리 (GET, POST, PUT, DEL)
        
        # 상위폴더+파일명 추출 (예: files→folder/image.png)
        endpoint_display = endpoint
        if endpoint.startswith('/api/'):
            endpoint_display = endpoint[5:]  # /api/ 제거
            
            # path 파라미터에서 파일 정보 추출 (query string이 있든 없든)
            if 'path=' in endpoint:
                import urllib.parse
                try:
                    path_param = endpoint.split('path=')[1].split('&')[0]
                    decoded_path = urllib.parse.unquote(path_param)
                    
                    # base_endpoint 추출
                    if '?' in endpoint_display:
                        base_endpoint = endpoint_display.split('?')[0]
                    else:
                        base_endpoint = endpoint_display
                    
                    # 경로 정보 표시 - 최대 4개 폴더까지 표시
                    path_parts = decoded_path.split('/')
                    if len(path_parts) >= 5:
                        # 5개 이상: 상위3개폴더/파일명
                        endpoint_display = f"{base_endpoint}→{path_parts[-4]}/{path_parts[-3]}/{path_parts[-2]}/{path_parts[-1]}"
                    elif len(path_parts) == 4:
                        # 4개: 상위2개폴더/파일명
                        endpoint_display = f"{base_endpoint}→{path_parts[-3]}/{path_parts[-2]}/{path_parts[-1]}"
                    elif len(path_parts) == 3:
                        # 3개: 상위폴더/파일명
                        endpoint_display = f"{base_endpoint}→{path_parts[-2]}/{path_parts[-1]}"
                    elif len(path_parts) == 2:
                        # 2개: 폴더/파일명
                        endpoint_display = f"{base_endpoint}→{path_parts[-2]}/{path_parts[-1]}"
                    elif len(path_parts) == 1:
                        # 1개: 파일명만
                        endpoint_display = f"{base_endpoint}→{path_parts[-1]}"
                except:
                    # path 파라미터 추출 실패시 원본 유지
                    pass
        
        endpoint_col = f"{endpoint_display:<25}"  # 25자리로 조정
        status_col = f"{status_code:>3}"         # 3자리 (우측 정렬)
        
        # 추가 정보가 있으면 표시
        extra_part = f" {extra_info}" if extra_info else ""
        
        # 🎯 완벽한 테이블 정렬 - 색상 코드 길이 정확히 계산
        # 색상 코드 길이: \033[XXm = 5자리, \033[0m = 4자리
        type_with_color = f"{type_color}{log_type}\033[0m"
        user_with_color = f"\033[90m{user_col}\033[0m"
        method_with_color = f"{method_color}{method_col}\033[0m"
        status_with_color = f"{status_color}{status_col}\033[0m"
        
        # 🎯 완벽한 테이블 정렬 - 색상 코드 길이 보정
        # 실제 텍스트 길이만 고려하여 정렬 (색상 코드는 무시)
        type_padded = f"{type_with_color:<8}"   # API(3) + 색상코드(9) = 8자리
        user_padded = f"{user_with_color:<35}"  # 사용자정보(30) + 색상코드(9) = 35자리  
        method_padded = f"{method_with_color:<8}"  # GET(3) + 색상코드(9) = 8자리
        status_padded = f"{status_with_color:>6}"  # 200(3) + 색상코드(9) = 6자리 (우측정렬)
        
        # 🎯 완벽한 정렬 - 모든 컬럼이 고정 위치에
        message = (
            f"{type_padded}  {timestamp_col}  "  # 타입-시간 간 여백 2칸
            f"{user_padded}  {method_padded}  "  # 사용자-메서드 간 여백 2칸
            f"{endpoint_col}  {status_padded}{extra_part}"  # 엔드포인트-상태 간 여백 2칸
        )
        
        # 콘솔에 테이블 형식으로 출력 (중복 방지)
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
    
    def _update_stats(self, ip: str, endpoint: str, method: str, user_id_override: Optional[str] = None, meta: Optional[Dict[str, Any]] = None):
        """통계 업데이트 - 세션 관리 포함"""
        # localhost IP 제외
        if ip in ['127.0.0.1', '::1', 'localhost']:
            return
            
        today = datetime.now().strftime('%Y-%m-%d')
        now_timestamp = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
        now_unix = time.time()
        # 계정 기반 사용자 식별: override 우선, 없으면 IP
        user_id = (user_id_override or ip)
        profile_meta: Dict[str, Any] = {}
        if user_id and '@' in user_id:
            try:
                account, pc = user_id.split('@', 1)
                profile_meta["account"] = account
                profile_meta["pc"] = pc
            except Exception:
                pass
        if meta and isinstance(meta, dict):
            # 기본 필드들
            for k in ("company", "department", "team", "title", "email", "account", "pc", "name"):
                v = meta.get(k)
                if v:
                    profile_meta[k] = v
            # 사내 전용 필드들 추가
            for k in ("login_id", "department_id", "employee_id", "department_name", "grade", "grade_en", 
                     "username", "display_name", "client_ip", "forwarded_client_ip"):
                v = meta.get(k)
                if v:
                    profile_meta[k] = v
        
        # 초 단위 중복 요청 체크 (같은 시분초에 같은 IP면 제외)
        second_timestamp = int(now_unix)  # 초 단위로 그룹핑
        second_key = f"{ip}_{second_timestamp}"  # 엔드포인트 제외, IP와 초만 사용
        
        # 초 단위 캐시 초기화
        if not hasattr(self, '_second_requests'):
            self._second_requests = {}
            self._last_cache_cleanup = now_unix
        
        # 1분마다 초 단위 캐시 정리
        if now_unix - self._last_cache_cleanup > 60:
            self._second_requests.clear()
            self._last_cache_cleanup = now_unix
        
        # 같은 초에 같은 IP 요청이면 무시
        if second_key in self._second_requests:
            return
        
        self._second_requests[second_key] = now_unix
        
        # 세션 관리
        self._update_session(ip, now_unix, endpoint)
        
        # 사용자별 통계
        if user_id not in self.stats_data["users"]:
            self.stats_data["users"][user_id] = {
                "primary_ip": ip,
                "ip_addresses": [ip],
                "total_requests": 0,
                "unique_days": [],
                "first_seen": today,
                "last_seen": today,
                "last_access_time": now_timestamp,
                "first_access_time": now_timestamp,
                "session_count": 0,  # 총 세션 수
                "total_session_time": 0,  # 총 세션 시간 (초)
                "current_session_start": now_timestamp,  # 현재 세션 시작 시간
                "daily_requests": {},
                "endpoints": {},
                "sessions": [],  # 세션 히스토리
                "profile": {}
            }
        
        user_data = self.stats_data["users"][user_id]
        if "profile" not in user_data:
            user_data["profile"] = {}
        if profile_meta:
            for k, v in profile_meta.items():
                if v:
                    user_data["profile"][k] = v
        # 기존 사용자에 최초 접속 시간이 없다면 보정
        if "first_access_time" not in user_data:
            user_data["first_access_time"] = now_timestamp

        user_data["total_requests"] += 1
        user_data["last_seen"] = today
        user_data["last_access_time"] = now_timestamp
        
        # 기존 사용자에게 새로운 필드 추가
        if "session_count" not in user_data:
            user_data["session_count"] = 0
        if "total_session_time" not in user_data:
            user_data["total_session_time"] = 0
        if "current_session_start" not in user_data:
            user_data["current_session_start"] = now_timestamp
        if "sessions" not in user_data:
            user_data["sessions"] = []
        
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
                "total_requests": 0,
                "by_department": {},
                "by_team": {},
                "by_company": {},
                "by_org_url": {}
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
                "month_name": datetime.strptime(month + "-01", "%Y-%m-%d").strftime("%Y년 %m월"),
                "by_department": {},
                "by_team": {},
                "by_company": {},
                "by_org_url": {}
            }
        
        monthly = self.stats_data["monthly_stats"][month]
        
        # 중복 제거하며 추가
        if user_id not in monthly["active_users"]:
            monthly["active_users"].append(user_id)
        monthly["total_requests"] += 1
        
        if user_data["first_seen"].startswith(month):
            if user_id not in monthly["new_users"]:
                monthly["new_users"].append(user_id)
        # 부서/팀/회사 카운트
        dept = user_data.get("profile", {}).get("department")
        team = user_data.get("profile", {}).get("team")
        company = user_data.get("profile", {}).get("company")
        if dept:
            daily["by_department"][dept] = daily["by_department"].get(dept, 0) + 1
            monthly["by_department"][dept] = monthly["by_department"].get(dept, 0) + 1
        if team:
            daily["by_team"][team] = daily["by_team"].get(team, 0) + 1
            monthly["by_team"][team] = monthly["by_team"].get(team, 0) + 1
        if company:
            daily["by_company"][company] = daily["by_company"].get(company, 0) + 1
            monthly["by_company"][company] = monthly["by_company"].get(company, 0) + 1
        org_url = user_data.get("profile", {}).get("org_url")
        if org_url:
            daily.setdefault("by_org_url", {})
            monthly.setdefault("by_org_url", {})
            daily["by_org_url"][org_url] = daily["by_org_url"].get(org_url, 0) + 1
            monthly["by_org_url"][org_url] = monthly["by_org_url"].get(org_url, 0) + 1
        
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
    
    def _update_session(self, ip: str, now_unix: float, endpoint: str):
        """세션 업데이트 - 접속/재접속/세션 종료 관리"""
        # localhost IP 제외
        if ip in ['127.0.0.1', '::1', 'localhost']:
            return
            
        # 세션 타임아웃된 사용자 정리
        self._cleanup_expired_sessions(now_unix)
        
        # 현재 사용자 세션 확인
        if ip in self.active_sessions:
            # 기존 세션 업데이트
            session = self.active_sessions[ip]
            session["last_activity"] = now_unix
            session["request_count"] += 1
            session["last_endpoint"] = endpoint
            
            # 사용자 데이터의 현재 세션 시간 업데이트
            if ip in self.stats_data["users"]:
                user_data = self.stats_data["users"][ip]
                session_duration = now_unix - session["start_time"]
                user_data["current_session_duration"] = int(session_duration)
                
                # 세션 관련 정보만 업데이트 (통계는 _update_stats에서 처리)
                user_data["last_seen"] = datetime.now().strftime('%Y-%m-%d')
                user_data["last_access_time"] = datetime.fromtimestamp(now_unix).strftime('%Y-%m-%d %H:%M:%S')
        else:
            # 새 세션 시작
            self.active_sessions[ip] = {
                "start_time": now_unix,
                "last_activity": now_unix,
                "request_count": 1,
                "last_endpoint": endpoint,
                "session_id": f"{ip}_{int(now_unix)}"
            }
            
            # 사용자 데이터에 새 세션 기록 (사용자가 없으면 생성)
            if ip not in self.stats_data["users"]:
                # 새 사용자 생성
                today = datetime.now().strftime('%Y-%m-%d')
                now_timestamp = datetime.fromtimestamp(now_unix).strftime('%Y-%m-%d %H:%M:%S')
                self.stats_data["users"][ip] = {
                    "primary_ip": ip,
                    "ip_addresses": [ip],
                    "total_requests": 0,
                    "unique_days": [],
                    "first_seen": today,
                    "last_seen": today,
                    "last_access_time": now_timestamp,
                    "session_count": 0,
                    "total_session_time": 0,
                    "current_session_start": now_timestamp,
                    "daily_requests": {},
                    "endpoints": {},
                    "sessions": []
                }
            
            user_data = self.stats_data["users"][ip]
            user_data["session_count"] += 1
            user_data["current_session_start"] = datetime.fromtimestamp(now_unix).strftime('%Y-%m-%d %H:%M:%S')
            user_data["current_session_duration"] = 0
            
            # 세션 관련 정보만 업데이트 (통계는 _update_stats에서 처리)
            user_data["last_seen"] = datetime.now().strftime('%Y-%m-%d')
            user_data["last_access_time"] = datetime.fromtimestamp(now_unix).strftime('%Y-%m-%d %H:%M:%S')
            
            # 세션 히스토리에 추가
            session_info = {
                "session_id": f"{ip}_{int(now_unix)}",
                "start_time": datetime.fromtimestamp(now_unix).strftime('%Y-%m-%d %H:%M:%S'),
                "end_time": None,  # 아직 진행 중
                "duration": 0,
                "request_count": 1,
                "last_endpoint": endpoint
            }
            user_data["sessions"].append(session_info)
            
            # 최근 100개 세션만 유지
            if len(user_data["sessions"]) > 100:
                user_data["sessions"] = user_data["sessions"][-100:]
    
    def _cleanup_expired_sessions(self, now_unix: float):
        """만료된 세션 정리 및 세션 종료 기록"""
        expired_ips = []
        
        for ip, session in self.active_sessions.items():
            if now_unix - session["last_activity"] > self.session_timeout:
                # 세션 종료 기록
                self._record_session_end(ip, session, now_unix)
                expired_ips.append(ip)
        
        # 만료된 세션 제거
        for ip in expired_ips:
            del self.active_sessions[ip]
    
    def _record_session_end(self, ip: str, session: Dict[str, Any], end_time: float):
        """세션 종료 기록"""
        if ip in self.stats_data["users"]:
            user_data = self.stats_data["users"][ip]
            session_duration = end_time - session["start_time"]
            
            # 총 세션 시간 업데이트
            user_data["total_session_time"] += int(session_duration)
            
            # 세션 히스토리 업데이트
            if "sessions" in user_data:
                for session_info in user_data["sessions"]:
                    if session_info["session_id"] == session["session_id"]:
                        session_info["end_time"] = datetime.fromtimestamp(end_time).strftime('%Y-%m-%d %H:%M:%S')
                        session_info["duration"] = int(session_duration)
                        session_info["request_count"] = session["request_count"]
                        break
    
    def get_active_users(self) -> Dict[str, Any]:
        """현재 활성 사용자 정보"""
        now_unix = time.time()
        self._cleanup_expired_sessions(now_unix)
        
        active_users = []
        for ip, session in self.active_sessions.items():
            # localhost IP 제외
            if ip in ['127.0.0.1', '::1', 'localhost']:
                continue
            session_duration = now_unix - session["start_time"]
            user_data = self.stats_data["users"].get(ip, {})
            
            active_users.append({
                "ip": ip,
                "session_id": session["session_id"],
                "session_start": datetime.fromtimestamp(session["start_time"]).strftime('%Y-%m-%d %H:%M:%S'),
                "session_duration": int(session_duration),
                "request_count": session["request_count"],
                "last_endpoint": session["last_endpoint"],
                "last_activity": datetime.fromtimestamp(session["last_activity"]).strftime('%Y-%m-%d %H:%M:%S'),
                "total_requests": user_data.get("total_requests", 0),
                "unique_days": len(user_data.get("unique_days", [])),
                "first_seen": user_data.get("first_seen", "Unknown")
            })
        
        # 세션 시작 시간으로 정렬 (최신 순)
        active_users.sort(key=lambda x: x["session_start"], reverse=True)
        
        return {
            "total_active": len(active_users),
            "active_users": active_users
        }
    
    # 통계 API 메서드들
    def get_daily_stats(self) -> Dict[str, Any]:
        """일별 통계 조회 - 실시간 활성 사용자 포함"""
        today = datetime.now().strftime('%Y-%m-%d')
        today_data = self.stats_data["daily_stats"].get(today, {
            "active_users": [],
            "new_users": [],
            "total_requests": 0
        })
        
        # 현재 활성 사용자 수
        active_users_info = self.get_active_users()
        
        return {
            "total_users": len(self.stats_data["users"]),
            "active_today": len(today_data["active_users"]) if isinstance(today_data["active_users"], list) else today_data["active_users"],
            "currently_active": active_users_info["total_active"],
            "new_users_today": len(today_data["new_users"]) if isinstance(today_data["new_users"], list) else today_data["new_users"],
            "total_requests_today": today_data["total_requests"],
            "active_users_detail": active_users_info["active_users"][:10]  # 상위 10명
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
                "active_users": len(daily_data["active_users"]) if isinstance(daily_data["active_users"], list) else daily_data["active_users"],
                "new_users": len(daily_data["new_users"]) if isinstance(daily_data["new_users"], list) else daily_data["new_users"],
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
                "active_users": len(monthly_data["active_users"]) if isinstance(monthly_data["active_users"], list) else monthly_data["active_users"],
                "new_users": len(monthly_data["new_users"]) if isinstance(monthly_data["new_users"], list) else monthly_data["new_users"],
                "total_requests": monthly_data["total_requests"],
                "month_name": monthly_data["month_name"]
            }
        
        return trend_data
    
    def get_users_stats(self) -> Dict[str, Any]:
        """사용자 통계 - 세션 정보 포함"""
        users = []
        for user_id, data in self.stats_data["users"].items():
            # localhost IP 제외
            if user_id in ['127.0.0.1', '::1', 'localhost']:
                continue
            # 현재 세션 상태 확인
            is_active = user_id in self.active_sessions
            current_session_duration = 0
            if is_active:
                now_unix = time.time()
                session = self.active_sessions[user_id]
                current_session_duration = int(now_unix - session["start_time"])
            
            # 사용자 프로필 정보 추출 (사내 claim 우선)
            profile = data.get("profile", {})
            # 계정: LoginId > employee_id > login_id > account > user_id에서 IP 추출
            account = (profile.get("login_id") or profile.get("employee_id") or 
                      profile.get("account") or profile.get("LoginId") or 
                      profile.get("name") or user_id)
            # 이름: Username > username > name
            name = (profile.get("Username") or profile.get("username") or 
                   profile.get("name") or profile.get("display_name") or "")
            # 부서: DeptName > department_name > department
            department = (profile.get("DeptName") or profile.get("department_name") or 
                         profile.get("department", ""))
            # 직급: GrdName_EN > position
            position = (profile.get("GrdName_EN") or profile.get("position", ""))
            
            # 디스플레이명 구성: "계정 | 이름(직급) | 부서 | IP"
            display_parts = []
            # 계정 정보가 있으면 추가
            if account and account != user_id:
                display_parts.append(account)
            # 이름 정보가 있으면 추가 (직급 포함)
            if name and name != account:
                name_with_position = name
                if position:
                    name_with_position = f"{name}({position})"
                display_parts.append(name_with_position)
            # 부서 정보가 있으면 추가
            if department:
                display_parts.append(department)
            # 항상 IP 추가
            display_parts.append(data["primary_ip"])
            
            # 항상 format된 문자열 사용 (최소한 IP는 포함)
            display_name = " | ".join(display_parts)
            
            users.append({
                "user_id": user_id,
                "display_name": display_name,
                "primary_ip": data["primary_ip"],
                "total_requests": data["total_requests"],
                "unique_days": len(data["unique_days"]),
                "last_seen": data["last_seen"],
                "last_access_time": data.get("last_access_time", data["last_seen"]),
                "name": name,
                "department": department,
                "position": position,
                "session_count": data.get("session_count", 0),
                "total_session_time": data.get("total_session_time", 0),
                "avg_session_time": round(data.get("total_session_time", 0) / max(data.get("session_count", 1), 1), 1),
                "is_active": is_active,
                "current_session_duration": current_session_duration,
                "current_session_start": data.get("current_session_start", "Unknown")
            })
        
        # 접속일수 내림차순 → 마지막 접속일 내림차순
        def _parse_access_time(access_time_str: str) -> float:
            try:
                # ISO 또는 'YYYY-MM-DD HH:MM:SS'
                try:
                    return datetime.fromisoformat(access_time_str.replace('Z','')).timestamp()
                except Exception:
                    return datetime.strptime(access_time_str, "%Y-%m-%d %H:%M:%S").timestamp()
            except Exception:
                return 0.0
        
        users.sort(key=lambda x: (x["unique_days"], _parse_access_time(x["last_access_time"])), reverse=True)
        
        return {
            "total_users": len(users),
            "users": users  # 전체 사용자
        }

    def get_breakdown_stats(self, category: str = "department", days: int = 7) -> Dict[str, Any]:
        """부서/팀/회사/org_url 별 집계
        category: department|team|company|org_url
        """
        end_date = datetime.now()
        counts: Dict[str, int] = {}
        for i in range(days):
            date = (end_date - timedelta(days=i)).strftime('%Y-%m-%d')
            daily = self.stats_data["daily_stats"].get(date)
            if not daily: continue
            key = f"by_{category}"
            bucket = daily.get(key, {})
            for k, v in bucket.items():
                counts[k] = counts.get(k, 0) + int(v)
        # 상위 50만 반환
        items = sorted(counts.items(), key=lambda x: x[1], reverse=True)[:50]
        return {"category": category, "days": days, "items": items}
    
    def get_recent_users(self) -> Dict[str, Any]:
        """모든 사용자 (마지막 접속순 내림차순)"""
        
        recent_users = []
        for user_id, data in self.stats_data["users"].items():
            # localhost IP 제외
            if user_id in ['127.0.0.1', '::1', 'localhost']:
                continue
            
            # 실제 저장된 마지막 접속 시간 사용
            last_access = data.get("last_access_time", data["last_seen"])
            
            # 사용자 프로필 정보 추출 (사내 claim 우선)
            profile = data.get("profile", {})
            # 계정: LoginId > employee_id > login_id > account > user_id
            account = (profile.get("login_id") or profile.get("employee_id") or 
                      profile.get("account") or profile.get("LoginId") or 
                      profile.get("name") or user_id)
            # 이름: Username > username > name
            name = (profile.get("Username") or profile.get("username") or 
                   profile.get("name") or profile.get("display_name") or "")
            # 부서: DeptName > department_name > department
            department = (profile.get("DeptName") or profile.get("department_name") or 
                         profile.get("department", ""))
            # 직급: GrdName_EN > position
            position = (profile.get("GrdName_EN") or profile.get("position", ""))
            
            # 디스플레이명 구성: "계정 | 이름(직급) | 부서 | IP"
            display_parts = []
            # 계정 정보가 있으면 추가
            if account and account != user_id:
                display_parts.append(account)
            # 이름 정보가 있으면 추가 (직급 포함)
            if name and name != account:
                name_with_position = name
                if position:
                    name_with_position = f"{name}({position})"
                display_parts.append(name_with_position)
            # 부서 정보가 있으면 추가
            if department:
                display_parts.append(department)
            # 항상 IP 추가
            display_parts.append(data["primary_ip"])
            
            # 항상 format된 문자열 사용 (최소한 IP는 포함)
            display_name = " | ".join(display_parts)
            
            recent_users.append({
                "user_id": user_id,
                "display_name": display_name,
                "primary_ip": data["primary_ip"],
                "total_requests": data["total_requests"],  # 전체 요청수 사용
                "last_access": last_access,
                "name": name,
                "department": department,
                "position": position
            })
        
        # 마지막 접속 시간으로 정렬 (최신 순, 안정 정렬)
        def _parse_ts(val: str) -> float:
            try:
                # ISO 또는 'YYYY-MM-DD HH:MM:SS'
                try:
                    return datetime.fromisoformat(val.replace('Z','')).timestamp()
                except Exception:
                    return datetime.strptime(val, "%Y-%m-%d %H:%M:%S").timestamp()
            except Exception:
                # 날짜만인 경우 자정으로 간주
                try:
                    return datetime.strptime(val, "%Y-%m-%d").timestamp()
                except Exception:
                    return 0.0
        recent_users.sort(key=lambda x: (-_parse_ts(x.get("last_access", "1970-01-01")), -x.get("total_requests", 0)))
        
        return {
            "total_recent": len(recent_users),
            "recent_users": recent_users  # 전체 사용자
        }
    
    def get_user_detail(self, user_id: str) -> Optional[Dict[str, Any]]:
        """특정 사용자 상세 정보"""
        if user_id not in self.stats_data["users"]:
            return None
        
        return self.stats_data["users"][user_id]

# 전역 인스턴스
logger_instance = AccessLogger()