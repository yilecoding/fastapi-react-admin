"""部门域工具。"""

from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.admin.model import Dept
from backend.app.admin.service.dept_service import dept_service
from backend.common.security.permission import filter_data_permission_for_user
from backend.plugin.ai.core.ports import RunContext
from backend.plugin.ai.core.registry import ai_tool


@ai_tool(
    name='dept_list',
    description=(
        '获取部门树形结构，返回部门 ID、名称、编码、负责人、状态。用户问"有哪些部门/某个部门下面有什么"时用它。'
    ),
    domain='dept',
    perm='sys:dept:list',
)
async def dept_list(
    db: AsyncSession,
    ctx: RunContext,
    name: str | None = None,
    code: str | None = None,
    status: int | None = None,
) -> list[dict[str, Any]]:
    """部门的数据范围是**显式**传进 service 的，不走 ContextVar。

    🔴 所以这里必须自己算一遍 `filter_data_permission_for_user(ctx.user, Dept)` ——
    和 `GET /sys/depts` 里那个 `Depends(DataPermissionFilter(Dept))` 是同一个东西，
    只是拿用户的方式不同（那边从 Request 取，这边从 ctx 取）。
    少了它，一个只该看见本部门的人问"有哪些部门"会拿到整棵组织树。
    """
    data_filter = filter_data_permission_for_user(ctx.user, Dept)
    return await dept_service.get_tree(
        db=db, data_filter=data_filter, name=name, code=code, leader=None, phone=None, status=status
    )
