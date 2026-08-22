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


def test_single_head(alembic_cfg):
    """🔴 只能有一条 head。

    两个人各自 `alembic revision` 就会分叉成两条 head，而 `upgrade head`
    在多 head 时**直接报错**，谁都升不了级。分叉要用 `alembic merge` 合掉。
    早发现比在部署时发现便宜得多。
    """
    from alembic.script import ScriptDirectory

    heads = ScriptDirectory.from_config(alembic_cfg).get_heads()
    assert len(heads) == 1, f'迁移历史分叉了，有 {len(heads)} 条 head：{heads}，需要 alembic merge'


def test_every_revision_is_reachable_from_base(alembic_cfg):
    """每个迁移都要能从 base 走到 —— 断链的那些永远不会被执行。"""
    from alembic.script import ScriptDirectory

    script = ScriptDirectory.from_config(alembic_cfg)
    all_revs = {r.revision for r in script.walk_revisions()}
    reachable = {r.revision for r in script.iterate_revisions('head', 'base')}
    orphans = all_revs - reachable
    assert not orphans, f'这些迁移不在 base→head 的链上，永远不会执行：{sorted(orphans)}'


def test_model_matches_migrations(alembic_cfg):
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

    import backend.main  # noqa: F401 —— 为副作用：把全部模型拉进 metadata

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
        f'差异：\n  ' + '\n  '.join(repr(d) for d in structural)
    )


def _is_comment_only(diff) -> bool:
    """列注释类差异。`compare_metadata` 返回 `('modify_comment', ...)` 这种元组。"""
    if isinstance(diff, tuple) and diff and isinstance(diff[0], str):
        return 'comment' in diff[0]
    if isinstance(diff, list):
        return all(_is_comment_only(d) for d in diff)
    return False
