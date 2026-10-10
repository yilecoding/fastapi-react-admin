"""补齐已存在库缺的 AI 助手菜单

Revision ID: f0000000aimenu
Revises: e0000000aiasst
Create Date: 2026-09-13 01:40:00

issue #104。`plugin/ai/sql/*/init_snowflake.sql` 只在 `fba init`（从零建库）那条路径上
跑一次，已经在跑的库永远不会执行它 —— 表由上一条迁移建出来了，菜单却一条都没有，
表现是**功能装好了但侧边栏里找不到入口**（同 `#81` 消息中心那次）。

这条把菜单补上。新库不会执行它（`fba init` 末尾 `alembic stamp head` 标成已应用
而不运行），所以不会插两遍。

⚠️ **刻意不补 `sys_role_menu`**：超管本来就拿得到全部菜单
（`menu_service.get_sidebar` 对 is_superuser 走 `get_sidebar(db, None)`），
而哪些非超管角色该有 AI 入口是每套部署自己的产品决定，不该由迁移替人做主。
"""

from alembic import op

from backend.plugin.core import check_plugin_installed
from backend.utils.data_migration import add_menu, delete_by_key, seeded_pk_mode

# revision identifiers, used by Alembic.
revision = 'f0000000aimenu'
down_revision = 'e0000000aiasst'
branch_labels = None
depends_on = None

#: 和 `plugin/ai/sql/*/init_snowflake.sql` 里**同一套 ID**（sys_menu 三个方言共用一套），
#: 抄过来才能让升级上来的库和新建的库收敛到同一份数据。
#: (menu_id, name, title, path, icon, menu_type, perms, sort, display, parent_name)
_MENUS = [
    (2210000000000000001, 'AiAssistant', 'AI 助手', '/ai', 'mdi:robot-outline', 0, None, 8, 1, None),
    (
        2210000000000000002,
        'AiChat',
        '对话助手',
        '/ai/chat',
        'mdi:chat-processing-outline',
        1,
        None,
        1,
        1,
        'AiAssistant',
    ),
    (
        2210000000000000003,
        'AiProvider',
        '模型密钥管理',
        '/ai/provider',
        'mdi:key-variant',
        1,
        None,
        2,
        1,
        'AiAssistant',
    ),
    (2210000000000000004, 'AiToolLog', '调用日志', '/ai/tool-log', 'mdi:history', 1, None, 3, 1, 'AiAssistant'),
    (2210000000000000005, 'UseAiChat', '发起对话', None, None, 2, 'ai:chat:use', 0, 0, 'AiChat'),
    (2210000000000000006, 'QueryAiProvider', '查询', None, None, 2, 'ai:provider:list', 0, 0, 'AiProvider'),
    (2210000000000000007, 'AddAiProvider', '新增', None, None, 2, 'ai:provider:add', 1, 0, 'AiProvider'),
    (2210000000000000008, 'EditAiProvider', '修改', None, None, 2, 'ai:provider:edit', 2, 0, 'AiProvider'),
    (2210000000000000009, 'DeleteAiProvider', '删除', None, None, 2, 'ai:provider:del', 3, 0, 'AiProvider'),
    (2210000000000000010, 'QueryAiToolLog', '查询', None, None, 2, 'ai:log:list', 0, 0, 'AiToolLog'),
]


def upgrade() -> None:
    if not seeded_pk_mode():
        # 自增主键模式下没有基础种子，也就没有「种子没同步」这个问题
        return

    # ⚠️ 用 `check_plugin_installed` 而不是「ai_provider 表在不在」：那张表由上一条迁移
    # 无条件创建，插件卸载了它照样在 —— 拿它当判据会给一个已卸载的插件插菜单，
    # 而侧边栏点进去是 404（`33ffb491b69f` 里记过同一条）
    if not check_plugin_installed('ai'):
        return

    conn = op.get_bind()
    # 顺序不能乱：父级按 name 解析，目录必须先于它的子项插入
    for menu_id, name, title, path, icon, menu_type, perms, sort, display, parent in _MENUS:
        add_menu(
            conn,
            menu_id=menu_id,
            name=name,
            title=title,
            path=path,
            perms=perms,
            icon=icon,
            menu_type=menu_type,
            sort=sort,
            display=display,
            parent_name=parent,
        )


def downgrade() -> None:
    if not seeded_pk_mode():
        return

    conn = op.get_bind()
    # 倒序删：先叶子后目录，否则子项会变成孤儿（`traversal_to_tree` 会把孤儿提到根，
    # 表现是侧边栏凭空多出几条顶层菜单）
    for menu in reversed(_MENUS):
        delete_by_key(conn, 'sys_menu', name=menu[1])
