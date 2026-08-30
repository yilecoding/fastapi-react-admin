"""迁移守卫。

放在 `app/task/tests` 下不是因为它属于 task 模块，而是因为 `pyproject.toml` 的
`testpaths` 只列了几个目录 —— 这是当前**唯一**能被收集到的非 admin 位置。
将来加 `backend/tests` 到 testpaths 时把它挪过去。
"""

import pytest


@pytest.fixture(scope='module')
def alembic_cfg():
    from alembic.config import Config

    from backend.core.path_conf import BASE_PATH

    cfg = Config(str(BASE_PATH / 'alembic.ini'))
    cfg.set_main_option('script_location', str(BASE_PATH / 'alembic'))
    return cfg


def test_single_head(alembic_cfg) -> None:
    """🔴 只能有一条 head。

    两个人各自 `alembic revision` 就会分叉成两条 head，而 `upgrade head`
    在多 head 时**直接报错**，谁都升不了级。分叉要用 `alembic merge` 合掉。
    早发现比在部署时发现便宜得多。
    """
    from alembic.script import ScriptDirectory

    heads = ScriptDirectory.from_config(alembic_cfg).get_heads()
    assert len(heads) == 1, f'迁移历史分叉了，有 {len(heads)} 条 head：{heads}，需要 alembic merge'


def test_every_revision_is_reachable_from_base(alembic_cfg) -> None:
    """每个迁移都要能从 base 走到 —— 断链的那些永远不会被执行。"""
    from alembic.script import ScriptDirectory

    script = ScriptDirectory.from_config(alembic_cfg)
    all_revs = {r.revision for r in script.walk_revisions()}
    reachable = {r.revision for r in script.iterate_revisions('head', 'base')}
    orphans = all_revs - reachable
    assert not orphans, f'这些迁移不在 base→head 的链上，永远不会执行：{sorted(orphans)}'


def test_model_matches_migrations(alembic_cfg) -> None:
    """🔴 **改了模型就必须生成迁移。** 这条是「以后靠 alembic」能不能立住的分水岭。

    做法：让 alembic 拿**当前模型**和**已升级到 head 的测试库**做 diff，
    有差异就说明有人改了模型却没 `pnpm db:revision`。

    不加这条守卫的话，「以后有数据库变化就做迁移」只是一句口头约定 ——
    而漏做的后果是**静默的**：本机开发库是手工 ALTER 过的（能跑），
    全新环境按迁移建出来的库缺那一列，要到部署时才炸。

    ⚠️ 它比对的是 **fba_test**。所以本地跑之前 fba_test 要先到 head：
        `pnpm --filter api db:upgrade`（或 `test:db` 重建后再 stamp+upgrade）
    """
    from alembic.autogenerate import compare_metadata
    from alembic.migration import MigrationContext
    from sqlalchemy import create_engine

    import backend.main  # ruff: ignore[unused-import] —— 为副作用：把全部模型拉进 metadata

    from backend.common.model import MappedBase
    from backend.database.db import get_database_url

    url = get_database_url(unittest=True).render_as_string(hide_password=False)
    # alembic 的 compare 走同步连接
    sync_url = url.replace('+aioodbc', '+pyodbc').replace('+asyncpg', '+psycopg').replace('+asyncmy', '+pymysql')

    engine = create_engine(sync_url, future=True)
    try:
        with engine.connect() as conn:
            diff = compare_metadata(MigrationContext.configure(conn), MappedBase.metadata)
    finally:
        engine.dispose()

    # 只关心结构性差异；列注释这类在不同方言下噪声大，单独放行
    structural = [d for d in diff if not _is_comment_only(d)]
    assert not structural, (
        '模型和迁移对不上 —— 改了模型但没生成迁移。跑：\n'
        "  pnpm db:revision '说清楚改了什么'\n"
        '差异：\n  ' + '\n  '.join(repr(d) for d in structural)
    )


def _is_comment_only(diff) -> bool:
    """列注释类差异。`compare_metadata` 返回 `('modify_comment', ...)` 这种元组。"""
    if isinstance(diff, tuple) and diff and isinstance(diff[0], str):
        return 'comment' in diff[0]
    if isinstance(diff, list):
        return all(_is_comment_only(d) for d in diff)
    return False


