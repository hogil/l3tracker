#!/usr/bin/env python3
# -*- coding: utf-8 -*-

import json
import shutil
from pathlib import Path

def clean_profile_keys():
    """stats.json의 profile 데이터를 7개 표준 키만 남기도록 정리"""
    
    # 표준 7개 키
    standard_keys = {
        "Username",
        "LginId", 
        "Sabun",
        "DeptName",
        "x-ms-forwarded-client-ip",
        "GrdName_EN",
        "GrdName"
    }
    
    # 동의어 매핑
    synonyms = {
        "Username": ["username", "name", "display_name"],
        "LginId": ["LoginId", "account"],
        "Sabun": ["employee_id", "employeeId"],
        "DeptName": ["department_name", "department"],
        "x-ms-forwarded-client-ip": ["client_ip", "forwarded_client_ip", "ClientIP"],
        "GrdName_EN": ["grade_en", "position"],
        "GrdName": ["grade"],
    }
    
    stats_file = Path("logs/stats.json")
    if not stats_file.exists():
        print("stats.json 파일이 존재하지 않습니다.")
        return
    
    # 백업 생성
    backup_file = Path("logs/stats.json.backup")
    shutil.copy2(stats_file, backup_file)
    print(f"백업 파일 생성: {backup_file}")
    
    # 데이터 로드
    try:
        with open(stats_file, 'r', encoding='utf-8') as f:
            data = json.load(f)
    except Exception as e:
        print(f"파일 로드 실패: {e}")
        return
    
    # 각 사용자의 profile 정리
    users_cleaned = 0
    keys_removed = 0
    
    for user_id, user_data in data.get("users", {}).items():
        if "profile" not in user_data:
            continue
            
        original_profile = user_data["profile"].copy()
        cleaned_profile = {}
        
        # 표준 키들 처리
        for std_key in standard_keys:
            value = original_profile.get(std_key)
            if not value:
                # 동의어에서 찾기
                for synonym in synonyms.get(std_key, []):
                    if original_profile.get(synonym):
                        value = original_profile.get(synonym)
                        break
            
            if value:
                cleaned_profile[std_key] = value
        
        # 정리된 profile로 교체
        keys_before = len(user_data["profile"])
        user_data["profile"] = cleaned_profile
        keys_after = len(user_data["profile"])
        
        if keys_before != keys_after:
            users_cleaned += 1
            keys_removed += (keys_before - keys_after)
            print(f"사용자 {user_id}: {keys_before} → {keys_after} keys")
    
    # 결과 저장
    try:
        with open(stats_file, 'w', encoding='utf-8') as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        
        print(f"\n정리 완료:")
        print(f"- 정리된 사용자: {users_cleaned}명")
        print(f"- 제거된 키: {keys_removed}개")
        print(f"- 백업 파일: {backup_file}")
        
    except Exception as e:
        print(f"파일 저장 실패: {e}")
        # 백업에서 복구
        shutil.copy2(backup_file, stats_file)
        print("백업에서 복구했습니다.")

if __name__ == "__main__":
    clean_profile_keys()