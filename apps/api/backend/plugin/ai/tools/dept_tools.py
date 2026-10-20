"""部门域工具。"""

from typing import Any

from sqlalchemy import or_
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.admin.crud.crud_user import user_dao
from backend.app.admin.model import Dept, User
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


# 🔴 「不要先用 user_list 查」那半句是实测补的：真实模型会先用 user_list 按**用户名**搜「张伟」
# （张伟是昵称，用户名是 zhangwei），搜不到就断定「用户不存在」、不再调这个工具 ——
# 而工具自己是按用户名**或昵称**找的。模型的谨慎在这里反而挡住了一条本来能走通的路
_LEADER_HINT = (
    'leader 直接填用户说的名字（用户名或昵称都行），工具会自己按用户名或昵称精确查找，'
    '不要先用 user_list 去查；找不到或重名时工具会返回原因和候选人'
)


async def _resolve_leader(db: AsyncSession, leader: str) -> User:
    """负责人：人说的是名字，库里存的是用户 ID。

    🔴 **只在调用者的数据范围里找**（`user_dao` 是 `DataScopedCRUD`，dispatcher 已锚定调用者）——
    看不见的人设不了，也不会因为「找到了」而泄露「这个人存在」。
    🔴 **重名不猜**：两个「张伟」时随便挑一个，就是把部门交给一个用户根本没指的人，而确认卡片上
    看起来完全正常。抛错并列出候选（带用户名），模型会回去问。
    停用的账号不算 —— 和 `dept_service._check_leader` 同一判据，审批按负责人取人时停用的等于没配。
    """
    name = leader.strip()
    users = await user_dao.select_models(
        db, or_(User.username == name, User.nickname == name), User.status == 1, User.deleted == 0
    )
    if not users:
        raise ValueError(f'找不到负责人「{name}」：按用户名或昵称精确匹配，且必须是你能看到的、未停用的账号')
    if len(users) > 1:
        candidates = '、'.join(f'{u.nickname}（用户名 {u.username}）' for u in users)
        raise ValueError(f'「{name}」对应多个用户：{candidates}。请向用户确认是哪一位，再用用户名重试')
    return users[0]


def _leader_label(user: User) -> str:
    return f'{user.nickname}（{user.username}）'


async def _create_param(
    db: AsyncSession, name: str, code: str, parent_id: str | None, leader: str | None, sort: int
) -> tuple[CreateDeptParam, User | None]:
    """🔴 负责人在这里解析成 `leader_id`，**不要**把名字原样塞进 `CreateDeptParam`：
    #108 把字段改成 `leader_id` 之后，pydantic 会静默丢弃未知字段 —— 预演卡片写着
    「负责人：张三」，建出来的部门没有负责人，不报错（实测踩过，`test_ai_write_tools.py` 守着）。
    """
    leader_user = await _resolve_leader(db, leader) if leader else None
    obj = CreateDeptParam(
        name=name,
        code=code,
        parent_id=parent_id,
        leader_id=leader_user.id if leader_user else None,
        sort=sort,
        status=1,
    )
    return obj, leader_user


async def _preview_create(
    db: AsyncSession,
    name: str,
    code: str,
    parent_id: str | None = None,
    leader: str | None = None,
    sort: int = 0,
) -> str:
    obj, leader_user = await _create_param(db, name, code, parent_id, leader, sort)
    parent = await dept_service.check_create(db=db, obj=obj)
    where = f'「{parent.name}」下' if parent else '顶级'
    extra = f'，负责人 {_leader_label(leader_user)}' if leader_user else ''
    return f'将在{where}新建部门「{obj.name}」（编码 {obj.code}{extra}）'


@ai_tool(
    name='dept_create',
    description=(
        '新建一个部门。会先请用户确认再执行。'
        f'code 是部门编码（大写字母开头，只含大写字母、数字、下划线，2-32 位，创建后不可改）；'
        f'parent_id 不传表示顶级部门。{_DEPT_ID_HINT}。{_LEADER_HINT}。'
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
    leader: str | None = None,
    sort: int = 0,
) -> dict[str, Any]:
    obj, _ = await _create_param(db, name, code, parent_id, leader, sort)
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


async def _leader_param(db: AsyncSession, dept_id: str, leader: str) -> tuple[Dept, UpdateDeptParam, User]:
    """换负责人 = 只动 leader_id。name / parent_id / status 带原值，理由同 `_rename_param`"""
    dept = await dept_service.get(db=db, pk=int(dept_id))
    leader_user = await _resolve_leader(db, leader)
    obj = UpdateDeptParam(name=dept.name, parent_id=dept.parent_id, status=dept.status, leader_id=leader_user.id)
    return dept, obj, leader_user


async def _preview_set_leader(db: AsyncSession, dept_id: str, leader: str) -> str:
    dept, obj, leader_user = await _leader_param(db, dept_id, leader)
    if dept.leader_id == obj.leader_id:
        raise ValueError(f'部门「{dept.name}」的负责人已经是 {_leader_label(leader_user)}，不需要改')
    await dept_service.check_update(db=db, pk=dept.id, obj=obj)
    if not dept.leader_id:
        before = '从「未设置」'
    elif old := await user_dao.select_model(db, dept.leader_id):
        before = f'从 {_leader_label(old)} '
    else:
        # 原负责人不在调用者的数据范围里：不把他的名字摊出来
        before = '从（你看不到的用户）'
    return f'将把部门「{dept.name}」（编码 {dept.code}）的负责人{before}改为 {_leader_label(leader_user)}'


@ai_tool(
    name='dept_set_leader',
    description=f'设置 / 更换部门负责人（只改负责人）。会先请用户确认再执行。{_DEPT_ID_HINT}。{_LEADER_HINT}。',
    domain='dept',
    perm='sys:dept:edit',
    mutating=True,
    preview=_preview_set_leader,
)
async def dept_set_leader(db: AsyncSession, ctx: RunContext, dept_id: str, leader: str) -> dict[str, Any]:
    dept, obj, leader_user = await _leader_param(db, dept_id, leader)
    await dept_service.update(db=db, background_tasks=ctx.background_tasks, pk=dept.id, obj=obj)
    return {'dept_id': dept_id, 'dept_name': dept.name, 'leader': _leader_label(leader_user)}
