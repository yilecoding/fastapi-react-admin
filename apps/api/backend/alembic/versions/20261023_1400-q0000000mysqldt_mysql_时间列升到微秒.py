"""MySQL：时间列从秒升到微秒（DATETIME → DATETIME(6)，#132）

`TimeZone` 在 MySQL 上原来建成 `DATETIME`，精度 0、只到秒。同一秒内的两件事分不出先后：回收站「还原」按
`deleted_time` 相等认「同一次删除」，同一秒内手动移除的附件会被一起挂回去（#132）。PostgreSQL（timestamptz）
和 SQL Server（datetimeoffset(7)）本来就到微秒以下，这条迁移只在 MySQL 上动手。

按**库里实际的列**改（查 `information_schema`），不按当前模型：精度不到 6 的 DATETIME 列一律改成 DATETIME(6)。
🔴 MySQL 的 `MODIFY` 是把整列重新定义一遍，没写上的属性就丢了 —— 可空性和注释都从库里读出来原样带上。
带默认值 / `EXTRA`（`ON UPDATE …`）的时间列本仓库的模型一个都没有，碰到就停下来，不猜。
存量值不变（整秒补 `.000000`）；降级时小数秒按 MySQL 的规则四舍五入到秒。

⚠️ MySQL 改列类型要重建整张表，大表（操作日志、登录日志）会锁一段时间，挑空闲时段升级。
同一张表的几列合成一条 `ALTER TABLE`，只重建一次。离线 `--sql` 模式不支持（要读库里现有的列，同 `d0000000usertz`）。

Revision ID: q0000000mysqldt
Revises: p0000000wfaireview
Create Date: 2026-10-23 14:00:00

"""

from itertools import groupby

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision = 'q0000000mysqldt'
down_revision = 'p0000000wfaireview'
branch_labels = None
depends_on = None


def _retype(column_type: str, precision_filter: str) -> None:
    bind = op.get_bind()
    if bind.dialect.name != 'mysql':
        return
    rows = bind.execute(
        sa.text(
            'SELECT TABLE_NAME, COLUMN_NAME, IS_NULLABLE, COLUMN_DEFAULT, EXTRA, COLUMN_COMMENT '
            'FROM information_schema.COLUMNS '
            f"WHERE TABLE_SCHEMA = DATABASE() AND DATA_TYPE = 'datetime' AND DATETIME_PRECISION {precision_filter} "
            'ORDER BY TABLE_NAME, ORDINAL_POSITION'
        )
    ).all()
    odd = [f'{r.TABLE_NAME}.{r.COLUMN_NAME}' for r in rows if r.COLUMN_DEFAULT is not None or r.EXTRA]
    if odd:
        raise RuntimeError(f'这些时间列带默认值或 EXTRA，本迁移不认识，先人工处理：{odd}')

    quote = bind.dialect.identifier_preparer.quote
    for table, group in groupby(rows, key=lambda r: r.TABLE_NAME):
        clauses, params = [], {}
        for i, r in enumerate(group):
            clause = f'MODIFY {quote(r.COLUMN_NAME)} {column_type} {"NULL" if r.IS_NULLABLE == "YES" else "NOT NULL"}'
            if r.COLUMN_COMMENT:
                # 注释走绑定参数：驱动负责转义引号 / 反斜杠 / 百分号
                clause += f' COMMENT :c{i}'
                params[f'c{i}'] = r.COLUMN_COMMENT
            clauses.append(clause)
        bind.execute(sa.text(f'ALTER TABLE {quote(table)} {", ".join(clauses)}'), params)


def upgrade() -> None:
    _retype('DATETIME(6)', '< 6')


def downgrade() -> None:
    _retype('DATETIME', '= 6')
