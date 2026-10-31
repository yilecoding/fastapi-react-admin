"""「看的人」和「发给谁」（#190）。

```
Viewer        这次请求是谁在看：本人 · 建号时间 · 本部门 + 所有上级部门 · 启用的角色。service 里由 request.user 构造一次
受众表        sys_notification_audience：一个来源（notice:<id>）发给哪些部门 / 角色 / 用户；一行都没有 = 全员
audience_admits(viewer, source)   这个人在不在这个来源的受众里 —— 收件箱和公告**都用这一个**
```

🔴 部门按「含下级」算：发给「技术中心」，后端组的人也要看得到。判定在看的人这一侧做（他的部门 + 所有上级部门里
有没有被点名的），所以受众表里只存被点名的那个部门，不展开整棵子树 —— 之后在它下面新建的组自动在范围内。
阅读统计要反过来「这个来源发给了哪些人」，见 `audience_user_clause`（往下展开子树），两边的口径必须一致：
都只走没删的部门（`_dept_chain` 往上走时遇到删了的部门就停，往下展开也只认没删的子部门）。
"""

from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from sqlalchemy import ColumnElement, and_, case, false, literal, or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased

from backend.common.enums import StatusType
from backend.plugin.notification.enums import AudienceKind
from backend.plugin.notification.model import NotificationAudience


@dataclass(frozen=True, slots=True)
class Viewer:
    """看的人。收件箱的「看得见哪些行」「哪些算未读」、公告的「看得见哪些」都以它为准"""

    id: int
    #: 建号时间。建号之前写的广播行对他算已读（新账号不该一进来就是几十个红点）
    join_time: datetime
    #: 本部门 + 所有上级部门
    dept_ids: tuple[int, ...] = ()
    #: 启用的角色
    role_ids: tuple[int, ...] = ()


#: 部门链最多往上走几层。只防库里有环（修查环之前写进去的）时没完没了：真实的部门树到不了这么深。
#: ⚠️ 不能往 100 以上调：SQL Server 递归 CTE 默认最多递归 100 层（`MAXRECURSION`），超了是**整条查询报错**（530），
#: 不是截断 —— 实测有环时上限 101 正好 100 层、能跑，200 报 530
_MAX_DEPT_DEPTH = 64


async def _dept_chain(db: AsyncSession, dept_id: int) -> tuple[int, ...]:
    """本部门 + 所有上级部门：**一条**递归 CTE（三个方言都认 `WITH RECURSIVE` / `WITH` 的递归写法）

    🔴 原来是 `dept_dao.get_ancestor_ids` 一层一条主键查询 —— 而「看的人」每个请求都要构造一次（未读数、
    每一次附件下载权限），部门树多深就多几次往返。口径和那段循环逐个部门对得上（`test_notice_phase2.py`
    里拿两者对表）：本部门照算；一个部门**没删**才接着往上走，所以删了的部门本身算、它的上级不算。

    - 每一行带着「下一个往上走到哪」（`next_id`，删了的部门是 NULL），结果取本部门 + 各行的 `next_id`：
      `parent_id` 指着一个不存在的部门时也照样算上它（同那段循环）
    - 有环时靠 `depth` 截住（`_MAX_DEPT_DEPTH`），重复的 ID 在这边去掉
    """
    from backend.app.admin.model import Dept

    chain = (
        select(
            Dept.id.label('id'),
            case((Dept.deleted == 0, Dept.parent_id), else_=None).label('next_id'),
            literal(1).label('depth'),
        )
        .where(Dept.id == dept_id)
        .cte('dept_chain', recursive=True)
    )
    up = aliased(Dept, name='up')
    chain = chain.union_all(
        select(up.id, case((up.deleted == 0, up.parent_id), else_=None), chain.c.depth + 1).where(
            up.id == chain.c.next_id, chain.c.depth < _MAX_DEPT_DEPTH
        )
    )
    parents = (await db.scalars(select(chain.c.next_id).where(chain.c.next_id.is_not(None)))).all()
    return tuple(dict.fromkeys([dept_id, *parents]))


async def viewer_of(db: AsyncSession, user: Any) -> Viewer:
    """由 `request.user`（JWT 用户快照）构造。部门的上级链查一次库（`_dept_chain`，一条递归 CTE）"""
    dept_ids: tuple[int, ...] = ()
    if getattr(user, 'dept_id', None) is not None:
        dept_ids = await _dept_chain(db, int(user.dept_id))
    role_ids = tuple(int(r.id) for r in (user.roles or []) if r.status == StatusType.enable)
    return Viewer(id=int(user.id), join_time=user.join_time, dept_ids=dept_ids, role_ids=role_ids)


