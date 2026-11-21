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
import concurrent.futures
import os
import time
import urllib.parse

from pathlib import Path

import celery
import celery_aio_pool

from celery.signals import worker_process_init, worker_ready

from backend.common.enums import DataBaseType
from backend.core.conf import settings
from backend.core.path_conf import BASE_PATH
from backend.database.redis import get_redis_url

#: 默认队列（celery 自己的默认名）。心跳、通知投递、Webhook 投递、审批超时这些**短而准点**的任务都在这里
DEFAULT_QUEUE = 'celery'
#: 长任务队列：一次可能跑几分钟的任务单独排队，由**另一个** worker 消费（#400）
LONG_QUEUE = 'long'

#: 走长任务队列的任务（名字或 celery 认的通配）。
#:
#: 🔴 **为什么要拆**：`celery_aio_pool.AsyncIOPool` 是 solo 池的子类，`limit = 1`，`run()` 把协程投进循环后
#: **同步等它跑完**才取下一条 —— 一个 worker 进程一次只跑一个任务，`--concurrency` 不起作用。
#: 一次 AI 预审（300 秒）/ 一份大导出 / 首次 `prune_logs` 期间，同一个 worker 上的 `health.heartbeat` 排队超过
#: 180 秒，`/health/status` 报 worker stale；邮件、短信、Webhook 投递一起延迟。
#: 拆成两个队列、两个 worker，长任务再慢也只堵它自己那条队。
#:
#: 新加任务时问一句：**它会不会跑超过一分钟？** 会就加进来。
#: `app/task/tests/test_task_queues.py` 要求每个注册的任务都被归过类，漏了会红。
LONG_TASKS: tuple[str, ...] = (
    'export.run',
    'workflow.ai_review',
    'maintenance.*',
)

#: 长任务 worker 自己写的心跳间隔（秒）。阈值同其它心跳（`HEARTBEAT_MAX_AGE_SECONDS`），漏两拍都不报警
LONG_WORKER_HEARTBEAT_SECONDS = 30

