"""ai_tool_invocation 加 channel —— 审计里要看得出「哪个外部系统替谁调的」

Revision ID: h0000000aichannel
Revises: 2113fec855f4
Create Date: 2026-10-20 10:00:00

MCP 网关的身份是外部系统**声明**的（M2M 凭据 + 代理用户）。只记 user_id 的话，
出了事只查得到「张三调了 user_list」，查不到是哪个系统替他发起的。

可空、不带默认值：NULL 就是网页对话，存量行天然就是这个语义，不需要回填，
也就绕开了三个方言 DEFAULT 约束各不相同的那一摊（见 alembic 分册）。
"""

import sqlalchemy as sa

from alembic import op

from backend.common.model import UniversalStr

# revision identifiers, used by Alembic.
revision = 'h0000000aichannel'
down_revision = '2113fec855f4'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        'ai_tool_invocation',
        sa.Column('channel', UniversalStr(64), nullable=True, comment='调用入口（NULL=网页对话）'),
    )


def downgrade() -> None:
    op.drop_column('ai_tool_invocation', 'channel')
