#!/usr/bin/env python3
import requests
import urllib3
import json

# SSL 경고 무시
urllib3.disable_warnings()

def test_stats_apis():
    """Stats API들 테스트"""
    base_url = "https://localhost:8443"
    
    print("=== Stats API 테스트 ===\n")
    
    # 1. 사용자 목록 API
    try:
        response = requests.get(f"{base_url}/api/stats/users", verify=False, timeout=10)
        if response.status_code == 200:
            data = response.json()
            print("✅ 사용자 목록 API 성공")
            print(f"총 사용자: {data.get('total_users', 0)}명\n")
            
            users = data.get('users', [])[:5]
            for i, user in enumerate(users, 1):
                print(f"{i}. ID: {user.get('user_id')}")
                print(f"   Display: {user.get('display_name', 'N/A')}")
                print(f"   Name: {user.get('name', 'N/A')}, Dept: {user.get('department', 'N/A')}")
                print(f"   Requests: {user.get('total_requests', 0)}")
                print()
        else:
            print(f"❌ 사용자 목록 API 오류: {response.status_code}")
            print(f"응답: {response.text[:200]}")
    except Exception as e:
        print(f"❌ 사용자 목록 API 예외: {e}")
    
    print("-" * 50)
    
    # 2. 최근 사용자 API
    try:
        response = requests.get(f"{base_url}/api/stats/recent-users", verify=False, timeout=10)
        if response.status_code == 200:
            data = response.json()
            print("✅ 최근 사용자 API 성공")
            print(f"최근 활동: {data.get('total_recent', 0)}명\n")
            
            recent_users = data.get('recent_users', [])[:3]
            for i, user in enumerate(recent_users, 1):
                print(f"{i}. ID: {user.get('user_id')}")
                print(f"   Display: {user.get('display_name', 'N/A')}")
                print(f"   Name: {user.get('name', 'N/A')}, Dept: {user.get('department', 'N/A')}")
                print()
        else:
            print(f"❌ 최근 사용자 API 오류: {response.status_code}")
    except Exception as e:
        print(f"❌ 최근 사용자 API 예외: {e}")
    
    print("-" * 50)
    
    # 3. 부서별 통계 API
    try:
        response = requests.get(f"{base_url}/api/stats/breakdown?category=department&days=14", verify=False, timeout=10)
        if response.status_code == 200:
            data = response.json()
            print("✅ 부서별 통계 API 성공\n")
            
            items = data.get('items', [])[:5]
            for dept, count in items:
                print(f"- {dept}: {count}건")
        else:
            print(f"❌ 부서별 통계 API 오류: {response.status_code}")
    except Exception as e:
        print(f"❌ 부서별 통계 API 예외: {e}")

if __name__ == "__main__":
    test_stats_apis()
