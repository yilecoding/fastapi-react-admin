"""同步列注释 —— 模型里改过、库上没跟

这 16 处是历史遗留：模型里的 `comment=` 改过（比如 `sys_file.path` 从
「相对 UPLOAD_DIR 的存储路径」改成「相对落盘根目录的存储路径」），但库上是
`create_all` 一次性建的，之后没人同步。**没有任何功能影响**——列注释只在
DBA 工具和 `sp_help` 里能看到。

单独拆出来而不是混进基线：基线要保持为空（它只是个起点标记），
而这一份是真实的一次结构变更，应该有自己的记录。

🔴 **这份迁移是三种数据库共用的同一条历史**（issue #59）。原始版本把
`existing_type` 硬编码成了 `mssql.BIT()` / 带 SQL Server collation 的
`NVARCHAR`——这类对象只有 mssql 的 DDL 编译器认识。MySQL 的
`ALTER TABLE ... MODIFY COLUMN` 需要重新编译**完整**列定义（不像 Postgres
可以用独立的 `COMMENT ON COLUMN` 语法跳过这一步），拿到一个 mssql 专属类型
对象会直接 `AttributeError: BIT object has no attribute length`，在 DDL
编译阶段就崩，根本连不到数据库。离线复现（不需要真实库）：

    DATABASE_TYPE=mysql alembic upgrade b0000000baseline:c0000000comments --sql

现在按 `op.get_bind().dialect.name` 分支，每种方言用各自实际的物理类型
（对应 `common/model.py` 的 `UniversalStr`/`UniversalText` 在该方言下
`load_dialect_impl()` 解析出来的类型）。

Revision ID: f532e6110c78
Revises:
Create Date: 2026-08-22 18:30:43.003028+08:00

"""

import contextlib

import sqlalchemy as sa
import sqlalchemy.exc

from alembic import op
from sqlalchemy.dialects import mssql, mysql

# revision identifiers, used by Alembic.
revision = 'c0000000comments'
down_revision = 'b0000000baseline'
branch_labels = None
depends_on = None


def _existing_types() -> dict[str, sa.types.TypeEngine]:
    """按当前连接的方言，给每一列建它在这个方言下真实的物理类型

    对应关系见 `common/model.py`：
    - `UniversalStr(n)`：mssql → `NVARCHAR(n)`；mysql/postgresql → `VARCHAR(n)`
    - `UniversalText`：mssql → `NVARCHAR(MAX)`；mysql → `LONGTEXT`；
      postgresql → `TEXT`
    - `sys_file.is_public`（裸 `Mapped[bool]`，没走 TypeDecorator）：
      mssql → `BIT`；mysql → `TINYINT(1)`；postgresql → `BOOLEAN`
    """
    dialect = op.get_bind().dialect.name
    if dialect == 'mssql':
        return {
            'varchar32': sa.NVARCHAR(length=32, collation='SQL_Latin1_General_CP1_CI_AS'),
            'varchar64': sa.NVARCHAR(length=64, collation='SQL_Latin1_General_CP1_CI_AS'),
            'varchar512': sa.NVARCHAR(length=512, collation='SQL_Latin1_General_CP1_CI_AS'),
            'longtext': sa.NVARCHAR(collation='SQL_Latin1_General_CP1_CI_AS'),
            'bool_': mssql.BIT(),
        }
    if dialect == 'mysql':
        return {
            'varchar32': sa.VARCHAR(length=32),
            'varchar64': sa.VARCHAR(length=64),
            'varchar512': sa.VARCHAR(length=512),
            'longtext': mysql.LONGTEXT(),
            'bool_': mysql.TINYINT(display_width=1),
        }
    # postgresql
    return {
        'varchar32': sa.VARCHAR(length=32),
        'varchar64': sa.VARCHAR(length=64),
        'varchar512': sa.VARCHAR(length=512),
        'longtext': sa.TEXT(),
        'bool_': sa.BOOLEAN(),
    }


def _bool_default(*, value: bool) -> sa.TextClause:
    """`is_public` 的 server_default 字面量，各方言自己的写法

    mssql 的 DEFAULT 约束习惯写成 `((0))`（`create_all` 生成的原样就是这个）；
    mysql/postgresql 没有这个双层括号的惯例，直接给标量字面量。
    """
    dialect = op.get_bind().dialect.name
    literal = '1' if value else '0'
    if dialect == 'mssql':
        return sa.text(f'(({literal}))')
    if dialect == 'postgresql':
        return sa.text('true' if value else 'false')
    return sa.text(literal)


