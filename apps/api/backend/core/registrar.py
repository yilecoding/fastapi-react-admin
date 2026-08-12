import asyncio
import os

from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager

import socketio

from fastapi import Depends, FastAPI
from fastapi_pagination import add_pagination
from prometheus_client import make_asgi_app
from starlette.middleware.authentication import AuthenticationMiddleware
from starlette.middleware.cors import CORSMiddleware
from starlette.staticfiles import StaticFiles
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
from backend.database.db import create_tables, dispose_database
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


@lifespan_manager.register
@asynccontextmanager
async def register_init(app: FastAPI) -> AsyncGenerator[None, None]:
    """
    启动初始化

    :param app: FastAPI 应用实例
    :return:
    """
    # 创建数据库表
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
    app.mount('/uploads', StaticFiles(directory=PUBLIC_UPLOAD_DIR), name='uploads')

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
