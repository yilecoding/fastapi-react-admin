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
