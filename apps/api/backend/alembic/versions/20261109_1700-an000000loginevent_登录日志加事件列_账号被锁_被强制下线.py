"""登录日志加「事件」列：账号被锁 / IP 被锁 / 被强制下线也记进登录日志

Revision ID: an000000loginevent
Revises: am000000datachange
Create Date: 2026-11-09 17:00:00

issue #273。已有的行都是登录尝试，`server_default` 回填成 `login`，再把库上的 DEFAULT 去掉 ——
模型侧的默认值是 Python 级的（`default='login'`），留着 DEFAULT 的话 `create_all` 建的新库和迁移升上来的旧库不一致，
`test_model_matches_migrations` 会报一条 server_default 差异（同 `d0000000usertz`）。

⚠️ 和 #271 的 `an000000datachangechain` 都接在 `am000000datachange` 后面：后合的那一条要改接、**ID 一起换**（alembic 分册「分叉了怎么接」）。
"""

import sqlalchemy as sa

from alembic import op

import backend.common.model

# revision identifiers, used by Alembic.
revision = 'an000000loginevent'
down_revision = 'am000000datachange'
branch_labels = None
depends_on = None

_TABLE = 'sys_login_log'
_COLUMN = 'event'


def upgrade() -> None:
    op.add_column(
        _TABLE,
        sa.Column(
            _COLUMN,
            backend.common.model.UniversalStr(16),
            nullable=False,
            server_default='login',
            comment='事件（login 登录 / locked 账号被锁 / ip_locked IP 被锁 / kicked 被强制下线）',
        ),
    )
    op.alter_column(_TABLE, _COLUMN, server_default=None)


def downgrade() -> None:
    op.drop_column(_TABLE, _COLUMN)
