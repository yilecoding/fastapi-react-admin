"""种子数据的**追加**机制：给已经在跑的库补上后来新增的那些行。

## 为什么需要这一层（issue #86）

schema 改动和种子数据走的是两条完全不同的路径：

- **schema**：部署时 `alembic upgrade head`，已存在的库会跟上；而且
  `test_model_matches_migrations` 兜着「改了模型忘了生成迁移」
- **种子数据**：只有 `fba init`（`drop_all` + `create_all` + 灌种子 + `stamp head`）
  会执行。已存在的库 🔴 **不会**跟上 —— 没有版本号、没有「这批种子进过这个库吗」
  的记录，也没有任何检查会发现「种子文件改了但某个库没跟上」

实际后果（不是理论风险）：`5c1d594` 往种子里加了三条 RBAC 权限锚点菜单，代码
部署那一刻校验就生效了，而菜单从来没进生产库 —— MANAGER 演示账号原本能看的
部门树当场 403。`256beae` 加的「每日问候」调度同理：功能部署了，从来没跑过。

## 机制：就用 alembic，不另造一套

数据迁移就是一条**普通的 alembic revision**，只是 `upgrade()` 里不是 DDL 而是
幂等的 INSERT。这样白拿三样东西：`alembic_version` 天然记录了「这个库跑到哪了」、
部署流程已经在跑 `alembic upgrade head`、`fba init` 之后的 `stamp head` 会把它标成
已应用而**不执行**（新库的行本来就来自种子 SQL，不会插两遍）。

## 三条纪律

- 🔴 **外键一律按业务键解析，不要硬编码 ID。** 三个方言的种子各有一套 ID
  （postgresql 的角色在 `4000000000000000xxx` 区间、另两个在 `3000000000000000xxx`），
  而生产库的 ID 又只在生产库里成立。用 `sys_menu.name` / `sys_role.code` 这类
  跨环境稳定的键去查，写一次三个方言都对。
- 🔴 **幂等靠业务键判存在，不要靠吃唯一约束冲突。** 三种方言的冲突语法各不相同
  （`MERGE` / `ON CONFLICT` / `INSERT IGNORE`），写任一种都会在另外两种上炸。
- ⚠️ **不要重新灌整份种子。** 那会把别人在界面上改过的数据覆盖回去。
  只补「按业务键查不到」的那些行。
"""

from typing import Any

import sqlalchemy as sa

from sqlalchemy.engine import Connection

from backend.common.enums import PrimaryKeyType
from backend.core.conf import settings
from backend.utils.timezone import timezone

#: 数据迁移专用的主键区间。**种子文件不要用这一段。**
#:
#: 只用在「纯连接行」上（`sys_role_menu` 这类只有代理主键、没人引用它的表）。
#: 有语义的行（菜单）一律**照抄种子里那个 ID** —— 三个方言的 `sys_menu` 用的是
#: 同一套 ID，抄过来能让「升级上来的库」和「`fba init` 新建的库」结构与数据都收敛，
#: 排障时不用先问一句「这个库是哪条路建出来的」。
DATA_MIGRATION_PK_BASE = 5000000000000000000


def _lightweight_table(name: str, columns: set[str]) -> sa.TableClause:
    """按需拼一个只有列名的表引用

    刻意**不**去 import 真正的 ORM 模型：迁移要在「当时那个 schema」上执行，
    而模型是「现在这个 schema」。一条老迁移 import 模型，等模型加了新列之后
    它就会往一个当时还没有那一列的表里插数据 —— 这是数据迁移最经典的坑。
    """
    return sa.table(name, *[sa.column(c) for c in sorted(columns)])


def seeded_pk_mode() -> bool:
    """当前主键模式下，种子数据这条路径存不存在

    🔴 数据迁移里**不要调 `snowflake.generate()`**：它要么读环境变量、要么去 Redis
    抢节点号（`snowflake.init()`），而 `alembic upgrade` 是部署时一个独立的
    `migrate` 容器，把 Redis 拉成它的前置依赖是个新耦合，而且失败时报的是
    「雪花 ID 生成失败」——完全看不出跟数据迁移有关。
    所以主键一律用显式常量（见 `DATA_MIGRATION_PK_BASE` 的注释）。

    代价是自增主键模式下这些常量不能用（mssql 会报
    `Cannot insert explicit value for identity column`）。但那个模式**本来就没有
    基础种子**：`build_sql_filename()` 只在雪花模式下拼出 `init_snowflake_test_data.sql`，
    自增模式找的是一个不存在的 `init_test_data.sql`。没有种子就没有「种子没同步」
    这个问题，整条数据迁移直接跳过即可。
    """
    return PrimaryKeyType(settings.DATABASE_PK_MODE) == PrimaryKeyType.snowflake


