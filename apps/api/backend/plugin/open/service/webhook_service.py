"""Webhook 端点与投递记录的管理（后台 JWT + RBAC，#167 第六节）"""

from __future__ import annotations

import json

from datetime import timedelta
from typing import TYPE_CHECKING, Any

from backend.common.exception import errors
from backend.common.i18n import t
from backend.common.pagination import paging_data
from backend.database.db import async_db_session
from backend.plugin.open.crud.crud_app import open_app_dao
from backend.plugin.open.crud.crud_webhook import open_event_dao, open_webhook_dao, open_webhook_delivery_dao
from backend.plugin.open.enums import WebhookDisabledReason
from backend.plugin.open.events import WEBHOOK_EVENTS, load_webhook_extensions, matches, unknown_patterns
from backend.plugin.open.gateway.auth import SCOPES
from backend.plugin.open.model import OpenApp, OpenWebhook
from backend.plugin.open.schema.webhook import (
    CreateWebhookParam,
    GetWebhookDeliveryDetail,
    IssuedWebhookSecret,
    PingResult,
    UpdateWebhookParam,
    WebhookAttemptItem,
    WebhookEventItem,
    WebhookSchemaBase,
)
from backend.plugin.open.service import webhook_sign
from backend.plugin.open.service.event_service import kick, record_ping, scope_granted
from backend.plugin.open.service.secret import encrypt
from backend.plugin.open.service.webhook_config import webhook_settings
from backend.plugin.open.service.webhook_delivery import check_target, deliver_one
from backend.utils.timezone import timezone

if TYPE_CHECKING:
    from datetime import datetime

    from sqlalchemy.ext.asyncio import AsyncSession

#: 重置密钥后旧密钥还一起签名多久（对方换配置的窗口）
SECRET_ROTATION_GRACE = timedelta(hours=24)


def _issue_secret() -> tuple[str, str, str]:
    secret = webhook_sign.new_secret()
    return secret, encrypt(secret), f'{secret[: len(webhook_sign.SECRET_PREFIX) + 4]}…'


async def _get_app(db: AsyncSession, app_id: int) -> OpenApp:
    app = await open_app_dao.get(db, app_id)
    if not app:
        raise errors.NotFoundError(msg=t('error.open.app_not_found'))
    return app


async def _check(app: OpenApp, obj: WebhookSchemaBase) -> None:
    """保存前的三道检查。每一道漏掉的表现都是「端点存上了，就是收不到东西」，看起来像网络问题"""
    unknown = unknown_patterns(obj.events)
    if unknown:
        raise errors.RequestError(msg=t('error.open.webhook_events_unknown', events='、'.join(unknown)))
    missing: dict[str, list[str]] = {}
    for ev in WEBHOOK_EVENTS.values():
        if matches(obj.events, ev.type) and not scope_granted(app.scopes, ev.scope):
            missing.setdefault(ev.scope, []).append(ev.type)
    if missing:
        raise errors.RequestError(
            msg=t(
                'error.open.webhook_scope_missing',
                scopes='、'.join(SCOPES[s].label if s in SCOPES else s for s in missing),
                events='、'.join(e for evs in missing.values() for e in evs),
            )
        )
    problem = await check_target(obj.url)
    if problem:
        raise errors.RequestError(msg=t('error.open.webhook_url_invalid', reason=problem))


def _apply_status(row: OpenWebhook, status: int) -> None:
    """启用时清掉失败计数（否则刚启用、再失败一次就又满足「连续 20 次」被秒停）"""
    if status == row.status:
        return
    row.status = status
    if status == 1:
        row.disabled_reason = None
        row.disabled_time = None
        row.consecutive_failures = 0
        row.first_failure_time = None
    else:
        row.disabled_reason = WebhookDisabledReason.manual.value
        row.disabled_time = timezone.now()