def test_fresh_database_is_stamped_at_head(alembic_cfg) -> None:
    """🔴 **`create_all` 建出来的库必须被 stamp 到 head。**

    症状：全新环境跑 `fba init`（drop_all + create_all + 灌种子）建库，
    库里**没有 `alembic_version` 表** —— 那张表不在 `MappedBase.metadata` 里，
    `create_all` 不会建它。将来 `db:upgrade` 会从 base 把**全部**迁移重跑一遍。

    为什么至今没炸：现有 3 条迁移在新库上碰巧都无害 —— `b0000000baseline`
    是空的，`c0000000comments` 每一步都包在 `suppress(ProgrammingError)` 里，
    `d0000000usertz` 有 `_has_column()` 早退。**第 4 条只要是普通的
    `add_column` / `create_index`，在 create_all 已经建好的新库上就会炸**
    （`Column names in each table must be unique`），而且是在部署时炸。

    另外三条守卫都抓不到这个：
      - `test_single_head` / `test_every_revision_is_reachable_from_base`
        只读 `alembic/versions/` 目录，**不连库**
      - `test_model_matches_migrations` 连库，但比的是表结构和模型，
        `MigrationContext` 从不读 `alembic_version` 的内容

    这条比对的是 **fba_test**，它和 `fba init` 走同一条建库路径
    （`reset_test_db.py`：drop_all + create_all + `_stamp_head`）。
    所以只要任何一侧漏了 stamp、或者加了迁移却没重建测试库，这条就红。
    """
    from alembic.script import ScriptDirectory
    from sqlalchemy import create_engine, inspect, text

    from backend.database.db import get_database_url

    url = get_database_url(unittest=True).render_as_string(hide_password=False)
    sync_url = url.replace('+aioodbc', '+pyodbc').replace('+asyncpg', '+psycopg').replace('+asyncmy', '+pymysql')

    engine = create_engine(sync_url, future=True)
    try:
        with engine.connect() as conn:
            assert inspect(conn).has_table('alembic_version'), (
                '库里没有 alembic_version 表 —— 说明它是 create_all 建的但没 stamp。\n'
                '跑 `pnpm --filter api test:db`（会自动 stamp），'
                '或检查 backend/cli.py 的 init 建完表后有没有 stamp 到 head'
            )
            stamped = {row[0] for row in conn.execute(text('SELECT version_num FROM alembic_version'))}
    finally:
        engine.dispose()

    heads = set(ScriptDirectory.from_config(alembic_cfg).get_heads())
    assert stamped == heads, (
        f'库的迁移版本 {sorted(stamped) or "（空）"} 不等于 head {sorted(heads)} —— '
        '要么新库没 stamp，要么加了迁移之后没升级。\n'
        '  新建库：fba init 会自动 stamp head\n'
        '  已有库：pnpm db:upgrade'
    )


def test_migrations_compile_offline_for_every_supported_dialect() -> None:
    """(issue #59) 每条迁移在三种数据库上都要能编译出 SQL——不只是能在 SQL Server 上跑

    `pnpm --filter api test:db` / 日常 pytest 只跑 SQL Server，一条迁移拿
    mssql 专属类型对象当 `existing_type`（比如 `mssql.BIT()`、带 SQL Server
    collation 的 `NVARCHAR`）在这条主线上完全测不出来——直到某个 MySQL/PostgreSQL
    环境走 `alembic upgrade head` 才会在 DDL 编译阶段炸
    （`AttributeError: BIT object has no attribute length`，`c0000000comments`
    就是这样，见该文件的注释）。

    这里用 `alembic upgrade ... --sql`（离线生成 SQL，不需要真实连接）对
    mysql / postgresql 各跑一遍 `c0000000comments`，只要不抛异常就说明没有
    方言专属对象泄漏到另一个方言的编译路径里。

    ⚠️ **只测到 `c0000000comments` 这一条，不是整条 head 链**，两个独立原因：

    - 不测 sqlserver——alembic 自己的 mssql 插件在离线 `--sql` 模式下生成列
      注释语句时有个已知限制（`_add_column_comment` 里 `assert schema_name`，
      离线模式拿不到 schema 名），这和本仓库的迁移写得对不对无关，真实的
      在线 `alembic upgrade`（这条主线唯一真正跑迁移的方式）不受影响，
      本文件其它守卫已经在真连接上覆盖了 sqlserver
    - 不跑到更后面的迁移——`d0000000usertz` 用 `sa.inspect(bind).get_columns()`
      做幂等性检查（判断列存不存在），这**需要一个真实连接**，离线 `--sql`
      模式下 `bind` 是 `MockConnection`，`sa.inspect()` 直接
      `NoInspectionAvailable`。这是"补历史遗留列"这类迁移的固有约束
      （运行期自省无法在纯离线模式下工作），不是本条要守的那类 bug，
      也不该让它挡住这条测试

    子进程跑是因为 `DATABASE_TYPE` 只在进程启动时被 `settings` 读一次——
    当前测试进程已经是 sqlserver 了，进程内改 `os.environ` 对缓存的单例没有
    任何效果（同 `env.py` 那条"改 DATABASE_SCHEMA 环境变量顶不住"的注释）。
    """
    import os
    import subprocess
    import sys

    from backend.core.path_conf import BASE_PATH

    for dialect in ('mysql', 'postgresql'):
        env = {**os.environ, 'DATABASE_TYPE': dialect}
        result = subprocess.run(
            [sys.executable, '-m', 'alembic', 'upgrade', 'b0000000baseline:c0000000comments', '--sql'],
            cwd=BASE_PATH,
            env=env,
            capture_output=True,
            text=True,
            timeout=60,
        )
        assert result.returncode == 0, (
            f'{dialect} 上离线生成迁移 SQL 失败（说明某条迁移里混进了另一个方言'
            f'专属的类型对象）：\n{result.stderr[-4000:]}'
        )


