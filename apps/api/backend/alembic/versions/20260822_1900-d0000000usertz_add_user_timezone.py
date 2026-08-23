"""补上 sys_user.timezone —— 加列那一步没有迁移

`sys_user.timezone`（用户显示时区）是手写 `ALTER` 加进开发库和 fba_test 的
（当时 alembic 还没引进来），所以迁移链里**只有 `c0000000comments` 里那条
`alter_column`**（改注释、去掉 server_default），**没有任何一条创建这一列**。

漏这一条不会报错，会静默：`c0000000comments` 里每一步都包在
`contextlib.suppress(ProgrammingError)` 里，在没有这一列的库上
`alter_column` 抛错被吞掉，`db:upgrade` 一路绿到 head，而列还是不存在 ——
下一次任何读用户的请求才炸，报的是 `Invalid column name 'timezone'`。

守卫测试也抓不到：`test_model_matches_migrations` 比对的是 **fba_test**，
而那个库已经被手工 ALTER 过了，模型和它是一致的。

## 幂等

新建的库是 `create_all` 从模型建的，**天然就有这一列**，所以不能无条件
`add_column`（会报 `Column names in each table must be unique`）。
先查 `sys.columns` 再决定加不加 —— 同 `c0000000comments` 头注释里那条
「补齐历史遗留类的迁移必须幂等」。

Revision ID: d0000000usertz
Revises: c0000000comments
Create Date: 2026-08-22 19:00:00.000000+08:00

"""

import sqlalchemy as sa

from alembic import op

import backend.common.model  # 让 UniversalStr 等自定义类型可解析

# revision identifiers, used by Alembic.
revision = 'd0000000usertz'
down_revision = 'c0000000comments'
branch_labels = None
depends_on = None

_TABLE = 'sys_user'
_COLUMN = 'timezone'


def _has_column() -> bool:
    """这一列在不在。用 inspector 而不是手写方言 SQL —— 五种数据库变体都要能跑"""
    bind = op.get_bind()
    return _COLUMN in {c['name'] for c in sa.inspect(bind).get_columns(_TABLE)}


def upgrade() -> None:
    if _has_column():
        return
    # 已有行要有值：列是 NOT NULL，`server_default` 负责回填存量行。
    #
    # ⚠️ 默认值写死 `'Asia/Shanghai'` 而**不是**读 `settings.DATETIME_TIMEZONE` ——
    # 迁移是一份历史记录，它记的必须是「当时那一刻发生了什么」。读配置的话，
    # 同一个 revision 在不同环境/不同时间跑出来的库会不一样。
    op.add_column(
        _TABLE,
        sa.Column(
            _COLUMN,
            backend.common.model.UniversalStr(64),
            nullable=False,
            server_default='Asia/Shanghai',
            comment='显示时区(IANA 标识)',
        ),
    )
    # 模型侧的默认值是 Python 级的（`default=`），库上不该留 DEFAULT 约束 ——
    # 留着的话 `create_all` 建出来的新库和迁移升上来的旧库不一致，
    # `test_model_matches_migrations` 会报一条 server_default 的差异。
    op.alter_column(_TABLE, _COLUMN, server_default=None)


def downgrade() -> None:
    if not _has_column():
        return
    op.drop_column(_TABLE, _COLUMN)
