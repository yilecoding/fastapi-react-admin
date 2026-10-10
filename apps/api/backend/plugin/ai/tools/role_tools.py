"""角色域工具。"""

from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.admin.service.role_service import role_service
from backend.plugin.ai.core.registry import ai_tool


@ai_tool(
    name='role_list',
    description='获取系统角色列表，返回角色 ID、名称、编码、状态。用户问"有哪些角色/某个角色在不在"时用它。',
    domain='role',
    # 复用接口上同一个权限码。界面上看不到角色列表的人，通过 AI 也看不到。
    perm='sys:role:list',
)
async def role_list(db: AsyncSession) -> list[dict[str, Any]]:
    """走 service 层，不碰 DAO。

    数据范围**自动**继承调用者：`role_dao` 是 `DataScopedCRUD`，
    当前用户由 `jwt_auth_middleware` 写进了 ContextVar，这里什么都不用做就是对的。
    反过来说，谁要是在这里加一句 `bypass_data_scope()`，受限用户就会通过 AI 看到全量角色。
    """
    roles = await role_service.get_all(db=db)
    return [
        {
            # 🔴 雪花 ID 必须转字符串（硬纪律 6）。直接给 int，模型在回答里
            # 复述一遍就可能丢精度，而用户拿着那个错 ID 去操作会命中另一条记录。
            'id': str(role.id),
            'name': role.name,
            'code': role.code,
            'status': role.status,
            'remark': role.remark,
        }
        for role in roles
    ]
