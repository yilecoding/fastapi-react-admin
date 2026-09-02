from collections.abc import AsyncGenerator

from sqlalchemy.engine import make_url
from sqlalchemy.ext.asyncio.session import AsyncSession

from backend.database.db import create_database_async_engine, create_database_async_session, get_database_url

# SALA 异步引擎和会话
async_test_engine = create_database_async_engine(get_database_url(unittest=True))
async_test_db_session = create_database_async_session(async_test_engine)


async def override_get_db() -> AsyncGenerator[AsyncSession, None]:
    """获取数据库会话"""
    async with async_test_db_session() as session:
        yield session


async def override_get_db_transaction() -> AsyncGenerator[AsyncSession, None]:
    """获取数据库会话"""
    async with async_test_db_session.begin() as session:
        yield session


def sync_test_db_url() -> str:
    """celery 结果后端那套**同步**驱动的 URL，指向测试库。

    🔴 **不要用字符串替换把 `/fba` 改成 `/fba_test`。** 原来五处测试都写的是
    `url.replace(f'/{SCHEMA}?', f'/{SCHEMA}_test?')` —— 它依赖库名后面紧跟一个
    `?`，而只有 SQL Server 的结果后端 URL 才有查询串（`?driver=ODBC+Driver+18…`）：

        sqlserver   db+mssql+pyodbc://…/fba?driver=…   ← 有 ?，替换成功
        postgresql  db+postgresql+psycopg://…/fba      ← 没有 ?，**替换静默失效**
        mysql       db+mysql+pymysql://…/fba           ← 同上

    失效的后果不是报错，是这些测试**连到开发库**上去跑：往 `fba` 里塞测试数据、
    再拿 `fba_test` 的结果去断言。实测（postgres 首次跑 pytest）：
    `test_prune_logs.py::test_deletes_old_keeps_new` 造的日志进了 `fba`，
    而清理任务（conftest 已把它指向测试库）在 `fba_test` 上删了 0 条，
    断言 `2 == 1` 失败 —— 报错信息完全不提数据库连错了这件事。

    改成让 SQLAlchemy 自己解析 URL 再换库名，和方言无关。
    """
    from backend.app.task.celery import get_result_backend
    from backend.core.conf import settings

    url = make_url(get_result_backend().removeprefix('db+'))
    return url.set(database=f'{settings.DATABASE_SCHEMA}_test').render_as_string(hide_password=False)
