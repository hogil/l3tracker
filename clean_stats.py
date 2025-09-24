#!/usr/bin/env python3
# -*- coding: utf-8 -*-

import json
import os
from datetime import datetime, timedelta
from collections import defaultdict

def clean_stats_json():
    """stats.json 파일을 정리하고 최적화"""
    
    # 백업 생성
    backup_file = 'logs/stats_backup.json'
    if os.path.exists('logs/stats.json'):
        with open('logs/stats.json', 'r', encoding='utf-8') as f:
            data = json.load(f)
        with open(backup_file, 'w', encoding='utf-8') as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        print(f'백업 생성: {backup_file}')
    else:
        print('stats.json 파일이 없습니다.')
        return
    
    # 데이터 정리
    cleaned_data = {
        "users": {},
        "daily_stats": {},
        "monthly_stats": {}
    }
    
    # 현재 날짜 기준으로 30일 이내 데이터만 유지
    cutoff_date = (datetime.now() - timedelta(days=30)).strftime('%Y-%m-%d')
    print(f'보존 기준 날짜: {cutoff_date} 이후')
    
    users_kept = 0
    users_removed = 0
    
    for user_id, user_data in data.get('users', {}).items():
        # 최근 30일 내 활동이 있는 사용자만 유지
        last_seen = user_data.get('last_seen', '1970-01-01')
        if last_seen >= cutoff_date:
            # 사용자 데이터 정리
            cleaned_user = {
                "primary_ip": user_data.get("primary_ip", user_id),
                "ip_addresses": list(set(user_data.get("ip_addresses", [user_id]))),  # 중복 제거
                "total_requests": user_data.get("total_requests", 0),
                "unique_days": [d for d in user_data.get("unique_days", []) if d >= cutoff_date],
                "first_seen": user_data.get("first_seen"),
                "last_seen": user_data.get("last_seen"),
                "last_access_time": user_data.get("last_access_time", user_data.get("last_seen")),
                "profile": user_data.get("profile", {}),
                "daily_requests": {k: v for k, v in user_data.get("daily_requests", {}).items() if k >= cutoff_date},
                "endpoints": user_data.get("endpoints", {}),
                "session_count": user_data.get("session_count", 0),
                "total_session_time": user_data.get("total_session_time", 0)
            }
            
            # 세션 데이터는 최근 7일만 유지
            session_cutoff = (datetime.now() - timedelta(days=7)).strftime('%Y-%m-%d')
            sessions = user_data.get("sessions", [])
            recent_sessions = []
            for session in sessions:
                session_date = session.get("start_time", "1970-01-01")[:10]
                if session_date >= session_cutoff:
                    recent_sessions.append(session)
            
            if recent_sessions:
                cleaned_user["sessions"] = recent_sessions
            
            cleaned_data["users"][user_id] = cleaned_user
            users_kept += 1
        else:
            users_removed += 1
    
    # 일별/월별 통계도 30일 이내만 유지
    for date, stats in data.get('daily_stats', {}).items():
        if date >= cutoff_date:
            cleaned_data["daily_stats"][date] = stats
    
    for month, stats in data.get('monthly_stats', {}).items():
        # 월별은 6개월까지 유지
        month_cutoff = (datetime.now() - timedelta(days=180)).strftime('%Y-%m')
        if month >= month_cutoff:
            cleaned_data["monthly_stats"][month] = stats
    
    # 정리된 데이터 저장
    with open('logs/stats.json', 'w', encoding='utf-8') as f:
        json.dump(cleaned_data, f, ensure_ascii=False, indent=2)
    
    # 통계 출력
    original_size = os.path.getsize(backup_file)
    new_size = os.path.getsize('logs/stats.json')
    reduction = ((original_size - new_size) / original_size * 100) if original_size > 0 else 0
    
    print('\n=== 정리 완료 ===')
    print(f'사용자: {users_kept}명 유지, {users_removed}명 제거')
    print(f'일별 통계: {len(cleaned_data["daily_stats"])}개')
    print(f'월별 통계: {len(cleaned_data["monthly_stats"])}개')
    print(f'파일 크기: {original_size:,} → {new_size:,} bytes ({reduction:.1f}% 감소)')

def create_sample_data():
    """테스트용 샘플 데이터 생성"""
    print('\n=== 샘플 데이터 생성 ===')
    
    sample_data = {
        "users": {
            "hgchoi@choi": {
                "primary_ip": "127.0.0.1",
                "ip_addresses": ["127.0.0.1"],
                "total_requests": 25,
                "unique_days": ["2025-09-24"],
                "first_seen": "2025-09-24",
                "last_seen": "2025-09-24", 
                "last_access_time": "2025-09-24 10:30:00",
                "profile": {
                    "LoginId": "hgchoi",
                    "Username": "최홍길",
                    "DeptName": "반도체사업부",
                    "company": "삼성전자",
                    "team": "개발팀",
                    "title": "선임연구원",
                    "account": "hgchoi",
                    "pc": "choi"
                },
                "daily_requests": {"2025-09-24": 25},
                "endpoints": {"/": 10, "/api/files": 8, "/api/thumbnail": 7},
                "session_count": 3,
                "total_session_time": 1800
            },
            "testuser@testpc": {
                "primary_ip": "192.168.1.100",
                "ip_addresses": ["192.168.1.100"],
                "total_requests": 15,
                "unique_days": ["2025-09-24"],
                "first_seen": "2025-09-24",
                "last_seen": "2025-09-24",
                "last_access_time": "2025-09-24 11:15:00", 
                "profile": {
                    "LoginId": "testuser",
                    "Username": "테스트사용자",
                    "DeptName": "테스트부서",
                    "company": "테스트회사",
                    "account": "testuser",
                    "pc": "testpc"
                },
                "daily_requests": {"2025-09-24": 15},
                "endpoints": {"/": 8, "/api/files": 4, "/api/thumbnail": 3},
                "session_count": 2,
                "total_session_time": 900
            }
        },
        "daily_stats": {
            "2025-09-24": {
                "active_users": 2,
                "new_users": 2,
                "total_requests": 40,
                "by_department": {"반도체사업부": 25, "테스트부서": 15},
                "by_company": {"삼성전자": 25, "테스트회사": 15}
            }
        },
        "monthly_stats": {
            "2025-09": {
                "active_users": 2,
                "new_users": 2,
                "total_requests": 40,
                "month_name": "2025년 9월"
            }
        }
    }
    
    with open('logs/stats_sample.json', 'w', encoding='utf-8') as f:
        json.dump(sample_data, f, ensure_ascii=False, indent=2)
    
    print('샘플 데이터 생성: logs/stats_sample.json')
    print('적용하려면: mv logs/stats_sample.json logs/stats.json')

if __name__ == "__main__":
    print("1. 기존 데이터 정리")
    print("2. 샘플 데이터 생성") 
    print("3. 둘 다 실행")
    
    choice = input("선택 (1/2/3): ").strip()
    
    if choice in ["1", "3"]:
        clean_stats_json()
    
    if choice in ["2", "3"]:
        create_sample_data()
