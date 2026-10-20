"""ai_mcp_client 加 allow_write —— MCP 写操作的开关，默认关

Revision ID: j0000000aimcpwrite
Revises: i0000000aimcpcli
Create Date: 2026-10-20 16:00:00

打开后外部系统可以**发起**写操作，但不能执行：网关只预演并返回一个确认链接，
必须由被代表的那个人本人登录网页点确认。存量凭据回填 False —— 和加这一列之前的
「MCP 入口只读」行为一致。
"""

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision = 'j0000000aimcpwrite'
down_revision = 'i0000000aimcpcli'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        'ai_mcp_client',
        sa.Column(
            'allow_write',
            sa.Boolean(),
            nullable=False,
            server_default=sa.false(),
            comment='是否允许发起写操作（仍需本人在网页确认）',
        ),
    )
    # 模型侧默认值是 Python 级的，库上不留 DEFAULT 约束（同 d0000000usertz 的理由）
    op.alter_column('ai_mcp_client', 'allow_write', server_default=None)


def downgrade() -> None:
    op.drop_column('ai_mcp_client', 'allow_write')
