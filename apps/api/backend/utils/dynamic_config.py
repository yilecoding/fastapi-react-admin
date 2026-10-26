from collections.abc import Callable

from sqlalchemy.ext.asyncio import AsyncSession

from backend.common.log import log
from backend.core.conf import settings
from backend.plugin.core import check_plugin_installed
from backend.utils.serializers import select_list_serialize

#: 动态配置覆盖之前的那份 settings（= `.env` / `conf.py` 给的值），回落时从这里取。
#:
#: 🔴 不能拿「当前的 `settings`」当回落值：`load_config` 是往**进程级单例**上 `setattr`，
#: 上一次加载写进去的库值会一直留着。原来组总开关关掉时直接 `return`、行被删掉时 `continue`，
#: 于是界面上写着「整组不加载，回落 .env」，进程里却还是上一次的库值，要重启才回落 ——
#: 而多副本下没加载过的那台是 .env 值、加载过的那台是库值，两台机器给出不同的答案
_ENV_DEFAULTS = settings.model_copy(deep=True)


def str_to_bool(value: str) -> bool:
    """将字符串转换为布尔值"""
    return value == 'true'


_MIB = 1024 * 1024


def mib_to_bytes(value: str) -> int:
    """库里按 MiB 存（界面上填 `8` 而不是 `8388608`），settings 里是字节"""
    return int(value) * _MIB


async def load_config(
    db: AsyncSession,
    config_type_attr: str,
    mapping: dict[str, Callable[[str], object]],
    status_key: str,
) -> None:
    """
    根据配置类型加载配置

    :param db: 数据库会话
    :param config_type_attr: 配置类型属性名
    :param mapping: 配置映射 {config_key: converter}
    :param status_key: 状态键
    :return:
    """
    if not check_plugin_installed('config'):
        return

    try:
        from backend.plugin.config.enums import ConfigType
        from backend.plugin.config.service.config_service import config_service
    except ImportError as e:
        raise ImportError('参数配置插件用法导入失败，请联系系统管理员') from e

    config_type = getattr(ConfigType, config_type_attr)
    dynamic_config = await config_service.get_all(db=db, type=config_type)
    configs: dict[str, str] = {}
    if dynamic_config:
        rows = select_list_serialize(dynamic_config) if hasattr(dynamic_config[0], '__table__') else dynamic_config
        configs = {dc['key']: dc['value'] for dc in rows}
    enabled = configs.get(status_key, '1') != '0'

    for config_key, converter in mapping.items():
        # 组关了 / 这一行被删了 / 值是脏的，一律**显式**写回 .env 的值，见 `_ENV_DEFAULTS` 的注释
        default = getattr(_ENV_DEFAULTS, config_key)
        if not enabled or config_key not in configs:
            setattr(settings, config_key, default)
            continue
        raw = configs[config_key]
        # 读取侧也要卡范围：写入侧的闸门挡不住直接写库 / 迁移 / 闸门上线前的历史行。
        # `FILE_CHUNK_SIZE = '0'` 能通过 int()，然后在 init 里 `ceil(size / 0)` —— 每次分片上传都 500
        problem = check_dynamic_int_bounds(config_key, raw)
        if problem:
            log.error(f'参数配置 {problem}，已忽略并回落到默认值')
            setattr(settings, config_key, default)
            continue
        try:
            value = converter(raw)
        except (TypeError, ValueError):
            # 🔴 单条脏数据不能拖垮整个请求。
            #
            # 这些 converter 大多是裸 `int`，而 load_user_security_config /
            # load_login_config 挂在**登录和改密码路径**上。原来这里不捕获异常：
            # 只要 sys_config 里有一个非数字值（参数配置页把某个数字框清空存下去
            # 就会产生 `''`），下一次登录就是
            # `500 invalid literal for int() with base 10: ''` —— 全站登不进来，
            # 包括改坏它的那个管理员自己。实测确认过。
            #
            # 现在退化成「这一个键回落到 .env 默认值 + 一条 error 日志」。
            # 写入侧现在有 `DYNAMIC_INT_BOUNDS` 闸门（schema 层），
            # 但读取侧不能依赖写入侧的自觉。
            log.error(f'参数配置 {config_key} 的值 {raw!r} 无法转换，已忽略并回落到默认值')
            value = default
        setattr(settings, config_key, value)


