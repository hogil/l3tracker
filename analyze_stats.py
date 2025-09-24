import json
from datetime import datetime, timedelta
import os

# stats.json 분석
with open('logs/stats.json', 'r', encoding='utf-8') as f:
    data = json.load(f)

print('=== STATS.JSON 데이터 분석 ===')
print(f'총 사용자 수: {len(data.get("users", {}))}')

# 날짜별 분석
date_stats = {}
total_requests = 0
for user_id, user_data in data.get('users', {}).items():
    total_requests += user_data.get('total_requests', 0)
    for date in user_data.get('unique_days', []):
        if date not in date_stats:
            date_stats[date] = {'users': 0, 'requests': 0}
        date_stats[date]['users'] += 1
        date_stats[date]['requests'] += user_data.get('daily_requests', {}).get(date, 0)

print(f'총 요청 수: {total_requests}')
print('\n=== 날짜별 활동 ===')
for date in sorted(date_stats.keys()):
    stats = date_stats[date]
    print(f'{date}: 사용자 {stats["users"]}명, 요청 {stats["requests"]}건')

# 의심스러운 데이터 체크
print('\n=== 의심스러운 데이터 ===')
suspicious_count = 0
for user_id, user_data in data.get('users', {}).items():
    issues = []
    
    # 과도한 요청
    requests = user_data.get('total_requests', 0)
    if requests > 500:
        issues.append(f'과도한 요청({requests})')
    
    # 세션 수 vs 요청 수 비율
    session_count = user_data.get('session_count', 0)
    if session_count > 0 and requests / session_count > 100:
        issues.append(f'세션당 요청 과다({requests}/{session_count})')
    
    # 빈 프로필
    profile = user_data.get('profile', {})
    if not profile or not any(profile.values()):
        issues.append('빈 프로필')
    
    if issues and suspicious_count < 10:  # 처음 10개만
        print(f'{user_id}: {" | ".join(issues)}')
        suspicious_count += 1

# 일별/월별 통계 확인
daily = data.get('daily_stats', {})
monthly = data.get('monthly_stats', {})
print(f'\n=== 통계 구조 ===')
print(f'일별 통계 날짜 수: {len(daily)}')
print(f'월별 통계 월 수: {len(monthly)}')

if daily:
    dates = sorted(daily.keys())[:5]
    print(f'일별 통계 날짜: {dates}{"..." if len(daily) > 5 else ""}')
if monthly:
    print(f'월별 통계 월: {sorted(monthly.keys())}')

# 파일 정보
file_size = os.path.getsize('logs/stats.json')
print(f'\n=== 파일 정보 ===')
print(f'파일 크기: {file_size:,} bytes ({file_size/1024:.1f} KB)')

# 로그 파일들 확인
print('\n=== 로그 파일들 ===')
log_files = ['logs/access.log', 'logs/stdout.log', 'logs/stderr.log']
for log_file in log_files:
    if os.path.exists(log_file):
        size = os.path.getsize(log_file)
        print(f'{log_file}: {size:,} bytes')
        if size > 0:
            with open(log_file, 'r', encoding='utf-8', errors='ignore') as f:
                lines = f.readlines()
                print(f'  - 총 {len(lines)}줄')
                if lines:
                    print(f'  - 첫 줄: {lines[0].strip()[:100]}')
                    print(f'  - 마지막 줄: {lines[-1].strip()[:100]}')
    else:
        print(f'{log_file}: 파일 없음')
