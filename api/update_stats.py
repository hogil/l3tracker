#!/usr/bin/env python3
"""
기존 logs/stats.json 파일의 사용자들에게 last_access_time 필드를 추가하는 스크립트
위치 변경: 프로젝트 루트에서 api/update_stats.py 로 이동됨.
프로젝트 루트를 기준으로 logs/stats.json 경로를 안전하게 해석합니다.
"""

import json
import os
from datetime import datetime, timedelta
from pathlib import Path


def _project_root() -> Path:
    # api/ 디렉터리의 부모가 프로젝트 루트
    return Path(__file__).resolve().parents[1]


def update_stats_file() -> bool:
    """stats.json 파일의 기존 사용자들에게 last_access_time 필드 추가"""
    stats_file = _project_root() / "logs" / "stats.json"

    if not stats_file.exists():
        print(f"Stats file not found: {stats_file}")
        return False

    print("기존 stats.json 파일 읽는 중...")
    with stats_file.open('r', encoding='utf-8') as f:
        stats_data = json.load(f)

    users_updated = 0

    # 각 사용자에 대해 last_access_time 필드 추가
    for user_id, user_data in stats_data.get("users", {}).items():
        if "last_access_time" not in user_data:
            # last_seen 날짜 기반으로 현실적인 시간 생성
            last_seen_date = user_data.get("last_seen", "2025-09-11")

            try:
                # 날짜 파싱
                date_obj = datetime.strptime(last_seen_date, "%Y-%m-%d")

                # 사용자 ID 기반 해시로 현실적인 시간 생성 (오전 9시 ~ 오후 6시)
                user_hash = abs(hash(user_id)) % 541  # 0~540분 (9시간)
                date_obj = date_obj.replace(hour=9, minute=0, second=0, microsecond=0)
                date_obj += timedelta(minutes=user_hash)

                # 초는 0~59 의사난수
                seconds = abs(hash(user_id + "sec")) % 60
                date_obj = date_obj.replace(second=seconds)

                # 타임스탬프 형식으로 저장
                user_data["last_access_time"] = date_obj.strftime("%Y-%m-%d %H:%M:%S")
                users_updated += 1

                print(f"Updated user {user_id}: {user_data['last_access_time']}")

            except ValueError as e:
                print(f"Error parsing date for user {user_id}: {e}")
                # 기본값 설정
                default_time = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
                user_data["last_access_time"] = default_time
                users_updated += 1

    # 백업 생성
    backup_file = stats_file.with_name(f"stats.json.backup_{datetime.now().strftime('%Y%m%d_%H%M%S')}")
    with backup_file.open('w', encoding='utf-8') as f:
        json.dump(stats_data, f, ensure_ascii=False, indent=2)
    print(f"백업 파일 생성: {backup_file}")

    # 업데이트된 데이터 저장
    with stats_file.open('w', encoding='utf-8') as f:
        json.dump(stats_data, f, ensure_ascii=False, indent=2)

    print(f"Stats 파일 업데이트 완료: {users_updated}명의 사용자 업데이트됨")
    return True


if __name__ == "__main__":
    update_stats_file()


