"""补齐已存在库缺的种子行（RBAC 权限锚点 / 消息中心菜单）

Revision ID: 33ffb491b69f
Revises: 9609aedfaf8d
Create Date: 2026-08-31 14:27:41.748755+08:00

issue #86。种子数据只在 `fba init`（从零建库）那条路径上跑一次，一个已经存在的库
再也不会重新执行那份 SQL —— 没有版本号、也没有任何检查会发现「种子改了但某个
正在跑的库没跟上」。实际后果：

- `5c1d594` 加的三条 RBAC 权限锚点菜单从没进生产库，而**校验在部署那一刻就生效了** ——
  MANAGER 演示账号原本能看的部门树当场 403
- `#81` 的消息中心菜单同理：功能上线了，侧边栏里没有入口

这条迁移把它们补上。`fba init` 建的新库不会执行它（init 末尾的 `alembic stamp head`
把它标成已应用而不运行），所以不会插两遍 —— 新库的行来自种子 SQL，老库的行来自这里。

机制与三条纪律见 `backend/utils/data_migration.py` 的模块注释。
"""

from alembic import op

from backend.plugin.core import check_plugin_installed
from backend.utils.data_migration import (
    DATA_MIGRATION_PK_BASE,
    add_menu,
    delete_by_key,
    grant_menu,
    scalar,
    seeded_pk_mode,
)

# revision identifiers, used by Alembic.
revision = '33ffb491b69f'
down_revision = '9609aedfaf8d'
branch_labels = None
depends_on = None


#: RBAC 权限锚点（`5c1d594`）。ID 照抄种子文件 —— 三个方言的 `sys_menu` 是同一套 ID。
#: 父级按 `name` 解析，所以不用管各环境的 ID 差异。
_PERM_ANCHORS = [
    # (menu_id, name, perms, parent_name, sort)
    (2049629108253622336, 'QuerySysRole', 'sys:role:list', 'SysRole', 4),
    (2049629108253622337, 'QuerySysDept', 'sys:dept:list', 'SysDept', 2),
    (2049629108253622338, 'QuerySysDataScope', 'data:scope:list', 'SysDataPermission', 5),
]

#: 消息中心（`#81` 的 `plugin/notification/sql/*/init_snowflake.sql`）
_NOTIFICATION_MENU_ID = 2049629108262010880
_NOTIFICATION_SEND_MENU_ID = 2049629108262010881

#: 演示角色 —— 种子里这四个都挂了消息中心。按 `code` 解析，各环境 ID 不同也没关系。
_DEMO_ROLE_CODES = ['STAFF', 'MANAGER', 'FINANCE_STAFF', 'VIEWER']


def upgrade() -> None:
    if not seeded_pk_mode():
        # 自增主键模式下没有基础种子，也就没有「种子没同步」这个问题
        return

    conn = op.get_bind()

    # ── 1. RBAC 权限锚点（5c1d594）────────────────────────────────────────────
    for menu_id, name, perms, parent_name, sort in _PERM_ANCHORS:
        add_menu(conn, menu_id=menu_id, name=name, title='查询', perms=perms, parent_name=parent_name, sort=sort)

    # MANAGER 要能看部门树。`sys:user:list` 那条种子里早就授权过了，这里只补部门这条。
    grant_menu(conn, row_id=DATA_MIGRATION_PK_BASE + 1, role_code='MANAGER', menu_name='QuerySysDept')

    # ── 2. 消息中心（#81）─────────────────────────────────────────────────────
    #
    # ⚠️ 用 `check_plugin_installed` 而不是「`sys_notification` 表在不在」：那张表由
    # 迁移 `9609aedfaf8d` 无条件创建，插件卸载了它照样在 —— 拿它当判据会给一个
    # 已卸载的插件插菜单，而侧边栏点进去是 404。
    if check_plugin_installed('notification'):
        add_menu(
            conn,
            menu_id=_NOTIFICATION_MENU_ID,
            name='Notification',
            title='消息中心',
            path='/notification',
            icon='mdi:bell-outline',
            menu_type=1,
            sort=7,
            display=1,
        )
        add_menu(
            conn,
            menu_id=_NOTIFICATION_SEND_MENU_ID,
            name='SendNotification',
            title='发送通知',
            perms='sys:notification:send',
            parent_name='Notification',
        )
        for offset, code in enumerate(_DEMO_ROLE_CODES, start=11):
            grant_menu(conn, row_id=DATA_MIGRATION_PK_BASE + offset, role_code=code, menu_name='Notification')

    # ⚠️ 刻意**不**补 `sys_notification` 那三条演示通知：它们是纯装饰，而其中一条的
    # `recipient_id` 指向 sqlserver 种子里那个 admin 的 ID，搬到别的方言上是个悬空引用。
    # 缺菜单会让整个功能没有入口（真问题），缺演示数据不会。


def downgrade() -> None:
    if not seeded_pk_mode():
        return

    conn = op.get_bind()

    # 先删授权行再删菜单 —— 反过来的话 `grant_menu` 解析不到菜单，授权行会留成悬空
    for code in _DEMO_ROLE_CODES:
        role_id = scalar(conn, 'sys_role', 'id', code=code)
        menu_id = scalar(conn, 'sys_menu', 'id', name='Notification')
        if role_id is not None and menu_id is not None:
            delete_by_key(conn, 'sys_role_menu', role_id=role_id, menu_id=menu_id)

    manager_id = scalar(conn, 'sys_role', 'id', code='MANAGER')
    dept_query_id = scalar(conn, 'sys_menu', 'id', name='QuerySysDept')
    if manager_id is not None and dept_query_id is not None:
        delete_by_key(conn, 'sys_role_menu', role_id=manager_id, menu_id=dept_query_id)

    for name in ('SendNotification', 'Notification'):
        delete_by_key(conn, 'sys_menu', name=name)
    for _, name, _, _, _ in _PERM_ANCHORS:
        delete_by_key(conn, 'sys_menu', name=name)