def _hits(viewer: Viewer) -> ColumnElement[bool]:
    """受众表里「点到了这个人」的那些行"""
    a = NotificationAudience
    hits = [and_(a.kind == AudienceKind.user.value, a.target_id == viewer.id)]
    # 空列表不拼 IN：SQLAlchemy 会把空 IN 渲染成恒假表达式，能跑，但没必要让每个方言都走一遍那条分支
    if viewer.dept_ids:
        hits.append(and_(a.kind == AudienceKind.dept.value, a.target_id.in_(viewer.dept_ids)))
    if viewer.role_ids:
        hits.append(and_(a.kind == AudienceKind.role.value, a.target_id.in_(viewer.role_ids)))
    return or_(*hits)


def audience_admits(viewer: Viewer, source: ColumnElement[str]) -> ColumnElement[bool]:
    """「这个来源的受众里有没有这个人」：一行受众都没有（全员）或者有一行点到了他。

    `source` 是外层查询里的一列 / 一个表达式（收件箱传 `Notification.source`，
    公告传 `source_expr('notice', Notice.id)`），两个子查询都关联到外层那一行

    :param viewer: 看的人
    :param source: 外层查询的来源列 / 表达式
    :return:
    """
    rows = select(NotificationAudience.id).where(NotificationAudience.source == source)
    return or_(~rows.exists(), rows.where(_hits(viewer)).exists())


def no_audience(source: ColumnElement[str]) -> ColumnElement[bool]:
    """这个来源没有受众限制（全员）"""
    return ~select(NotificationAudience.id).where(NotificationAudience.source == source).exists()


async def _with_descendants(db: AsyncSession, dept_ids: Iterable[int]) -> set[int]:
    """被点名的部门 + 它们所有没删的下级部门（部门表是几十上百行的配置，整张读进来往下走）"""
    from backend.app.admin.model import Dept

    children: dict[int, list[int]] = {}
    for pk, parent in (await db.execute(select(Dept.id, Dept.parent_id).where(Dept.deleted == 0))).all():
        if parent is not None:
            children.setdefault(parent, []).append(pk)
    out: set[int] = set()
    stack = list(dept_ids)
    # 带着「走过的」集合走：库里要是有环（修部门查环之前写进去的），不带它就是死循环
    while stack:
        current = stack.pop()
        if current in out:
            continue
        out.add(current)
        stack.extend(children.get(current, ()))
    return out


async def audience_user_clause(db: AsyncSession, source: str) -> ColumnElement[bool] | None:
    """反过来：这个来源发给了哪些人 —— 给 `sys_user` 用的条件（阅读统计的「未读」那一页）。None = 全员

    和 `audience_admits` 同一个口径：部门含下级、角色只认启用（且没删）的

    :param db: 数据库会话
    :param source: 来源
    :return:
    """
    from backend.app.admin.model import Role, User, user_role

    rows = (
        await db.execute(
            select(NotificationAudience.kind, NotificationAudience.target_id).where(
                NotificationAudience.source == source
            )
        )
    ).all()
    if not rows:
        return None
    by_kind: dict[str, set[int]] = {}
    for kind, target_id in rows:
        by_kind.setdefault(kind, set()).add(target_id)
    conds: list[ColumnElement[bool]] = []
    if users := by_kind.get(AudienceKind.user.value):
        conds.append(User.id.in_(sorted(users)))
    if depts := by_kind.get(AudienceKind.dept.value):
        conds.append(User.dept_id.in_(sorted(await _with_descendants(db, depts))))
    if roles := by_kind.get(AudienceKind.role.value):
        holders = (
            select(user_role.c.user_id)
            .join(Role, Role.id == user_role.c.role_id)
            .where(user_role.c.role_id.in_(sorted(roles)), Role.status == StatusType.enable, Role.deleted == 0)
        )
        conds.append(User.id.in_(holders))
    return or_(*conds) if conds else false()


def normalize_audience(entries: Sequence[tuple[str, int]]) -> list[tuple[str, int]]:
    """去重、保序（同一个部门点了两次只存一行，唯一约束也不许两行）

    ⚠️ 取 `.value` 不用 `str()`：本仓库的 `StrEnum` 是 `(str, Enum)` 的老写法，`str(AudienceKind.dept)` 是
    `'AudienceKind.dept'`（common/security 分册记过），写进库里就谁也匹配不上了
    """
    return list(dict.fromkeys((AudienceKind(kind).value, int(target_id)) for kind, target_id in entries))
