"""审批：发起草稿记下哪些字段是 AI 填的、还没核对（#111 第 3 条）

`wf_draft.ai_filled`：JSON 数组。只放在界面状态里的话，关掉抽屉再打开，值还在、「AI 填的」标记没了。

带「列已经在就跳过」：开发服务器的 lifespan `create_all` 可能已经把这一列建好了（同 `v0000000aireviewatt`）。

Revision ID: x0000000wfdraftai
Revises: w0000000wfaiassist
Create Date: 2026-10-24 14:00:00

"""

import sqlalchemy as sa

from alembic import op

import backend.common.model

# revision identifiers, used by Alembic.
revision = 'x0000000wfdraftai'
down_revision = 'w0000000wfaiassist'
branch_labels = None
depends_on = None


def _has_column(table: str, column: str) -> bool:
    return any(c['name'] == column for c in sa.inspect(op.get_bind()).get_columns(table))


def upgrade() -> None:
    if _has_column('wf_draft', 'ai_filled'):
        return
    op.add_column(
        'wf_draft',
        sa.Column(
            'ai_filled',
            backend.common.model.UniversalText(),
            nullable=True,
            comment='AI 填了、还没核对的字段 ID（JSON 数组）',
        ),
    )


def downgrade() -> None:
    if _has_column('wf_draft', 'ai_filled'):
        op.drop_column('wf_draft', 'ai_filled')
