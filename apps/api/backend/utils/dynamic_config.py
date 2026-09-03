from collections.abc import Callable

from sqlalchemy.ext.asyncio import AsyncSession

from backend.common.log import log
from backend.core.conf import settings
from backend.plugin.core import check_plugin_installed
from backend.utils.serializers import select_list_serialize


def str_to_bool(value: str) -> bool:
    """将字符串转换为布尔值"""
    return value == 'true'


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
    if not dynamic_config:
        return

    config_list = select_list_serialize(dynamic_config) if hasattr(dynamic_config[0], '__table__') else dynamic_config
    configs = {dc['key']: dc['value'] for dc in config_list}
    if configs.get(status_key, '1') == '0':
        return

    for config_key, converter in mapping.items():
        if config_key not in configs:
            continue
        raw = configs[config_key]
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
            # 写入侧的校验在前端（pages/config/registry.ts），
            # 但读取侧不能依赖写入侧的自觉。
            log.error(f'参数配置 {config_key} 的值 {raw!r} 无法转换，已忽略并回落到默认值')
            continue
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
}


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
