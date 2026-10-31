"""事件产生：事务内 outbox + fan-out（#167 第三节）。

```
service 写业务行 ── emit() ── record_event()：写 open_event + 每个订阅了的端点一行 open_webhook_delivery（pending）
                                  └ 挂一个 after_commit：提交之后踢一脚 worker（正常路径秒级）
Celery `open.webhook_deliver_pending`（每 15 秒的安全网 + 被踢）── 签名 POST
```

- 🔴 **fan-out 在事件产生时做，不在投递时做**：端点后加进来的不该收到历史事件（同 Svix）
- 🔴 **踢 worker 必须在提交之后**：提交前踢，worker 可能先于提交读表、看不到这几行（等 15 秒的安全网才发）。
  调用方的提交点散在各处（路由依赖、`_Ctx`、导入框架），所以挂在 session 的 `after_commit` 上，不让每个调用方记着踢
"""

from __future__ import annotations

import asyncio
import json

from typing import TYPE_CHECKING, Any

from backend.common.after_commit import run_after_commit
from backend.common.log import log
from backend.plugin.open.crud.crud_webhook import open_webhook_dao
from backend.plugin.open.enums import WebhookDeliveryStatus
from backend.plugin.open.events import PING, get_webhook_event, matches
from backend.plugin.open.model import OpenEvent, OpenWebhook, OpenWebhookDelivery
from backend.plugin.open.service.webhook_config import webhook_settings
from backend.utils.serializers import stringify_unsafe_ints
from backend.utils.timezone import timezone

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession

TASK_NAME = 'open.webhook_deliver_pending'


def build_payload(type: str, data: dict[str, Any]) -> str:
    """请求体原文。紧凑分隔、不转义中文；ID 一律字符串（硬纪律 6：对方多半是 JS / Java，2^61 的雪花 ID 会丢精度）"""
    body = {'type': type, 'timestamp': timezone.to_iso(timezone.now()), 'data': stringify_unsafe_ints(data)}
    return json.dumps(body, ensure_ascii=False, separators=(',', ':'))


def scope_granted(app_scopes: str | None, scope: str) -> bool:
    try:
        return scope in (json.loads(app_scopes) if app_scopes else [])
    except ValueError:
        return False


async def record_event(db: AsyncSession, type: str, *, aggregate_id: int | None, data: dict[str, Any]) -> OpenEvent:
    """写一行事件 + fan-out。不 commit"""
    spec = get_webhook_event(type)
    if spec is None:
        # 代码里 emit 了一个没登记的类型 —— 是 bug，不是运行时数据问题，就该炸（守卫测试也会扫）
        raise ValueError(f'Webhook 事件 {type} 没有登记（events.register_webhook_event）')
    ev = OpenEvent(type=type, aggregate_id=aggregate_id, payload=build_payload(type, data))
    db.add(ev)
    await db.flush()

    if not (await webhook_settings(db)).enabled:
        return ev
    now = timezone.now()
    pending = 0
    for hook, app in await open_webhook_dao.subscribers(db):
        if app.expire_time is not None and app.expire_time <= now:
            continue
        if not matches(_patterns(hook), type) or not scope_granted(app.scopes, spec.scope):
            continue
        db.add(
            OpenWebhookDelivery(
                webhook_id=hook.id, event_id=ev.id, event_type=type, status=WebhookDeliveryStatus.pending.value
            )
        )
        pending += 1
    if pending:
        kick_after_commit(db)
    return ev


async def record_ping(db: AsyncSession, hook: OpenWebhook) -> OpenWebhookDelivery:
    """发测试事件：只给这一个端点，不看订阅、不看 scope、不看总开关（管理员点「测试」就是要看到结果）"""
    ev = OpenEvent(type=PING, aggregate_id=hook.id, payload=build_payload(PING, {'webhook_id': hook.id}))
    db.add(ev)
    await db.flush()
    delivery = OpenWebhookDelivery(
        webhook_id=hook.id, event_id=ev.id, event_type=PING, status=WebhookDeliveryStatus.pending.value
    )
    db.add(delivery)
    await db.flush()
    return delivery


def _patterns(hook: OpenWebhook) -> list[str]:
    try:
        return list(json.loads(hook.events or '[]'))
    except ValueError:
        return []


def kick_after_commit(db: AsyncSession) -> None:
    """提交之后踢一次 worker。同一个事务里多次只踢一次；回滚了不踢

    走公用的 `common/after_commit.py: run_after_commit`（#190 之前这里自己挂了一份同形状的监听）。
    `lambda` 而不是直接传 `kick`：提交那一刻才查模块级的名字，测试 monkeypatch 掉的 `kick` 才生效
    """
    run_after_commit(db, 'open.webhook_kick', lambda: kick())


async def kick() -> None:
    """踢一脚 worker。丢不出去只记 warning：每 15 秒的周期调度会补上"""
    try:
        from backend.app.task.celery import celery_app

        await asyncio.to_thread(celery_app.send_task, TASK_NAME, retry=False)
    except Exception as e:
        log.warning(f'Webhook 投递任务派发失败（周期调度会补上）：{e!s}')
