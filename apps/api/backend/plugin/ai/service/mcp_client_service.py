import json

from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.admin.model import User
from backend.common.exception import errors
from backend.common.pagination import paging_data
from backend.common.security.data_scope import bypass_data_scope
from backend.plugin.ai.core.registry import get_tool, load_builtin_tools
from backend.plugin.ai.crud.crud_mcp_client import ai_mcp_client_dao
from backend.plugin.ai.mcp_gateway.tokens import issue_token
from backend.plugin.ai.model import AiMcpClient
from backend.plugin.ai.schema.mcp_client import (
    AiMcpClientSchemaBase,
    CreateAiMcpClientParam,
    IssuedAiMcpToken,
    UpdateAiMcpClientParam,
)


async def _check(db: AsyncSession, obj: AiMcpClientSchemaBase) -> None:
    """配置写错的后果都是**静默**的，所以存之前就拦：

    - `act_as` 里拼错一个用户名 → 外部系统代表他时一律 403，看起来像「凭据坏了」
    - `tools` 里拼错一个工具名 → 那个工具永远调不到，看起来像「权限不够」
    - 没开 `allow_write` 却在 `tools` 里放写操作工具 → 入口只读，放进去也调不了，却让人以为能调
    """
    names = [n for n in obj.act_as if n != '*']
    if names:
        # 配置的是「谁能被代表」，不是展示数据，不按操作者的数据范围过滤
        with bypass_data_scope():
            found = set(
                (await db.execute(select(User.username).where(User.username.in_(names), User.deleted == 0))).scalars()
            )
        if missing := [n for n in names if n not in found]:
            raise errors.RequestError(msg=f'这些用户名不存在：{"、".join(missing)}')
    if obj.tools:
        load_builtin_tools()
        unknown = [name for name in obj.tools if get_tool(name) is None]
        if unknown:
            raise errors.RequestError(msg=f'这些工具不存在：{"、".join(unknown)}')
        mutating = [name for name in obj.tools if get_tool(name).mutating]  # type: ignore[union-attr]
        if mutating and not obj.allow_write:
            raise errors.RequestError(
                msg=f'这份凭据没有开「允许写操作」，写操作工具放进白名单也调不了：{"、".join(mutating)}'
            )


def _columns(obj: AiMcpClientSchemaBase) -> dict[str, Any]:
    data = obj.model_dump()
    data['act_as'] = json.dumps(obj.act_as, ensure_ascii=False)
    data['tools'] = json.dumps(obj.tools, ensure_ascii=False) if obj.tools else None
    return data


class AiMcpClientService:
    """MCP 凭据管理"""

    @staticmethod
    async def get(*, db: AsyncSession, pk: int) -> AiMcpClient:
        obj = await ai_mcp_client_dao.get(db, pk)
        if not obj:
            raise errors.NotFoundError(msg='MCP 凭据不存在')
        return obj

    @staticmethod
    async def get_list(*, db: AsyncSession, name: str | None, status: int | None) -> dict[str, Any]:
        return await paging_data(db, await ai_mcp_client_dao.get_select(name=name, status=status))

    @staticmethod
    async def create(*, db: AsyncSession, obj: CreateAiMcpClientParam, user_id: int) -> IssuedAiMcpToken:
        if await ai_mcp_client_dao.get_by_client_id(db, obj.client_id):
            raise errors.ConflictError(msg=f'凭据标识 {obj.client_id} 已存在')
        await _check(db, obj)
        token, digest, hint = issue_token()
        row = AiMcpClient(**_columns(obj), token_sha256=digest, token_hint=hint, created_by=user_id)
        db.add(row)
        await db.flush()
        return IssuedAiMcpToken(id=row.id, client_id=row.client_id, mcp_token=token)

    @classmethod
    async def update(cls, *, db: AsyncSession, pk: int, obj: UpdateAiMcpClientParam) -> None:
        row = await cls.get(db=db, pk=pk)
        await _check(db, obj)
        for key, value in _columns(obj).items():
            setattr(row, key, value)

    @classmethod
    async def rotate(cls, *, db: AsyncSession, pk: int) -> IssuedAiMcpToken:
        """换一把新令牌，旧的立即失效（同一行、同一个 client_id，审计不断档）"""
        row = await cls.get(db=db, pk=pk)
        token, digest, hint = issue_token()
        row.token_sha256, row.token_hint = digest, hint
        return IssuedAiMcpToken(id=row.id, client_id=row.client_id, mcp_token=token)

    @staticmethod
    async def delete(*, db: AsyncSession, pk: int) -> int:
        return await ai_mcp_client_dao.delete(db, pk)


ai_mcp_client_service: AiMcpClientService = AiMcpClientService()
