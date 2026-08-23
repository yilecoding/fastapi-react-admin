"""重建单元测试数据库（`<DATABASE_SCHEMA>_test`）。

    cd apps/api && uv run python -m backend.scripts.reset_test_db
    # 或
    pnpm --filter api test:db

**为什么要有这个脚本**：测试库的表是从模型生成的，而 `create_all` **只建不改** ——
模型加一列（例如 `sys_file.is_public`），已经存在的测试库不会跟着变，
下一次跑测试就是一片 `Invalid column name 'is_public'`，看着像测试写坏了。
测试库里没有要保的数据，所以正确做法是**整个重建**，而不是手写 ALTER 追着补。

⚠️ 它 drop 的是 `..._test` 库（`get_database_url(unittest=True)`），
不会碰开发库。库本身必须已经存在（`CREATE DATABASE` 需要在别的库上执行）——
第一次用先手工建一个空库，见 CLAUDE.md「跑测试」一节。
"""

import asyncio
import sys

import cappa

# 注册所有模型 —— 不 import 的话 metadata 是空的，drop/create 都成了空操作。
# 少 import 一个插件，它的表就会被漏掉，且不报错
import backend.app.admin.model  # ruff: ignore[unused-import]
import backend.plugin.config.model  # ruff: ignore[unused-import]
import backend.plugin.dict.model  # ruff: ignore[unused-import]
import backend.plugin.notice.model  # ruff: ignore[unused-import]
import backend.plugin.oauth2.model  # ruff: ignore[unused-import]

from backend.cli import execute_sql_scripts, get_sql_scripts
from backend.common.model import MappedBase
from backend.core.conf import settings
from backend.database.db import create_database_async_engine, create_database_async_session, get_database_url


async def main() -> None:
    url = get_database_url(unittest=True)
    print(f'目标库：{url.database}（不是开发库 {settings.DATABASE_SCHEMA}）')

    engine = create_database_async_engine(url)
    session_factory = create_database_async_session(engine)

    async with engine.begin() as conn:
        print('删除旧表…')
        await conn.run_sync(MappedBase.metadata.drop_all)
        print('按模型建表…')
        await conn.run_sync(MappedBase.metadata.create_all)
    print(f'  {len(MappedBase.metadata.tables)} 张表')

    # 种子数据复用 cli 的那一套（主 SQL + 各插件 SQL，顺序由 resolve_plugin_order 定），
    # 免得这里和 `fba init` 各写一份、日后走偏
    print('灌种子数据…')
    scripts = await get_sql_scripts()
    async with session_factory.begin() as db:
        for script in scripts:
            print(f'  {script}')
            await execute_sql_scripts(db, script, is_init=True)

    await engine.dispose()

    print('完成。现在可以 `pnpm test`')


def _stamp_head() -> None:
    """把测试库标记到迁移 head。

    🔴 **必须在 `asyncio.run()` 之外调用。** alembic 的 `command.stamp` 会执行
    `env.py`，而那份 env 里是 `asyncio.run(...)` —— 在已经跑着的事件循环里再调
    直接 `asyncio.run() cannot be called from a running event loop`。

    为什么要 stamp：重建之后 `alembic_version` 是空的，
    `test_model_matches_migrations` 那条守卫比对的就是这个库，不 stamp 会红。

    用 stamp 而不是 upgrade：表是 `create_all` 从**当前模型**建的，已经是最新
    结构，再跑一遍迁移是重复劳动（「补齐历史遗留」类的迁移在新库上本来就无事可做）。
    stamp 只写一行版本号。
    """
    from alembic import command
    from alembic.config import Config

    from backend.core.path_conf import BASE_PATH

    # 🔴 必须把目标库**显式写进 sqlalchemy.url**。
    # 原来是设 `os.environ['DATABASE_SCHEMA']` —— 那没用：`settings` 是模块级
    # 缓存的单例，早在 import 期就按 .env 构造好了，进程内改 environ 影响不到它。
    # 结果是这个函数一直在 stamp **开发库**，测试库的 alembic_version 停在旧版本，
    # 而两个库都有那张表、看起来都正常，没有任何现象。
    # （对应地，`alembic/env.py` 改成「调用方设过就不覆盖」。）
    cfg = Config(str(BASE_PATH / 'alembic.ini'))
    cfg.set_main_option('script_location', str(BASE_PATH / 'alembic'))
    cfg.set_main_option(
        'sqlalchemy.url',
        get_database_url(unittest=True).render_as_string(hide_password=False).replace('%', '%%'),
    )
    command.stamp(cfg, 'head')
    print(f'已把 {get_database_url(unittest=True).database} 标记到迁移 head')


if __name__ == '__main__':
    try:
        asyncio.run(main())
        # 见 `_stamp_head` 的注释：它内部还会再起一个事件循环，只能在这里调
        _stamp_head()
    except cappa.Exit as e:
        # execute_sql_scripts 用 cappa.Exit 包报错（它继承 SystemExit，不是 Exception，
        # 下面那个 except 接不住）。它的 message 存在 e.message 上、不传给 SystemExit
        # 的 args —— 裸跑（不经过 cappa 的 CLI 入口）时默认异常处理只看得到 int 退出码，
        # 表现是「exit 1，一个字都不打印」，看着像挂了但完全不知道挂在哪。
        # 实测踩过：种子 SQL 里混进一行不合法语句，报错被这样吞得干干净净。
        print(f'重建失败：{e.message}', file=sys.stderr)
        sys.exit(1)
    except Exception as e:
        # 最常见的两种：库不存在（先手工 CREATE DATABASE）、容器没起来
        print(f'重建失败：{e}', file=sys.stderr)
        sys.exit(1)
