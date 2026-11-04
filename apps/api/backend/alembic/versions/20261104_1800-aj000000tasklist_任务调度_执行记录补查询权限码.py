"""任务调度 / 执行记录补「查询」权限码（task:scheduler:list · task:result:list）

Revision ID: aj000000tasklist
Revises: ai000000mcpicon
Create Date: 2026-11-04 18:00:00+08:00

issue #228：这两个模块的读接口原来只挂 `DependsJwtAuth`，任何登录用户都能读到所有任务的
`args` / `kwargs` 和执行记录里的 `result` / `traceback`。现在挂上了 `RequestPermission` + `DependsRBAC`，
权限码要有对应的按钮菜单才能被授权。

🔴 **光加按钮不授权，会把现在能用这两个页面的角色当场锁成 403**（同 #30 · `33ffb491b69f` 那次 MANAGER 的部门树）。
所以凡是**已经拥有父页面菜单**的角色，一并授予新的「查询」按钮 —— 升级前能看的，升级后照样能看。
没有父页面的角色本来就进不了这两个页面，不授权；超管不走菜单，不受影响。

- 菜单 ID 照抄种子（`sql/*/init_snowflake_test_data.sql`），升级上来的库和新建的库收敛到同一份
- 父级、角色都按业务键 / 现有关联解析，不硬编码 ID
- `sys_role_menu` 是纯连接行，主键走 `DATA_MIGRATION_PK_BASE` 的 `228_000` 段（按 issue 号分段，不和别的迁移撞）
- ⚠️ 用户的权限快照缓存在 Redis（`fba:user:*`，TTL = access token 时长）。迁移不碰 Redis（不给 `migrate` 容器
  加前置依赖，见 `utils/data_migration.py`），所以已登录用户最长要等一个 token 周期才拿到新按钮 ——
  这段时间里那些角色打这两页会 403。部署后想立即生效就清一次 `fba:user:*`（只清快照，不影响登录态）
"""

import sqlalchemy as sa

from alembic import op

from backend.utils.data_migration import DATA_MIGRATION_PK_BASE, add_menu, delete_by_key, scalar, seeded_pk_mode

# revision identifiers, used by Alembic.
revision = 'aj000000tasklist'
down_revision = 'ai000000mcpicon'
branch_labels = None
depends_on = None

#: (menu_id, name, perms, sort, parent_name)
_MENUS = [
    (2049629108253622318, 'QueryTaskScheduler', 'task:scheduler:list', 4, 'SchedulerManage'),
    (2049629108253622319, 'QueryTaskResult', 'task:result:list', 1, 'SchedulerRecord'),
]

_PK_BASE = DATA_MIGRATION_PK_BASE + 228_000

_role_menu = sa.table('sys_role_menu', sa.column('id'), sa.column('role_id'), sa.column('menu_id'))


def upgrade() -> None:
    if not seeded_pk_mode():
        # 自增主键模式没有基础种子（同 o0000000dataio）
        return
    conn = op.get_bind()
    next_pk = _PK_BASE
    for menu_id, name, perms, sort, parent in _MENUS:
        add_menu(conn, menu_id=menu_id, name=name, title='查询', perms=perms, sort=sort, parent_name=parent)
        child_id = scalar(conn, 'sys_menu', 'id', name=name)
        parent_id = scalar(conn, 'sys_menu', 'id', name=parent)
        if child_id is None or parent_id is None:
            continue
        holders = conn.execute(sa.select(_role_menu.c.role_id).where(_role_menu.c.menu_id == parent_id)).scalars()
        already = set(conn.execute(sa.select(_role_menu.c.role_id).where(_role_menu.c.menu_id == child_id)).scalars())
        for role_id in sorted(set(holders) - already):
            conn.execute(sa.insert(_role_menu).values(id=next_pk, role_id=role_id, menu_id=child_id))
            next_pk += 1


def downgrade() -> None:
    if not seeded_pk_mode():
        return
    conn = op.get_bind()
    for _menu_id, name, *_ in _MENUS:
        child_id = scalar(conn, 'sys_menu', 'id', name=name)
        if child_id is not None:
            conn.execute(sa.delete(_role_menu).where(_role_menu.c.menu_id == child_id))
        delete_by_key(conn, 'sys_menu', name=name)