# 挂在 worker 进程上的长任务心跳；留着引用，循环里的那个 asyncio 任务才不会被回收
_long_heartbeat: concurrent.futures.Future | None = None


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

    🔴 **雪花不在这里初始化**，挪到了下面的 `init_worker_snowflake`（#369）。这里是 `asyncio.run` 起的临时循环，
    `snowflake.init()` 在里面 `create_task` 起的节点心跳随循环一起被取消 —— 心跳不跑，本地租约期限停在启动后
    `SNOWFLAKE_NODE_TTL_SECONDS` 秒，之后所有发号都被拒。
    """
    from backend.database.redis import redis_client

    async def _init() -> None:
        await redis_client.init()
        # 🔴 走之前把连接池断开。这里是 `asyncio.run` 起的**临时**循环，ping 建的连接留在池里
        # 绑着它；任务跑在 AsyncIOPool 自己的循环里，拿到这条连接就
        # `got Future attached to a different loop` / `Event loop is closed`。
        # 坏连接被丢掉后第二次就好了，所以只表现为「每个 worker 进程第一个用 Redis 的任务必失败」
        # （见 app/task/AGENTS.md「补完要把 Redis 连接池断开」）
        await redis_client.connection_pool.disconnect()

    asyncio.run(_init())


def _needs_snowflake() -> bool:
    return settings.SNOWFLAKE_ENABLED or settings.DATABASE_PK_MODE == 'snowflake'


def pool_loop(sender: object = None) -> asyncio.AbstractEventLoop | None:
    """任务真正运行的那个事件循环（AsyncIOPool 在独立线程里 `run_forever()` 的那个）

    不是 AsyncIOPool / 循环没在转时返回 None。

    :param sender: `worker_ready` 传进来的 consumer（`sender.pool` 就是 AsyncIOPool）；不给就找单例
    """
    loop = getattr(getattr(sender, 'pool', None), 'loop', None)
    if loop is None:
        singleton = getattr(celery_aio_pool.AsyncIOPool, 'singleton', None)
        loop = getattr(singleton, 'loop', None)
    if loop is None or not loop.is_running():
        return None
    return loop


async def _long_queue_heartbeat() -> None:
    """长任务 worker 的心跳：每 `LONG_WORKER_HEARTBEAT_SECONDS` 秒往 Redis 写一次 epoch 秒

    🔴 **不能也靠 beat 派一个心跳任务进长任务队列**：那个任务要排在长任务后面，一次 AI 预审 300 秒就把它挡过阈值，
    「长任务 worker 正在忙」被报成「长任务 worker 死了」。这条队列上「忙」是常态，要证明的只是**进程活着、循环在转**
    —— 所以心跳挂在 worker 自己的循环上，和任务交替跑（任务都是 `async def`，不占住循环）。

    写失败只记日志、接着写：Redis 抖一下不能让心跳协程退出，否则之后永远报 stale。
    """
    from backend.common.log import log
    from backend.database.redis import redis_client

    while True:
        try:
            await redis_client.set(settings.LONG_WORKER_HEARTBEAT_REDIS_KEY, f'{time.time():.3f}')
        except Exception as e:
            log.warning(f'长任务 worker 心跳写入失败：{e!r}')
        await asyncio.sleep(LONG_WORKER_HEARTBEAT_SECONDS)


def consumed_queues(sender: object) -> set[str]:
    """这个 worker 在消费哪些队列（`-Q` 给的；不给就是默认队列）"""
    consumer = getattr(sender, 'task_consumer', None)
    queues = getattr(consumer, 'queues', None)
    if queues:
        return {q.name for q in queues}
    consume_from = getattr(getattr(getattr(sender, 'app', None), 'amqp', None), 'queues', None)
    consume_from = getattr(consume_from, 'consume_from', None)
    return set(consume_from) if consume_from else {DEFAULT_QUEUE}


@worker_ready.connect(weak=False)
def start_long_queue_heartbeat(sender=None, **kwargs) -> None:  # ruff:ignore[missing-type-function-argument]
    """消费长任务队列的 worker 起一个心跳（`/health/status` 的 `worker_long`，#400）

    不消费这条队列的 worker 不写 —— 否则只起了默认 worker、长任务没人消费时，心跳照样是绿的，
    导出 / AI 预审 / 日志清理**静默地永远不执行**，正是拆队列最怕的那种坏法。
    """
    global _long_heartbeat

    from backend.common.log import log

    if LONG_QUEUE not in consumed_queues(sender):
        return
    loop = pool_loop(sender)
    if loop is None:
        log.error('长任务 worker 心跳没起来：worker 不是 AsyncIOPool（--pool=custom），找不到任务运行的事件循环')
        return
    _long_heartbeat = asyncio.run_coroutine_threadsafe(_long_queue_heartbeat(), loop)


@worker_ready.connect(weak=False)
def init_worker_snowflake(sender=None, **kwargs) -> None:  # ruff:ignore[missing-type-function-argument]
    """在任务真正运行的那个事件循环里初始化雪花节点（#369）

    🔴 **必须是 AsyncIOPool 自己的循环。** 动态分配节点时 `snowflake.init()` 会起一个心跳任务续租；
    放在 `asyncio.run` 的临时循环里，循环一关心跳就被取消，启动 `SNOWFLAKE_NODE_TTL_SECONDS`（默认 60）
    秒后本地租约到期，worker 里所有带雪花主键的写入全报错 —— Webhook 投递记录写不进去，回收后**重复外发**。
    AsyncIOPool 的循环在独立线程里 `run_forever()`，挂在它上面的心跳活得和 worker 进程一样久。

    为什么挂 `worker_ready` 而不是 `worker_process_init`：后者是 `AsyncIOPool.__init__` 自己发的，
    发的时候 `self.loop` 还没建出来。`worker_ready` 在 consumer 开始处理消息**之前**同步发出（主线程），
    这里 `.result()` 等到初始化完成才返回，所以不会有任务抢在雪花就绪之前跑。

    :param sender: celery 传进来的 consumer，`sender.pool` 就是 AsyncIOPool
    """
    if not _needs_snowflake():
        return

    from backend.common.log import log
    from backend.utils.snowflake import snowflake

    loop = pool_loop(sender)
    if loop is None:
        # 不退回 asyncio.run —— 那正是 #369 的起法，60 秒后才坏，比现在就报错更难查
        log.error('雪花算法未初始化：worker 不是 AsyncIOPool（--pool=custom），找不到任务运行的事件循环')
        return

    try:
        asyncio.run_coroutine_threadsafe(snowflake.init(), loop).result(timeout=60)
    except Exception as e:
        # celery 的 Signal.send 会吞掉处理器里的异常，worker 照常起来 —— 只能靠这行日志
        log.error(f'worker 雪花算法初始化失败，带雪花主键的写入都会报错：{e!r}')


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


def _userinfo(value: str) -> str:
    """URL 里用户名 / 密码那一段的编码。

    🔴 必须 `safe=''`：裸 `quote()` 不编码 `/`，密码带 `/` 时整条 URL 解析错位（见
    `database/redis.py: get_redis_url`）。也不能用 `quote_plus`：它把空格编成 `+`，
    而 SQLAlchemy 解析 URL 时只做 `unquote`，实测密码 `pass word` 解析回来是 `pass+word`。
    """
    return urllib.parse.quote(value, safe='')


def get_broker_url() -> str:
    """broker 连接串。选哪个由 `.env` 的 CELERY_BROKER 决定，代码不覆盖。"""
    if settings.CELERY_BROKER == 'redis':
        return get_redis_url(database=settings.CELERY_BROKER_REDIS_DATABASE)
    return (
        f'amqp://{_userinfo(settings.CELERY_RABBITMQ_USERNAME)}:{_userinfo(settings.CELERY_RABBITMQ_PASSWORD)}'
        f'@{settings.CELERY_RABBITMQ_HOST}:{settings.CELERY_RABBITMQ_PORT}/{settings.CELERY_RABBITMQ_VHOST}'
    )


def get_result_backend() -> str:
    """
    结果后端 = 主库。执行记录页读的就是这里写下的 `task_result` 表。

    ⚠️ 这里是**同步**驱动，和应用主体的异步驱动是两套：
    mssql → pyodbc（不是 aioodbc）· postgresql → psycopg · mysql → pymysql。
    """
    user = _userinfo(settings.DATABASE_USER)
    pwd = _userinfo(settings.DATABASE_PASSWORD)
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
        task_default_queue=DEFAULT_QUEUE,
        # 按任务名分队列（#400，见 `LONG_TASKS`）。按名字配而不是写在 `@task(queue=...)` 上：
        # `send_task('export.run')` / beat / 「立即执行」都只拿得到名字，路由表三条路都认。
        # 调度那一行显式填了 `queue` 时以它为准（`send_task` 的 options 优先于路由表）
        task_routes={name: {'queue': LONG_QUEUE} for name in LONG_TASKS},
    )

    # celery 里设这个参数无效，只能改 loader
    # https://github.com/celery/celery/issues/7270
    app.loader.override_backends = {'db': 'backend.app.task.database:DatabaseBackend'}

    app.autodiscover_tasks(find_task_packages())
    return app


celery_app: celery.Celery = init_celery()
