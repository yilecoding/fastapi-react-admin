"""数据变更审计：sys_data_change 表 · 「日志管理 → 数据变更」页 + 查询按钮 · 参数配置「日志」组的保留天数

Revision ID: al000000datachange
Revises: ak000000noticehtml
Create Date: 2026-11-09 12:00:00

issue #260。表 + 菜单 + 参数放在一条里：它们一起才构成「功能可用」
（只建表的话记录照写，但没有地方看，保留天数也没处改）。

🔴 手写的建表要自己写 `autoincrement=False`：SQL Server 上会把雪花主键建成 IDENTITY（alembic 分册）。
菜单 / 参数行照抄种子文件里那几个 ID（三个方言同一套），按业务键（`name` / `key`）判存在，幂等。
"""

import sqlalchemy as sa

from alembic import op

import backend.common.model

from backend.plugin.core import check_plugin_installed
from backend.utils.data_migration import add_menu, delete_by_key, insert_if_absent, seeded_pk_mode
from backend.utils.timezone import timezone

# revision identifiers, used by Alembic.
revision = 'al000000datachange'
down_revision = 'ak000000noticehtml'
branch_labels = None
depends_on = None

#: 和 `sql/*/init_snowflake_test_data.sql` 同一套 ID
_PAGE = (2049629108253622359, 'DataChangeLog', '数据变更', '/log/change', 'mdi:file-compare', 3)
_BUTTON = (2049629108253622360, 'QueryDataChangeLog', '查询', 'log:change:list', 1)

#: 照抄 `plugin/config/sql/*/init_snowflake.sql`
_CONFIG = (
    2224875016875409434,
    '数据变更记录保留（天）',
    'DATA_CHANGE_RETENTION_DAYS',
    '180',
    '谁把哪个字段从什么改成了什么，每天凌晨的日志清理删掉超过这么多天的。网络安全法要求网络日志留存不少于六个月',
)


def upgrade() -> None:
    ustr = backend.common.model.UniversalStr
    tz = backend.common.model.TimeZone

    op.create_table(
        'sys_data_change',
        sa.Column('id', sa.BigInteger(), autoincrement=False, nullable=False, comment='雪花算法主键 ID'),
        sa.Column('trace_id', ustr(length=64), nullable=False, comment='请求跟踪 ID（和操作日志同一个）'),
        sa.Column(
            'entity_type', ustr(length=32), nullable=False, comment='对象类型（user / dept / role / menu / config…）'
        ),
        sa.Column('entity_id', sa.BigInteger(), nullable=True, comment='对象 ID（批量汇总行为空）'),
        sa.Column('entity_label', ustr(length=256), nullable=True, comment='对象当时的名字（快照）'),
        sa.Column('action', ustr(length=16), nullable=False, comment='create / update / delete / bulk'),
        sa.Column('changes', sa.JSON(), nullable=True, comment='字段变化（JSON 数组）'),
        sa.Column('fields', ustr(length=1024), nullable=False, comment='改了哪些字段（,a,b, 形式，按字段筛选用）'),
        sa.Column('actor_id', sa.BigInteger(), nullable=True, comment='操作人 ID（系统操作为空）'),
        sa.Column('actor_name', ustr(length=64), nullable=True, comment='操作人用户名（快照）'),
        sa.Column(
            'source', ustr(length=16), nullable=False, comment='来源（web / ai / import / oauth2 / task / system）'
        ),
        sa.Column('source_ref', ustr(length=128), nullable=True, comment='来源的引用（AI 工具调用 ID、任务名…）'),
        sa.Column('ip', ustr(length=64), nullable=True, comment='IP 地址'),
        sa.Column('created_time', tz(timezone=True), nullable=False, comment='创建时间'),
        sa.PrimaryKeyConstraint('id'),
        comment='数据变更记录表',
    )
    op.create_index(op.f('ix_sys_data_change_id'), 'sys_data_change', ['id'], unique=True)
    op.create_index(op.f('ix_sys_data_change_trace_id'), 'sys_data_change', ['trace_id'], unique=False)
    op.create_index(op.f('ix_sys_data_change_actor_id'), 'sys_data_change', ['actor_id'], unique=False)
    op.create_index(op.f('ix_sys_data_change_created_time'), 'sys_data_change', ['created_time'], unique=False)
    op.create_index(
        'ix_sys_data_change_entity', 'sys_data_change', ['entity_type', 'entity_id', 'created_time'], unique=False
    )

    if not seeded_pk_mode():
        # 自增主键模式没有基础种子（同 k0000000openapp）
        return
    conn = op.get_bind()
    menu_id, name, title, path, icon, sort = _PAGE
    add_menu(
        conn,
        menu_id=menu_id,
        name=name,
        title=title,
        path=path,
        icon=icon,
        menu_type=1,
        sort=sort,
        display=1,
        parent_name='Log',
    )
    button_id, button_name, button_title, perms, button_sort = _BUTTON
    add_menu(
        conn,
        menu_id=button_id,
        name=button_name,
        title=button_title,
        perms=perms,
        menu_type=2,
        sort=button_sort,
        display=0,
        parent_name=name,
    )
    if check_plugin_installed('config'):
        pk, cfg_name, key, value, remark = _CONFIG
        insert_if_absent(
            conn,
            'sys_config',
            {'key': key},
            {
                'id': pk,
                'name': cfg_name,
                'type': 'LOG',
                'value': value,
                'is_frontend': False,
                'remark': remark,
                'created_time': timezone.now(),
                'updated_time': None,
            },
        )


def downgrade() -> None:
    if seeded_pk_mode():
        conn = op.get_bind()
        delete_by_key(conn, 'sys_config', id=_CONFIG[0], key=_CONFIG[2])
        delete_by_key(conn, 'sys_menu', name=_BUTTON[1])
        delete_by_key(conn, 'sys_menu', name=_PAGE[1])
    op.drop_index('ix_sys_data_change_entity', table_name='sys_data_change')
    for name in ('created_time', 'actor_id', 'trace_id', 'id'):
        op.drop_index(op.f(f'ix_sys_data_change_{name}'), table_name='sys_data_change')
    op.drop_table('sys_data_change')
