import shutil

from functools import cache
from re import Pattern
from typing import Any, Literal

from pydantic import Field, model_validator
from pydantic_settings import BaseSettings, PydanticBaseSettingsSource, SettingsConfigDict

from backend.core.path_conf import ENV_EXAMPLE_FILE_PATH, ENV_FILE_PATH
from backend.plugin.settings_source import PluginSettingsSource


class Settings(BaseSettings):
    """全局配置"""

    model_config = SettingsConfigDict(
        env_file=ENV_FILE_PATH,
        env_file_encoding='utf-8',
        extra='allow',
        case_sensitive=True,
    )

    @classmethod
    def settings_customise_sources(
        cls,
        settings_cls: type[BaseSettings],
        init_settings: PydanticBaseSettingsSource,
        env_settings: PydanticBaseSettingsSource,
        dotenv_settings: PydanticBaseSettingsSource,
        file_secret_settings: PydanticBaseSettingsSource,
    ) -> tuple[PydanticBaseSettingsSource, ...]:
        """自定义配置源优先级"""
        return env_settings, dotenv_settings, PluginSettingsSource(settings_cls)

    # .env 当前环境
    ENVIRONMENT: Literal['dev', 'prod']

    # FastAPI
    FASTAPI_API_V1_PATH: str = '/api/v1'
    FASTAPI_TITLE: str = 'fba'
    FASTAPI_DESCRIPTION: str = 'FastAPI Best Architecture'
    FASTAPI_DOCS_URL: str = '/docs'
    FASTAPI_REDOC_URL: str = '/redoc'
    FASTAPI_OPENAPI_URL: str | None = '/openapi'
    FASTAPI_STATIC_FILES: bool = True

    # .env 数据库
    DATABASE_TYPE: Literal['mysql', 'postgresql', 'sqlserver']
    DATABASE_HOST: str
    DATABASE_PORT: int
    DATABASE_USER: str
    DATABASE_PASSWORD: str
    DATABASE_SOURCES: dict[str, str] = Field(default_factory=dict)

    # 数据库
    DATABASE_ECHO: bool | Literal['debug'] = False
    DATABASE_POOL_ECHO: bool | Literal['debug'] = False
    DATABASE_SCHEMA: str = 'fba'
    DATABASE_CHARSET: str = 'utf8mb4'
    DATABASE_PK_MODE: Literal['autoincrement', 'snowflake'] = 'autoincrement'
    # SQL Server 专用（宿主机需装 msodbcsql18）
    DATABASE_DRIVER: str = 'ODBC Driver 18 for SQL Server'
    DATABASE_TRUST_SERVER_CERTIFICATE: bool = True

    # .env Redis
    REDIS_HOST: str
    REDIS_PORT: int
    REDIS_PASSWORD: str
    REDIS_DATABASE: int

    # Redis
    REDIS_TIMEOUT: int = 5

    # 缓存
    CACHE_LOCAL_ENABLED: bool = True
    CACHE_LOCAL_MAXSIZE: int = 100000
    CACHE_LOCAL_TTL: int = 60 * 60 * 2  # 2 小时
    CACHE_REDIS_TTL: int = 60 * 60 * 2  # 2 小时
    CACHE_CONFIG_REDIS_PREFIX: str = 'fba:cache:config'
    CACHE_DICT_REDIS_PREFIX: str = 'fba:cache:dict'
    CACHE_PUBSUB_CHANNEL: str = 'fba:cache:invalidate'
    CACHE_PUBSUB_RECONNECT_DELAY: int = 5  # 重连延迟（秒）
    CACHE_PUBSUB_MAX_RECONNECT_ATTEMPTS: int = 10  # 最大重连次数

    # .env Snowflake
    SNOWFLAKE_ENABLED: bool = False
    SNOWFLAKE_DATACENTER_ID: int | None = None
    SNOWFLAKE_WORKER_ID: int | None = None

    # Snowflake
    SNOWFLAKE_REDIS_PREFIX: str = 'fba:snowflake'
    SNOWFLAKE_HEARTBEAT_INTERVAL_SECONDS: int = 30
    SNOWFLAKE_NODE_TTL_SECONDS: int = 60

    # .env Token
    TOKEN_SECRET_KEY: str  # 密钥 secrets.token_urlsafe(32)

    # Token
    TOKEN_ALGORITHM: str = 'HS256'
    TOKEN_EXPIRE_SECONDS: int = 60 * 60 * 24  # 1 天
    TOKEN_REFRESH_EXPIRE_SECONDS: int = 60 * 60 * 24 * 7  # 7 天
    TOKEN_REDIS_PREFIX: str = 'fba:token'
    TOKEN_EXTRA_INFO_REDIS_PREFIX: str = 'fba:token_extra_info'
    TOKEN_ONLINE_REDIS_PREFIX: str = 'fba:token_online'
    TOKEN_REFRESH_REDIS_PREFIX: str = 'fba:refresh_token'
    TOKEN_REQUEST_UNDERLYING_SECURITY: bool = True
    TOKEN_REQUEST_PATH_EXCLUDE: list[str] = [  # JWT / RBAC 路由白名单
        f'{FASTAPI_API_V1_PATH}/auth/login',
    ]
    TOKEN_REQUEST_PATH_EXCLUDE_PATTERN: list[Pattern[str]] = []  # JWT / RBAC 路由白名单（正则）

    # 用户安全
    USER_LOCK_REDIS_PREFIX: str = 'fba:user:lock'
    USER_LOCK_THRESHOLD: int = 5  # 用户密码错误锁定阈值，0 表示禁用锁定
    USER_LOCK_SECONDS: int = 60 * 5  # 5 分钟
    USER_PASSWORD_EXPIRY_DAYS: int = 365  # 用户密码有效期，0 表示永不过期
    USER_PASSWORD_REMINDER_DAYS: int = 7  # 用户密码到期提醒，0 表示不提醒
    USER_PASSWORD_HISTORY_CHECK_COUNT: int = 3
    USER_PASSWORD_MIN_LENGTH: int = 6
    USER_PASSWORD_MAX_LENGTH: int = 32
    USER_PASSWORD_REQUIRE_SPECIAL_CHAR: bool = False

    # 登录
    LOGIN_CAPTCHA_ENABLED: bool = True
    LOGIN_CAPTCHA_REDIS_PREFIX: str = 'fba:login:captcha'
    LOGIN_CAPTCHA_EXPIRE_SECONDS: int = 60 * 5  # 5 分钟
    LOGIN_FAILURE_PREFIX: str = 'fba:login:failure'

    # 🔴 按 **IP** 的跨账号登录失败计数 —— 上面那条按 user_id 计数挡不住密码喷洒。
    # 「200 个用户名各试 4 次」在阈值 5 之下，一次账号锁定都不会触发，
    # 而单账号锁定恰恰是攻击者要绕开的东西。这一层按来源 IP 补齐。
    # ⚠️ 依赖 `TRUSTED_PROXIES` 配对 —— IP 取错了这层计数一样会被绕过。
    LOGIN_IP_FAILURE_PREFIX: str = 'fba:login:failure:ip'
    LOGIN_IP_LOCK_THRESHOLD: int = 30  # 单 IP 跨账号失败阈值，0 表示禁用
    LOGIN_IP_LOCK_SECONDS: int = 60 * 15

    # JWT
    JWT_USER_REDIS_PREFIX: str = 'fba:user'

    # RBAC
    RBAC_ROLE_MENU_MODE: bool = True
    RBAC_ROLE_MENU_EXCLUDE: list[str] = []

    # Cookie
    COOKIE_REFRESH_TOKEN_KEY: str = 'fba_refresh_token'
    COOKIE_REFRESH_TOKEN_EXPIRE_SECONDS: int = 60 * 60 * 24 * 7  # 7 天

    # 数据权限
    DATA_PERMISSION_MODEL_EXCLUDE: list[str] = [  # 排除允许进行数据过滤的 SQLA 模型
        'DataScope',
        'DataRule',
        'sys_role_data_scope',
        'sys_data_scope_rule',
    ]
    DATA_PERMISSION_COLUMN_EXCLUDE: list[str] = [  # 排除允许进行数据过滤的 SQLA 模型列
        'id',
        'sort',
        'deleted',
        'deleted_time',
        'created_time',
        'updated_time',
    ]
    DATA_PERMISSION_MODEL_TEMPLATE_VARIABLES: list[dict[str, str]] = [  # 数据规则模型可用模板变量
        {'key': '__ALL__', 'comment': '所有模型'},
    ]
    DATA_PERMISSION_COLUMN_TEMPLATE_VARIABLES: list[dict[str, str]] = [  # 数据规则字段可用模板变量
        {'key': '__dept_id__', 'comment': '部门 ID'},
        {'key': '__created_by__', 'comment': '创建者'},
    ]
    DATA_PERMISSION_TEMPLATE_VARIABLES: list[dict[str, str]] = [  # 数据规则值可用模板变量
        {'key': '${user_id}', 'comment': '当前登录用户 ID'},
        {'key': '${dept_id}', 'comment': '当前登录用户部门 ID'},
        {'key': '${now}', 'comment': '当前时间'},
    ]

    # Socket.IO
    WS_NO_AUTH_MARKER: str = 'internal'

    # CORS
    CORS_ALLOWED_ORIGINS: list[str] = [  # 末尾不带斜杠
        'http://127.0.0.1',
        # 本项目前端 dev server（端口固定在 vite.config.ts 的 server.port）
        'http://127.0.0.1:1125',
        'http://localhost:1125',
    ]
    CORS_EXPOSE_HEADERS: list[str] = [
        'X-Request-ID',
    ]

    # 中间件配置
    MIDDLEWARE_CORS: bool = True

    # 请求限制配置
    REQUEST_LIMITER_REDIS_PREFIX: str = 'fba:limiter'

    # 限流总开关。**只给测试用** —— pytest 里同一个 IP 会在几秒内反复登录，
    # 不关掉的话 `/auth/login/swagger` 的 5次/分钟会把整套测试打成 429。
    # 🔴 prod 下置 false 会被 `check_production_settings()` 拒绝启动：
    # 关掉它等于同时废掉登录爆破和验证码刷取的**唯一**一道闸。
    REQUEST_LIMITER_ENABLED: bool = True

    # 🔴 可信反向代理白名单（IP 或 CIDR），**默认空 = 谁都不信**。
    #
    # 为空时 `get_request_ip()` 只认 `request.client.host`，完全忽略
    # `X-Real-IP` / `X-Forwarded-For`。这对直连场景是正确的，也是唯一安全的默认值：
    # 这两个头是**客户端可以随便填的**，而它们决定了限流的 key
    # （`utils/limiter.py: default_identifier` = `{IP}:{path}`）、登录日志里的来源
    # 和 IP 属地。信任未经验证的头 = 每个请求换一个 X-Real-IP 就是全新的限流配额，
    # 登录爆破、验证码刷取全部无损通过，而日志里的 IP 全是攻击者自己填的。
    #
    # 部署在 nginx / LB 后面时，填上代理自己的地址或网段才会开始采信：
    #     TRUSTED_PROXIES=["172.18.0.0/16"]
    # ⚠️ 同时要让 uvicorn 的 --forwarded-allow-ips 收到同样的范围。
    # 写 `*` 等于在更底一层把「谁都信」重新打开，这里的白名单就白配了。
    TRUSTED_PROXIES: list[str] = []

    # 时间配置
    DATETIME_TIMEZONE: str = 'Asia/Shanghai'
    DATETIME_FORMAT: str = '%Y-%m-%d %H:%M:%S'

    # 文件上传
    #
    # 每一类各自一份「扩展名白名单 + 大小上限」。原来只有图片和视频两类，
    # 且 else 分支直接 raise —— 于是 pdf/docx/xlsx 一律被判「此文件格式暂不支持」，
    # 附件预览最主力的几种格式一个都传不上来。
    #
    # ⚠️ 大小上限在应用层判已经晚了：Starlette 先把整个 body 收完才轮到校验
    # （见 utils/file_ops.py: upload_file_verify 的注释）。真要拦住超大请求
    # 得在反代 / 中间件层限 Content-Length，这里的值只是「业务上允许多大」。
    UPLOAD_READ_SIZE: int = 1024
    UPLOAD_IMAGE_EXT_INCLUDE: list[str] = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg', 'ico', 'avif']
    UPLOAD_IMAGE_SIZE_MAX: int = 5 * 1024 * 1024  # 5 MB
    UPLOAD_DOCUMENT_EXT_INCLUDE: list[str] = [
        'pdf',
        'doc',
        'docx',
        'xls',
        'xlsx',
        'ppt',
        'pptx',
        'txt',
        'md',
        'csv',
        'json',
        'xml',
        'log',
        'rtf',
    ]
    UPLOAD_DOCUMENT_SIZE_MAX: int = 50 * 1024 * 1024  # 50 MB
    UPLOAD_VIDEO_EXT_INCLUDE: list[str] = ['mp4', 'mov', 'avi', 'flv', 'webm', 'mkv']
    UPLOAD_VIDEO_SIZE_MAX: int = 20 * 1024 * 1024  # 20 MB
    UPLOAD_AUDIO_EXT_INCLUDE: list[str] = ['mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac']
    UPLOAD_AUDIO_SIZE_MAX: int = 20 * 1024 * 1024  # 20 MB
    UPLOAD_ARCHIVE_EXT_INCLUDE: list[str] = ['zip', 'rar', '7z', 'tar', 'gz']
    UPLOAD_ARCHIVE_SIZE_MAX: int = 100 * 1024 * 1024  # 100 MB

    # 演示模式配置
    DEMO_MODE: bool = False
    DEMO_MODE_EXCLUDE: set[tuple[str, str]] = {
        ('POST', f'{FASTAPI_API_V1_PATH}/auth/login'),
        ('POST', f'{FASTAPI_API_V1_PATH}/auth/logout'),
        ('GET', f'{FASTAPI_API_V1_PATH}/auth/captcha'),
        ('POST', f'{FASTAPI_API_V1_PATH}/auth/refresh'),
    }

    # IP 定位配置
    IP_LOCATION_PARSE: Literal['online', 'offline', 'false'] = 'offline'
    IP_LOCATION_REDIS_PREFIX: str = 'fba:ip:location'
    IP_LOCATION_EXPIRE_SECONDS: int = 60 * 60 * 24  # 1 天

    # Trace ID
    TRACE_ID_REQUEST_HEADER_KEY: str = 'X-Request-ID'
    TRACE_ID_LOG_LENGTH: int = 32  # UUID 长度，必须小于等于 32
    TRACE_ID_LOG_DEFAULT_VALUE: str = '-'

    # 日志
    LOG_FORMAT: str = (
        '<green>{time:YYYY-MM-DD HH:mm:ss.SSS}</> | <lvl>{level: <8}</> | <cyan>{request_id}</> | <lvl>{message}</>'
    )

    # 日志（控制台）
    LOG_STD_LEVEL: str = 'INFO'

    # 日志（文件）
    LOG_FILE_ACCESS_LEVEL: str = 'INFO'
    LOG_FILE_ERROR_LEVEL: str = 'ERROR'
    LOG_ACCESS_FILENAME: str = 'fba_access.log'
    LOG_ERROR_FILENAME: str = 'fba_error.log'

    # 操作日志
    OPERA_LOG_PATH_EXCLUDE: list[str] = [
        '/favicon.ico',
        '/docs',
        '/redoc',
        '/openapi',
        f'{FASTAPI_API_V1_PATH}/auth/login/swagger',
        f'{FASTAPI_API_V1_PATH}/oauth2/github/callback',
        f'{FASTAPI_API_V1_PATH}/oauth2/google/callback',
    ]
    OPERA_LOG_REDACT_KEYS: list[str] = [
        'password',
        'old_password',
        'new_password',
        'confirm_password',
    ]
    OPERA_LOG_QUEUE_MAXSIZE: int = 100000
    OPERA_LOG_QUEUE_BATCH_CONSUME_SIZE: int = 100
    OPERA_LOG_QUEUE_TIMEOUT: int = 60  # 1 分钟
    OPERA_LOG_BODY_MAX_SIZE: int = 10240  # 10 KB
    # 响应体记录：只记 JSON 类响应，超限截断（避免把文件下载/大列表灌进日志表）
    OPERA_LOG_RESPONSE_MAX_SIZE: int = 10240  # 10 KB
    OPERA_LOG_RESPONSE_CONTENT_TYPES: list[str] = ['application/json', 'text/plain']
    # 这些请求头会被打码 —— 它们要么是凭据，要么含会话信息
    OPERA_LOG_REDACT_HEADERS: list[str] = [
        'authorization',
        'cookie',
        'set-cookie',
        'proxy-authorization',
        'x-api-key',
        'x-auth-token',
    ]

    # Plugin 配置
    PLUGIN_REQUIRED: list[str] = ['dict']
    PLUGIN_PIP_CHINA: bool = True
    PLUGIN_PIP_INDEX_URL: str = 'https://mirrors.aliyun.com/pypi/simple/'
    PLUGIN_PIP_MAX_RETRY: int = 3
    PLUGIN_REDIS_PREFIX: str = 'fba:plugin'

    # I18n 配置
    I18N_DEFAULT_LANGUAGE: str = 'zh-CN'

    # Grafana
    GRAFANA_METRICS_ENABLE: bool = False
    GRAFANA_OTLP_GRPC_ENDPOINT: str = 'fba_alloy:4317'
    # 以下配置为静态定义，修改后需要手动同步相关 Grafana 配置：
    # - GRAFANA_PROMETHEUS_APP_NAME：deploy/backend/grafana/fba_datasource.yml
    #   deploy/backend/grafana/dashboards/fba_server.json
    # - GRAFANA_CELERY_OTEL_SERVICE_NAME：deploy/backend/grafana/dashboards/fba_celery.json
    # - GRAFANA_METRICS_PATH：deploy/backend/grafana/fba_config.alloy
    #   deploy/backend/grafana/dashboards/fba_server.json
    # - GRAFANA_PROMETHEUS_EXEMPLAR_TRACE_ID_KEY：deploy/backend/grafana/fba_datasource.yml
    GRAFANA_PROMETHEUS_APP_NAME: str = 'fba_server'
    GRAFANA_CELERY_OTEL_SERVICE_NAME: str = 'fba_celery_worker'
    GRAFANA_METRICS_PATH: str = '/metrics'
    GRAFANA_PROMETHEUS_EXEMPLAR_TRACE_ID_KEY: str = 'TraceID'

    ##################################################
    # [ App ] task
    ##################################################
    # .env Redis
    CELERY_BROKER_REDIS_DATABASE: int = 1

    # .env RabbitMQ
    # docker run -d --hostname fba-mq --name fba-mq  -p 5672:5672 -p 15672:15672 rabbitmq:latest
    CELERY_RABBITMQ_HOST: str = '127.0.0.1'
    CELERY_RABBITMQ_PORT: int = 5672
    CELERY_RABBITMQ_USERNAME: str = 'guest'
    CELERY_RABBITMQ_PASSWORD: str = 'guest'

    # 基础配置
    #
    # 🔴 CELERY_BROKER 是决定 broker 的**唯一**地方，任何环境都以 .env 为准。
    # 上游在 check_env() 里有一行 prod 无条件改成 'rabbitmq'，已经删掉 ——
    # 那行不看 .env，失败方式是「本地跑得好好的，一上生产 worker 连一个
    # 5672 端口上根本不存在的服务」，而你的 .env 里明明写着 redis。
    # 要用 RabbitMQ 就在 .env 里写，并起服务：
    #   docker compose -f docker-compose.dev.yml --profile rabbitmq up -d
    CELERY_BROKER: Literal['rabbitmq', 'redis'] = 'redis'
    CELERY_RABBITMQ_VHOST: str = ''
    CELERY_REDIS_PREFIX: str = 'fba:celery'
    CELERY_TASK_MAX_RETRIES: int = 5

    ##################################################
    # [ Plugin ] oauth2
    ##################################################
    # .env
    OAUTH2_GITHUB_CLIENT_ID: str
    OAUTH2_GITHUB_CLIENT_SECRET: str
    OAUTH2_GOOGLE_CLIENT_ID: str
    OAUTH2_GOOGLE_CLIENT_SECRET: str

    # 基础配置（in plugin.toml）
    OAUTH2_STATE_REDIS_PREFIX: str
    OAUTH2_STATE_EXPIRE_SECONDS: int
    OAUTH2_GITHUB_REDIRECT_URI: str
    OAUTH2_GOOGLE_REDIRECT_URI: str
    OAUTH2_FRONTEND_LOGIN_REDIRECT_URI: str
    OAUTH2_FRONTEND_BINDING_REDIRECT_URI: str

    ##################################################
    # [ Plugin ] email
    ##################################################
    # .env
    EMAIL_USERNAME: str
    EMAIL_PASSWORD: str

    # 基础配置（in plugin.toml）
    EMAIL_HOST: str
    EMAIL_PORT: int
    EMAIL_SSL: bool
    EMAIL_CAPTCHA_REDIS_PREFIX: str
    EMAIL_CAPTCHA_EXPIRE_SECONDS: int

    @model_validator(mode='before')
    @classmethod
    def check_env(cls, values: Any) -> Any:
        """检查环境变量"""
        if values.get('ENVIRONMENT') == 'prod':
            # FastAPI
            values['FASTAPI_OPENAPI_URL'] = None
            values['FASTAPI_STATIC_FILES'] = False

            # Grafana
            values['GRAFANA_METRICS_ENABLE'] = True

        return values


@cache
def get_settings() -> Settings:
    """获取全局配置单例"""
    if not ENV_FILE_PATH.exists():
        shutil.copy(ENV_EXAMPLE_FILE_PATH, ENV_FILE_PATH)
    return Settings()


# 创建全局配置实例
settings = get_settings()