class WebhookService:
    @staticmethod
    def events() -> list[WebhookEventItem]:
        load_webhook_extensions()
        return [
            WebhookEventItem(type=e.type, label=e.label, scope=e.scope, sample=e.sample)
            for e in sorted(WEBHOOK_EVENTS.values(), key=lambda e: e.type)
        ]

    @staticmethod
    async def get_list(*, db: AsyncSession, app_id: int) -> list[OpenWebhook]:
        await _get_app(db, app_id)
        return list(await open_webhook_dao.get_by_app(db, app_id))

    @staticmethod
    async def get(*, db: AsyncSession, pk: int) -> OpenWebhook:
        row = await open_webhook_dao.get(db, pk)
        if not row:
            raise errors.NotFoundError(msg=t('error.open.webhook_not_found'))
        return row

    @staticmethod
    async def create(*, db: AsyncSession, obj: CreateWebhookParam, user_id: int) -> IssuedWebhookSecret:
        app = await _get_app(db, obj.app_id)
        limit = (await webhook_settings(db)).max_per_app
        if await open_webhook_dao.count_by_app(db, app.id) >= limit:
            raise errors.RequestError(msg=t('error.open.webhook_limit', max=limit))
        await _check(app, obj)
        secret, cipher, hint = _issue_secret()
        row = OpenWebhook(
            app_id=app.id,
            name=obj.name,
            url=obj.url,
            secret_cipher=cipher,
            secret_hint=hint,
            events=json.dumps(obj.events, ensure_ascii=False),
            remark=obj.remark,
            created_by=user_id,
        )
        _apply_status(row, obj.status)
        db.add(row)
        await db.flush()
        return IssuedWebhookSecret(id=row.id, secret_key=secret)

    async def update(self, *, db: AsyncSession, pk: int, obj: UpdateWebhookParam) -> None:
        row = await self.get(db=db, pk=pk)
        await _check(await _get_app(db, row.app_id), obj)
        row.name, row.url, row.remark = obj.name, obj.url, obj.remark
        row.events = json.dumps(obj.events, ensure_ascii=False)
        _apply_status(row, obj.status)

    async def reset_secret(self, *, db: AsyncSession, pk: int) -> IssuedWebhookSecret:
        """换新密钥。旧的再签 24 小时（两把一起签），对方有一天时间换配置，不丢事件"""
        row = await self.get(db=db, pk=pk)
        secret, cipher, hint = _issue_secret()
        row.secret_prev_cipher = row.secret_cipher
        row.secret_prev_expire_time = timezone.now() + SECRET_ROTATION_GRACE
        row.secret_cipher, row.secret_hint = cipher, hint
        return IssuedWebhookSecret(id=row.id, secret_key=secret)

    async def delete(self, *, db: AsyncSession, pk: int) -> int:
        await self.get(db=db, pk=pk)
        return await open_webhook_dao.delete_with_history(db, pk)

    @staticmethod
    async def ping(*, pk: int) -> PingResult:
        """发一个测试事件、**当场**发出去并返回结果（不等 worker：管理员在界面上等着看）。

        自己开两段事务：先提交投递行，`deliver_one` 才抢得到它
        """
        async with async_db_session.begin() as db:
            hook = await open_webhook_dao.get(db, pk)
            if not hook:
                raise errors.NotFoundError(msg=t('error.open.webhook_not_found'))
            delivery = await record_ping(db, hook)
            delivery_id = delivery.id
        status = await deliver_one(delivery_id, now_even_if_not_due=True)
        async with async_db_session() as db:
            done = await open_webhook_delivery_dao.get(db, delivery_id)
        return PingResult(
            delivery_id=delivery_id,
            status=status or (done.status if done else 'unknown'),
            response_code=done.last_response_code if done else None,
            error=done.last_error if done else None,
            duration_ms=done.last_duration_ms if done else None,
        )

    @staticmethod
    async def deliveries(
        *,
        db: AsyncSession,
        app_id: int | None,
        webhook_id: int | None,
        event_type: str | None,
        status: str | None,
    ) -> dict[str, Any]:
        stmt = open_webhook_delivery_dao.get_select(
            app_id=app_id, webhook_id=webhook_id, event_type=event_type, status=status
        )
        return await paging_data(db, stmt)

    @staticmethod
    async def delivery(*, db: AsyncSession, pk: int) -> GetWebhookDeliveryDetail:
        row = await open_webhook_delivery_dao.get(db, pk)
        if not row:
            raise errors.NotFoundError(msg=t('error.open.webhook_delivery_not_found'))
        hook = await open_webhook_dao.get(db, row.webhook_id)
        event = await open_event_dao.get(db, row.event_id)
        attempts = await open_webhook_delivery_dao.attempts_of(db, pk)
        return GetWebhookDeliveryDetail(
            id=row.id,
            webhook_id=row.webhook_id,
            webhook_name=hook.name if hook else '',
            event_id=row.event_id,
            event_type=row.event_type,
            status=row.status,
            attempts=row.attempts,
            next_attempt_time=row.next_attempt_time,
            last_response_code=row.last_response_code,
            last_error=row.last_error,
            last_duration_ms=row.last_duration_ms,
            success_time=row.success_time,
            created_time=row.created_time,
            updated_time=row.updated_time,
            payload=event.payload if event else '',
            attempts_log=[WebhookAttemptItem.model_validate(a) for a in attempts],
        )

    @staticmethod
    async def resend(*, db: AsyncSession, pk: int) -> None:
        row = await open_webhook_delivery_dao.get(db, pk)
        if not row:
            raise errors.NotFoundError(msg=t('error.open.webhook_delivery_not_found'))
        if not await open_webhook_delivery_dao.resend(db, pk):
            raise errors.ConflictError(msg=t('error.open.webhook_delivery_not_resendable'))

    async def resend_exhausted(self, *, db: AsyncSession, pk: int, since: datetime) -> int:
        await self.get(db=db, pk=pk)
        return await open_webhook_delivery_dao.resend_exhausted(db, webhook_id=pk, since=since)

    @staticmethod
    async def kick() -> None:
        await kick()


webhook_service: WebhookService = WebhookService()
