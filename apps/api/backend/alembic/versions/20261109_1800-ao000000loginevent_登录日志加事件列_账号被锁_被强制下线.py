"""登录日志加「事件」列：账号被锁 / IP 被锁 / 被强制下线也记进登录日志

Revision ID: ao000000loginevent
Revises: an000000datachangechain
Create Date: 2026-11-09 18:00:00

issue #273。已有的行都是登录尝试，`server_default` 回填成 `login`，再把库上的 DEFAULT 去掉 ——
模型侧的默认值是 Python 级的（`default='login'`），留着 DEFAULT 的话 `create_all` 建的新库和迁移升上来的旧库不一致，
`test_model_matches_migrations` 会报一条 server_default 差异（同 `d0000000usertz`）。

⚠️ 原来叫 `an000000loginevent`、接在 `am000000datachange` 后面；#271 的 `an000000datachangechain` 先合进了 main、
也接在那里 —— 按 alembic 分册「分叉了怎么接」改接到它后面，**ID 一起换**。
"""

import sqlalchemy as sa

from alembic import op

import backend.common.model

# revision identifiers, used by Alembic.
revision = 'ao000000loginevent'
down_revision = 'an000000datachangechain'
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
