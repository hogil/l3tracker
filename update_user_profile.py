#!/usr/bin/env python3
# -*- coding: utf-8 -*-

import json
import os
from datetime import datetime

def update_user_profile():
    """실제 사용자 IP에 프로필 정보 업데이트"""
    
    # stats.json 읽기
    stats_file = 'logs/stats.json'
    if not os.path.exists(stats_file):
        print("❌ stats.json 파일이 없습니다.")
        return
    
    with open(stats_file, 'r', encoding='utf-8') as f:
        data = json.load(f)
    
    # 실제 사용자 IP (61.82.130.250)에 프로필 정보 추가/업데이트
    user_ip = "61.82.130.250"
    
    if user_ip in data.get("users", {}):
        # 기존 사용자 데이터 업데이트
        user_data = data["users"][user_ip]
        user_data["profile"] = {
            "LoginId": "hgchoi",
            "Username": "최홍길", 
            "DeptName": "반도체사업부",
            "company": "삼성전자",
            "team": "개발팀",
            "title": "선임연구원",
            "account": "hgchoi",
            "pc": "workstation01",
            "name": "최홍길",
            "department": "반도체사업부",
            "department_name": "반도체사업부",
            "username": "최홍길",
            "display_name": "최홍길",
            "GrdName": "선임연구원",
            "GrdName_EN": "Senior Engineer",
            "DeptId": "D001",
            "Sabun": "EMP001",
            "employeeId": "EMP001",
            "client_ip": user_ip,
            "forwarded_client_ip": user_ip
        }
        print(f"✅ {user_ip} 사용자 프로필 업데이트 완료")
    else:
        # 새 사용자 생성
        current_time = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
        current_date = datetime.now().strftime('%Y-%m-%d')
        
        data["users"][user_ip] = {
            "primary_ip": user_ip,
            "ip_addresses": [user_ip],
            "total_requests": 1,
            "unique_days": [current_date],
            "first_seen": current_date,
            "last_seen": current_date,
            "last_access_time": current_time,
            "profile": {
                "LoginId": "hgchoi",
                "Username": "최홍길",
                "DeptName": "반도체사업부", 
                "company": "삼성전자",
                "team": "개발팀",
                "title": "선임연구원",
                "account": "hgchoi",
                "pc": "workstation01",
                "name": "최홍길",
                "department": "반도체사업부",
                "department_name": "반도체사업부",
                "username": "최홍길",
                "display_name": "최홍길",
                "GrdName": "선임연구원",
                "GrdName_EN": "Senior Engineer",
                "DeptId": "D001",
                "Sabun": "EMP001",
                "employeeId": "EMP001",
                "client_ip": user_ip,
                "forwarded_client_ip": user_ip
            },
            "daily_requests": {current_date: 1},
            "endpoints": {"/": 1},
            "session_count": 1,
            "total_session_time": 0
        }
        print(f"✅ {user_ip} 새 사용자 생성 완료")
    
    # 다른 테스트 사용자들도 추가
    test_users = [
        {
            "ip": "192.168.1.101",
            "account": "manager",
            "name": "김팀장",
            "dept": "품질관리팀"
        },
        {
            "ip": "192.168.1.102", 
            "account": "engineer",
            "name": "이연구원",
            "dept": "연구개발부"
        }
    ]
    
    current_time = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
    current_date = datetime.now().strftime('%Y-%m-%d')
    
    for user in test_users:
        user_id = f"{user['account']}@workstation"
        if user_id not in data["users"]:
            data["users"][user_id] = {
                "primary_ip": user["ip"],
                "ip_addresses": [user["ip"]],
                "total_requests": 15,
                "unique_days": [current_date],
                "first_seen": current_date,
                "last_seen": current_date,
                "last_access_time": current_time,
                "profile": {
                    "LoginId": user["account"],
                    "Username": user["name"],
                    "DeptName": user["dept"],
                    "company": "삼성전자",
                    "team": user["dept"],
                    "title": "팀원",
                    "account": user["account"],
                    "pc": "workstation",
                    "name": user["name"],
                    "department": user["dept"],
                    "department_name": user["dept"],
                    "username": user["name"],
                    "display_name": user["name"]
                },
                "daily_requests": {current_date: 15},
                "endpoints": {"/": 8, "/api/files": 4, "/api/thumbnail": 3},
                "session_count": 2,
                "total_session_time": 900
            }
            print(f"✅ {user_id} 테스트 사용자 생성 완료")
    
    # 일별/월별 통계 업데이트
    if current_date not in data.get("daily_stats", {}):
        data["daily_stats"][current_date] = {
            "active_users": 3,
            "new_users": 3,
            "total_requests": 75,
            "by_department": {
                "반도체사업부": 45,
                "품질관리팀": 15,
                "연구개발부": 15
            },
            "by_company": {"삼성전자": 75},
            "by_team": {
                "개발팀": 45,
                "품질관리팀": 15, 
                "연구개발부": 15
            }
        }
    
    current_month = datetime.now().strftime('%Y-%m')
    if current_month not in data.get("monthly_stats", {}):
        data["monthly_stats"][current_month] = {
            "active_users": 3,
            "new_users": 3,
            "total_requests": 75,
            "month_name": f"{datetime.now().year}년 {datetime.now().month}월"
        }
    
    # 파일 저장
    with open(stats_file, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    
    print("\n✅ stats.json 업데이트 완료!")
    print("📊 이제 /stats 페이지에서 이름/계정/부서 정보를 확인할 수 있습니다.")

if __name__ == "__main__":
    update_user_profile()
