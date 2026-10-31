"""个人偏好：sys_user_preference 表

Revision ID: ah000000userpref
Revises: ag000000noticephase2
Create Date: 2026-10-31 18:10:52+08:00

issue #202（工作台个性化）。纯建表，没有种子行：「没有行 = 用默认值」。

- 🔴 `id` 要写 `autoincrement=False`：SQL Server 上会把雪花主键建成 IDENTITY（alembic 分册）
- `(user_id, key)` 两列都非空 → 普通唯一约束，三个方言语义一致，不需要 SQL Server 的筛选唯一索引
- `key` 在 MySQL 是保留字，DDL / DML 由 SQLAlchemy 自动加引号（`sys_config.key` 一直这么用）
"""

import sqlalchemy as sa

from alembic import op

import backend.common.model

# revision identifiers, used by Alembic.
revision = 'ah000000userpref'
down_revision = 'ag000000noticephase2'
branch_labels = None
depends_on = None


def upgrade() -> None:
    ustr = backend.common.model.UniversalStr
    utext = backend.common.model.UniversalText
    tz = backend.common.model.TimeZone

    op.create_table(
        'sys_user_preference',
        sa.Column('id', sa.BigInteger(), autoincrement=False, nullable=False, comment='雪花算法主键 ID'),
        sa.Column('user_id', sa.BigInteger(), nullable=False, comment='用户 ID'),
        sa.Column('key', ustr(length=64), nullable=False, comment='偏好键（如 dashboard.layout）'),
        sa.Column('value', utext(), nullable=False, comment='偏好值（JSON 文本）'),
        sa.Column('created_time', tz(timezone=True), nullable=False, comment='创建时间'),
        sa.Column('updated_time', tz(timezone=True), nullable=True, comment='更新时间'),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('user_id', 'key', name='uq_sys_user_preference'),
        comment='用户个人偏好表',
    )
    op.create_index(op.f('ix_sys_user_preference_id'), 'sys_user_preference', ['id'], unique=True)


def downgrade() -> None:
    op.drop_index(op.f('ix_sys_user_preference_id'), table_name='sys_user_preference')
    op.drop_table('sys_user_preference')
