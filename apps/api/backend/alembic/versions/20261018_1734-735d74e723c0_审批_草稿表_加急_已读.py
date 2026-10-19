"""审批：发起草稿表 · 加急 · 办理人已读

- `wf_draft`：一个人、一个流程一份没提交的表单（填一半关掉抽屉，下次打开还在）
- `wf_instance.urgent`：发起人标的加急，待办列表排前面
- `wf_task.read_time`：办理人第一次打开这张单的时间

🔴 `wf_draft` 是手写的、带「表已经在就跳过」：autogenerate 没识别出这张表 —— 开发服务器
`--reload` 一重启，lifespan 的 `create_all` 已经在开发库里把它建好了（插件分册「跑过 pytest /
起过服务之后开发库里已经有这几张表」那条）。新库是 `create_all` 建的、也已经有它。
主键照抄别的雪花表写 `autoincrement=False`，否则 mssql 上建成 IDENTITY、一行都写不进去（alembic 分册）。

两个新列同 `a7d8fbe59942`：先带 server_default 回填存量行，再去掉 DEFAULT（模型侧是 Python 级默认值）。

Revision ID: 735d74e723c0
Revises: b3c41d7e9a20
Create Date: 2026-10-18 17:34:17.134217+08:00

"""

import sqlalchemy as sa

from alembic import op

import backend.common.model

# revision identifiers, used by Alembic.
revision = '735d74e723c0'
down_revision = 'b3c41d7e9a20'
branch_labels = None
depends_on = None


def _has_table(name: str) -> bool:
    return sa.inspect(op.get_bind()).has_table(name)


def _has_column(table: str, column: str) -> bool:
    return column in {c['name'] for c in sa.inspect(op.get_bind()).get_columns(table)}


def upgrade() -> None:
    if not _has_column('wf_instance', 'urgent'):
        op.add_column(
            'wf_instance', sa.Column('urgent', sa.Boolean(), nullable=False, server_default=sa.false(), comment='加急')
        )
        op.alter_column('wf_instance', 'urgent', server_default=None)
    if not _has_column('wf_task', 'read_time'):
        op.add_column(
            'wf_task',
            sa.Column(
                'read_time', backend.common.model.TimeZone(timezone=True), nullable=True, comment='办理人已读时间'
            ),
        )
    if not _has_table('wf_draft'):
        op.create_table(
            'wf_draft',
            sa.Column('id', sa.BigInteger(), autoincrement=False, nullable=False, comment='雪花算法主键 ID'),
            sa.Column('user_id', sa.BigInteger(), nullable=False, comment='谁的草稿'),
            sa.Column('code', backend.common.model.UniversalStr(length=64), nullable=False, comment='流程定义编码'),
            sa.Column(
                'form_data', backend.common.model.UniversalText(), nullable=False, comment='没提交的表单（JSON）'
            ),
            sa.Column('created_time', backend.common.model.TimeZone(timezone=True), nullable=False, comment='创建时间'),
            sa.Column('updated_time', backend.common.model.TimeZone(timezone=True), nullable=True, comment='更新时间'),
            sa.PrimaryKeyConstraint('id'),
            sa.UniqueConstraint('user_id', 'code', name='uk_wf_draft_user_code'),
            comment='发起草稿表',
        )
        op.create_index(op.f('ix_wf_draft_id'), 'wf_draft', ['id'], unique=True)
        op.create_index(op.f('ix_wf_draft_user_id'), 'wf_draft', ['user_id'], unique=False)


def downgrade() -> None:
    if _has_table('wf_draft'):
        op.drop_index(op.f('ix_wf_draft_user_id'), table_name='wf_draft')
        op.drop_index(op.f('ix_wf_draft_id'), table_name='wf_draft')
        op.drop_table('wf_draft')
    if _has_column('wf_task', 'read_time'):
        op.drop_column('wf_task', 'read_time')
    if _has_column('wf_instance', 'urgent'):
        op.drop_column('wf_instance', 'urgent')
