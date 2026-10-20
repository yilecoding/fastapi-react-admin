"""MCP 令牌的生成与哈希。网关鉴权和凭据管理共用这一份 —— 两边各写一个 sha256 迟早对不上"""

import hashlib
import secrets

TOKEN_PREFIX = 'fra_mcp_'
_HINT_LENGTH = len(TOKEN_PREFIX) + 4


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def issue_token() -> tuple[str, str, str]:
    """→ (明文, sha256, 辨认用前缀)。明文只在调用方那一次响应里出现"""
    token = f'{TOKEN_PREFIX}{secrets.token_urlsafe(32)}'
    return token, hash_token(token), f'{token[:_HINT_LENGTH]}…'