def scalar(conn: Connection, table: str, column: str, **where: Any) -> Any | None:
    """按业务键查一个标量（典型用途：拿 `sys_menu.name` 换它的 id）"""
    t = _lightweight_table(table, {column, *where})
    stmt = sa.select(t.c[column]).where(*[t.c[k] == v for k, v in where.items()]).limit(1)
    return conn.execute(stmt).scalar()


def insert_if_absent(conn: Connection, table: str, key: dict[str, Any], values: dict[str, Any]) -> bool:
    """`key` 查不到时插入一行，返回是否真的插了

    :param conn: `op.get_bind()`
    :param table: 表名
    :param key: 判存在用的业务键（也会一起写进新行）
    :param values: 其余列
    :return: True = 插了新行；False = 已经有了，什么都没做
    """
    t = _lightweight_table(table, {*key, *values})
    exists = conn.execute(
        sa.select(sa.literal(1)).select_from(t).where(*[t.c[k] == v for k, v in key.items()]).limit(1)
    ).first()
    if exists is not None:
        return False
    conn.execute(sa.insert(t).values({**key, **values}))
    return True


def delete_by_key(conn: Connection, table: str, **key: Any) -> int:
    """按业务键删除（给 `downgrade()` 用）"""
    t = _lightweight_table(table, set(key))
    result = conn.execute(sa.delete(t).where(*[t.c[k] == v for k, v in key.items()]))
    return result.rowcount or 0


def add_menu(
    conn: Connection,
    *,
    menu_id: int,
    name: str,
    title: str,
    parent_name: str | None = None,
    path: str | None = None,
    perms: str | None = None,
    icon: str | None = None,
    menu_type: int = 2,
    sort: int = 0,
    display: int = 0,
) -> bool:
    """补一条 `sys_menu`，父级按 `name` 解析

    幂等判定和父级解析都用 `name`：它是这张表里唯一跨环境稳定的键
    （`title` 管理员随时能改、`id` 在别的表里每套环境不同）。

    ⚠️ `menu_id` 要**照抄种子文件里那个值** —— `sys_menu` 的 ID 三个方言是同一套，
    抄过来才能让升级上来的库和新建的库收敛。

    :return: True = 插了；False = 已经有了 / 父级不存在
    """
    parent_id = None
    if parent_name is not None:
        parent_id = scalar(conn, 'sys_menu', 'id', name=parent_name)
        if parent_id is None:
            # 父级不在（比如那个模块被删了 / 这个库的种子更老）——跳过而不是插一条孤儿。
            # `traversal_to_tree` 会把孤儿提到根，表现是侧边栏凭空多出一条顶层菜单。
            return False

    values: dict[str, Any] = {
        'id': menu_id,
        'title': title,
        'path': path,
        'sort': sort,
        'icon': icon,
        'type': menu_type,
        'perms': perms,
        'status': 1,
        'display': display,
        'link': '',
        'remark': None,
        'parent_id': parent_id,
        'created_time': timezone.now(),
    }
    return insert_if_absent(conn, 'sys_menu', {'name': name}, values)


def grant_menu(conn: Connection, *, row_id: int, role_code: str, menu_name: str) -> bool:
    """把一条菜单授权给一个角色（`sys_role_menu`），角色和菜单都按业务键解析

    `sys_role_menu` 是纯连接行、主键没人引用，所以 `row_id` 用
    `DATA_MIGRATION_PK_BASE` 那一段，不必和种子里的值一致。

    :return: True = 插了；False = 角色/菜单不存在，或者已经授权过
    """
    role_id = scalar(conn, 'sys_role', 'id', code=role_code)
    menu_id = scalar(conn, 'sys_menu', 'id', name=menu_name)
    if role_id is None or menu_id is None:
        return False

    return insert_if_absent(conn, 'sys_role_menu', {'role_id': role_id, 'menu_id': menu_id}, {'id': row_id})
