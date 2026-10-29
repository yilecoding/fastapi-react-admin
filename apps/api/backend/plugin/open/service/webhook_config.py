"""参数配置「Webhook」组（#167）+ 只在 .env 里的几项。

🔴 **直接查 `sys_config`，不走 `load_config` 的 Redis 缓存**：`emit` 在业务事务里跑、投递在 Celery 里跑、
清理任务的测试在 `asyncio.run()` 的一次性循环里跑 —— 共享的 `redis_client` 绑到那个随后就关掉的循环上，
下一条用例当场 `Event loop is closed`（#169 的 CI 两个方言都红在这上面，见 `plugin/notification` 分册）。
一次一个小查询，比缓存失效的心智负担便宜。组开关关了 / 行没了 / 值越界 → 回落 settings（同 `load_config` 的规则）。
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING

from sqlalchemy import select

from backend.core.conf import settings
from backend.plugin.core import check_plugin_installed
from backend.utils.dynamic_config import check_dynamic_int_bounds, str_to_bool

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession

_STATUS_KEY = 'OPEN_WEBHOOK_CONFIG_STATUS'
_KEYS = (
    'OPEN_WEBHOOK_ENABLED',
    'OPEN_WEBHOOK_DISABLE_AFTER',
    'OPEN_WEBHOOK_RETENTION_DAYS',
    'OPEN_WEBHOOK_MAX_PER_APP',
)


@dataclass(frozen=True, slots=True)
class WebhookSettings:
    enabled: bool
    disable_after: int
    retention_days: int
    max_per_app: int


async def webhook_settings(db: AsyncSession) -> WebhookSettings:
    raw: dict[str, str] = {}
    if check_plugin_installed('config'):
        from backend.plugin.config.model import Config

        rows = dict(
            (await db.execute(select(Config.key, Config.value).where(Config.key.in_([*_KEYS, _STATUS_KEY])))).all()
        )
        if rows.get(_STATUS_KEY, '1') != '0':
            raw = {k: v for k, v in rows.items() if k in _KEYS and v is not None}

    def _int(key: str) -> int:
        value = raw.get(key)
        if value is None or check_dynamic_int_bounds(key, value):
            return int(getattr(settings, key))
        return int(value)

    enabled_raw = raw.get('OPEN_WEBHOOK_ENABLED')
    return WebhookSettings(
        enabled=str_to_bool(enabled_raw) if enabled_raw is not None else bool(settings.OPEN_WEBHOOK_ENABLED),
        disable_after=_int('OPEN_WEBHOOK_DISABLE_AFTER'),
        retention_days=_int('OPEN_WEBHOOK_RETENTION_DAYS'),
        max_per_app=_int('OPEN_WEBHOOK_MAX_PER_APP'),
    )


def backoff_schedule() -> list[int]:
    """退避秒数（.env）。写坏了回落默认值，不让一次手滑停掉全部重试（同通知投递）"""
    default = [15, 300, 3600, 21600]
    try:
        values = [int(x) for x in str(settings.OPEN_WEBHOOK_RETRY_BACKOFF_SECONDS).split(',') if x.strip()]
    except ValueError:
        return default
    if not values or any(v <= 0 for v in values):
        return default
    return values


def max_attempts() -> int:
    """总尝试次数 = 第一次 + 退避表的长度（默认 5 次 / 约 7 小时，照飞书事件订阅）"""
    return len(backoff_schedule()) + 1
