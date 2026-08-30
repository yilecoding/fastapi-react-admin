import asyncio
import os

from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager

import socketio

from alembic.config import Config as AlembicConfig
from fastapi import Depends, FastAPI
from fastapi_pagination import add_pagination
from prometheus_client import make_asgi_app
from sqlalchemy import text
from starlette.datastructures import MutableHeaders
from starlette.middleware.authentication import AuthenticationMiddleware
from starlette.middleware.cors import CORSMiddleware
from starlette.responses import JSONResponse
from starlette.staticfiles import StaticFiles
from starlette.types import Receive, Scope, Send
from starlette_context.middleware import ContextMiddleware
from starlette_context.plugins import RequestIdPlugin

from backend import __version__
from backend.common.cache.pubsub import cache_pubsub_manager
from backend.common.exception.exception_handler import register_exception
from backend.common.lifespan import lifespan_manager
from backend.common.log import set_custom_logfile, setup_logging
from backend.common.observability.otel import init_otel
from backend.common.response.response_code import StandardResponseCode
from backend.core.conf import settings
from backend.core.path_conf import PUBLIC_UPLOAD_DIR, STATIC_DIR, UPLOAD_DIR
from backend.database.db import async_db_session, create_tables, dispose_database
from backend.database.redis import redis_client
from backend.middleware.access_middleware import AccessMiddleware
from backend.middleware.i18n_middleware import I18nMiddleware
from backend.middleware.jwt_auth_middleware import JwtAuthMiddleware
from backend.middleware.opera_log_middleware import OperaLogMiddleware
from backend.middleware.state_middleware import StateMiddleware
from backend.plugin.hooks import init_plugin_otel_hooks, register_plugin_hooks
from backend.plugin.router import build_final_router
from backend.utils.demo_mode import demo_site
from backend.utils.openapi import ensure_unique_route_names, simplify_operation_ids
from backend.utils.serializers import MsgSpecJSONResponse
from backend.utils.snowflake import snowflake
from backend.utils.trace_id import OtelTraceIdPlugin


async def _verify_production_database() -> None:
    """prod 启动前对数据库做两项检查，任一不过就拒绝启动

    **1. 迁移版本必须在 head。**

    prod 下**不建表**（见下面 `register_init` 里的分支）。`create_tables()`
    走的是 `metadata.create_all`，它只建不改：模型加了一列，已存在的表不会跟着变，
    表现是运行时一片 `Invalid column name`。更麻烦的是它会让「忘了跑迁移」
    伪装成「服务正常启动」，直到某个接口碰到那一列才炸。
    改成校验之后，同一个场景变成启动即失败 —— 硬纪律 9 说的「失败必须是可见状态」。

    **2. 不能有账号还在用种子密码。**

    `fba init` 收尾会强制改密，但那条路绕得开：直接拿 `backend/sql/**` 灌库、
    或者从测试环境 dump 一份过来，都不经过 init。这里按 hash 字面量比对兜底，
    无论库是怎么来的都拦得住（种子 hash 是固定盐，三个方言里同一个常量）。

    ⚠️ 只查 `SEEDED_PASSWORD_HASHES`（admin/test），**不查**
    `SEEDED_DEMO_PASSWORD_HASHES`（公开演示用的 8 个组织架构账号）——后者的密码
    设计上永远是 123456，查了就是拿自己的这条检查把自己的公开演示功能锁死。
    实测踩过：两份混在一起时，同步演示账号进库、下次重启 api 就直接崩溃重启。

    :return:
    """
    from alembic.script import ScriptDirectory
    from sqlalchemy import inspect, select, text

    from backend.app.admin.model import User
    from backend.app.admin.utils.password_security import SEEDED_PASSWORD_HASHES
    from backend.core.path_conf import BASE_PATH

    problems: list[str] = []

    async with async_db_session() as db:
        conn = await db.connection()
        has_version_table = await conn.run_sync(lambda c: inspect(c).has_table('alembic_version'))
        if not has_version_table:
            problems.append(
                '数据库里没有 alembic_version 表 —— 这个库是 create_all 建的但没 stamp。'
                '跑 `fba init`（会自动 stamp head），或对已有库 `alembic stamp <当前版本>` 后 `alembic upgrade head`'
            )
        else:
            stamped = {row[0] for row in (await conn.execute(text('SELECT version_num FROM alembic_version')))}
            config = AlembicConfig(str(BASE_PATH / 'alembic.ini'))
            config.set_main_option('script_location', str(BASE_PATH / 'alembic'))
            heads = set(ScriptDirectory.from_config(config).get_heads())
            if stamped != heads:
                problems.append(
                    f'数据库迁移版本 {sorted(stamped) or "（空）"} 不等于 head {sorted(heads)}'
                    ' —— 先跑 `alembic upgrade head`'
                )

        seeded = (
            (
                await db.execute(
                    select(User.username).where(User.password.in_(SEEDED_PASSWORD_HASHES), User.deleted == 0)
                )
            )
            .scalars()
            .all()
        )
        if seeded:
            problems.append(f'这些账号仍在使用种子数据里的默认密码（123456）：{sorted(seeded)} —— 改掉之后再启动')

    if problems:
        lines = '\n'.join(f'  {i}. {p}' for i, p in enumerate(problems, 1))
        raise RuntimeError(f'\n\n🔴 ENVIRONMENT=prod，数据库检查未通过，拒绝启动：\n{lines}\n')


