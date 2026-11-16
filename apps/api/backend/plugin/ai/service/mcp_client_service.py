import json

from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.admin.crud.crud_user import user_dao
from backend.app.admin.model import User
from backend.common.exception import errors
from backend.common.pagination import paging_data
from backend.common.security.data_scope import bypass_data_scope, scoped_to_user
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


async def _check_grantable(db: AsyncSession, *, act_as: list[str], allow_superuser: bool, operator: Any) -> None:
    """🔴 **发凭据的人自己够不够格**（#314）：凭据能代表谁，不能超出发它的人自己管得着的范围。

    原来只校验「用户名存在、工具存在」：一个被授予 `ai:mcp:add` / `edit` 的**非超管**管理员，能发一份
    `act_as=["*"]` + `allow_superuser=true` 的凭据，再带 `X-Acting-User: admin` 调网关 —— 以超管身份跑全部只读工具，
    不受他自己的数据范围限制；凭据开了写的话，确认链接发给的也是被代表的那个人。

    - `allow_superuser` 和 `act_as` 里的 `*` 只有超管能设
    - `act_as` 里点名的人必须在操作者的数据范围内（看不见的人不能被他发凭据代表）。和「不存在」报同一句话：
      分开报就是一个按用户名探测范围外的人在不在的口子

    同一道闸也管「重新生成令牌」：换令牌 = 拿到一把能代表这些人的明文令牌，等于重新发了一次
    """
    if operator.is_superuser:
        return
    if allow_superuser:
        raise errors.ForbiddenError(msg='只有超级管理员能允许凭据代表超级管理员')
    if '*' in act_as:
        raise errors.ForbiddenError(msg='只有超级管理员能发「可代表任何普通用户」（act_as 含 *）的凭据')
    if not act_as:
        return
    # 显式锚定到操作者，不靠 JWT 中间件「反正会设」（AI 分册「行级数据权限由 dispatcher 锚定」同一个理由）
    with scoped_to_user(operator):
        visible = {u.username for u in await user_dao.select_models(db, User.username.in_(act_as), User.deleted == 0)}
    if missing := [n for n in act_as if n not in visible]:
        raise errors.RequestError(msg=f'这些用户名不存在或不在你的数据范围内：{"、".join(missing)}')


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
    async def create(*, db: AsyncSession, obj: CreateAiMcpClientParam, operator: Any) -> IssuedAiMcpToken:
        if await ai_mcp_client_dao.get_by_client_id(db, obj.client_id):
            raise errors.ConflictError(msg=f'凭据标识 {obj.client_id} 已存在')
        await _check_grantable(db, act_as=obj.act_as, allow_superuser=obj.allow_superuser, operator=operator)
        await _check(db, obj)
        token, digest, hint = issue_token()
        row = AiMcpClient(**_columns(obj), token_sha256=digest, token_hint=hint, created_by=operator.id)
        db.add(row)
        await db.flush()
        return IssuedAiMcpToken(id=row.id, client_id=row.client_id, mcp_token=token)

    @classmethod
    async def update(cls, *, db: AsyncSession, pk: int, obj: UpdateAiMcpClientParam, operator: Any) -> None:
        row = await cls.get(db=db, pk=pk)
        # 按**改完之后**的值判：PUT 带回的是整份配置，超管发的凭据非超管改不了（哪怕只改备注）——
        # 改了就等于他重新发了一次
        await _check_grantable(db, act_as=obj.act_as, allow_superuser=obj.allow_superuser, operator=operator)
        await _check(db, obj)
        for key, value in _columns(obj).items():
            setattr(row, key, value)

    @classmethod
    async def rotate(cls, *, db: AsyncSession, pk: int, operator: Any) -> IssuedAiMcpToken:
        """换一把新令牌，旧的立即失效（同一行、同一个 client_id，审计不断档）。

        🔴 换令牌的人拿到的是一把能代表 `act_as` 里那些人的明文令牌：非超管不能给超管发的凭据换令牌（#314）
        """
        row = await cls.get(db=db, pk=pk)
        await _check_grantable(
            db, act_as=json.loads(row.act_as), allow_superuser=row.allow_superuser, operator=operator
        )
        token, digest, hint = issue_token()
        row.token_sha256, row.token_hint = digest, hint
        return IssuedAiMcpToken(id=row.id, client_id=row.client_id, mcp_token=token)

    @staticmethod
    async def delete(*, db: AsyncSession, pk: int) -> int:
        return await ai_mcp_client_dao.delete(db, pk)


ai_mcp_client_service: AiMcpClientService = AiMcpClientService()
