"""MCP 网关的鉴权：M2M 凭据 + 外部系统声明的代理用户。

🔴 **代理用户是对方声明的，我们只能信到「这个凭据被允许代表谁」为止。** 所以：

- 每个外部系统一份凭据（`ai_mcp_client` 表，「AI 助手 → MCP 凭据」页里发），**只存 sha256**
- 每份凭据带一张 `act_as` 白名单：只能代表名单里的用户（`"*"` = 任何普通用户）
- **默认不能代表超管**（`allow_superuser` 显式打开才行）—— 超管绕过一切权限码和数据范围，
  一份泄露的凭据 + `X-Acting-User: admin` 就是整个系统
- 可选的 `tools` 白名单：只能**收窄**，不能放大 —— 声明的用户自己没权限的工具照样看不到
- 用户本身走和 JWT 完全相同的 `get_jwt_user()`：账号停用 / 部门停用 / 角色全停用，
  在网页上登不进来的人，经 MCP 也代表不了
- 凭据停用 / 删除 / 换令牌即刻生效：每个请求都按哈希现查，不缓存
"""

import json

from dataclasses import dataclass
from typing import Any

from pydantic import BaseModel

from backend.common.exception import errors
from backend.common.security.data_scope import bypass_data_scope
from backend.common.security.jwt import get_jwt_user
from backend.core.conf import settings
from backend.database.db import async_db_session
from backend.plugin.ai.mcp_gateway.tokens import hash_token

ACTING_USER_HEADER = 'x-acting-user'


class McpClient(BaseModel):
    """一个外部系统的凭据（从 `ai_mcp_client` 一行投影出来，只带鉴权要用的字段）"""

    id: str
    act_as: list[str]
    allow_superuser: bool = False
    allow_write: bool = False
    tools: list[str] | None = None
    rate_per_minute: int | None = None

    @property
    def effective_rate(self) -> int:
        return self.rate_per_minute or settings.AI_MCP_RATE_PER_MINUTE

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


async def _load_client(token: str) -> McpClient | None:
    """按令牌哈希查一份**正常状态**的凭据，顺手记一笔最近使用时间。

    直接按哈希等值查（走索引）：比对的是哈希，响应时间泄露不出明文的任何信息。
    """
    from backend.plugin.ai.crud.crud_mcp_client import ai_mcp_client_dao

    async with async_db_session() as db:
        row = await ai_mcp_client_dao.get_active_by_token_hash(db, hash_token(token))
        if row is None:
            return None
        await ai_mcp_client_dao.touch(db, row)
        await db.commit()
        return McpClient(
            id=row.client_id,
            act_as=json.loads(row.act_as),
            allow_superuser=row.allow_superuser,
            allow_write=row.allow_write,
            tools=json.loads(row.tools) if row.tools else None,
            rate_per_minute=row.rate_per_minute,
        )


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
    if scheme.lower() != 'bearer' or not token.strip():
        raise McpAuthError(401, '缺少凭据（Authorization: Bearer <token>）')

    client = await _load_client(token.strip())
    if client is None:
        # 不区分「令牌不对」和「凭据已停用」：区分了就告诉了持有旧令牌的人「这把曾经有效」
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
