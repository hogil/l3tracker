#!/usr/bin/env python3
import json
import os
from datetime import datetime

def check_stats_file():
    """현재 stats.json 파일 상태 확인"""
    
    print('=== 현재 stats.json 상태 ===')
    with open('logs/stats.json', 'r', encoding='utf-8') as f:
        data = json.load(f)

    users = data.get('users', {})
    print(f'총 사용자 수: {len(users)}')

    # 실제 사용자 IP 확인
    target_ip = '61.82.130.250'
    if target_ip in users:
        user_data = users[target_ip]
        profile = user_data.get('profile', {})
        print(f'\n{target_ip} 사용자:')
        print(f'  - Username: {profile.get("Username", "N/A")}')
        print(f'  - DeptName: {profile.get("DeptName", "N/A")}')
        print(f'  - LoginId: {profile.get("LoginId", "N/A")}')
        print(f'  - 요청수: {user_data.get("total_requests", 0)}')
    else:
        print(f'\n❌ {target_ip} 사용자가 stats.json에 없습니다.')

    # 다른 사용자들도 확인
    print('\n프로필이 있는 사용자들:')
    profile_users = 0
    for user_id, user_data in users.items():
        profile = user_data.get('profile', {})
        if profile and profile.get('Username'):
            username = profile.get('Username', 'N/A')
            dept = profile.get('DeptName', 'N/A')
            print(f'  - {user_id}: {username} ({dept})')
            profile_users += 1
            if profile_users >= 5:  # 처음 5개만
                break
    
    print(f'\n프로필이 있는 사용자: {profile_users}명')
    
    # 부서별 통계 확인
    daily_stats = data.get('daily_stats', {})
    if daily_stats:
        latest_date = max(daily_stats.keys())
        latest_stats = daily_stats[latest_date]
        by_dept = latest_stats.get('by_department', {})
        print(f'\n{latest_date} 부서별 통계:')
        for dept, count in by_dept.items():
            print(f'  - {dept}: {count}건')
    else:
        print('\n❌ 부서별 통계 없음')

if __name__ == "__main__":
    check_stats_file()
