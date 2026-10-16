"""审批：待办的轮次列（退回后重走同一节点）+「改办理人」权限菜单

两件事：

1. `wf_task.batch`：退回之后同一个节点会走第二遍，「这一步谁已经同意过 / 还剩几个人」
   只能在同一轮里数（见模型上的注释）。存量行回填 0 —— 它们都是第一轮
2. 「实例监控」下补一个按钮权限 `workflow:instance:reassign`（改办理人 / 离职交接），
   菜单 ID 照抄 `plugin/workflow/sql/*/init_snowflake.sql`

## 幂等

新库是 `create_all` 从模型建的，天然就有这一列（同 `d0000000usertz`），先查再加。
加完去掉 server_default：模型侧的默认值是 Python 级的，库上留着 DEFAULT 约束的话
`test_model_matches_migrations` 会报差异。

Revision ID: a7d8fbe59942
Revises: 9d0fb0b50b06
Create Date: 2026-10-16 17:13:50.540241+08:00

"""

import sqlalchemy as sa

from alembic import op

from backend.plugin.core import check_plugin_installed
from backend.utils.data_migration import add_menu, delete_by_key, scalar, seeded_pk_mode

# revision identifiers, used by Alembic.
revision = 'a7d8fbe59942'
down_revision = '9d0fb0b50b06'
branch_labels = None
depends_on = None

_TABLE = 'wf_task'
_COLUMN = 'batch'
_MENU = (
    2049629108266205211,
    'ReassignWorkflowInstance',
    '改办理人',
    'WorkflowMonitor',
    'workflow:instance:reassign',
    2,
)


def _has_column() -> bool:
    return _COLUMN in {c['name'] for c in sa.inspect(op.get_bind()).get_columns(_TABLE)}


def upgrade() -> None:
    if not _has_column():
        op.add_column(
            _TABLE,
            sa.Column(
                _COLUMN,
                sa.Integer(),
                nullable=False,
                server_default='0',
                comment='进入节点的轮次（退回后重走同一节点时不同）',
            ),
        )
        op.alter_column(_TABLE, _COLUMN, server_default=None)

    if seeded_pk_mode() and check_plugin_installed('workflow'):
        menu_id, name, title, parent, perms, sort = _MENU
        add_menu(op.get_bind(), menu_id=menu_id, name=name, title=title, parent_name=parent, perms=perms, sort=sort)


def downgrade() -> None:
    if seeded_pk_mode():
        conn = op.get_bind()
        menu_id = scalar(conn, 'sys_menu', 'id', name=_MENU[1])
        if menu_id is not None:
            delete_by_key(conn, 'sys_role_menu', menu_id=menu_id)
        delete_by_key(conn, 'sys_menu', name=_MENU[1])
    if _has_column():
        op.drop_column(_TABLE, _COLUMN)
