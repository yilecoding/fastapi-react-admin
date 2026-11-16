"""参数配置密钥加密（#305）。

Revision ID: at000000configsecret
Revises: as000000whsecrets
Create Date: 2026-11-15 12:00:00

有非空历史密钥时，升级前必须配置 CONFIG_ENCRYPT_SECRET_KEY；缺失则停止升级。
空值和普通配置不动；包含软删除行；重复执行不二次加密。
离线 SQL 无法读取历史数据，拒绝以离线模式假装完成迁移。
downgrade 保留密文，不能把已经加密的凭据重新写成明文。
"""

from alembic import context, op

revision = 'at000000configsecret'
down_revision = 'as000000whsecrets'
branch_labels = None
depends_on = None


def upgrade() -> None:
    if context.is_offline_mode():
        raise RuntimeError('Config secret migration requires an online database connection')
    from backend.plugin.config.secret import encrypt_legacy_configs

    encrypt_legacy_configs(op.get_bind())


def downgrade() -> None:
    pass