def upgrade() -> None:
    """
    🔴 **这一份必须幂等。** 同一份迁移在两种库上遇到的状态不一样：

    - **老库**（2026-08-22 之前 create_all 建的）：列注释是旧的 → 要改
    - **新建库**（现在 create_all 一建就是新注释，比如刚跑过 `pnpm --filter api test:db`
      的 fba_test）：列注释**已经是目标值** → 再执行会炸

    炸的样子：`sp_addextendedproperty` 报
    `Property 'MS_Description' already exists for 'dbo.sys_dept.code'`。
    alembic 的 `alter_column(comment=...)` 在 mssql 上编译成 add 而不是 update，
    所以「已经对了」反而失败。

    这不是这一份的特例 —— **凡是「补齐历史遗留」类的迁移都有这个形状**：
    新建的库天然就是目标状态。写这类迁移时先问「新库跑这一步会怎样」。

    ⚠️ 只吞 `ProgrammingError`（"already exists" 属于它），不吞所有异常 ——
    连接断了、权限不足也是异常，那些必须让迁移失败。实测 SQL Server 在这里
    不会毒化事务，后续语句照常执行。
    """
    t = _existing_types()
    with contextlib.suppress(sqlalchemy.exc.ProgrammingError):
        op.alter_column('sys_dept', 'code', existing_type=t['varchar32'], comment='部门编码', existing_nullable=False)
    with contextlib.suppress(sqlalchemy.exc.ProgrammingError):
        op.alter_column(
            'sys_file',
            'path',
            existing_type=t['varchar512'],
            comment='相对落盘根目录的存储路径',
            existing_comment='相对 UPLOAD_DIR 的存储路径',
            existing_nullable=False,
        )
    with contextlib.suppress(sqlalchemy.exc.ProgrammingError):
        op.alter_column(
            'sys_file',
            'is_public',
            existing_type=t['bool_'],
            server_default=None,
            comment='是否落在公开子树（不鉴权可读）',
            existing_nullable=False,
        )
    with contextlib.suppress(sqlalchemy.exc.ProgrammingError):
        op.alter_column(
            'sys_opera_log',
            'request_headers',
            existing_type=t['longtext'],
            comment='请求头（已脱敏）',
            existing_nullable=True,
        )
    with contextlib.suppress(sqlalchemy.exc.ProgrammingError):
        op.alter_column(
            'sys_opera_log', 'response_headers', existing_type=t['longtext'], comment='响应头', existing_nullable=True
        )
    with contextlib.suppress(sqlalchemy.exc.ProgrammingError):
        op.alter_column(
            'sys_opera_log',
            'response_body',
            existing_type=t['longtext'],
            comment='响应体（超限截断）',
            existing_nullable=True,
        )
    with contextlib.suppress(sqlalchemy.exc.ProgrammingError):
        op.alter_column('sys_role', 'code', existing_type=t['varchar32'], comment='角色编码', existing_nullable=False)
    with contextlib.suppress(sqlalchemy.exc.ProgrammingError):
        op.alter_column(
            'sys_user',
            'timezone',
            existing_type=t['varchar64'],
            server_default=None,
            comment='显示时区(IANA 标识)',
            existing_nullable=False,
        )


def downgrade() -> None:
    t = _existing_types()
    with contextlib.suppress(sqlalchemy.exc.ProgrammingError):
        op.alter_column(
            'sys_user',
            'timezone',
            existing_type=t['varchar64'],
            server_default=sa.text("('Asia/Shanghai')"),
            comment=None,
            existing_comment='显示时区(IANA 标识)',
            existing_nullable=False,
        )
    with contextlib.suppress(sqlalchemy.exc.ProgrammingError):
        op.alter_column(
            'sys_role',
            'code',
            existing_type=t['varchar32'],
            comment=None,
            existing_comment='角色编码',
            existing_nullable=False,
        )
    with contextlib.suppress(sqlalchemy.exc.ProgrammingError):
        op.alter_column(
            'sys_opera_log',
            'response_body',
            existing_type=t['longtext'],
            comment=None,
            existing_comment='响应体（超限截断）',
            existing_nullable=True,
        )
    with contextlib.suppress(sqlalchemy.exc.ProgrammingError):
        op.alter_column(
            'sys_opera_log',
            'response_headers',
            existing_type=t['longtext'],
            comment=None,
            existing_comment='响应头',
            existing_nullable=True,
        )
    with contextlib.suppress(sqlalchemy.exc.ProgrammingError):
        op.alter_column(
            'sys_opera_log',
            'request_headers',
            existing_type=t['longtext'],
            comment=None,
            existing_comment='请求头（已脱敏）',
            existing_nullable=True,
        )
    with contextlib.suppress(sqlalchemy.exc.ProgrammingError):
        op.alter_column(
            'sys_file',
            'is_public',
            existing_type=t['bool_'],
            server_default=_bool_default(value=False),
            comment=None,
            existing_comment='是否落在公开子树（不鉴权可读）',
            existing_nullable=False,
        )
    with contextlib.suppress(sqlalchemy.exc.ProgrammingError):
        op.alter_column(
            'sys_file',
            'path',
            existing_type=t['varchar512'],
            comment='相对 UPLOAD_DIR 的存储路径',
            existing_comment='相对落盘根目录的存储路径',
            existing_nullable=False,
        )
    with contextlib.suppress(sqlalchemy.exc.ProgrammingError):
        op.alter_column(
            'sys_dept',
            'code',
            existing_type=t['varchar32'],
            comment=None,
            existing_comment='部门编码',
            existing_nullable=False,
        )
