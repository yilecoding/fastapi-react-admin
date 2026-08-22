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


if __name__ == '__main__':
    try:
        asyncio.run(main())
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
