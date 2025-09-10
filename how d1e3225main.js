[33mcommit d1e3225ff2e52545f0b270df88fd6eb8ab8e0e74[m
Author: hogil <hgchoik@gmail.com>
Date:   Tue Sep 9 14:54:38 2025 +0900

    fix: labels 폴더 자동 생성 완전 방지
    
    - LABELS_DIR.mkdir() 중복 호출 모두 제거
    - startup_event, change_folder, _labels_save에서 중복 생성 제거
    - classification 폴더만 필요할 때 생성되도록 수정
    - IndentationError 수정으로 서버 정상 시작 보장

 -20
api/main.py
"hort --pretty=format\357\200\272-h -ad -s -15"
