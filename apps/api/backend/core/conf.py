import math
import os
import shutil

from collections import Counter
from functools import cache
from pathlib import Path
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
    # access token 的有效期。撤销不靠它（每个请求都核对 Redis 里的会话还在不在），
    # 它只限定「一枚泄漏出去的 access token 能用多久」。会话本身活多久见下面的 SESSION_*
    TOKEN_EXPIRE_SECONDS: int = 60 * 30  # 30 分钟
    TOKEN_ONLINE_REDIS_PREFIX: str = 'fba:token_online'  # socket 在线状态（按会话 ID）
    TOKEN_REQUEST_UNDERLYING_SECURITY: bool = True
    TOKEN_REQUEST_PATH_EXCLUDE: list[str] = [  # JWT / RBAC 路由白名单
        f'{FASTAPI_API_V1_PATH}/auth/login',
        # ⚠️ **不要**把 `/auth/logout` 加进来。曾经加过，为的是让「access token 已过期
        # 时点登出」不被中间件 401 挡住 —— 但代价是 `request.user` 在这条路由上变成
        # 未认证，`opera_log_middleware` 的 `request.user.username` 走 AttributeError
        # 分支，**每一次登出的操作日志都记不下用户名**（那张表本来就是审计用的）。
        # 而它买到的只有那一种情况，且前端的 401 → 单飞刷新 → 重放已经覆盖了：
        # 刷新会换掉 refresh token 的 secret，会话本身的撤销走 `session_store`（#138）。
        # 只带 cookie、不带 Authorization 的请求（桌面端）本来就过得了中间件 ——
        # `extract_token()` 没有 Authorization 头时返回 None，是「未认证」不是「认证失败」。
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

    # 登录会话（#138）—— 存储与规则见 `common/security/session.py`
    SESSION_REDIS_PREFIX: str = 'fba:session'  # 一个会话一个 hash
    SESSION_USER_INDEX_PREFIX: str = 'fba:session_user'  # 每个用户的会话（ZSET，分值 = 最后活跃）
    SESSION_ALL_INDEX_KEY: str = 'fba:session_all'  # 全站会话（在线用户页读它）
    SESSION_END_REDIS_PREFIX: str = 'fba:session_end'  # 会话为什么结束（被踢 / 空闲 / …）
    SESSION_END_REASON_TTL_SECONDS: int = 60 * 60 * 24  # 原因留多久；会话过期后也多留这么久，好报出准确原因
    # 同一枚 refresh token 在这段时间里再出示一次 → 回放同一组新令牌（多标签页同时刷新、弱网重试）；
    # 过了这段时间再出示 → 判盗用、撤销会话。🔴 不能短于客户端刷新请求的超时（前端是 10 秒）
    SESSION_REFRESH_GRACE_SECONDS: int = 30
    SESSION_ACTIVITY_WRITE_SECONDS: int = 60  # 最后活跃时间最多多久写一次 Redis
    SESSION_SWAGGER_SECONDS: int = 60 * 60 * 24  # swagger 调试口（非 prod）的会话：只有 access，不续期
    # 按端的策略。端是固定枚举（web / desktop / mobile），登录时客户端自报 ——
    # 只用来选下面这组时长和上限，不决定任何安全相关的行为。参数配置「会话策略」组会在运行时覆盖
    SESSION_WEB_IDLE_MINUTES: int = 120
    SESSION_WEB_ABSOLUTE_DAYS: int = 7
    SESSION_WEB_MAX: int = 0  # 0 = 不限
    SESSION_WEB_OVERFLOW: str = 'evict_idle'  # 超限时：evict_idle 挤掉最久没活跃的 / deny 拒绝新登录
    SESSION_DESKTOP_IDLE_MINUTES: int = 120
    SESSION_DESKTOP_ABSOLUTE_DAYS: int = 7
    SESSION_DESKTOP_MAX: int = 0
    SESSION_DESKTOP_OVERFLOW: str = 'evict_idle'
    SESSION_MOBILE_IDLE_MINUTES: int = 60 * 24 * 30
    SESSION_MOBILE_ABSOLUTE_DAYS: int = 90
    SESSION_MOBILE_MAX: int = 1
    SESSION_MOBILE_OVERFLOW: str = 'evict_idle'

    # Cookie
    COOKIE_REFRESH_TOKEN_KEY: str = 'fba_refresh_token'
    # 只在这个路径下发回来：refresh token 不该随每个 API 请求一起飞。
    # 用到它的只有登录 / 刷新 / 登出（oauth2 回调是在别的路径上**设置**它，设置不受 Path 限制）
    COOKIE_REFRESH_TOKEN_PATH: str = f'{FASTAPI_API_V1_PATH}/auth'
    # None = 跟着请求走：HTTPS 请求下发 Secure cookie，HTTP 不带。
    # 写死 True 的话，没上 HTTPS 的部署里浏览器直接不存这个 cookie —— 每 30 分钟被登出一次，日志里什么都没有
    COOKIE_SECURE: bool | None = None

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
        'http://127.0.0.1:8888',
        'http://localhost:8888',
        # 🔴 桌面端（apps/desktop）的渲染层跑在自定义协议 `app://local` 上，
        # 对后端就是跨源。漏了这条的表现是「桌面端装好了、页面也出来了，
        # 但所有接口 CORS 失败」—— 和后端挂了长得一样。
        # 它不含 localhost / 127.0.0.1，所以不会被 conf.py 末尾那条生产环境检查判成本地来源。
        'app://local',
    ]
    CORS_EXPOSE_HEADERS: list[str] = [
        'X-Request-ID',
        # 下载的文件名在这个头里（导出文件、导入模板、错误报告都是后端按当前语言起的名）。
        # 前后端跨源时（开发期 8888 → 8088、桌面端 app://local）不列在这里，前端 JS 读到的是 null，
        # 只能退回一个写死的名字 —— 和后端那份翻译各说各的
        'Content-Disposition',
        # 限流 429 的「多少秒后再试」。跨源时不列在这里，前端读到的是 null，只能说一个猜的秒数
        'Retry-After',
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

    # 回收站（#122 第二期）：删除的文件在回收站里留几天，到期由 `maintenance.purge_recycled_files` 彻底删除。
    # 0 = 不启用回收站，删除即彻底删除（对象一并删掉，和第二期之前一样）。
    # 只有这一个真相源：清理任务、回收站列表上的「剩余 N 天」、删除确认框的文案都读它
    FILE_RECYCLE_DAYS: int = 30

    # 分片上传（#122 第三期）：不小于 FILE_CHUNK_THRESHOLD 的文件，前端切成 FILE_CHUNK_SIZE 一片地传，可续传。
    # 两个值由 `GET /sys/files/upload-policy` 下发给前端，前端不写死。
    # 🔴 参数配置页「文件上传」组（sys_config 的 FILE 组，#139）会**覆盖**这里：组开着且有那一行时库值生效，
    # 这里只是默认值。⚠️ 库里按 **MiB** 存（界面上填 8），这里是**字节** —— 别把库里的数抄进 .env。
    # 范围（每片 1–64 MiB、阈值 1–99 MiB，阈值要小于 nginx 的 client_max_body_size）见 dynamic_config.DYNAMIC_INT_BOUNDS
    # 会话在 Redis 里 FILE_MULTIPART_EXPIRE_SECONDS 没动静就过期（每传一片续一次），
    # 过期会话留下的分片由 `maintenance.purge_stale_multipart` 清掉
    FILE_CHUNK_SIZE: int = 8 * 1024 * 1024  # 8 MiB
    FILE_CHUNK_THRESHOLD: int = 16 * 1024 * 1024  # 16 MiB
    FILE_MULTIPART_EXPIRE_SECONDS: int = 24 * 3600
    FILE_MULTIPART_REDIS_PREFIX: str = 'fba:file:multipart'

    # 存储（本地 + S3 兼容，见 utils/storage_ops.py 与 sys_storage）
    #
    # 对象存储的 SecretKey 落库前用它加密（64 位十六进制）。🔴 留空 = 拒绝保存 S3 存储，
    # 不会静默存明文 —— 同 AI_ENCRYPT_SECRET_KEY / OPEN_SECRET_KEY 的 fail-closed 约定。
    # 生成：python -c "import os;print(os.urandom(32).hex())"
    STORAGE_ENCRYPT_SECRET_KEY: str = ''
    # 预签名下载地址的有效期（秒）。预签名 URL 签出去就**撤不回来**，谁拿到都能下，所以宜短
    STORAGE_PRESIGN_EXPIRE_SECONDS: int = 300

    # 表格导入（解析层见 utils/excel_ops.py）
    #
    # 刻意**不复用** UPLOAD_DOCUMENT_SIZE_MAX 那 50 MB：那是「存档一份文档」的
    # 上限，而导入表格是要被整份读进内存解析的，量级完全不同。
    #
    # 🔴 `UNCOMPRESSED` 那条是独立的一道闸门，不是上一条的换算。xlsx 是 zip，
    # 实测一个 199 KB 的上传能声明出 200 MB 的解压体积 —— 只看上传大小完全无感
    TABLE_IMPORT_SIZE_MAX: int = 5 * 1024 * 1024  # 5 MB
    TABLE_IMPORT_UNCOMPRESSED_MAX: int = 100 * 1024 * 1024  # 100 MB
    # zip 里最多多少个条目。正常 xlsx 是几十个，见 `excel_ops._verify_archive`
    TABLE_IMPORT_MAX_ENTRIES: int = 1000
    TABLE_IMPORT_MAX_ROWS: int = 1000

    # 用户批量导入
    #
    # 🔴 **默认密码放这里而不是 sys_config**（参数配置插件那张表）。那张表的值
    # 会**原样显示在参数配置页**上，而且 `PUT /sys/configs` 的请求体会进操作日志
    # （`value` 不在 `OPERA_LOG_REDACT_KEYS` 里）—— 放进去等于同时在两个地方公开它。
    #
    # 🔴 **空串 = 关掉导入功能**，不是「用某个内置默认值」。没有一个内置值是安全的：
    # 它会跟着仓库一起公开，而每套部署都会照抄。
    #
    # ⚠️ 这个值**自己必须过 `validate_password_strength()`** —— 比如 `123456`
    # 就过不了（`is_has_letter` 那条）。不校验的表现是**延迟且分裂的**：导入成功、
    # 用户拿默认密码能登录，但他自己去改密码时被「必须含字母」挡住，
    # 而这两件事看不出是同一个原因。导入接口每次都现校验一遍
    USER_IMPORT_DEFAULT_PASSWORD: str = ''

    # 导入（#11 · v0.4，`common/dataio/importing.py` + `app/admin/service/import_service.py`）
    # 预览把结果存 Redis、换一个一次性令牌；提交凭令牌取回。错误报告挂在同一个令牌上，提交之后还能下
    IMPORT_REDIS_PREFIX: str = 'fba:import'
    IMPORT_EXPIRE_SECONDS: int = 60 * 30  # 30 分钟

    # 导出（#11 · v0.4，`common/dataio/` + `app/admin/service/export_service.py`）
    #
    # 行数不超过 SYNC 的在请求里当场生成，点完就下载；超过的进 Celery，生成完发站内消息。
    # **两条路都落一条导出记录**（`sys_export_job`），文件只有发起人自己能下载
    EXPORT_SYNC_MAX_ROWS: int = 5000
    # 单次上限。超过直接拒绝并说清楚「共 N 条，超过上限」—— 不静默截断（原来前端拼 CSV
    # 到 4000 条就悄悄停了，文件照常下载）
    EXPORT_MAX_ROWS: int = 200_000
    # keyset 分批取数，一批多少行
    EXPORT_BATCH_SIZE: int = 1000
    # 文件保留多久。到期由 `maintenance.purge_expired_exports` 删掉文件、记录改成「已过期」
    EXPORT_FILE_RETENTION_HOURS: int = 72
    # 记录（不是文件）保留多久。过了连记录一起删 —— 谁导过什么，操作日志里另有一份
    EXPORT_RECORD_RETENTION_DAYS: int = 90
    # 同一个人同时「排队 / 生成中」的导出上限。导出是全表扫 + 写文件，没有上限就是一个拒绝服务入口
    EXPORT_MAX_CONCURRENT_PER_USER: int = 3

    # 演示模式配置（上游 FBA 自带：只读锁定，非 GET 请求一律 403）。
    # 🔴 与 ENVIRONMENT=prod 互斥（见 check_production_settings），只适合
    # ENVIRONMENT=dev 的「看不能动」式静态演示。
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
        # MCP 凭据新建 / 重新生成时的明文令牌（`plugin/ai/schema/mcp_client.py: IssuedAiMcpToken`）。
        # 不进名单的话操作日志会把它原样落进 response_body —— 永久、且日志表有自己的查看权限
        'mcp_token',
        # 能力开放应用新建 / 重置密钥时的明文 SK（`plugin/open/schema/app.py: IssuedOpenSecret`），同上
        'secret_key',
        # 短信配置新建 / 编辑时的厂商凭据 secret（`plugin/sms/schema/config.py`），按键名精确匹配
        'access_key_secret',
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
    # 🔴 celery 标准的 task_time_limit/task_soft_time_limit 对这个 worker pool
    # 是 no-op——celery_aio_pool.AsyncIOPool 靠 asyncio.run_coroutine_threadsafe(...)
    # .result() 无限等待，没有实现任何超时/信号机制（源码里搜不到 time_limit/
    # soft_time_limit/alarm）。真正的超时保护在 tasks/base.py 的 with_timeout()
    # 装饰器里用 asyncio.wait_for() 补，这个值就是喂给它的默认秒数
    CELERY_TASK_TIME_LIMIT: int = 1800

    # 后台进程心跳，`/health/status` 读这两个键（见 core/registrar.py）。值是 epoch 秒：
    #   scheduler —— beat 的调度循环每一拍写（`utils/schedulers.py: DatabaseScheduler.tick`），最长 60 秒一拍
    #   worker    —— 执行 `health.heartbeat`（beat 每 60 秒派一次）时写
    # 阈值 = 3 个周期：漏一两拍（重启、发版换容器）不报警，连续三拍没有才判死
    SCHEDULER_HEARTBEAT_REDIS_KEY: str = 'fba:health:scheduler_heartbeat'
    WORKER_HEARTBEAT_REDIS_KEY: str = 'fba:health:worker_heartbeat'
    HEARTBEAT_MAX_AGE_SECONDS: int = 180

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
    # [ Plugin ] workflow
    ##################################################
    # AI 自动同意的总闸（#111 第 5 条）。关掉 = 所有流程的 AI 自动同意立刻停（要重启）；
    # 开着也只是「允许」：节点要自己开、而且这个流程 × 模型的数据够了才会真的替人同意
    WORKFLOW_AI_APPROVE_ENABLED: bool = True

    ##################################################
    # [ Plugin ] ai
    ##################################################
    # 基础配置（in plugin.toml）
    AI_AGENT_ENGINE: str
    AI_MAX_TOOL_ROUNDS: int
    AI_TOOL_DOMAINS: list[str]
    AI_CONFIRM_MUTATING_TOOLS: bool
    AI_CONFIRM_TOKEN_EXPIRE_SECONDS: int
    AI_CONFIRM_REDIS_PREFIX: str
    AI_EXTERNAL_HTTP_TIMEOUT: int
    AI_EXTERNAL_HTTP_USE_PROXY: bool
    # 模型密钥的落库加密密钥（64 位十六进制）。留空 = 拒绝保存密钥，不会静默存明文
    AI_ENCRYPT_SECRET_KEY: str
    # MCP 网关：外部系统以「M2M 凭据 + 声明的代理用户」调只读工具（见 plugin/ai/AGENTS.md）
    AI_MCP_ENABLED: bool
    # 每份凭据每分钟最多多少次请求（凭据里的 rate_per_minute 可单独覆盖）
    AI_MCP_RATE_PER_MINUTE: int
    # 网页对话每人每分钟最多发多少句（每句都是一次或几次计费的模型请求）
    AI_CHAT_RATE_PER_MINUTE: int
    # 前端的访问地址：MCP 发起的写操作要拼一个「回网页确认」的链接
    AI_WEB_BASE_URL: str

    ##################################################
    # [ Plugin ] open
    ##################################################
    # 🔴 这几项必须在这里声明成字段：只写在 plugin.toml 里的话它们是 extra，**进程环境变量覆盖不了**
    # （env_settings 只认声明过的字段）—— 部署时用容器环境变量配 OPEN_SECRET_KEY 会被静默忽略。
    # 基础配置（in plugin.toml）
    # SK 落库的加密密钥（64 位十六进制）。留空 = 拒绝新建 / 重置密钥，不会静默存明文
    OPEN_SECRET_KEY: str
    OPEN_RATE_PER_MINUTE: int
    OPEN_SIGN_WINDOW_SECONDS: int
    OPEN_NONCE_REDIS_PREFIX: str
    OPEN_LAST_USED_REDIS_PREFIX: str

    ##################################################
    # [ Plugin ] sms
    ##################################################
    # 🔴 同 open：只写在 plugin.toml 里的配置是 extra，容器环境变量覆盖不了，必须在这里声明成字段
    # 基础配置（in plugin.toml）
    # 凭据 secret 的落库加密密钥（64 位十六进制）。留空 = 拒绝保存带凭据的配置，不会静默存明文
    SMS_ENCRYPT_SECRET_KEY: str
    # 全站每小时发送上限（0 = 不限），防使用方写错循环把余额刷光
    SMS_GLOBAL_HOURLY_MAX: int
    # 「发送中」停留超过多少秒算「结果未知」（进程在两步式日志之间崩溃）
    SMS_SENDING_STALE_SECONDS: int
    SMS_REDIS_PREFIX: str

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


class ProductionConfigError(RuntimeError):
    """prod 环境配置不合格 —— 启动阻断，不降级也不只是告警"""


# 已知的占位 / 示例值。全部来自本仓库的 .env*.example、cli.py 的交互默认值、
# 以及 deploy 目录里那份编排配置。任何一个原样出现在 prod 都是「没改配置」，
# 而不是「就想这么设」。
_KNOWN_PLACEHOLDERS: frozenset[str] = frozenset({
    'CHANGE_ME__secrets.token_urlsafe(32)',
    'e2e-only-not-a-real-secret-CHANGE-ME',
    'ci-only-not-a-real-secret-Ku3Jd9wQpZ2vLxR7',
    'YourStrong!Passw0rd',
    'postgres',
    '123456',
    '12345678',
    'password',
    'passw0rd',
    'admin',
    'root',
    'sa',
    'test',
    'guest',
    'secret',
    'changeme',
    'fba',
})

# 子串命中即判占位（大小写不敏感）。挡的是「只删了后缀」这种改法，
# 例如把 `CHANGE_ME__secrets.token_urlsafe(32)` 改成 `CHANGE_ME__prod`。
_PLACEHOLDER_MARKERS: tuple[str, ...] = (
    'change_me',
    'changeme',
    'change-me',
    'your',
    'example',
    'placeholder',
    'todo',
    'fixme',
    'xxxx',
    'dummy',
    'sample',
    'not-a-real',
)


def _entropy_bits(value: str) -> float:
    """整串的 Shannon 熵（bit）

    `'123'` ≈ 4.75，`'aaaaaaaaaaaaaaaa'` = 0，`secrets.token_urlsafe(32)` ≈ 230。
    """
    if not value:
        return 0.0
    counts = Counter(value)
    n = len(value)
    return -sum((c / n) * math.log2(c / n) for c in counts.values()) * n


def _check_secret(name: str, value: str | None, *, min_len: int, min_bits: float, min_distinct: int) -> str | None:
    """判定一个密钥 / 密码是不是「还是占位符或者太弱」，返回不合格的原因

    🔴 **光查黑名单挡不住伪修复。** 有人把 `CHANGE_ME__...` 改成 `123` 也算「改过了」，
    而那比占位符还糟 —— 占位符至少还能被识别出来。真正兜底的是后两道闸：
    去重字符数和熵。`'123'` 只有 3 个字符 4.75 bit，`'abcabcabc...'` 哪怕 36 个字符
    也只有 57 bit，都过不去。
    """
    if value is None or not value.strip():
        return f'{name} 为空'
    v = value.strip()
    if v.lower() in {p.lower() for p in _KNOWN_PLACEHOLDERS}:
        return f'{name} 仍是仓库里的示例值（{v[:12]}…）'
    lower = v.lower()
    for marker in _PLACEHOLDER_MARKERS:
        if marker in lower:
            return f'{name} 含占位标记 “{marker}”'
    if len(v) < min_len:
        return f'{name} 长度 {len(v)} < 最小要求 {min_len}'
    distinct = len(set(v))
    if distinct < min_distinct:
        return f'{name} 只用了 {distinct} 种字符（要求 ≥ {min_distinct}）'
    bits = _entropy_bits(v)
    if bits < min_bits:
        return f'{name} 强度不足：{bits:.0f} bit（要求 ≥ {min_bits:.0f} bit）'
    return None


def _check_connection_target(name: str, value: str | None) -> str | None:
    """拒绝生产数据库连接目标上的空值和模板占位符。"""
    normalized = (value or '').strip().lower()
    if not normalized:
        return f'{name} 不能为空'
    if any(marker in normalized for marker in _PLACEHOLDER_MARKERS):
        return f'{name} 仍是占位值，请填写生产实际配置'
    return None


def _check_session_settings(s: Settings) -> str | None:
    """会话配置里两条「单看都合理、放一起就坏」的约束

    - **宽限期不能短于客户端刷新请求的超时**（前端是 10 秒）。刷新响应丢了、客户端拿旧
      refresh token 重试时，宽限期已过就会被判成盗用、整个会话撤销 —— 用户看到的是
      「检测到登录凭据被重复使用」，而他什么都没做。ContiNew 把这个值从 30 改成 5 就是这么栽的
    - **超限策略只认两个值**。拼错一个字母不会报错，读取侧会回落成默认策略，
      配置文件上写着「拒绝新登录」、实际在挤人

    ⚠️ 原来这里校验的是「refresh token 必须比 access token 活得长」。会话模型换掉之后
    （#138）不再有独立的 refresh 有效期：会话自己有空闲 / 绝对两道上限，access token
    只是会话里的一枚短期凭据，两者没有先后关系要约束。

    :param s: 待校验的配置实例
    :return: 不合格时返回问题描述，合格返回 None
    """
    problems = []
    if not 10 <= s.SESSION_REFRESH_GRACE_SECONDS <= 120:
        problems.append(
            f'SESSION_REFRESH_GRACE_SECONDS={s.SESSION_REFRESH_GRACE_SECONDS} 不在 10~120 之间 —— '
            '短于客户端刷新超时会把弱网重试判成盗用、整个会话被撤销'
        )
    for client in ('WEB', 'DESKTOP', 'MOBILE'):
        overflow = getattr(s, f'SESSION_{client}_OVERFLOW')
        if overflow not in ('evict_idle', 'deny'):
            problems.append(f'SESSION_{client}_OVERFLOW={overflow!r} 只能是 evict_idle 或 deny')
    return '；'.join(problems) or None


def _check_snowflake_node_lease(s: Settings) -> str | None:
    """雪花节点的心跳必须**明显快于** TTL，否则会发出重复 ID

    节点号是 `SET <key> <pid> NX EX=TTL` 抢到的，靠心跳 `EXPIRE` 续期。
    心跳慢于 TTL 时，进程**还活着** key 就过期了 —— 另一个副本
    `acquire_node_id()` 扫一圈看见槽位空着就占走**同一个号**，
    于是两边用同样的 datacenter/worker 发号，**雪花 ID 开始重复**。

    而全仓所有 ID 都是雪花（硬纪律 6），症状是「偶尔两条记录 ID 一样」——
    从这个现象追回「心跳配置」几乎不可能，所以要在启动时拦。

    ⚠️ 要留余量，不是只要求「小于」：续期本身要往返 Redis，而且心跳任务和
    事件循环里的别人抢 CPU。取一半 —— 默认值 30/60 正好是这个比例。

    ⚠️ 判据是 `* 2 >` 而**不是** `* 2 >=`：写成后者会把默认配置本身拒掉，
    那种误杀比漏判更糟（所有人第一次上生产就起不来，而报错指着一份
    没改过的配置）。反向验证过，见 `test_prod_config.py` 那三条。

    :param s: 待校验的配置实例
    :return: 不合格时返回问题描述，合格返回 None
    """
    if s.SNOWFLAKE_HEARTBEAT_INTERVAL_SECONDS * 2 <= s.SNOWFLAKE_NODE_TTL_SECONDS:
        return None
    return (
        f'SNOWFLAKE_HEARTBEAT_INTERVAL_SECONDS={s.SNOWFLAKE_HEARTBEAT_INTERVAL_SECONDS} '
        f'相对 SNOWFLAKE_NODE_TTL_SECONDS={s.SNOWFLAKE_NODE_TTL_SECONDS} 太慢 —— '
        '心跳要不慢于 TTL 的一半，否则节点号会在进程活着的时候过期、被别的副本抢走，'
        '两边发出重复的雪花 ID'
    )


def _check_import_default_password(s: Settings) -> str | None:
    """
    批量导入的默认密码不能是常见弱口令。

    影响面是「乘以 N」：它一次给一整批新账号用，而这些账号在本人改密之前
    全都是同一个口令。空串是**关闭功能**，不算配错。

    ⚠️ 这里只拦最常见的那几个。真正的强度校验在导入接口里现查一遍
    （`validate_password_strength()`，读的是动态配置，这一层拿不到 db）。
    """
    weak = {'123456', '12345678', 'admin', 'password', 'admin123', 'abc123'}
    if s.USER_IMPORT_DEFAULT_PASSWORD and s.USER_IMPORT_DEFAULT_PASSWORD.lower() in weak:
        return 'USER_IMPORT_DEFAULT_PASSWORD 是常见弱口令，prod 请换掉'
    return None


def check_production_settings(s: Settings) -> None:
    """prod 启动前置校验 —— 一次性收集**全部**问题后 fail-fast

    🔴 为什么是一次列全而不是逐条 raise：运维改一条重启一次、再撞下一条，
    是最招人绕过的体验 —— 最后的解法往往变成「先把 ENVIRONMENT 设成 dev 跑起来再说」。

    🔴 为什么是抛异常而不是 log.warning：`settings` 在模块导入期就实例化，
    异常会让 uvicorn / celery / alembic **全部**在第一秒退出，编排立刻看到 CrashLoop。
    警告会被日志淹没，而这类问题的特征恰恰是「一切正常，直到出事」。

    :param s: 待校验的配置实例
    :return:
    """
    if s.ENVIRONMENT != 'prod':
        return

    problems: list[str | None] = []

    problems.extend([
        # 签名密钥 —— 泄漏等于任何人都能签发管理员 token，标准最高
        _check_secret('TOKEN_SECRET_KEY', s.TOKEN_SECRET_KEY, min_len=32, min_bits=128, min_distinct=16),
        _check_secret('DATABASE_PASSWORD', s.DATABASE_PASSWORD, min_len=12, min_bits=48, min_distinct=8),
        # Redis 里放着全部 token 和用户缓存，而默认密码是空串
        _check_secret('REDIS_PASSWORD', s.REDIS_PASSWORD, min_len=12, min_bits=48, min_distinct=8),
    ])

    # 只在真用 rabbitmq 当 broker 时才要求它的口令
    if s.CELERY_BROKER == 'rabbitmq':
        problems.append(
            _check_secret(
                'CELERY_RABBITMQ_PASSWORD', s.CELERY_RABBITMQ_PASSWORD, min_len=12, min_bits=48, min_distinct=8
            )
        )

    # 非密钥类的 prod 硬约束
    problems.extend([
        _check_connection_target('DATABASE_HOST', s.DATABASE_HOST),
        _check_connection_target('DATABASE_USER', s.DATABASE_USER),
    ])
    if s.DEMO_MODE:
        problems.append('DEMO_MODE 在 prod 必须为 false')
    if not s.LOGIN_CAPTCHA_ENABLED:
        problems.append('LOGIN_CAPTCHA_ENABLED 在 prod 必须为 true')
    if not s.REQUEST_LIMITER_ENABLED:
        problems.append('REQUEST_LIMITER_ENABLED 在 prod 必须为 true —— 它是登录爆破的唯一一道闸')
    if s.USER_PASSWORD_MIN_LENGTH < 8:
        problems.append(f'USER_PASSWORD_MIN_LENGTH={s.USER_PASSWORD_MIN_LENGTH}，prod 最低 8')
    bad_origins = [o for o in s.CORS_ALLOWED_ORIGINS if o == '*' or 'localhost' in o or '127.0.0.1' in o]
    if bad_origins:
        problems.append(f'CORS_ALLOWED_ORIGINS 含本地 / 通配来源：{bad_origins}')
    if s.DATABASE_USER in {'sa', 'root', 'postgres'}:
        problems.append(f'DATABASE_USER={s.DATABASE_USER} 是数据库超级用户，prod 请用最小权限账号')

    problems.extend((
        _check_snowflake_node_lease(s),
        _check_session_settings(s),
        _check_import_default_password(s),
    ))

    found = [p for p in problems if p]
    if found:
        lines = '\n'.join(f'  {i}. {p}' for i, p in enumerate(found, 1))
        raise ProductionConfigError(
            f'\n\n🔴 ENVIRONMENT=prod，但有 {len(found)} 项配置不合格，拒绝启动：\n{lines}\n\n'
            f'配置文件：{ENV_FILE_PATH}\n'
            f'生成一个合格的签名密钥：python -c "import secrets;print(secrets.token_urlsafe(32))"\n'
        )


def _ensure_env_file() -> None:
    """`.env` 缺失时：dev 拷示例、prod 拒绝启动

    🔴 判据只能用**进程环境变量** `ENVIRONMENT` —— `.env` 还不存在，读不到里面的值。
    这在本类里是自洽的：`settings_customise_sources` 把 `env_settings` 排在
    `dotenv_settings` **前面**，进程环境变量本来就优先。

    容器内（`/.dockerenv`）无条件视为生产形态：镜像里缺 `.env` 是编排配错了，
    悄悄拷一份带公开密钥的示例进去，是这里最坏的失败方式 ——
    服务正常起来，JWT 用一个 GitHub 上人人可见的常量签名。
    """
    if ENV_FILE_PATH.exists():
        return

    env_hint = os.environ.get('ENVIRONMENT', '').strip().lower()
    in_container = Path('/.dockerenv').exists() or bool(os.environ.get('CONTAINER'))
    if env_hint == 'prod' or in_container:
        raise ProductionConfigError(
            f'\n\n🔴 配置文件不存在：{ENV_FILE_PATH}\n'
            f'   （ENVIRONMENT={env_hint or "未设置"}，容器={in_container}）\n'
            '   生产环境不会自动复制 .env.example —— 那份示例里的密钥是公开的。\n'
            '   请挂载真实的 .env，或用环境变量注入全部必填项。\n'
        )

    if not ENV_EXAMPLE_FILE_PATH.exists():
        raise ProductionConfigError(f'配置文件与示例文件都不存在：{ENV_FILE_PATH}')

    shutil.copy(ENV_EXAMPLE_FILE_PATH, ENV_FILE_PATH)
    print(
        f'⚠️  已从 .env.example 生成 {ENV_FILE_PATH}（仅开发环境）。'
        'TOKEN_SECRET_KEY 仍是占位符，请尽快 `uv run fba init --auto` 或手工替换。'
    )


@cache
def get_settings() -> Settings:
    """获取全局配置单例"""
    _ensure_env_file()
    s = Settings()
    check_production_settings(s)
    return s


# 创建全局配置实例
settings = get_settings()