@lifespan_manager.register
@asynccontextmanager
async def register_init(app: FastAPI) -> AsyncGenerator[None, None]:
    """
    启动初始化

    :param app: FastAPI 应用实例
    :return:
    """
    # 🔴 prod **不建表**。开发环境保留 create_all 的便利（改个模型重启就有表），
    # 生产环境唯一合法的建表途径是 alembic —— 见 _verify_production_database 的说明
    if settings.ENVIRONMENT == 'prod':
        await _verify_production_database()
    else:
        await create_tables()

    # 初始化 redis
    await redis_client.init()

    # 初始化 snowflake 节点
    if settings.SNOWFLAKE_ENABLED or settings.DATABASE_PK_MODE == 'snowflake':
        await snowflake.init()

    # 创建操作日志任务
    opera_log_task = asyncio.create_task(OperaLogMiddleware.consumer())

    # 启动缓存 Pub/Sub 监听器
    cache_pubsub_manager.start_listener()

    try:
        yield
    finally:
        # 停止缓存 Pub/Sub 监听器
        await cache_pubsub_manager.stop_listener()

        # 取消操作日志任务
        if not opera_log_task.done():
            opera_log_task.cancel()
            try:
                await opera_log_task
            except asyncio.CancelledError:
                pass

        # 释放 snowflake 节点
        if settings.SNOWFLAKE_ENABLED or settings.DATABASE_PK_MODE == 'snowflake':
            await snowflake.shutdown()

        # 关闭 redis 连接
        await redis_client.aclose()

        # 释放数据库连接池
        await dispose_database()


def register_app() -> FastAPI:
    """注册 FastAPI 应用"""

    app = FastAPI(
        title=settings.FASTAPI_TITLE,
        version=__version__,
        description=settings.FASTAPI_DESCRIPTION,
        docs_url=settings.FASTAPI_DOCS_URL,
        redoc_url=settings.FASTAPI_REDOC_URL,
        openapi_url=settings.FASTAPI_OPENAPI_URL,
        default_response_class=MsgSpecJSONResponse,
        lifespan=lifespan_manager.build(),
    )

    # 注册组件
    register_logger()
    register_socket_app(app)
    register_health(app)
    register_static_file(app)
    register_middleware(app)
    register_router(app)
    register_page(app)
    register_exception(app)

    # 注册插件钩子
    register_plugin_hooks(app)

    if settings.GRAFANA_METRICS_ENABLE:
        register_metrics(app)

    return app


def register_logger() -> None:
    """注册日志"""
    setup_logging()
    set_custom_logfile()


