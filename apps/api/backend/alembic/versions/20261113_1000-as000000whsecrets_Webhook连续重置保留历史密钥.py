"""Webhook 连续重置时保留每把旧密钥的宽限期

Revision ID: as000000whsecrets
Revises: ar000000smsoptcreds
Create Date: 2026-11-13 10:00:00

新增可空历史字段。原 secret_prev_* 保留，升级时正在宽限期的密钥和到期时间不变，
无需解密或回填。回滚会丢弃更早的历史密钥，仍保留最近一次的 secret_prev_*。
"""

import sqlalchemy as sa

from alembic import op

from backend.common.model import UniversalText

revision = 'as000000whsecrets'
down_revision = 'ar000000smsoptcreds'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        'open_webhook',
        sa.Column('secret_history', UniversalText(), nullable=True, comment='更早的签名密钥密文与各自到期时间（JSON）'),
    )


def downgrade() -> None:
    op.drop_column('open_webhook', 'secret_history')
