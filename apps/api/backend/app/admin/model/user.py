from datetime import datetime

import sqlalchemy as sa

from sqlalchemy.orm import Mapped, mapped_column

from backend.common.enums import DataBaseType
from backend.common.model import Base, TimeZone, UniversalStr, id_key
from backend.core.conf import settings
from backend.database.db import uuid4_str
from backend.utils.timezone import timezone

# email 可空，而 SQL Server 的 UNIQUE 约束认为多个 NULL 彼此相等 ——
# 用普通唯一约束时，第二个不填邮箱的用户会被数据库拒绝（23000 IntegrityError，已实测确认）。
# 因此 SQL Server 下改用筛选唯一索引，只对非 NULL 的 email 生效；
# MySQL / PostgreSQL 的 NULL 互不相等，保持原有唯一约束即可。
_EMAIL_UNIQUE = (
    sa.Index(
        'uk_sys_user_email_deleted',
        'email',
        'deleted',
        unique=True,
        mssql_where=sa.text('email IS NOT NULL'),
    )
    if DataBaseType.sqlserver == settings.DATABASE_TYPE
    else sa.UniqueConstraint('email', 'deleted', name='uk_sys_user_email_deleted')
)


class User(Base):
    """用户表"""

    __tablename__ = 'sys_user'
    __table_args__ = (
        sa.UniqueConstraint('username', 'deleted', name='uk_sys_user_username_deleted'),
        _EMAIL_UNIQUE,
        {'comment': '用户表'},
    )

    id: Mapped[id_key] = mapped_column(init=False)
    uuid: Mapped[str] = mapped_column(UniversalStr(64), init=False, default_factory=uuid4_str, unique=True)
    username: Mapped[str] = mapped_column(UniversalStr(64), index=True, comment='用户名')
    nickname: Mapped[str] = mapped_column(UniversalStr(64), comment='昵称')
    password: Mapped[str | None] = mapped_column(UniversalStr(256), comment='密码')
    salt: Mapped[bytes | None] = mapped_column(sa.LargeBinary(256), comment='加密盐')
    email: Mapped[str | None] = mapped_column(UniversalStr(256), default=None, index=True, comment='邮箱')
    phone: Mapped[str | None] = mapped_column(UniversalStr(11), default=None, comment='手机号')
    avatar: Mapped[str | None] = mapped_column(UniversalStr(256), default=None, comment='头像')
    status: Mapped[int] = mapped_column(default=1, index=True, comment='用户账号状态(0停用 1正常)')
    is_superuser: Mapped[bool] = mapped_column(default=False, comment='超级权限(0否 1是)')
    is_staff: Mapped[bool] = mapped_column(default=False, comment='后台管理登陆(0否 1是)')
    is_multi_login: Mapped[bool] = mapped_column(default=False, comment='是否重复登陆(0否 1是)')
    join_time: Mapped[datetime] = mapped_column(TimeZone, init=False, default_factory=timezone.now, comment='注册时间')
    last_login_time: Mapped[datetime | None] = mapped_column(
        TimeZone, init=False, onupdate=timezone.now, comment='上次登录时间'
    )
    last_password_changed_time: Mapped[datetime | None] = mapped_column(
        TimeZone, init=False, default_factory=timezone.now, comment='上次密码变更时间'
    )

    # 逻辑外键
    dept_id: Mapped[int | None] = mapped_column(sa.BigInteger, default=None, comment='部门关联ID')