def register_health(app: FastAPI) -> None:
    """注册健康检查端点

    🔴 **路径必须在 `FASTAPI_API_V1_PATH` 之外。** `OperaLogMiddleware` 和
    `AccessMiddleware` 都按 `path.startswith(settings.FASTAPI_API_V1_PATH)` 决定
    要不要记录 —— 挂进 /api/v1 的话，每 15 秒一次的探针会把 sys_opera_log 刷爆。

    另外两条豁免是「不做什么」换来的：直接注册在 app 上（不走 `build_final_router`）
    就不带 `DependsJwtAuth` / `demo_site`；不加 `Depends(RateLimiter(...))` 就不受限流。
    两者都是 per-route 依赖，不挂就没有。

    :param app: FastAPI 应用实例
    :return:
    """

    @app.get('/health/live', include_in_schema=False)
    async def liveness() -> JSONResponse:
        """存活探针 —— 刻意不碰任何外部依赖

        探 DB 的话，数据库抖一下会让编排把**所有**副本一起 kill，
        把一次短暂的依赖故障放大成全站雪崩。存活只回答「进程还在不在」。
        """
        return JSONResponse({'status': 'alive'})

    @app.get('/health/ready', include_in_schema=False)
    async def readiness() -> JSONResponse:
        """就绪探针 —— 探 DB + Redis，决定能不能进流量"""
        checks: dict[str, str] = {}

        try:
            async with asyncio.timeout(5), async_db_session() as db:
                await db.execute(text('SELECT 1'))
            checks['database'] = 'ok'
        except Exception as e:
            checks['database'] = f'error: {type(e).__name__}'

        try:
            async with asyncio.timeout(3):
                await redis_client.ping()
            checks['redis'] = 'ok'
        except Exception as e:
            checks['redis'] = f'error: {type(e).__name__}'

        ready = all(v == 'ok' for v in checks.values())
        # 🔴 不能用 ResponseModel 那层信封 —— 它永远是 HTTP 200，
        # 而探针只看状态码，会把「DB 挂了」读成健康。
        # 这正是硬纪律 9 说的「请求失败必须是可见状态，不是缺失状态」。
        return JSONResponse(
            {'status': 'ready' if ready else 'degraded', 'checks': checks},
            status_code=200 if ready else 503,
        )


class _PublicUploadsStaticFiles(StaticFiles):
    """`/uploads` 公开子树的纵深防御：加 `X-Content-Type-Options` + 限制性 CSP

    (issue #56) SVG 已经在 `FileService.verify_public()` 里被挡在准入门槛外，
    这里不指望单一防线——万一以后有人往 `UPLOAD_IMAGE_EXT_INCLUDE` 加了别的
    可执行图片格式，`nosniff` 挡掉 MIME 嗅探绕过，`script-src 'none'` 让即便
    渗进来的文档也执行不了脚本。这棵子树只用来给 `<img src>` 加载，没有任何
    功能需要内联脚本/样式，所以这条 CSP 可以直接锁到最紧。
    """

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        async def send_wrapper(message: dict) -> None:
            if message['type'] == 'http.response.start':
                headers = MutableHeaders(raw=message['headers'])
                headers['X-Content-Type-Options'] = 'nosniff'
                headers['Content-Security-Policy'] = "default-src 'none'; sandbox"
            await send(message)

        await super().__call__(scope, receive, send_wrapper)


def register_static_file(app: FastAPI) -> None:
    """
    注册静态资源服务

    :param app: FastAPI 应用实例
    :return:
    """
    # 上传目录只保证存在，**不挂成静态资源**。
    #
    # 原来这里有 `app.mount('/static/upload', StaticFiles(...))`，是个**无鉴权**入口：
    # 知道文件名的任何人（不需要登录）都能读走上传物，随机后缀只是「不好猜」而不是访问控制。
    # 现在读文件统一走 `GET /api/v1/sys/files/{pk}/download`（带 JWT）。
    #
    # ⚠️ 光删这条 mount 是**不够**的：UPLOAD_DIR 原来在 STATIC_DIR 里面，
    # 下面那条 `/static` 挂载会把它连带公开（实测删了还是 200）。
    # 所以 UPLOAD_DIR 已经搬到 BASE_PATH / 'upload'，见 core/path_conf.py。
    if not os.path.exists(UPLOAD_DIR):
        os.makedirs(UPLOAD_DIR)

    # 公开上传目录**是**静态资源 —— 富文本正文里的内联图走这里。
    #
    # 为什么必须有一条无鉴权的读取路径：正文存的是 HTML，里面是 `<img src="…">`。
    # 裸 `<img src>` 带不上 Authorization 头（access token 走 HTTPBearer，
    # cookie 里只有 refresh token），所以走 `/{pk}/download` 只会拿到 401；
    # 而 blob URL 活不过一次刷新，存进 NVARCHAR(MAX) 就是死链。
    #
    # 和当初撤掉的 `/static/upload` 的区别在于**范围**：那条 mount 把整个
    # 上传目录（含别人的文档）公开了；这里公开的是一棵独立子树，
    # 只有显式 `?public=true` 且分类为图片的上传物才进得来。
    # 公告正文里的图本来就是给全体用户看的，暴露面基本等于零新增。
    #
    # 顺带白拿 StaticFiles 的 ETag / Last-Modified —— 同一张图重复浏览不重复传字节。
    if not os.path.exists(PUBLIC_UPLOAD_DIR):
        os.makedirs(PUBLIC_UPLOAD_DIR)
    app.mount('/uploads', _PublicUploadsStaticFiles(directory=PUBLIC_UPLOAD_DIR), name='uploads')

    # 固有静态资源
    if settings.FASTAPI_STATIC_FILES:
        app.mount('/static', StaticFiles(directory=STATIC_DIR), name='static')


