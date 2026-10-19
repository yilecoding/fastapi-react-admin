"""菜单域工具。"""

from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.admin.service.menu_service import menu_service
from backend.plugin.ai.core.registry import ai_tool


@ai_tool(
    name='menu_list',
    description=(
        '获取菜单树形结构，返回菜单 ID、标题、类型（目录/菜单/按钮）、权限码、状态。'
        '用户问"有哪些菜单/某个权限码挂在哪"时用它。'
    ),
    domain='menu',
    perm='sys:menu:list',
)
async def menu_list(db: AsyncSession, title: str | None = None, status: int | None = None) -> list[dict[str, Any]]:
    return await menu_service.get_tree(db=db, title=title, status=status)
