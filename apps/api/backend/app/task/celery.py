"""Celery 实例。

与上游 `backend/app/task/celery.py` 的三处差异，都是 SQL Server 适配：

1. **result_backend 多一条 mssql 支路。** 上游只拼了 postgresql / mysql
   （`db+postgresql+psycopg://…`），SQL Server 会拿到一个连不上的 URL。
2. **走 `mssql+pyodbc`（同步驱动），不是 `aioodbc`。** celery 的
   DatabaseBackend 与 beat 的 DatabaseScheduler 都是**同步**代码，异步驱动喂不进去。
   `pyodbc` 不是新依赖 —— 它是 `aioodbc` 的依赖，venv 里本来就有（实测 5.3.0）。
3. **prod 不再劫持 broker。** 上游 `check_env()` 里有一行无条件把 prod 改成
   rabbitmq，已删；broker 一律以 `.env` 的 `CELERY_BROKER` 为准。
"""

import asyncio
import os
import urllib.parse

from pathlib import Path

import celery
import celery_aio_pool

from celery.signals import worker_process_init

from backend.common.enums import DataBaseType
from backend.core.conf import settings
from backend.core.path_conf import BASE_PATH


@worker_process_init.connect(weak=False)
def init_worker_runtime(*args, **kwargs) -> None:
    """worker 进程的启动初始化。

    🔴 **celery worker 不跑 FastAPI 的 lifespan**（`core/registrar.py` 里那段），
    所以 Redis 连接和雪花节点在 worker 里都是**未初始化**的。业务任务只要往
    自己的表里写一行就会炸：`ServerError: 雪花 ID 生成失败，雪花算法未初始化`。

    ⚠️ 更坑的是这个异常的**表现**：它发生在 SQLAlchemy 的 flush 里，被包成
    `StatementError`，而 celery_aio_pool 的错误处理路径遇到没有 `__traceback__`
    的异常会自己崩成 `'NoneType' object has no attribute 'tb_frame'` ——
    日志里最显眼的是那句 AttributeError，真因要往上翻十几行才看得到。实测踩过。

    这里只补「任务代码会用到的全局单例」，不碰 lifespan 里那些属于 web 进程的东西
    （操作日志消费者、缓存 Pub/Sub 监听器）—— 那些在 worker 里跑起来只会重复消费。
    """
    from backend.core.conf import settings as _settings
    from backend.database.redis import redis_client
    from backend.utils.snowflake import snowflake

    async def _init() -> None:
        await redis_client.init()
        if _settings.SNOWFLAKE_ENABLED or _settings.DATABASE_PK_MODE == 'snowflake':
            await snowflake.init()

    asyncio.run(_init())


def find_task_packages() -> list[str]:
    """扫出所有含 tasks.py 的包，交给 autodiscover

    🔴 **不能用字符串 `str.replace(prefix, '')` 去掉前缀** —— 它是全局替换，不是
    "剥前缀"。容器里 `BASE_PATH.parent` 是 `/app`（`Dockerfile.prod` 的
    `WORKDIR /app`），而业务代码本身有一层目录也叫 `app`（`backend/app/task/...`）。
    于是 `/app/backend/app/task/tasks/maintenance` 里 `/app/` 这个子串出现了
    **两次**——一次是路径开头要剥掉的前缀，另一次恰好是 `backend/app/task` 中间那段。
    全局替换把两处都吃掉，`backend` 和 `task` 中间的点被吞掉，autodiscover 收到的
    是 `backendtask.tasks.maintenance`，celery worker/beat 启动时
    `ModuleNotFoundError: No module named 'backendtask'`，整个进程崩溃重启。
    本机 `pnpm dev` 跑的是 uvicorn 直连源码（`BASE_PATH.parent` 是仓库路径，
    不叫 `app`），CI 的 pytest 同理，两边都摸不到这条路径——只有真的用
    Dockerfile.prod 构建的镜像跑 `celery worker` 才会炸，第一次是在生产环境
    的容器里实测踩到的。
    改用 `Path.relative_to()` 就是纯路径运算，不会误伤同名子串。
    """
    packages = []
    task_dir = BASE_PATH / 'app' / 'task' / 'tasks'
    for root, _dirs, files in os.walk(task_dir):
        if 'tasks.py' in files:
            relative = Path(root).relative_to(BASE_PATH.parent)
            packages.append('.'.join(relative.parts))
    return packages


