"""审批：AI 预审记下提交那一刻的实例版本号（#111 第 5 条：AI 自动同意）

`wf_ai_review.instance_version`。AI 自动同意只在「提交之后谁都没动过」时做 —— 预审审的是提交时的内容，
之后有人改过字段 / 推进过，那个结论就不是针对现在这张单的了。存量行是空的：它们永远不会触发自动同意。

带「列已经在就跳过」：开发服务器的 lifespan `create_all` 可能已经把这一列建好了（同 `v0000000aireviewatt`）。

Revision ID: y0000000aireviewver
Revises: x0000000wfdraftai
Create Date: 2026-10-24 16:00:00

"""

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision = 'y0000000aireviewver'
down_revision = 'x0000000wfdraftai'
branch_labels = None
depends_on = None


def _has_column(table: str, column: str) -> bool:
    return any(c['name'] == column for c in sa.inspect(op.get_bind()).get_columns(table))


def upgrade() -> None:
    if _has_column('wf_ai_review', 'instance_version'):
        return
    op.add_column(
        'wf_ai_review',
        sa.Column('instance_version', sa.Integer(), nullable=True, comment='提交时的实例版本号'),
    )


def downgrade() -> None:
    if _has_column('wf_ai_review', 'instance_version'):
        op.drop_column('wf_ai_review', 'instance_version')
