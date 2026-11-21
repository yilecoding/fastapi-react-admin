"""任务提示推给谁（#400）

`TaskBase` 的提示原来 `sio.emit(...)` **不带房间**：开始 / 成功那两条所有在线页面都收到；失败那条写的是
`执行失败：{exc}`，也是推给所有人 —— 它一直没推出去（见 `tasks/base.py: on_failure`），否则任何一个登录用户都会看到
`SQLAlchemyError` 重试耗尽后 `str(exc)` 里的完整 SQL、绑定参数和数据库主机。修通推送之前先把受众和内容收住。

现在只推给**看得到执行记录的人**（`task:result:list`，执行记录页和详情接口的守卫），按人推进 `user_room`；
提示里也不再带异常原文 —— 那些在执行记录里（#228 把它收在同一个权限码后面），推送只说「失败了，去那里看」。
"""

from backend.common.log import log
from backend.common.socketio.actions import task_notification
from backend.database.db import async_db_session

#: 看执行记录要的权限码（`app/task/api/v1/result.py`）。推送的受众和它对齐：能看到提示的人，点进去也看得到详情
TASK_RESULT_PERM = 'task:result:list'


async def task_watcher_ids() -> list[int]:
    """现在能看执行记录的人

    两步：SQL 先粗筛候选（启用的超管 + 某个启用角色挂着一个 `perms` 里含这个码的菜单），
    再逐个拿 `get_jwt_user` 的快照过 `rbac.user_has_perm`。🔴 **判据只能是 `user_has_perm`**：
    父目录停用 = 整棵关掉（#143）、权限码白名单、casbin 模式下只认超管 —— 这些都只在那一份里，
    自己用 SQL 判一遍就是第二套，迟早和接口守卫分叉（结果是看得到提示、点进去 403，或者反过来）。
    """
    from sqlalchemy import or_, select, true

    from backend.app.admin.model import Menu, Role, User
    from backend.app.admin.model.m2m import role_menu, user_role
    from backend.common.enums import StatusType
    from backend.common.exception import errors
    from backend.common.security.data_scope import bypass_data_scope
    from backend.common.security.jwt import get_jwt_user
    from backend.common.security.rbac import user_has_perm
    from backend.core.conf import settings

    stmt = select(User.id).where(User.status == StatusType.enable, User.deleted == 0)
    if not settings.RBAC_ROLE_MENU_MODE:
        # casbin 模式：`user_has_perm` 只放行超管（fail-closed），候选也只取超管
        stmt = stmt.where(User.is_superuser == true())
    elif TASK_RESULT_PERM not in settings.RBAC_ROLE_MENU_EXCLUDE:
        granted = (
            select(user_role.c.user_id)
            .join(Role, Role.id == user_role.c.role_id)
            .join(role_menu, role_menu.c.role_id == Role.id)
            .join(Menu, Menu.id == role_menu.c.menu_id)
            .where(Role.status == StatusType.enable, Menu.perms.like(f'%{TASK_RESULT_PERM}%'))
        )
        # 🔴 布尔列写 `== true()`：写成 is_(True) 在 SQL Server 上编译成非法的 `IS 1`（CI 的 SQL Server job 红过一次）
        stmt = stmt.where(or_(User.is_superuser == true(), User.id.in_(granted)))
    # 码在白名单里：人人都过得了那道闸，候选就是全部启用用户，交给下面逐个判

    # 后台任务里没有「当前用户」，查人不能被谁的数据范围过滤
    with bypass_data_scope():
        async with async_db_session() as db:
            candidates = list((await db.scalars(stmt)).all())

    ids: list[int] = []
    for user_id in candidates:
        try:
            user = await get_jwt_user(user_id)
        except errors.BaseExceptionError:
            continue  # 部门 / 角色全停用之类，登不进来的人也不推
        if user.status == StatusType.enable and user_has_perm(user, TASK_RESULT_PERM):
            ids.append(user_id)
    return ids


async def notify_task_watchers(msg: str) -> None:
    """把一条任务提示推给能看执行记录的人。推不出去只记日志 —— 少一条 toast 不该让任务失败"""
    try:
        await task_notification(msg, await task_watcher_ids())
    except Exception as e:
        log.warning(f'任务提示推送失败（{msg}）：{e!r}')
