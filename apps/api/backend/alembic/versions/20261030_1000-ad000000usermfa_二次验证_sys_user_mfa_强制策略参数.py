"""二次验证：sys_user_mfa 表 · 补齐已存在库缺的「二次验证强制」参数

Revision ID: ad000000usermfa
Revises: ac000000webhook
Create Date: 2026-10-30 10:00:00

issue #181。表和参数放在一条里：参数行没有的话，参数配置页上看不见这个开关（策略只能靠改 .env，而它是动态配置）。

🔴 手写的建表要自己写 `autoincrement=False`：SQL Server 上会把雪花主键建成 IDENTITY（alembic 分册）。
"""

import sqlalchemy as sa

from alembic import op

import backend.common.model

from backend.plugin.core import check_plugin_installed
from backend.utils.data_migration import delete_by_key, insert_if_absent, seeded_pk_mode
from backend.utils.timezone import timezone

# revision identifiers, used by Alembic.
revision = 'ad000000usermfa'
down_revision = 'ac000000webhook'
branch_labels = None
depends_on = None

#: 照抄 `plugin/config/sql/*/init_snowflake.sql` 里那个 ID（三个方言同一套）
_CONFIG = (
    2224875016875409433,
    '二次验证强制',
    'LOGIN_MFA_ENFORCE',
    'off',
    'off：自愿开启；superuser：超级管理员必须开；all：所有人必须开。被强制、还没绑定的人下次登录会先走绑定',
)


def upgrade() -> None:
    utext = backend.common.model.UniversalText
    tz = backend.common.model.TimeZone

    op.create_table(
        'sys_user_mfa',
        sa.Column('id', sa.BigInteger(), autoincrement=False, nullable=False, comment='雪花算法主键 ID'),
        sa.Column('user_id', sa.BigInteger(), nullable=False, comment='用户 ID'),
        sa.Column('secret_cipher', utext(), nullable=False, comment='TOTP 密钥密文（AES）'),
        sa.Column('recovery_hashes', utext(), nullable=False, comment='恢复码哈希 JSON 数组（用过的记了时间）'),
        sa.Column('last_step', sa.BigInteger(), nullable=True, comment='最近一次成功用过的 TOTP 时间片'),
        sa.Column('enabled_time', tz(timezone=True), nullable=True, comment='开启时间'),
        sa.Column('created_time', tz(timezone=True), nullable=False, comment='创建时间'),
        sa.Column('updated_time', tz(timezone=True), nullable=True, comment='更新时间'),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('user_id'),
        comment='用户二次验证表',
    )
    op.create_index(op.f('ix_sys_user_mfa_id'), 'sys_user_mfa', ['id'], unique=True)

    if not seeded_pk_mode() or not check_plugin_installed('config'):
        return
    pk, name, key, value, remark = _CONFIG
    # 按 `key` 判存在：有人已经在界面上手工加过同名键，就不再插第二条、也不覆盖他填的值
    insert_if_absent(
        op.get_bind(),
        'sys_config',
        {'key': key},
        {
            'id': pk,
            'name': name,
            'type': 'LOGIN',
            'value': value,
            'is_frontend': False,
            'remark': remark,
            'created_time': timezone.now(),
            'updated_time': None,
        },
    )


def downgrade() -> None:
    if seeded_pk_mode():
        delete_by_key(op.get_bind(), 'sys_config', id=_CONFIG[0], key=_CONFIG[2])
    op.drop_index(op.f('ix_sys_user_mfa_id'), table_name='sys_user_mfa')
    op.drop_table('sys_user_mfa')
