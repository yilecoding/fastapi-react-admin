"""审批人规则解析（#107 设计 2「审批人规则」）

返回的是「有序、去重、只含正常状态用户」的 `[(id, 昵称)]`。昵称顺带拿回来做快照。

🔴 **结果里永远去掉发起人**（pis-oms 的规则；pis 吃过「申请人自审」的亏）。
去掉之后为空，交给节点的 `onEmpty` 处理 —— 这里不做任何兜底。
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from sqlalchemy import case, select, true

from backend.app.admin.model import Dept, User
from backend.app.admin.model.m2m import user_role
from backend.plugin.workflow.engine.form import is_bigint_id

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession


def _ids(values: Any) -> list[int]:
    """把一串 ID 转成 int，不是纯数字的丢掉。

    发起页的流程预告拿的是**还没校验**的表单（填到一半的人员字段可能是空串），
    这里 `int()` 一个非数字就是 500 —— 预告是给人看的，宁可少算一个人也不能整个挂掉。
    """
    return [int(x) for x in values or [] if is_bigint_id(x)]


async def users_by_ids(db: AsyncSession, ids: list[int]) -> list[tuple[int, str]]:
    """按给定顺序取正常状态的用户；查不到 / 停用 / 删除的直接丢掉"""
    if not ids:
        return []
    rows = await db.execute(select(User.id, User.nickname).where(User.id.in_(ids), User.deleted == 0, User.status == 1))
    found = dict(rows.all())
    return [(i, found[i]) for i in dict.fromkeys(ids) if i in found]


async def user_dept(db: AsyncSession, user_id: int) -> int | None:
    return await db.scalar(select(User.dept_id).where(User.id == user_id))


async def _dept_chain(db: AsyncSession, dept_id: int | None) -> list[Any]:
    """从这个部门一路往上到根：[自己, 父, 祖父, …]。防环：同一个部门不走第二次"""
    chain = []
    seen: set[int] = set()
    while dept_id is not None and dept_id not in seen:
        seen.add(dept_id)
        # 负责人停用 / 删除了就当「没配」：不然这一级照样算命中、取人为空，走 onEmpty（默认驳回）——
        # 组长离职账号一停，组员之后每张单都被自动驳回（独立审查发现）
        leader_ok = select(User.id).where(User.id == Dept.leader_id, User.deleted == 0, User.status == 1).exists()
        row = (
            await db.execute(
                select(Dept.id, Dept.parent_id, case((leader_ok, Dept.leader_id), else_=None).label('leader_id')).where(
                    Dept.id == dept_id, Dept.deleted == 0
                )
            )
        ).first()
        if row is None:
            break
        chain.append(row)
        dept_id = row.parent_id
    return chain


async def _dept_tree_ids(db: AsyncSession, dept_id: int) -> set[int]:
    """这个部门和它所有下级部门"""
    rows = (await db.execute(select(Dept.id, Dept.parent_id).where(Dept.deleted == 0))).all()
    children: dict[int | None, list[int]] = {}
    for pk, parent in rows:
        children.setdefault(parent, []).append(pk)
    out, stack = set(), [dept_id]
    while stack:
        cur = stack.pop()
        if cur in out:
            continue
        out.add(cur)
        stack.extend(children.get(cur, []))
    return out


async def resolve(  # ruff:ignore[complex-structure]
    db: AsyncSession,
    rule: dict[str, Any],
    *,
    initiator_id: int,
    initiator_dept_id: int | None,
    form_data: dict[str, Any],
    selected: dict[str, list[str]],
    node_id: str,
) -> list[tuple[int, str]]:
    kind = rule.get('kind')
    ids: list[int] = []
    match kind:
        case 'user':
            ids = _ids(rule.get('user_ids'))
        case 'initiator':
            # 「确认」类节点：发起人自己办。这是唯一不去掉发起人的规则 —— 规则本身就是选他
            return await users_by_ids(db, [initiator_id])
        case 'role':
            role_ids = _ids(rule.get('role_ids'))
            if role_ids:
                rows = await db.execute(
                    select(user_role.c.user_id).where(user_role.c.role_id.in_(role_ids)).order_by(user_role.c.user_id)
                )
                ids = [r[0] for r in rows.all()]
        case 'dept_leader':
            # 第 1 级 = 发起人所在部门的负责人，第 2 级 = 上一级部门的负责人……
            # 某一级的负责人**就是发起人自己**时往上再找一级：部门负责人发起的申请
            # 交给他自己审批没有意义，而按「去掉发起人」直接落空又会让每个负责人的
            # 申请都走 onEmpty。没配负责人的部门同样往上跳，不算一级。
            level = rule.get('level') or 1
            hit = 0
            for d in await _dept_chain(db, initiator_dept_id):
                if d.leader_id is None or d.leader_id == initiator_id:
                    continue
                hit += 1
                if hit == level:
                    ids = [d.leader_id]
                    break
        case 'var_user':
            v = form_data.get(rule.get('field') or '')
            ids = _ids(v if isinstance(v, list) else [v])
        case 'select_on_start':
            ids = _ids(selected.get(node_id))

    users = await users_by_ids(db, ids)

    scope = rule.get('scope') or 'none'
    if scope != 'none' and kind == 'role':
        # 范围限定取不到范围值（发起人没有部门）时**不静默放开成全平台**，结果为空交给 onEmpty
        if initiator_dept_id is None:
            return []
        allowed = {initiator_dept_id} if scope == 'initiator_dept' else await _dept_tree_ids(db, initiator_dept_id)
        dept_of = dict(
            (await db.execute(select(User.id, User.dept_id).where(User.id.in_([u for u, _ in users])))).all()
        )
        users = [(u, n) for u, n in users if dept_of.get(u) in allowed]

    return [(u, n) for u, n in users if u != initiator_id]


async def superusers(db: AsyncSession, *, initiator_id: int) -> list[tuple[int, str]]:
    """onEmpty=admin 的去处。

    🔴 布尔列要写 `== true()`，**不能写 `.is_(True)`**：后者在 SQL Server 上编译成
    `is_superuser IS 1`，那不是合法 T-SQL（`IS` 后面只能跟 `NULL`），直接 500。
    PG / MySQL 认这个写法，所以只在 SQL Server 上炸 —— 实测踩过，发起人所在部门没配负责人、
    节点配了「转给管理员」时触发。

    同样去掉发起人：管理员自己发起的单子不能转回给他自己审批。
    """
    rows = await db.execute(
        select(User.id, User.nickname)
        .where(User.is_superuser == true(), User.deleted == 0, User.status == 1)
        .order_by(User.id)
    )
    return [(r[0], r[1]) for r in rows.all() if r[0] != initiator_id]