#: 动态配置里**数值型**键的合法范围（闭区间）。
#:
#: 🔴 **写入侧此前完全没有校验** —— 只有前端
#: `packages/platform/src/pages/config/registry.ts` 里的 `min` / `max`，
#: 而那是 UX 提示，不是闸门：带管理员 token 直接 `PUT /sys/configs` 就能绕过。
#:
#: 实测（这四发全部 HTTP 200）：`USER_PASSWORD_MIN_LENGTH` 可以被写成
#: `1` / `0` / `-5` / `999`。其中 `999` 的后果是**所有人都改不了密码**
#: （「密码长度不能少于 999 个字符」）—— 一次 API 调用自锁。
#:
#: 而这个仓库已经修过同类的一次：值被清空成 `''`，下一次登录直接
#: `500 invalid literal for int()`，全站登不进来（见 `load_config` 里那段注释）。
#: 那次只修了**读取侧**的回落，写入侧的洞留着。这张表补的是写入侧。
#:
#: ⚠️ 范围要和前端 registry 对得上，`test_dynamic_config_bounds.py` 有对账测试 ——
#: 它第一次跑就抓到一处：`USER_LOCK_THRESHOLD` 的下界我写成了 1，
#: 而 0 是合法的「禁用锁定」（`conf.py` 写着，代码里也有那个分支）。
DYNAMIC_INT_BOUNDS: dict[str, tuple[int, int]] = {
    # 0 表示禁用锁定（`conf.py` 写着，`check_user_login_locked` 里也有那个分支）
    'USER_LOCK_THRESHOLD': (0, 100),
    'USER_LOCK_SECONDS': (1, 86400),
    'USER_PASSWORD_EXPIRY_DAYS': (0, 3650),
    'USER_PASSWORD_REMINDER_DAYS': (0, 365),
    'USER_PASSWORD_HISTORY_CHECK_COUNT': (0, 24),
    'USER_PASSWORD_MIN_LENGTH': (1, 128),
    'USER_PASSWORD_MAX_LENGTH': (1, 128),
    # 下面两个的单位是 MiB（见 `load_file_config`）。
    # 🔴 阈值的上界跟着 `apps/web/nginx.conf` 的 `client_max_body_size 100m` 走：小于阈值的文件是
    # **一个请求**传完的，阈值调到 100 以上，100 MB 上下的文件就是 nginx 的 413，而应用日志里什么都没有。
    # 留 1 MiB 给 multipart 的边界和表头。改 nginx 那个值时同步改这里和前端 registry
    'FILE_CHUNK_THRESHOLD': (1, 99),
    # 每一片也是一个请求，同样要小于 client_max_body_size；64 MiB 再往上，单片失败重传的代价就太大了
    'FILE_CHUNK_SIZE': (1, 64),
    # 通知推送（#166）：外部渠道的重试次数（不含第一次）、投递记录保留天数
    'NOTIFICATION_RETRY_MAX': (0, 10),
    'NOTIFICATION_DELIVERY_RETENTION_DAYS': (1, 365),
    # 会话策略（#138）。空闲按分钟：下界 5 给等保那种「15 / 30 分钟无操作退出」留空间，上界 90 天；
    # 绝对有效期按天；会话上限 0 = 不限
    **{
        key: bounds
        for client in ('WEB', 'DESKTOP', 'MOBILE')
        for key, bounds in (
            (f'SESSION_{client}_IDLE_MINUTES', (5, 60 * 24 * 90)),
            (f'SESSION_{client}_ABSOLUTE_DAYS', (1, 365)),
            (f'SESSION_{client}_MAX', (0, 100)),
        )
    },
}

#: 会话超限策略：挤掉最久没活跃的 / 拒绝新登录（#138）
SESSION_OVERFLOW_MODES = ('evict_idle', 'deny')


#: 只认几个固定取值的动态配置（写入侧在 schema 上卡，读取侧对不上回落 .env）
DYNAMIC_CHOICES: dict[str, tuple[str, ...]] = {
    f'SESSION_{client}_OVERFLOW': SESSION_OVERFLOW_MODES for client in ('WEB', 'DESKTOP', 'MOBILE')
}


def session_overflow(value: str) -> str:
    """会话超限策略：拼错一个字母不报错的话，界面上写着「拒绝新登录」、实际在挤人"""
    if value not in SESSION_OVERFLOW_MODES:
        raise ValueError(value)
    return value


