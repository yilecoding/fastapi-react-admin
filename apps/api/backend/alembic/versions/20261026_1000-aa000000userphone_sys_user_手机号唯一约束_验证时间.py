"""sys_user：手机号加唯一约束 + 新增 phone_verified_time（手机号验证时间）

Revision ID: aa000000userphone
Revises: z0000000sms
Create Date: 2026-10-26 10:00:00

issue #168 第一步。手机登录的前提是「这个号确实是这个人的」：

- 唯一约束 `uk_sys_user_phone_deleted`（同 email 那条：`(phone, deleted)`；SQL Server 用筛选唯一索引，
  让多个 NULL 互不冲突）
- `phone_verified_time`：空 = 管理员录入 / 导入的、没经过本人验证。本人在个人中心用验证码绑定时写入

🔴 **加唯一约束之前先查重，有重复就报清楚是哪几个号、停下来。** 不静默处理（删谁的都不对），
也不让数据库用一句 `duplicate key` 把人打发走 —— 那句话不说是哪一行。
离线 `--sql` 模式下没有真连接，查不了也不查。

幂等同 `d0000000usertz`：新建的库是 `create_all` 从模型建的，列和约束天然都有，先问在不在再动手。
"""

import sqlalchemy as sa

from alembic import op

import backend.common.model

# revision identifiers, used by Alembic.
revision = 'aa000000userphone'
down_revision = 'z0000000sms'
branch_labels = None
depends_on = None

_TABLE = 'sys_user'
_COLUMN = 'phone_verified_time'
_UK = 'uk_sys_user_phone_deleted'


def _offline() -> bool:
    return bool(op.get_context().as_sql)


def _has_column() -> bool:
    return _COLUMN in {c['name'] for c in sa.inspect(op.get_bind()).get_columns(_TABLE)}


def _has_unique() -> bool:
    inspector = sa.inspect(op.get_bind())
    names = {c['name'] for c in inspector.get_unique_constraints(_TABLE)}
    names |= {i['name'] for i in inspector.get_indexes(_TABLE)}
    return _UK in names


def _assert_no_duplicates() -> None:
    rows = (
        op
        .get_bind()
        .execute(
            sa.text(
                f'SELECT phone, COUNT(*) AS n FROM {_TABLE} WHERE phone IS NOT NULL AND deleted = 0 '
                'GROUP BY phone HAVING COUNT(*) > 1'
            )
        )
        .fetchall()
    )
    if rows:
        detail = '、'.join(f'{phone}（{n} 个账号）' for phone, n in rows)
        raise RuntimeError(f'sys_user.phone 有重复，加不了唯一约束：{detail}。先在「用户管理」里改掉重复的号码，再升级')


def upgrade() -> None:
    offline = _offline()
    if offline or not _has_column():
        op.add_column(
            _TABLE,
            sa.Column(
                _COLUMN,
                backend.common.model.TimeZone(timezone=True),
                nullable=True,
                comment='手机号验证时间(空=未经本人验证)',
            ),
        )
    if offline or not _has_unique():
        if not offline:
            _assert_no_duplicates()
        if op.get_bind().dialect.name == 'mssql':
            # 和模型里 `_PHONE_UNIQUE` 一致：SQL Server 的 UNIQUE 把多个 NULL 当相等，要用筛选唯一索引
            op.create_index(_UK, _TABLE, ['phone', 'deleted'], unique=True, mssql_where=sa.text('phone IS NOT NULL'))
        else:
            op.create_unique_constraint(_UK, _TABLE, ['phone', 'deleted'])


def downgrade() -> None:
    offline = _offline()
    if offline or _has_unique():
        if op.get_bind().dialect.name == 'mssql':
            op.drop_index(_UK, table_name=_TABLE)
        else:
            op.drop_constraint(_UK, _TABLE, type_='unique')
    if offline or _has_column():
        op.drop_column(_TABLE, _COLUMN)
