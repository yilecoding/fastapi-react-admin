"""MCP 网关的鉴权：M2M 凭据 + 外部系统声明的代理用户。

🔴 **代理用户是对方声明的，我们只能信到「这个凭据被允许代表谁」为止。** 所以：

- 每个外部系统一份凭据（`AI_MCP_CLIENTS`），**只存 sha256**，比对用常量时间
- 每份凭据带一张 `act_as` 白名单：只能代表名单里的用户（`"*"` = 任何普通用户）
- **默认不能代表超管**（`allow_superuser` 显式打开才行）—— 超管绕过一切权限码和数据范围，
  一份泄露的凭据 + `X-Acting-User: admin` 就是整个系统
- 可选的 `tools` 白名单：只能**收窄**，不能放大 —— 声明的用户自己没权限的工具照样看不到
- 用户本身走和 JWT 完全相同的 `get_jwt_user()`：账号停用 / 部门停用 / 角色全停用，
  在网页上登不进来的人，经 MCP 也代表不了

任何一处配置读不通（缺字段、哈希格式不对）一律拒绝，不回落成「放行」。
"""

import hashlib
import hmac

from dataclasses import dataclass
from typing import Any

from pydantic import BaseModel, Field, ValidationError

from backend.common.exception import errors
from backend.common.log import log
from backend.common.security.data_scope import bypass_data_scope
from backend.common.security.jwt import get_jwt_user
from backend.core.conf import settings
from backend.database.db import async_db_session

ACTING_USER_HEADER = 'x-acting-user'


class McpClient(BaseModel):
    """一个外部系统的凭据配置"""

    id: str = Field(min_length=1, max_length=48, pattern=r'^[a-z0-9][a-z0-9_-]*$')
    token_sha256: str = Field(pattern=r'^[0-9a-f]{64}$')
    act_as: list[str] = Field(min_length=1)
    allow_superuser: bool = False
    tools: list[str] | None = None

    def may_act_as(self, username: str) -> bool:
        return '*' in self.act_as or username in self.act_as

    def allows_tool(self, name: str) -> bool:
        return self.tools is None or name in self.tools


@dataclass(frozen=True, slots=True)
class McpPrincipal:
    """一次 MCP 请求的身份：哪个系统、代表谁"""

    client: McpClient
    user: Any

    @property
    def channel(self) -> str:
        return f'mcp:{self.client.id}'


class McpAuthError(Exception):
    """鉴权失败。`status` 是 HTTP 状态码，`message` 回给调用方（不带内部细节）"""

    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.message = message


def load_clients() -> list[McpClient]:
    """读配置并逐项校验。坏掉的那一项**跳过并报错日志**，其余照常 —— 不让一项写错把所有系统都拒掉，
    也绝不让写错的那一项以「缺省值」的形态生效"""
    clients: list[McpClient] = []
    for raw in settings.AI_MCP_CLIENTS:
        try:
            clients.append(McpClient.model_validate(raw))
        except ValidationError as e:  # ruff: ignore[try-except-in-loop]  配置就几项，每个请求读一次
            log.error(f'AI_MCP_CLIENTS 里有一项配置无效，已忽略：{e.errors(include_input=False)}')
    return clients


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def _match_client(token: str, clients: list[McpClient]) -> McpClient | None:
    """常量时间比对，并且**每一项都比**：提前返回会让响应时间泄露「第几项对上了」"""
    digest = hash_token(token)
    matched: McpClient | None = None
    for client in clients:
        if hmac.compare_digest(client.token_sha256, digest):
            matched = client
    return matched


async def _resolve_user(username: str) -> Any:
    from backend.app.admin.crud.crud_user import user_dao

    # 「这个人是谁」不是展示数据，按可见范围过滤会自锁（同 jwt.get_jwt_user 的豁免）
    with bypass_data_scope():
        async with async_db_session() as db:
            row = await user_dao.get_by_username(db, username)
    if row is None:
        return None
    try:
        return await get_jwt_user(row.id)
    except errors.BaseExceptionError:
        # 账号 / 部门 / 角色停用 —— 和网页登录同一套判据
        return None


async def authenticate(headers: Any) -> McpPrincipal:
    """从请求头解析出身份；任何一步不通过都抛 `McpAuthError`"""
    if not settings.AI_MCP_ENABLED:
        raise McpAuthError(404, 'MCP 网关未开启')

    scheme, _, token = (headers.get('authorization') or '').partition(' ')
    if scheme.lower() != 'bearer' or not token:
        raise McpAuthError(401, '缺少凭据（Authorization: Bearer <token>）')

    client = _match_client(token.strip(), load_clients())
    if client is None:
        raise McpAuthError(401, '凭据无效')

    username = (headers.get(ACTING_USER_HEADER) or '').strip()
    if not username:
        raise McpAuthError(400, f'缺少代理用户（{ACTING_USER_HEADER} 请求头）')
    # 不区分「用户不存在」和「不在白名单里」：区分了就成了一个枚举用户名的口子
    if not client.may_act_as(username):
        raise McpAuthError(403, '这个凭据不能代表该用户')

    user = await _resolve_user(username)
    if user is None:
        raise McpAuthError(403, '这个凭据不能代表该用户')
    if user.is_superuser and not client.allow_superuser:
        raise McpAuthError(403, '这个凭据不能代表超级管理员')

    return McpPrincipal(client=client, user=user)
