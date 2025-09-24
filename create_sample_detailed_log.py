#!/usr/bin/env python3
# -*- coding: utf-8 -*-

import json
import csv
from datetime import datetime, timedelta
from pathlib import Path
import random

def create_sample_detailed_log():
    """기존 stats.json 데이터를 기반으로 샘플 상세 접속 로그 생성"""
    
    stats_file = Path("logs/stats.json")
    output_file = Path("logs/detailed_access.csv")
    
    if not stats_file.exists():
        print("stats.json 파일이 존재하지 않습니다.")
        return
    
    # stats.json 데이터 로드
    with open(stats_file, 'r', encoding='utf-8') as f:
        stats_data = json.load(f)
    
    # CSV 파일 생성
    with open(output_file, 'w', encoding='utf-8', newline='') as f:
        writer = csv.writer(f)
        
        # 헤더 작성
        writer.writerow(['계정', '이름', '사번', '직급', '담당업무', '부서', '접속일자', 'IP주소'])
        
        # 각 사용자별로 일별 접속 기록 생성
        for user_id, user_data in stats_data.get("users", {}).items():
            profile = user_data.get("profile", {})
            primary_ip = user_data.get("primary_ip", "")
            
            # 프로필 정보 추출
            account = profile.get("LginId", "")
            name = profile.get("Username", "")
            # 사번 - 기존에 있으면 사용, 없으면 8자리 숫자로 임의 생성
            sabun = profile.get("Sabun", "")
            if not sabun and account:  # 계정이 있는데 사번이 없으면 생성
                sabun = f"{random.randint(10000000, 99999999)}"
            position = profile.get("GrdName_EN", "")  # 직급
            job_role = profile.get("GrdName", "")  # 담당업무
            department = profile.get("DeptName", "")
            
            # 각 접속일마다 기록 생성 (일별 1개씩만)
            for date in user_data.get("unique_days", []):
                # CSV 행 작성 (접속시간 제외, 일별 1개만)
                writer.writerow([
                    account,
                    name,
                    sabun,
                    position,
                    job_role,
                    department,
                    date,
                    primary_ip
                ])
    
    print(f"샘플 상세 접속 로그 생성 완료: {output_file}")
    
    # 생성된 파일 통계 출력
    with open(output_file, 'r', encoding='utf-8') as f:
        lines = f.readlines()
        print(f"총 기록 수: {len(lines) - 1}개 (헤더 제외)")

if __name__ == "__main__":
    create_sample_detailed_log()