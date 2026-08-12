import sqlalchemy as sa

from backend.common.enums import PrimaryKeyType
from backend.common.model import MappedBase
from backend.core.conf import settings
from backend.utils.snowflake import snowflake


def _pk_column() -> sa.Column:
    """
    关联表主键，跟随 DATABASE_PK_MODE。

    原实现硬编码 autoincrement=True，与主表在雪花模式下不一致；
    在 SQL Server 上这会让关联表主键变成 IDENTITY，导致种子数据无法显式插入 id
    （"Cannot insert explicit value for identity column ... IDENTITY_INSERT is set to OFF"）。
    """
    if PrimaryKeyType.autoincrement == settings.DATABASE_PK_MODE:
        return sa.Column(
            'id', sa.BigInteger, primary_key=True, unique=True, index=True,
            autoincrement=True, comment='主键 ID',
        )
    return sa.Column(
        'id', sa.BigInteger, primary_key=True, unique=True, index=True,
        default=snowflake.generate, comment='雪花算法主键 ID',
    )


# 用户角色表
user_role = sa.Table(
    'sys_user_role',
    MappedBase.metadata,
    _pk_column(),
    sa.Column('user_id', sa.BigInteger, primary_key=True, comment='用户ID'),
    sa.Column('role_id', sa.BigInteger, primary_key=True, comment='角色ID'),
)

# 角色菜单表
role_menu = sa.Table(
    'sys_role_menu',
    MappedBase.metadata,
    _pk_column(),
    sa.Column('role_id', sa.BigInteger, primary_key=True, comment='角色ID'),
    sa.Column('menu_id', sa.BigInteger, primary_key=True, comment='菜单ID'),
)

# 角色数据范围表
role_data_scope = sa.Table(
    'sys_role_data_scope',
    MappedBase.metadata,
    _pk_column(),
    sa.Column('role_id', sa.BigInteger, primary_key=True, comment='角色 ID'),
    sa.Column('data_scope_id', sa.BigInteger, primary_key=True, comment='数据范围 ID'),
)

# 数据范围规则表
data_scope_rule = sa.Table(
    'sys_data_scope_rule',
    MappedBase.metadata,
    _pk_column(),
    sa.Column('data_scope_id', sa.BigInteger, primary_key=True, comment='数据范围 ID'),
    sa.Column('data_rule_id', sa.BigInteger, primary_key=True, comment='数据规则 ID'),
)