def check_dynamic_choice(key: str, raw: str) -> str | None:
    """校验一个只认固定取值的动态配置；不在 `DYNAMIC_CHOICES` 里的键直接放过

    :param key: 配置键名
    :param raw: 界面传上来的原始字符串值
    :return: 不合格时返回给人看的原因，合格返回 None
    """
    choices = DYNAMIC_CHOICES.get(key)
    if choices is None or raw in choices:
        return None
    return f'{key} 只能是 {" / ".join(choices)}，收到 {raw!r}'


def check_dynamic_int_bounds(key: str, raw: str) -> str | None:
    """校验一个动态配置值是否在合法范围内

    :param key: 配置键名。不在 `DYNAMIC_INT_BOUNDS` 里的键直接放过 ——
        写成「表里没有就拒绝」会让所有非数值配置一起失效
    :param raw: 界面传上来的原始字符串值
    :return: 不合格时返回**给人看的**原因，合格返回 None
    """
    bounds = DYNAMIC_INT_BOUNDS.get(key)
    if bounds is None:
        return None

    low, high = bounds
    try:
        value = int(raw)
    except (TypeError, ValueError):
        # 空串是最常见的一种：数字输入框按退格就到，而它曾经让全站登不进来
        return f'{key} 需要一个 {low}~{high} 的整数，收到 {raw!r}'
    if not (low <= value <= high):
        return f'{key} 必须在 {low}~{high} 之间，收到 {value}'
    return None


async def load_user_security_config(db: AsyncSession) -> None:
    """
    获取用户安全配置

    :param db: 数据库会话
    :return:
    """
    mapping = {
        'USER_LOCK_THRESHOLD': int,
        'USER_LOCK_SECONDS': int,
        'USER_PASSWORD_EXPIRY_DAYS': int,
        'USER_PASSWORD_REMINDER_DAYS': int,
        'USER_PASSWORD_HISTORY_CHECK_COUNT': int,
        'USER_PASSWORD_MIN_LENGTH': int,
        'USER_PASSWORD_MAX_LENGTH': int,
        'USER_PASSWORD_REQUIRE_SPECIAL_CHAR': str_to_bool,
    }
    await load_config(db, 'user_security', mapping, 'USER_SECURITY_CONFIG_STATUS')


async def load_login_config(db: AsyncSession) -> None:
    """
    获取登录配置

    :param db: 数据库会话
    :return:
    """
    mapping = {
        'LOGIN_CAPTCHA_ENABLED': str_to_bool,
    }
    await load_config(db, 'login', mapping, 'LOGIN_CONFIG_STATUS')


async def load_file_config(db: AsyncSession) -> None:
    """
    获取文件上传配置（分片阈值 / 每片大小）

    挂在 `GET /sys/files/upload-policy` 和分片 init 上。会话在 init 时就记下了 `chunk_size`
    （`multipart_service.MultipartSession`），改配置不影响传到一半的文件

    :param db: 数据库会话
    :return:
    """
    mapping = {
        'FILE_CHUNK_THRESHOLD': mib_to_bytes,
        'FILE_CHUNK_SIZE': mib_to_bytes,
    }
    await load_config(db, 'file', mapping, 'FILE_CONFIG_STATUS')


async def load_session_config(db: AsyncSession) -> None:
    """
    获取会话策略（#138）：按端的空闲超时 / 绝对有效期 / 会话上限 / 超限策略

    挂在登录上（表单 / oauth2）。这几项在建会话时就**存进会话里**了，所以改配置只影响之后的登录，
    已经登录的人按登录那一刻的规则走完 —— 同分片上传的 `chunk_size`

    :param db: 数据库会话
    :return:
    """
    mapping: dict[str, Callable[[str], object]] = {}
    for client in ('WEB', 'DESKTOP', 'MOBILE'):
        mapping[f'SESSION_{client}_IDLE_MINUTES'] = int
        mapping[f'SESSION_{client}_ABSOLUTE_DAYS'] = int
        mapping[f'SESSION_{client}_MAX'] = int
        mapping[f'SESSION_{client}_OVERFLOW'] = session_overflow
    await load_config(db, 'session', mapping, 'SESSION_CONFIG_STATUS')