def get_broker_url() -> str:
    """broker 连接串。选哪个由 `.env` 的 CELERY_BROKER 决定，代码不覆盖。"""
    if settings.CELERY_BROKER == 'redis':
        return (
            f'redis://:{urllib.parse.quote(settings.REDIS_PASSWORD)}'
            f'@{settings.REDIS_HOST}:{settings.REDIS_PORT}/{settings.CELERY_BROKER_REDIS_DATABASE}'
        )
    return (
        f'amqp://{settings.CELERY_RABBITMQ_USERNAME}:{urllib.parse.quote(settings.CELERY_RABBITMQ_PASSWORD)}'
        f'@{settings.CELERY_RABBITMQ_HOST}:{settings.CELERY_RABBITMQ_PORT}/{settings.CELERY_RABBITMQ_VHOST}'
    )


def get_result_backend() -> str:
    """
    结果后端 = 主库。执行记录页读的就是这里写下的 `task_result` 表。

    ⚠️ 这里是**同步**驱动，和应用主体的异步驱动是两套：
    mssql → pyodbc（不是 aioodbc）· postgresql → psycopg · mysql → pymysql。
    """
    user = settings.DATABASE_USER
    pwd = urllib.parse.quote_plus(settings.DATABASE_PASSWORD)
    host, port, db = settings.DATABASE_HOST, settings.DATABASE_PORT, settings.DATABASE_SCHEMA

    if DataBaseType.sqlserver == settings.DATABASE_TYPE:
        # driver 名里的空格必须编码，否则 SQLAlchemy 解析 query string 时会截断
        query = urllib.parse.urlencode({
            'driver': 'ODBC Driver 18 for SQL Server',
            'TrustServerCertificate': 'yes',
        })
        return f'db+mssql+pyodbc://{user}:{pwd}@{host}:{port}/{db}?{query}'
    if DataBaseType.mysql == settings.DATABASE_TYPE:
        return f'db+mysql+pymysql://{user}:{pwd}@{host}:{port}/{db}'
    return f'db+postgresql+psycopg://{user}:{pwd}@{host}:{port}/{db}'


def init_celery() -> celery.Celery:
    """初始化 Celery 应用"""
    # celery < 6.0 才需要这个补丁，让 `async def` 任务能被执行
    # https://github.com/celery/celery/issues/7874
    celery.app.trace.build_tracer = celery_aio_pool.build_async_tracer
    celery.app.trace.reset_worker_optimizations()

    app = celery.Celery(
        'fba_celery',
        broker_url=get_broker_url(),
        broker_connection_retry_on_startup=True,
        result_backend=get_result_backend(),
        result_extended=True,
        database_engine_options={'echo': settings.DATABASE_ECHO},
        # 🔴 **调度只有一个来源：`task_scheduler` 表。**
        # 刻意不配 `beat_schedule` —— `DatabaseScheduler.setup_schedule()` 只
        # SELECT 那张表，从不合并 `app.conf.beat_schedule`。曾经两边都配着，
        # 注释还写「静态项仍然生效」，实测是**死代码**：celery.conf 里躺着一条
        # 谁也不会执行的调度。新库的初始调度走种子 SQL（和菜单同一个路子），
        # 这样「在界面上删掉一条调度」不会被代码里的副本复活。
        beat_scheduler='backend.app.task.utils.schedulers:DatabaseScheduler',
        task_cls='backend.app.task.tasks.base:TaskBase',
        task_track_started=True,
        enable_utc=False,
        timezone=settings.DATETIME_TIMEZONE,
        worker_send_task_events=True,
        task_send_sent_event=True,
    )

    # celery 里设这个参数无效，只能改 loader
    # https://github.com/celery/celery/issues/7270
    app.loader.override_backends = {'db': 'backend.app.task.database:DatabaseBackend'}

    app.autodiscover_tasks(find_task_packages())
    return app


celery_app: celery.Celery = init_celery()
