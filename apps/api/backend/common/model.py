from datetime import datetime
from typing import Annotated

from sqlalchemy import BigInteger, DateTime, String, Text, TypeDecorator, Unicode
from sqlalchemy.dialects.mssql import NVARCHAR as MSSQL_NVARCHAR
from sqlalchemy.dialects.mysql import LONGTEXT
from sqlalchemy.engine.interfaces import Dialect
from sqlalchemy.ext.asyncio import AsyncAttrs
from sqlalchemy.orm import DeclarativeBase, Mapped, MappedAsDataclass, declared_attr, mapped_column
from sqlalchemy.sql.type_api import TypeEngine

from backend.common.enums import DataBaseType, PrimaryKeyType
from backend.core.conf import settings
from backend.utils.snowflake import snowflake
from backend.utils.timezone import timezone

# 通用 Mapped 类型主键, 需手动添加，参考以下使用方式
# MappedBase -> id: Mapped[id_key]
# DataClassBase && Base -> id: Mapped[id_key] = mapped_column(init=False)
id_key = Annotated[
    int,
    mapped_column(
        BigInteger,
        primary_key=True,
        unique=True,
        index=True,
        autoincrement=True,
        sort_order=-999,
        comment='主键 ID',
    )
    if PrimaryKeyType.autoincrement == settings.DATABASE_PK_MODE
    # 雪花算法 Mapped 类型主键
    # 详情：https://fastapi-practices.github.io/fastapi_best_architecture_docs/backend/reference/pk.html
    else mapped_column(
        BigInteger,
        primary_key=True,
        unique=True,
        index=True,
        # 🔴 **必须显式写出来**，虽然 `create_all` 不写也一样。
        # SQLAlchemy 的 `autoincrement='auto'` 规则是「整型主键 + 没有默认值」才算自增，
        # 而这一列有 `default=snowflake.generate`（Python 侧），所以 `create_all` 建出来
        # 的列本来就不是 IDENTITY。**但 alembic autogenerate 渲染不出 Python 侧的
        # `default=`** —— 它写出来的 `sa.Column('id', sa.BigInteger(), nullable=False)`
        # 在 mssql 上重新命中「auto」规则，于是**迁移建的表是 IDENTITY、
        # create_all 建的表不是**。后果：迁移建出来的库里，任何带显式雪花 ID 的
        # INSERT 都报 `Cannot insert explicit value for identity column ... (544)`，
        # 也就是那张表**一行都写不进去**。
        # 而 `test_model_matches_migrations` 抓不到：它比的是「模型 vs fba_test」，
        # 后者是 `create_all` 建的 —— 两边都是「非 IDENTITY」，全绿。
        # 实测：`sys_notification` 是本仓库第一张真正由迁移创建的表，当场踩到。
        autoincrement=False,
        default=snowflake.generate,
        sort_order=-999,
        comment='雪花算法主键 ID',
    ),
]


class UniversalText(TypeDecorator[str]):
    """PostgreSQL、MySQL、SQL Server 兼容性（长）文本类型"""

    impl = LONGTEXT if DataBaseType.mysql == settings.DATABASE_TYPE else Text
    cache_ok = True

    # 🔴 `TypeDecorator` **不会**把 `python_type` 转发给 impl，基类实现直接
    # `raise NotImplementedError`。数据权限的 `filter_data_permission()` 拿它做值转换
    # （`table.columns[c].type.python_type`），不写这个属性 = 任何打在文本列上的
    # 数据规则都让接口 500（同 `TimeZone` 早就显式写了一份的原因）。
    @property
    def python_type(self) -> type[str]:
        return str

    def load_dialect_impl(self, dialect: Dialect) -> TypeEngine:
        # SQL Server 用 NVARCHAR(MAX)。
        # 注意不能用 UnicodeText —— 它在 mssql 下映射到 NTEXT，
        # 而 NTEXT 自 SQL Server 2005 起已废弃，微软声明将来会移除。
        if dialect.name == 'mssql':
            return dialect.type_descriptor(MSSQL_NVARCHAR(None))
        return dialect.type_descriptor(self.impl)

    def process_bind_param(self, value: str | None, dialect) -> str | None:  # ruff:ignore[missing-type-function-argument]
        return value

    def process_result_value(self, value: str | None, dialect) -> str | None:  # ruff:ignore[missing-type-function-argument]
        return value


class UniversalStr(TypeDecorator[str]):
    """
    PostgreSQL、MySQL、SQL Server 兼容性变长字符串类型。

    SQL Server 下映射为 NVARCHAR —— 用 VARCHAR 存中文会按代码页截断/乱码。
    所有需要存中文的 `sa.String(n)` 都应替换为 `UniversalStr(n)`。
    """

    impl = String
    cache_ok = True

    # 见 `UniversalText.python_type` 的注释：不写就是数据权限规则打在
    # 任意字符串列（`code` / `name` / `username` …）上直接 500
    @property
    def python_type(self) -> type[str]:
        return str

    def load_dialect_impl(self, dialect: Dialect) -> TypeEngine:
        if dialect.name == 'mssql':
            return dialect.type_descriptor(Unicode(length=self.impl.length))
        return dialect.type_descriptor(self.impl)

    def process_bind_param(self, value: str | None, dialect) -> str | None:  # ruff:ignore[missing-type-function-argument]
        return value

    def process_result_value(self, value: str | None, dialect) -> str | None:  # ruff:ignore[missing-type-function-argument]
        return value


