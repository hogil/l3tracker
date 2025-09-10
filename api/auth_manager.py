#!/usr/bin/env python3
# -*- coding: utf-8 -*-

import json
import hashlib
import secrets
from datetime import datetime, timedelta
from pathlib import Path
from typing import Dict, Any, Optional, List
from enum import Enum

class UserRole(Enum):
    ADMIN = "admin"
    USER = "user"
    VIEWER = "viewer"

class Permission(Enum):
    VIEW_FILES = "view_files"
    UPLOAD_FILES = "upload_files"
    DELETE_FILES = "delete_files"
    MANAGE_LABELS = "manage_labels"
    MANAGE_USERS = "manage_users"
    ADMIN_ACCESS = "admin_access"

# 권한 매트릭스
ROLE_PERMISSIONS = {
    UserRole.ADMIN: [
        Permission.VIEW_FILES,
        Permission.UPLOAD_FILES,
        Permission.DELETE_FILES,
        Permission.MANAGE_LABELS,
        Permission.MANAGE_USERS,
        Permission.ADMIN_ACCESS
    ],
    UserRole.USER: [
        Permission.VIEW_FILES,
        Permission.UPLOAD_FILES,
        Permission.MANAGE_LABELS
    ],
    UserRole.VIEWER: [
        Permission.VIEW_FILES
    ]
}

# 사용자 데이터베이스 파일
USERS_DB_FILE = Path("api/users.json")
SESSIONS_DB_FILE = Path("api/sessions.json")

