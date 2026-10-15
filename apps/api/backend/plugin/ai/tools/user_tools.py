"""用户域工具。"""

from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.admin.crud.crud_user import user_dao
from backend.plugin.ai.core.registry import ai_tool

# 一次最多回多少行。**不是分页**，是"给模型看的样本量"：
# 结果全文会进对话历史，几百行塞进去既烧 token 又会把真正的问题淹掉
_MAX_ROWS = 30


@ai_tool(
    name='user_list',
    description=(
        '查询系统用户，可按用户名、手机号、部门 ID、状态筛选。用户问"有哪些用户""某某是谁""技术中心有哪些人"时用它。'
    ),
    domain='user',
    perm='sys:user:list',
)
async def user_list(
    db: AsyncSession,
    username: str | None = None,
    phone: str | None = None,
    dept_id: int | None = None,
    status: int | None = None,
) -> dict[str, Any]:
    """走 DAO 的 `get_select`，不走 `service.get_list`。

    ⚠️ 不是图省事绕过 service：`get_list` 的返回值是 `paging_data(...)`，它依赖
    `DependsPagination` 设的分页上下文，而 SSE 端点上没有那个依赖。
    而**数据范围不会因此丢**——它挂在 `DataScopedCRUD.select()` 上，
    `get_select` 拿到的 Select 已经带着当前用户的可见范围了。

    🔴 **刻意只回一部分字段。** 这里返回的东西会原样进模型上下文（并发给供应商），
    所以邮箱、手机号这类能直接定位到人的字段**不返回**——需要的时候人去用户管理页看。
    """
    stmt = await user_dao.get_select(dept=dept_id, username=username, phone=phone, status=status, role=None)

    # ⚠️ **不要 `.scalars()`。** `get_select` 用 `JoinConfig(..., fill_result=True)`
    # join 了 Dept，每一行是 `(User, Dept)` 两列；`.scalars()` 只取第一列，部门就丢了。
    # 第一版写成 `u.dept` 直接 `AttributeError: 'User' object has no attribute 'dept'`
    # —— User 上压根没有这个关系属性，只有 `dept_id` 列。表现是工具失败、
    # AI 答"可能是权限或数据结构问题"，而权限完全正常。
    rows = (await db.execute(stmt.limit(_MAX_ROWS))).all()
    return {
        'total_returned': len(rows),
        'truncated': len(rows) == _MAX_ROWS,
        'users': [
            {
                'id': str(user.id),  # 雪花 ID 一律字符串（硬纪律 6）
                'username': user.username,
                'nickname': user.nickname,
                'dept': dept.name if dept is not None else None,
                'status': user.status,
                'is_superuser': bool(user.is_superuser),
                'last_login_time': user.last_login_time.isoformat() if user.last_login_time else None,
            }
            for user, dept in rows
        ],
    }