class TimeZone(TypeDecorator[datetime]):
    """PostgreSQL、MySQL、SQL Server 兼容性时区感知类型"""

    impl = DateTime(timezone=True)
    cache_ok = True

    @property
    def python_type(self) -> type[datetime]:
        return datetime

    def process_bind_param(self, value: datetime | None, dialect) -> datetime | None:  # ruff:ignore[missing-type-function-argument]
        if value is not None and value.tzinfo is None:
            # 🔴 naive datetime 不能走 `timezone.from_datetime()`（= `astimezone()`）。
            # Python 对 naive 值调 astimezone 是按**操作系统本地时区**重新解释，
            # 不是按应用配置的 DATETIME_TIMEZONE —— 本机系统时区恰好也是 UTC+8
            # 时看不出问题，CI runner 系统时区是 UTC，同一个 naive 值会被当成 UTC
            # 时刻再转成 +08:00，静静地被加了 8 小时。naive 值本来就该被理解成
            # 「已经是应用时区的墙钟时间」，只需要补时区标记，不需要换算。
            value = value.replace(tzinfo=timezone.tz_info)
        elif value is not None and value.utcoffset() != timezone.now().utcoffset():
            # TODO 处理夏令时偏移
            value = timezone.from_datetime(value)
        return value

    def process_result_value(self, value: datetime | None, dialect) -> datetime | None:  # ruff:ignore[missing-type-function-argument]
        if value is not None and value.tzinfo is None:
            value = value.replace(tzinfo=timezone.tz_info)
        return value


# Mixin: 一种面向对象编程概念, 使结构变得更加清晰, `Wiki <https://en.wikipedia.org/wiki/Mixin/>`__
class UserMixin(MappedAsDataclass):
    """用户 Mixin 数据类"""

    created_by: Mapped[int] = mapped_column(sort_order=998, comment='创建者')
    updated_by: Mapped[int | None] = mapped_column(init=False, default=None, sort_order=998, comment='修改者')


class DateTimeMixin(MappedAsDataclass):
    """日期时间 Mixin 数据类"""

    created_time: Mapped[datetime] = mapped_column(
        TimeZone,
        init=False,
        default_factory=timezone.now,
        sort_order=999,
        comment='创建时间',
    )
    updated_time: Mapped[datetime | None] = mapped_column(
        TimeZone,
        init=False,
        onupdate=timezone.now,
        sort_order=999,
        comment='更新时间',
    )


class LogicalDeleteMixin(MappedAsDataclass):
    """逻辑删除 Mixin 数据类"""

    deleted: Mapped[int] = mapped_column(
        BigInteger,
        init=False,
        default=0,
        server_default='0',
        sort_order=999,
        comment='是否已删除（0：否；id：是）',
    )
    deleted_time: Mapped[datetime | None] = mapped_column(
        TimeZone,
        init=False,
        default=None,
        sort_order=999,
        comment='删除时间',
    )


class MappedBase(AsyncAttrs, DeclarativeBase):
    """
    声明式基类, 作为所有基类或数据模型类的父类而存在

    `AsyncAttrs <https://docs.sqlalchemy.org/en/20/orm/extensions/asyncio.html#sqlalchemy.ext.asyncio.AsyncAttrs>`__

    `DeclarativeBase <https://docs.sqlalchemy.org/en/20/orm/declarative_config.html>`__

    `mapped_column() <https://docs.sqlalchemy.org/en/20/orm/mapping_api.html#sqlalchemy.orm.mapped_column>`__
    """

    @declared_attr.directive
    def __tablename__(self) -> str:
        """生成表名"""
        return self.__name__.lower()

    @declared_attr.directive
    def __table_args__(self) -> dict:
        """表配置"""
        return {'comment': self.__doc__ or ''}


class DataClassBase(MappedAsDataclass, MappedBase):
    """
    声明性数据类基类, 带有数据类集成, 允许使用更高级配置, 但你必须注意它的一些特性, 尤其是和 DeclarativeBase 一起使用时

    `MappedAsDataclass <https://docs.sqlalchemy.org/en/20/orm/dataclasses.html#orm-declarative-native-dataclasses>`__
    """

    __abstract__ = True


class Base(DataClassBase, DateTimeMixin, LogicalDeleteMixin):
    """
    声明性数据类基类, 带有数据类集成, 并包含 MiXin 数据类基础表结构
    """

    __abstract__ = True
