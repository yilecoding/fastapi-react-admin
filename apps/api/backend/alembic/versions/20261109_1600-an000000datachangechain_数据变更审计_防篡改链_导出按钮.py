"""数据变更审计：防篡改链（sys_data_change 加序号 / 签名列 + 链头表）· 「数据变更」页的导出按钮

Revision ID: an000000datachangechain
Revises: am000000datachange
Create Date: 2026-11-09 16:00:00

issue #260 二期。

- 🔴 **已有的记录按 (created_time, id) 补签进链**，再建链头那一行：之后没有序号的行一律算「绕过应用写进来的」。
  不补签、按时间分「旧行 / 伪造的行」的话，伪造的人把时间写早一点就混进了旧行（chain.py 模块注释）。
  补签读的是库里的值（和校验同一条路），密钥用这次升级时 `.env` 里的 `DATA_CHANGE_CHAIN_KEY`。
  离线生成 SQL（`--sql`）时没有数据可读，跳过 —— 那时第一次写记录会由 chain.py 建链头，已有的行会被报成没有序号
- 新库（`fba init`：create_all + 种子）没有这一步：链头那一行由 chain.py 在第一次写记录时建
- 唯一索引在 SQL Server 上要筛掉 NULL（旧行全是 NULL，SQL Server 认为多个 NULL 相等）
- 🔴 手写的建表要自己写 `autoincrement=False`（alembic 分册）。导出按钮照抄种子里的 ID，按 `name` 判存在，幂等
"""

import sqlalchemy as sa

from alembic import context, op

import backend.common.model

from backend.utils.data_migration import add_menu, delete_by_key, seeded_pk_mode

# revision identifiers, used by Alembic.
revision = 'an000000datachangechain'
down_revision = 'am000000datachange'
branch_labels = None
depends_on = None

#: 和 `sql/*/init_snowflake_test_data.sql` 同一套 ID
_EXPORT = (2049629108253622361, 'ExportDataChangeLog', '导出', 'log:change:export', 2)


def upgrade() -> None:
    op.add_column('sys_data_change', sa.Column('chain_seq', sa.BigInteger(), nullable=True, comment='防篡改链序号'))
    op.add_column(
        'sys_data_change',
        sa.Column(
            'chain_hash',
            sa.String(length=80),
            nullable=True,
            comment='防篡改链签名（密钥标识:HMAC-SHA256，含上一行的签名）',
        ),
    )
    op.create_index(
        'uq_sys_data_change_chain_seq',
        'sys_data_change',
        ['chain_seq'],
        unique=True,
        mssql_where=sa.text('chain_seq IS NOT NULL'),
    )
    op.create_table(
        'sys_data_change_chain',
        sa.Column('id', sa.BigInteger(), autoincrement=False, nullable=False, comment='固定为 1'),
        sa.Column('head_seq', sa.BigInteger(), nullable=False, comment='最后一条记录的序号'),
        sa.Column('head_hash', sa.String(length=80), nullable=False, comment='最后一条记录的签名'),
        sa.Column('anchor_seq', sa.BigInteger(), nullable=False, comment='保留期删到了哪个序号（校验从它后面开始）'),
        sa.Column('anchor_hash', sa.String(length=80), nullable=False, comment='锚点那一行的签名'),
        sa.PrimaryKeyConstraint('id'),
        comment='数据变更记录防篡改链的链头（只有一行）',
    )

    _backfill()

    if not seeded_pk_mode():
        # 自增主键模式没有基础种子（同 k0000000openapp）
        return
    button_id, name, title, perms, sort = _EXPORT
    add_menu(
        op.get_bind(),
        menu_id=button_id,
        name=name,
        title=title,
        perms=perms,
        menu_type=2,
        sort=sort,
        display=0,
        parent_name='DataChangeLog',
    )


def _backfill() -> None:
    if context.is_offline_mode():
        return
    from backend.common.data_change import chain

    ustr = backend.common.model.UniversalStr
    # 只列签名要用的列，类型照模型写（JSON 要反序列化、时间要按 TimeZone 读）：不能直接用模型那张表 ——
    # 从更老的版本一路升上来时，模型里可能有这一步之后才加的列
    records = sa.Table(
        'sys_data_change',
        sa.MetaData(),
        sa.Column('id', sa.BigInteger(), primary_key=True, autoincrement=False),
        sa.Column('trace_id', ustr(64)),
        sa.Column('entity_type', ustr(32)),
        sa.Column('entity_id', sa.BigInteger()),
        sa.Column('entity_label', ustr(256)),
        sa.Column('action', ustr(16)),
        sa.Column('changes', sa.JSON()),
        sa.Column('fields', ustr(1024)),
        sa.Column('actor_id', sa.BigInteger()),
        sa.Column('actor_name', ustr(64)),
        sa.Column('source', ustr(16)),
        sa.Column('source_ref', ustr(128)),
        sa.Column('ip', ustr(64)),
        sa.Column('created_time', backend.common.model.TimeZone(timezone=True)),
        sa.Column('chain_seq', sa.BigInteger()),
        sa.Column('chain_hash', sa.String(80)),
    )
    head = sa.Table(
        'sys_data_change_chain',
        sa.MetaData(),
        sa.Column('id', sa.BigInteger(), primary_key=True, autoincrement=False),
        sa.Column('head_seq', sa.BigInteger()),
        sa.Column('head_hash', sa.String(80)),
        sa.Column('anchor_seq', sa.BigInteger()),
        sa.Column('anchor_hash', sa.String(80)),
    )
    chain.backfill(op.get_bind(), records, head)


def downgrade() -> None:
    if seeded_pk_mode():
        delete_by_key(op.get_bind(), 'sys_menu', name=_EXPORT[1])
    op.drop_table('sys_data_change_chain')
    op.drop_index('uq_sys_data_change_chain_seq', table_name='sys_data_change')
    op.drop_column('sys_data_change', 'chain_hash')
    op.drop_column('sys_data_change', 'chain_seq')
