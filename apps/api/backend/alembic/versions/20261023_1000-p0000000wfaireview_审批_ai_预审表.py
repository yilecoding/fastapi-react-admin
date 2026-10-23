"""审批：AI 预审表 wf_ai_review（#111 第 2 条）

一次提交 / 重新提交一行；审批事务里只插 `pending`，结果由 Celery 任务写。

手写、带「表已经在就跳过」：同 `735d74e723c0` 的 `wf_draft` —— 起过开发服务器 / 跑过 pytest 之后
lifespan 的 `create_all` 已经在开发库里建好了这张表，autogenerate 认为「没变化」。
主键写 `autoincrement=False`，否则 mssql 上建成 IDENTITY、一行都写不进去（alembic 分册）。

Revision ID: p0000000wfaireview
Revises: o0000000dataio
Create Date: 2026-10-23 10:00:00

"""

import sqlalchemy as sa

from alembic import op

import backend.common.model

# revision identifiers, used by Alembic.
revision = 'p0000000wfaireview'
down_revision = 'o0000000dataio'
branch_labels = None
depends_on = None


def _has_table(name: str) -> bool:
    return sa.inspect(op.get_bind()).has_table(name)


def upgrade() -> None:
    if _has_table('wf_ai_review'):
        return
    op.create_table(
        'wf_ai_review',
        sa.Column('id', sa.BigInteger(), autoincrement=False, nullable=False, comment='雪花算法主键 ID'),
        sa.Column('instance_id', sa.BigInteger(), nullable=False, comment='实例 ID'),
        sa.Column(
            'status', backend.common.model.UniversalStr(length=16), nullable=False, comment='pending / done / failed'
        ),
        sa.Column(
            'points_version', backend.common.model.UniversalStr(length=16), nullable=False, comment='审核要点版本'
        ),
        sa.Column(
            'verdict', backend.common.model.UniversalStr(length=16), nullable=True, comment='pass / attention / reject'
        ),
        sa.Column('reasons', backend.common.model.UniversalText(), nullable=True, comment='理由（JSON）'),
        sa.Column('error', backend.common.model.UniversalStr(length=512), nullable=True, comment='失败原因'),
        sa.Column('model', backend.common.model.UniversalStr(length=128), nullable=True, comment='模型名'),
        sa.Column('duration_ms', sa.Integer(), nullable=True, comment='耗时（毫秒）'),
        sa.Column('prompt_tokens', sa.Integer(), nullable=True, comment='输入 token'),
        sa.Column('completion_tokens', sa.Integer(), nullable=True, comment='输出 token'),
        sa.Column('finished_time', backend.common.model.TimeZone(timezone=True), nullable=True, comment='完成时间'),
        sa.Column('created_time', backend.common.model.TimeZone(timezone=True), nullable=False, comment='创建时间'),
        sa.Column('updated_time', backend.common.model.TimeZone(timezone=True), nullable=True, comment='更新时间'),
        sa.PrimaryKeyConstraint('id'),
        comment='AI 预审表',
    )
    op.create_index(op.f('ix_wf_ai_review_id'), 'wf_ai_review', ['id'], unique=True)
    op.create_index(op.f('ix_wf_ai_review_instance_id'), 'wf_ai_review', ['instance_id'], unique=False)


def downgrade() -> None:
    if not _has_table('wf_ai_review'):
        return
    op.drop_index(op.f('ix_wf_ai_review_instance_id'), table_name='wf_ai_review')
    op.drop_index(op.f('ix_wf_ai_review_id'), table_name='wf_ai_review')
    op.drop_table('wf_ai_review')