def _column_call_at(text: str, start: int) -> str:
    r"""从 `sa.Column(` 起按括号配对截出完整调用

    ⚠️ 不能用 `[^)]*\)` 那种「到第一个右括号为止」的正则：`sa.BigInteger()`
    自己就带一对括号，截出来的片段永远停在它上面，`autoincrement=False`
    落在片段之外 —— 于是那条守卫会**每一条迁移都报红**（第一版就是这样）。
    """
    depth = 0
    for i in range(start, len(text)):
        if text[i] == '(':
            depth += 1
        elif text[i] == ')':
            depth -= 1
            if depth == 0:
                return text[start : i + 1]
    return text[start:]


def test_created_tables_declare_snowflake_pk_as_non_autoincrement() -> None:
    """🔴 迁移里 `create_table` 的雪花主键必须显式 `autoincrement=False`

    **这条守卫补的是 `test_model_matches_migrations` 天生看不见的一个洞。**

    模型侧的 `id_key` 靠 `default=snowflake.generate`（Python 侧默认值）让
    SQLAlchemy 的 `autoincrement='auto'` 判定为「不是自增列」。但 **alembic
    autogenerate 渲染不出 Python 侧的 `default=`** —— 它写出来的是一句朴素的
    `sa.Column('id', sa.BigInteger(), nullable=False)`，重新命中 auto 规则，
    于是在 SQL Server 上建成 **IDENTITY** 列。后果不是"差一点"，是那张表
    **一行都写不进去**：ORM 带着雪花 ID 去 INSERT，数据库回
    `Cannot insert explicit value for identity column ... (544)`。

    为什么 `test_model_matches_migrations` 抓不到：它比的是「模型 vs fba_test」，
    而 fba_test 是 `create_all` 建的 —— 两边都是「非 IDENTITY」，差集为空，全绿。
    唯一能暴露它的是「用迁移建出来的库」，也就是**生产**
    （`core/registrar.py` 在 prod 下要求 alembic 在 head）。
    实测：`sys_notification` 是本仓库第一张真正由迁移创建的表，当场踩到。

    自增主键模式（`DATABASE_PK_MODE=autoincrement`）下这条不适用 —— 那时
    IDENTITY 正是想要的，所以只在雪花模式下断言。
    """
    import re

    from backend.common.enums import PrimaryKeyType
    from backend.core.conf import settings
    from backend.core.path_conf import BASE_PATH

    if PrimaryKeyType(settings.DATABASE_PK_MODE) != PrimaryKeyType.snowflake:
        pytest.skip('自增主键模式下 IDENTITY 是想要的行为')

    # 只看 `create_table` 里的 id 列 —— `add_column` 加的普通列不涉及主键
    id_column = re.compile(r"sa\.Column\(\s*'id'\s*,")
    offenders: list[str] = []
    for path in sorted((BASE_PATH / 'alembic' / 'versions').glob('*.py')):
        body = path.read_text(encoding='utf-8')
        if 'create_table(' not in body:
            continue
        for match in id_column.finditer(body):
            call = _column_call_at(body, match.start())
            if 'autoincrement=False' not in call:
                offenders.append(f'{path.name}: {" ".join(call.split())}')

    assert not offenders, (
        '这些迁移建表时没给雪花主键写 autoincrement=False，SQL Server 上会建成 IDENTITY，\n'
        '那张表在「用迁移建出来的库」（= 生产）里一行都插不进去：\n' + '\n'.join(f'  - {o}' for o in offenders)
    )