class AuthManager:
    def __init__(self):
        self.users: Dict[str, Dict[str, Any]] = self.load_users()
        self.sessions: Dict[str, Dict[str, Any]] = self.load_sessions()
        
        # 기본 관리자 계정 생성 (초기 설정)
        if not self.users:
            self.create_default_admin()
    
    def create_default_admin(self):
        """기본 관리자 계정 생성"""
        admin_user = {
            "username": "admin",
            "display_name": "Administrator",
            "password_hash": self.hash_password("admin123"),
            "role": UserRole.ADMIN.value,
            "created_at": datetime.now().isoformat(),
            "last_login": None,
            "is_active": True,
            "ip_whitelist": [],  # 빈 리스트 = 모든 IP 허용
            "session_timeout": 3600  # 1시간
        }
        self.users["admin"] = admin_user
        self.save_users()
        print("기본 관리자 계정이 생성되었습니다. (admin/admin123)")
    
    def load_users(self) -> Dict[str, Dict[str, Any]]:
        """사용자 데이터 로드"""
        try:
            if USERS_DB_FILE.exists():
                with open(USERS_DB_FILE, 'r', encoding='utf-8') as f:
                    return json.load(f)
        except Exception as e:
            print(f"사용자 데이터 로드 실패: {e}")
        return {}
    
    def save_users(self):
        """사용자 데이터 저장"""
        try:
            USERS_DB_FILE.parent.mkdir(exist_ok=True)
            with open(USERS_DB_FILE, 'w', encoding='utf-8') as f:
                json.dump(self.users, f, ensure_ascii=False, indent=2)
        except Exception as e:
            print(f"사용자 데이터 저장 실패: {e}")
    
    def load_sessions(self) -> Dict[str, Dict[str, Any]]:
        """세션 데이터 로드"""
        try:
            if SESSIONS_DB_FILE.exists():
                with open(SESSIONS_DB_FILE, 'r', encoding='utf-8') as f:
                    return json.load(f)
        except Exception as e:
            print(f"세션 데이터 로드 실패: {e}")
        return {}
    
    def save_sessions(self):
        """세션 데이터 저장"""
        try:
            SESSIONS_DB_FILE.parent.mkdir(exist_ok=True)
            with open(SESSIONS_DB_FILE, 'w', encoding='utf-8') as f:
                json.dump(self.sessions, f, ensure_ascii=False, indent=2)
        except Exception as e:
            print(f"세션 데이터 저장 실패: {e}")
    
    def hash_password(self, password: str) -> str:
        """비밀번호 해시화"""
        return hashlib.sha256(password.encode()).hexdigest()
    
    def verify_password(self, password: str, password_hash: str) -> bool:
        """비밀번호 검증"""
        return self.hash_password(password) == password_hash
    
    def create_user(self, username: str, password: str, display_name: str, role: UserRole, ip_whitelist: List[str] = None) -> bool:
        """새 사용자 생성"""
        if username in self.users:
            return False
        
        user_data = {
            "username": username,
            "display_name": display_name,
            "password_hash": self.hash_password(password),
            "role": role.value,
            "created_at": datetime.now().isoformat(),
            "last_login": None,
            "is_active": True,
            "ip_whitelist": ip_whitelist or [],
            "session_timeout": 3600
        }
        
        self.users[username] = user_data
        self.save_users()
        return True
    
    def authenticate(self, username: str, password: str, client_ip: str) -> Optional[str]:
        """사용자 인증 및 세션 생성"""
        if username not in self.users:
            return None
        
        user = self.users[username]
        
        # 비활성 사용자 체크
        if not user.get("is_active", True):
            return None
        
        # 비밀번호 검증
        if not self.verify_password(password, user["password_hash"]):
            return None
        
        # IP 화이트리스트 체크
        ip_whitelist = user.get("ip_whitelist", [])
        if ip_whitelist and client_ip not in ip_whitelist:
            return None
        
        # 세션 생성
        session_token = secrets.token_urlsafe(32)
        session_data = {
            "username": username,
            "client_ip": client_ip,
            "created_at": datetime.now().isoformat(),
            "expires_at": (datetime.now() + timedelta(seconds=user.get("session_timeout", 3600))).isoformat(),
            "is_valid": True
        }
        
        self.sessions[session_token] = session_data
        
        # 마지막 로그인 시간 업데이트
        self.users[username]["last_login"] = datetime.now().isoformat()
        
        self.save_sessions()
        self.save_users()
        
        return session_token
    
    def validate_session(self, session_token: str, client_ip: str) -> Optional[Dict[str, Any]]:
        """세션 유효성 검증"""
        if session_token not in self.sessions:
            return None
        
        session = self.sessions[session_token]
        
        # 세션 유효성 체크
        if not session.get("is_valid", True):
            return None
        
        # 만료 시간 체크
        expires_at = datetime.fromisoformat(session["expires_at"])
        if datetime.now() > expires_at:
            self.invalidate_session(session_token)
            return None
        
        # IP 체크 (세션 하이재킹 방지)
        if session["client_ip"] != client_ip:
            self.invalidate_session(session_token)
            return None
        
        username = session["username"]
        if username not in self.users:
            self.invalidate_session(session_token)
            return None
        
        return {
            "username": username,
            "user": self.users[username],
            "session": session
        }
    
    def invalidate_session(self, session_token: str):
        """세션 무효화"""
        if session_token in self.sessions:
            self.sessions[session_token]["is_valid"] = False
            self.save_sessions()
    
    def logout(self, session_token: str):
        """로그아웃"""
        self.invalidate_session(session_token)
    
    def has_permission(self, username: str, permission: Permission) -> bool:
        """사용자 권한 확인"""
        if username not in self.users:
            return False
        
        user = self.users[username]
        user_role = UserRole(user["role"])
        
        return permission in ROLE_PERMISSIONS.get(user_role, [])
    
    def get_user_permissions(self, username: str) -> List[str]:
        """사용자의 모든 권한 반환"""
        if username not in self.users:
            return []
        
        user = self.users[username]
        user_role = UserRole(user["role"])
        
        return [perm.value for perm in ROLE_PERMISSIONS.get(user_role, [])]
    
    def update_user(self, username: str, **kwargs) -> bool:
        """사용자 정보 업데이트"""
        if username not in self.users:
            return False
        
        user = self.users[username]
        
        # 업데이트 가능한 필드들
        updatable_fields = ["display_name", "role", "is_active", "ip_whitelist", "session_timeout"]
        
        for field, value in kwargs.items():
            if field in updatable_fields:
                user[field] = value
            elif field == "password":
                user["password_hash"] = self.hash_password(value)
        
        self.save_users()
        return True
    
    def delete_user(self, username: str) -> bool:
        """사용자 삭제"""
        if username not in self.users:
            return False
        
        # 관리자는 삭제할 수 없음
        if self.users[username]["role"] == UserRole.ADMIN.value:
            return False
        
        del self.users[username]
        
        # 해당 사용자의 모든 세션 무효화
        for token, session in self.sessions.items():
            if session["username"] == username:
                session["is_valid"] = False
        
        self.save_users()
        self.save_sessions()
        return True
    
    def get_all_users(self) -> List[Dict[str, Any]]:
        """모든 사용자 목록 반환 (비밀번호 제외)"""
        users_list = []
        for username, user in self.users.items():
            user_info = user.copy()
            user_info.pop("password_hash", None)  # 비밀번호 해시 제거
            users_list.append(user_info)
        
        return users_list
    
    def cleanup_expired_sessions(self):
        """만료된 세션 정리"""
        current_time = datetime.now()
        expired_tokens = []
        
        for token, session in self.sessions.items():
            expires_at = datetime.fromisoformat(session["expires_at"])
            if current_time > expires_at:
                expired_tokens.append(token)
        
        for token in expired_tokens:
            del self.sessions[token]
        
        if expired_tokens:
            self.save_sessions()
        
        return len(expired_tokens)

# 전역 인스턴스
auth_manager = AuthManager()