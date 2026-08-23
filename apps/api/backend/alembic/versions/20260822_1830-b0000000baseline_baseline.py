"""baseline —— 迁移历史的起点，不做任何 DDL

🔴 **这份**刻意是空的。

它标记的是「2026-08-22 这一刻的库结构 = 当时模型生成的结构」。已有环境
（开发库、fba_test）执行 `alembic stamp head` 认领这个起点即可，**不需要重建**；
全新环境仍然走 `create_all`（`fba init`），建完再 stamp。

为什么不把「建全部表」写进基线：那需要把 23 张表的 DDL 灌进一个文件，
而它和模型之间从此有两份真相 —— 改模型忘了改它就静默偏离。
基线为空 + 之后每次改动一份增量，是唯一一份真相仍然在模型里。

Revision ID: b0000000baseline
Revises:
Create Date: 2026-08-22 18:30:00
"""

import sqlalchemy as sa  # ruff: ignore[unused-import]

from alembic import op  # ruff: ignore[unused-import]

revision = 'b0000000baseline'
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    """空 —— 见模块注释。"""


def downgrade() -> None:
    """空。"""
