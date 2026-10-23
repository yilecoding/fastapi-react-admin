"""审批 AI 预审：记下给模型读了哪些附件（#111 第 2 条）

`wf_ai_review.attachments`：JSON 列表，每份附件一项（字段 · 文件 ID · sha256 · 读没读出来）。
不变式 5（可审计）要能回答「这条建议是基于哪几份附件给的」—— 只存文件 ID 不够，文件可以被替换，所以带 sha256。

带「列已经在就跳过」：开发服务器的 lifespan `create_all` 可能已经把这一列建好了（同 `d0000000usertz`）。

Revision ID: v0000000aireviewatt
Revises: u0000000health
Create Date: 2026-10-24 10:00:00

"""

import sqlalchemy as sa

from alembic import op

import backend.common.model

# revision identifiers, used by Alembic.
revision = 'v0000000aireviewatt'
down_revision = 'u0000000health'
branch_labels = None
depends_on = None


def _has_column(table: str, column: str) -> bool:
    return any(c['name'] == column for c in sa.inspect(op.get_bind()).get_columns(table))


def upgrade() -> None:
    if _has_column('wf_ai_review', 'attachments'):
        return
    op.add_column(
        'wf_ai_review',
        sa.Column(
            'attachments',
            backend.common.model.UniversalText(),
            nullable=True,
            comment='给模型读了哪些附件（JSON：字段 · 文件 ID · sha256 · 读没读出来）',
        ),
    )


def downgrade() -> None:
    if _has_column('wf_ai_review', 'attachments'):
        op.drop_column('wf_ai_review', 'attachments')
