"""部门域工具。"""

from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.admin.model import Dept
from backend.app.admin.schema.dept import CreateDeptParam, UpdateDeptParam
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
    return await dept_service.get_tree(db=db, data_filter=data_filter, name=name, code=code, phone=None, status=status)


# ---------------------------------------------------------------------------
# 变更类工具
#
# 🔴 三条约定（见 `plugin/ai/AGENTS.md`「写操作工具」）：
# - 入参直接构造 admin 的 `CreateDeptParam` / `UpdateDeptParam`，不为 AI 另写一份更宽松的校验
# - 执行走 `dept_service.create/update`，预演走同一个 service 的 `check_create/check_update` ——
#   两边共用一份业务规则，预演说「能做」执行就不会因为另一套规则说「不能」
# - 数据范围不用在这里写：`dept_dao` 是 `DataScopedCRUD`，dispatcher 执行 handler 和
#   preview 时都锚定了调用者，范围外的部门（含上级部门）在这里就是「不存在」
# ---------------------------------------------------------------------------

_DEPT_ID_HINT = '部门 ID 是字符串（雪花 ID），先用 dept_list 查到再传，不要自己编'


def _create_param(name: str, code: str, parent_id: str | None, sort: int) -> CreateDeptParam:
    """⚠️ 刻意不收「负责人」。负责人是 `leader_id`（用户 ID），而人说的是名字 ——
    名字 → 用户 ID 要在调用者的数据范围里查、还要处理重名，是另一件事。

    🔴 原来这里收一个 `leader: str` 原样塞进 `CreateDeptParam`。#108 把那个字段改成了
    `leader_id` 之后，pydantic **静默丢弃**了未知字段：预演卡片上写着「负责人：张三」，
    人点了确认，建出来的部门没有负责人，不报错。
    """
    return CreateDeptParam(name=name, code=code, parent_id=parent_id, sort=sort, status=1)


async def _preview_create(
    db: AsyncSession,
    name: str,
    code: str,
    parent_id: str | None = None,
    sort: int = 0,
) -> str:
    obj = _create_param(name, code, parent_id, sort)
    parent = await dept_service.check_create(db=db, obj=obj)
    where = f'「{parent.name}」下' if parent else '顶级'
    return f'将在{where}新建部门「{obj.name}」（编码 {obj.code}）'


@ai_tool(
    name='dept_create',
    description=(
        '新建一个部门。会先请用户确认再执行。'
        f'code 是部门编码（大写字母开头，只含大写字母、数字、下划线，2-32 位，创建后不可改）；'
        f'parent_id 不传表示顶级部门。{_DEPT_ID_HINT}。暂不支持设置负责人，需要的话请用户到部门管理页设置。'
    ),
    domain='dept',
    perm='sys:dept:add',
    mutating=True,
    preview=_preview_create,
)
async def dept_create(
    db: AsyncSession,
    name: str,
    code: str,
    parent_id: str | None = None,
    sort: int = 0,
) -> dict[str, Any]:
    obj = _create_param(name, code, parent_id, sort)
    await dept_service.create(db=db, obj=obj)
    return {'name': obj.name, 'code': obj.code, 'parent_id': parent_id}


async def _rename_param(db: AsyncSession, dept_id: str, new_name: str) -> tuple[Dept, UpdateDeptParam]:
    """改名 = 只动 name。`parent_id` / `status` 显式带上原值：

    🔴 `UpdateDeptParam` 里它们一个是可选、一个是必填，漏传 `parent_id` 的话
    `check_update` 会按「挪到顶级」去判同级重名 —— 校验对象错了，却不报错。
    `update` 走 `exclude_unset`，带上原值等于没改。
    """
    dept = await dept_service.get(db=db, pk=int(dept_id))
    obj = UpdateDeptParam(name=new_name, parent_id=dept.parent_id, status=dept.status)
    return dept, obj


async def _preview_rename(db: AsyncSession, dept_id: str, new_name: str) -> str:
    dept, obj = await _rename_param(db, dept_id, new_name)
    if dept.name == obj.name:
        raise ValueError(f'部门已经叫「{dept.name}」了，不需要改')
    await dept_service.check_update(db=db, pk=dept.id, obj=obj)
    return f'将把部门「{dept.name}」（编码 {dept.code}）改名为「{obj.name}」'


@ai_tool(
    name='dept_rename',
    description=f'修改部门名称（只改名称，不动上级、编码、状态）。会先请用户确认再执行。{_DEPT_ID_HINT}。',
    domain='dept',
    perm='sys:dept:edit',
    mutating=True,
    preview=_preview_rename,
)
async def dept_rename(db: AsyncSession, ctx: RunContext, dept_id: str, new_name: str) -> dict[str, Any]:
    dept, obj = await _rename_param(db, dept_id, new_name)
    old_name = dept.name
    await dept_service.update(db=db, background_tasks=ctx.background_tasks, pk=dept.id, obj=obj)
    return {'dept_id': dept_id, 'old_name': old_name, 'new_name': obj.name}
