#!/usr/bin/env python3
import requests
import json
import urllib3

# SSL 경고 무시
urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

def test_stats_api():
    """Stats API 테스트"""
    base_url = "https://localhost:8443"
    
    print("=== Stats API 테스트 ===")
    
    # 1. 사용자 통계
    try:
        response = requests.get(f"{base_url}/api/stats/users", verify=False)
        if response.status_code == 200:
            data = response.json()
            print(f"\n📊 사용자 통계:")
            print(f"- 총 사용자: {data.get('total_users', 0)}명")
            
            users = data.get('users', [])[:3]  # 처음 3명만
            for user in users:
                print(f"- {user.get('user_id')}: {user.get('display_name', 'N/A')}")
                print(f"  이름: {user.get('name', 'N/A')}, 부서: {user.get('department', 'N/A')}")
        else:
            print(f"❌ 사용자 통계 API 오류: {response.status_code}")
    except Exception as e:
        print(f"❌ 사용자 통계 API 예외: {e}")
    
    # 2. 최근 사용자
    try:
        response = requests.get(f"{base_url}/api/stats/recent-users", verify=False)
        if response.status_code == 200:
            data = response.json()
            print(f"\n🕐 최근 사용자:")
            print(f"- 최근 활동: {data.get('total_recent', 0)}명")
            
            recent_users = data.get('recent_users', [])[:3]
            for user in recent_users:
                print(f"- {user.get('user_id')}: {user.get('display_name', 'N/A')}")
                print(f"  이름: {user.get('name', 'N/A')}, 부서: {user.get('department', 'N/A')}")
        else:
            print(f"❌ 최근 사용자 API 오류: {response.status_code}")
    except Exception as e:
        print(f"❌ 최근 사용자 API 예외: {e}")
    
    # 3. 부서별 통계
    try:
        response = requests.get(f"{base_url}/api/stats/breakdown?category=department&days=14", verify=False)
        if response.status_code == 200:
            data = response.json()
            print(f"\n🏢 부서별 통계:")
            items = data.get('items', [])[:5]
            for dept, count in items:
                print(f"- {dept}: {count}건")
        else:
            print(f"❌ 부서별 통계 API 오류: {response.status_code}")
    except Exception as e:
        print(f"❌ 부서별 통계 API 예외: {e}")

if __name__ == "__main__":
    test_stats_api()
