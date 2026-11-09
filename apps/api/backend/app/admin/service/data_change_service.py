from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.admin.crud.crud_data_change import data_change_dao
from backend.common.data_change import registry
from backend.common.pagination import paging_data


class DataChangeService:
    """数据变更记录（#260）。写入不在这里 —— 由 `common/data_change/capture.py` 在业务事务提交前写"""

    @staticmethod
    async def get_list(*, db: AsyncSession, **filters: Any) -> dict[str, Any]:
        select = await data_change_dao.get_select(**{k: v for k, v in filters.items() if v is not None})
        return await paging_data(db, select)

    @staticmethod
    async def verify(db: AsyncSession) -> dict[str, Any]:
        """防篡改链从头重算一遍（`common/data_change/chain.py`）。结果也写一行应用日志 —— 日志在库外，是事后的旁证"""
        from backend.common.data_change import chain
        from backend.common.log import log

        report = await db.run_sync(chain.verify)
        log.info(
            f'数据变更记录校验：{"通过" if report.ok else f"发现 {report.problem_count} 个问题"}，'
            f'校验 {report.checked} 行，链头 #{report.head_seq}，锚点 #{report.anchor_seq}'
        )
        return report.as_dict()

    @staticmethod
    def meta() -> dict[str, Any]:
        return {
            'entities': registry.describe(),
            'sources': [{'value': k, 'label': v} for k, v in registry.SOURCES.items()],
            'actions': [{'value': k, 'label': v} for k, v in registry.ACTIONS.items()],
        }


data_change_service: DataChangeService = DataChangeService()


async def data_change_retention_days(db: AsyncSession) -> int:
    """数据变更记录保留天数，给每天的日志清理任务用。

    同 `plugin/notification/service/config.py: delivery_retention_days`：**直接查 `sys_config`**，不走带 Redis 缓存的
    `load_config`（清理任务的测试在一次性循环里跑，共享 Redis 连接池会绑到那个随后就关掉的循环上）。
    行没了 / 值越界 → 回落 settings。这一组没有总开关：只有一个数，关掉它没有意义。
    """
    from sqlalchemy import select

    from backend.core.conf import settings
    from backend.plugin.core import check_plugin_installed
    from backend.utils.dynamic_config import check_dynamic_int_bounds

    key = 'DATA_CHANGE_RETENTION_DAYS'
    fallback = int(settings.DATA_CHANGE_RETENTION_DAYS)
    if not check_plugin_installed('config'):
        return fallback
    from backend.plugin.config.model import Config

    raw = (await db.execute(select(Config.value).where(Config.key == key, Config.deleted == 0))).scalar_one_or_none()
    if raw is None or check_dynamic_int_bounds(key, raw):
        return fallback
    return int(raw)
