"""审批：AI 辅助调用记录表 wf_ai_assist（#111 第 1、3 条）

设计器一句话生成 / 发起时自动填单，每次调用一行：模型 · 提示词版本 · 轮数 · 耗时 · token · 成败（不变式 5）。
不存输入和结果原文（见模型的 docstring）。

手写、带「表已经在就跳过」：同 `p0000000wfaireview`。
主键 `autoincrement=False`（alembic 分册：否则 mssql 上是 IDENTITY）。

Revision ID: w0000000wfaiassist
Revises: v0000000aireviewatt
Create Date: 2026-10-24 12:00:00

"""

import sqlalchemy as sa

from alembic import op

import backend.common.model

# revision identifiers, used by Alembic.
revision = 'w0000000wfaiassist'
down_revision = 'v0000000aireviewatt'
branch_labels = None
depends_on = None


def _has_table(name: str) -> bool:
    return sa.inspect(op.get_bind()).has_table(name)


def upgrade() -> None:
    if _has_table('wf_ai_assist'):
        return
    op.create_table(
        'wf_ai_assist',
        sa.Column('id', sa.BigInteger(), autoincrement=False, nullable=False, comment='雪花算法主键 ID'),
        sa.Column('kind', backend.common.model.UniversalStr(length=16), nullable=False, comment='design / fill'),
        sa.Column('user_id', sa.BigInteger(), nullable=False, comment='谁发起的'),
        sa.Column('definition_id', sa.BigInteger(), nullable=True, comment='哪个流程定义'),
        sa.Column('status', backend.common.model.UniversalStr(length=16), nullable=False, comment='done / failed'),
        sa.Column('prompt_version', backend.common.model.UniversalStr(length=16), nullable=False, comment='提示词版本'),
        sa.Column('rounds', sa.Integer(), nullable=False, comment='调用轮数'),
        sa.Column('model', backend.common.model.UniversalStr(length=128), nullable=True, comment='模型名'),
        sa.Column('duration_ms', sa.Integer(), nullable=True, comment='耗时（毫秒）'),
        sa.Column('prompt_tokens', sa.Integer(), nullable=True, comment='输入 token'),
        sa.Column('completion_tokens', sa.Integer(), nullable=True, comment='输出 token'),
        sa.Column('error', backend.common.model.UniversalStr(length=512), nullable=True, comment='失败原因'),
        sa.Column('created_time', backend.common.model.TimeZone(timezone=True), nullable=False, comment='创建时间'),
        sa.Column('updated_time', backend.common.model.TimeZone(timezone=True), nullable=True, comment='更新时间'),
        sa.PrimaryKeyConstraint('id'),
        comment='AI 辅助调用记录',
    )
    op.create_index(op.f('ix_wf_ai_assist_id'), 'wf_ai_assist', ['id'], unique=True)
    op.create_index(op.f('ix_wf_ai_assist_user_id'), 'wf_ai_assist', ['user_id'], unique=False)


def downgrade() -> None:
    if not _has_table('wf_ai_assist'):
        return
    op.drop_index(op.f('ix_wf_ai_assist_user_id'), table_name='wf_ai_assist')
    op.drop_index(op.f('ix_wf_ai_assist_id'), table_name='wf_ai_assist')
    op.drop_table('wf_ai_assist')
