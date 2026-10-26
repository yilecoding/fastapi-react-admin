"""参数配置「通知推送」组（#166 第七节）。同邮件插件的 `utils/dynamic_config.py`：组开关关掉或行被删 → 回落 .env"""

from sqlalchemy.ext.asyncio import AsyncSession

from backend.utils.dynamic_config import load_config, str_to_bool


async def load_notification_config(db: AsyncSession) -> None:
    await load_config(
        db,
        'notification',
        {
            'NOTIFICATION_EXTERNAL_ENABLED': str_to_bool,
            'NOTIFICATION_RETRY_MAX': int,
            'NOTIFICATION_DELIVERY_RETENTION_DAYS': int,
        },
        'NOTIFICATION_CONFIG_STATUS',
    )


async def delivery_retention_days(db: AsyncSession) -> int:
    """投递记录保留天数，给每天的日志清理任务用。**直接查 `sys_config`，不走 `load_notification_config`。**

    🔴 `load_config` → `config_service.get_all` 挂着 Redis 缓存。清理任务的测试是在 `asyncio.run()` 开的
    一次性循环里跑任务的，共享的 `redis_client` 连接池会绑到那个随后就关掉的循环上，下一条走 TestClient 的用例
    当场 `Event loop is closed`（PR #169 的 CI 两个方言都红在 `test_result_columns.py` 的 setup 上）。
    这里只要一个数，按「组开关关了 / 行没了 / 值越界 → 回落 settings」同一套规则自己读。
    """
    from sqlalchemy import select

    from backend.core.conf import settings
    from backend.plugin.core import check_plugin_installed
    from backend.utils.dynamic_config import check_dynamic_int_bounds

    key = 'NOTIFICATION_DELIVERY_RETENTION_DAYS'
    fallback = int(settings.NOTIFICATION_DELIVERY_RETENTION_DAYS)
    if not check_plugin_installed('config'):
        return fallback
    from backend.plugin.config.model import Config

    rows = dict(
        (
            await db.execute(
                select(Config.key, Config.value).where(Config.key.in_([key, 'NOTIFICATION_CONFIG_STATUS']))
            )
        ).all()
    )
    raw = rows.get(key)
    if rows.get('NOTIFICATION_CONFIG_STATUS', '1') == '0' or raw is None or check_dynamic_int_bounds(key, raw):
        return fallback
    return int(raw)