def register_middleware(app: FastAPI) -> None:
    """
    注册中间件（执行顺序从下往上）

    :param app: FastAPI 应用实例
    :return:
    """
    # Opera log
    app.add_middleware(OperaLogMiddleware)

    # State
    app.add_middleware(StateMiddleware)

    # JWT auth
    app.add_middleware(
        AuthenticationMiddleware,
        backend=JwtAuthMiddleware(),
        on_error=JwtAuthMiddleware.auth_exception_handler,
    )

    # I18n
    app.add_middleware(I18nMiddleware)

    # Access log
    app.add_middleware(AccessMiddleware)

    # ContextVar
    plugins = [OtelTraceIdPlugin()] if settings.GRAFANA_METRICS_ENABLE else [RequestIdPlugin(validate=True)]
    app.add_middleware(
        ContextMiddleware,
        plugins=plugins,
        default_error_response=MsgSpecJSONResponse(
            content={'code': StandardResponseCode.HTTP_400, 'msg': 'BAD_REQUEST', 'data': None},
            status_code=StandardResponseCode.HTTP_400,
        ),
    )

    # CORS
    # https://github.com/fastapi-practices/fastapi-best-architecture/pull/789/changes
    # https://github.com/open-telemetry/opentelemetry-python-contrib/issues/4031
    if settings.MIDDLEWARE_CORS:
        app.add_middleware(
            CORSMiddleware,
            allow_origins=settings.CORS_ALLOWED_ORIGINS,
            allow_credentials=True,
            allow_methods=['*'],
            allow_headers=['*'],
            expose_headers=settings.CORS_EXPOSE_HEADERS,
        )


def register_router(app: FastAPI) -> None:
    """
    注册路由

    :param app: FastAPI 应用实例
    :return:
    """
    dependencies = [Depends(demo_site)] if settings.DEMO_MODE else None

    # API
    router = build_final_router()
    app.include_router(router, dependencies=dependencies)

    # Extra
    ensure_unique_route_names(app)
    simplify_operation_ids(app)


def register_page(app: FastAPI) -> None:
    """
    注册分页查询功能

    :param app: FastAPI 应用实例
    :return:
    """
    add_pagination(app)


def register_socket_app(app: FastAPI) -> None:
    """
    注册 Socket.IO 应用

    :param app: FastAPI 应用实例
    :return:
    """
    from backend.common.socketio.server import sio

    socket_app = socketio.ASGIApp(
        socketio_server=sio,
        other_asgi_app=app,
        # 切勿删除此配置：https://github.com/pyropy/fastapi-socketio/issues/51
        socketio_path='/ws/socket.io',
    )
    app.mount('/ws', socket_app)


def register_metrics(app: FastAPI) -> None:
    """
    注册指标

    :param app: FastAPI 应用实例
    :return:
    """
    metrics_app = make_asgi_app()
    app.mount(settings.GRAFANA_METRICS_PATH, metrics_app)

    init_otel(app)
    init_plugin_otel_hooks(app)
