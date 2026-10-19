"""ai_provider 加 use_proxy —— 代理走不走必须按供应商配

Revision ID: g0000000aiproxy
Revises: f0000000aimenu
Create Date: 2026-09-14 15:40:00

🔴 起因是实测：同一个内网 LLM 网关，在不同位置的**可达路径是相反的**。
本机 WSL 里直连 TCP 全被挡（ping 通、8086/443/80 全不通），必须经企业代理
（`HTTP(S)_PROXY`）才通；而 `sop2ppt` 那台机器上的注释写着正相反——代理到不了，
必须 `trust_env=False` 强制直连。

写死任何一边，另一边的表现都是**纯超时**（等满 timeout 秒），看起来像"网关挂了"，
而网关是好的。所以它是一个部署相关的配置，不是常量。

默认 `False`（直连），与加这一列之前的写死行为一致——已有数据不会因为这次改动改变行为。
"""

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision = 'g0000000aiproxy'
down_revision = 'f0000000aimenu'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        'ai_provider',
        sa.Column(
            'use_proxy',
            sa.Boolean(),
            nullable=False,
            server_default=sa.false(),
            comment='是否走系统代理（内网网关按实际可达路径选）',
        ),
    )


def downgrade() -> None:
    op.drop_column('ai_provider', 'use_proxy')
