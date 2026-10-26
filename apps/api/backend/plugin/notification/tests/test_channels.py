"""通知渠道路由（#166）：路由决定 · 注册表守卫 · 策略 / 偏好接口 · 投递 worker 的状态机 · 抢占 · 事务。

都是「坏了不报错」的那几处：

- 结果未知被重试 = 重复发短信；没地址被静默跳过 = 管理员看不出为什么没人收到
- 两个 worker 抢同一行都发 = 每人收两封
- 业务回滚了投递行还在 = 「审批没成、邮件先到」
- forced / off 的格子个人能存进去 = 界面上显示「已关闭」，管理员改回 default_on 时又突然生效

异步代码经 `client.portal.call` 在应用自己的事件循环里跑（同短信插件 `test_sms_send.py`）：
`async_db_session` 被 conftest 换成了绑在那个循环上的测试库会话，`asyncio.run()` 会撞「different loop」。
"""

from __future__ import annotations

import asyncio
import functools

from datetime import timedelta
from typing import TYPE_CHECKING, Any

import pytest

from sqlalchemy import delete, select, update

from backend.app.admin.model import User
from backend.common.exception import errors
from backend.core.conf import settings
from backend.plugin.notification.crud.crud_channel import notification_delivery_dao
from backend.plugin.notification.enums import DeliveryStatus, NotificationCategory, NotificationChannel, PolicyMode
from backend.plugin.notification.kinds import get_notification_kind, list_notification_kinds, register_notification_kind
from backend.plugin.notification.model import Notification, NotificationDelivery, NotificationPolicy, NotificationPref
from backend.plugin.notification.service import delivery_service, senders
from backend.plugin.notification.service.notification_service import create_in_tx
from backend.plugin.notification.service.routing import effective_modes, wants
from backend.tests.utils.db import async_test_db_session
from backend.utils.timezone import timezone

if TYPE_CHECKING:
    from collections.abc import Awaitable, Callable, Iterator

    from starlette.testclient import TestClient

API = '/sys/notification-channels'
TITLE = 'PYTEST_CHANNEL'

#: 本文件自己的类型：邮件 default_off、短信 default_off（短信走 pytest 的业务模板，见下）
register_notification_kind(
    'pytest.channel',
    label='测试·渠道',
    category=NotificationCategory.SYSTEM,
    defaults={'inapp': 'forced', 'email': 'default_off', 'sms': 'default_off'},
    sms_template='captcha',
    sms_params=lambda title, content: {'code': '000000', 'minutes': '5'},
)


def _call(client: TestClient, fn: Callable[..., Awaitable[Any]], *args: Any, **kwargs: Any) -> Any:
    return client.portal.call(functools.partial(fn, *args, **kwargs))


async def _user_id(username: str) -> int:
    async with async_test_db_session() as db:
        return int(await db.scalar(select(User.id).where(User.username == username)))


async def _set_user(username: str, **values: Any) -> None:
    async with async_test_db_session.begin() as db:
        await db.execute(update(User).where(User.username == username).values(**values))


async def _deliveries(kind: str = 'pytest.channel') -> list[NotificationDelivery]:
    async with async_test_db_session() as db:
        return list(
            (
                await db.scalars(
                    select(NotificationDelivery)
                    .where(NotificationDelivery.kind == kind)
                    .order_by(NotificationDelivery.id)
                )
            ).all()
        )


async def _purge() -> None:
    async with async_test_db_session.begin() as db:
        await db.execute(delete(NotificationDelivery).where(NotificationDelivery.kind.like('pytest%')))
        await db.execute(delete(NotificationPolicy).where(NotificationPolicy.kind.like('pytest%')))
        await db.execute(delete(NotificationPref).where(NotificationPref.kind.like('pytest%')))
        await db.execute(delete(Notification).where(Notification.title.like(f'{TITLE}%')))


async def _policy(kind: str, channel: str, mode: str) -> None:
    async with async_test_db_session.begin() as db:
        await db.execute(
            delete(NotificationPolicy).where(NotificationPolicy.kind == kind, NotificationPolicy.channel == channel)
        )
        db.add(NotificationPolicy(kind=kind, channel=channel, mode=mode))


async def _notify(user_ids: list[int], *, kind: str = 'pytest.channel', rollback: bool = False) -> int:
    async with async_test_db_session() as db:
        dispatch = await create_in_tx(
            db, kind=kind, user_ids=user_ids, title=f'{TITLE} 标题', content='正文', link='/dashboard'
        )
        if rollback:
            await db.rollback()
        else:
            await db.commit()
        return dispatch.pending


@pytest.fixture(autouse=True)
def _isolate(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    """不推 socket、不连 broker；每条用例前后把本文件造的行清掉。外部渠道总闸按 .env 默认开着"""

    async def _noop(*args: object, **kwargs: object) -> None:  # ruff: ignore[unused-async] - 顶掉的原函数是 async
        return None

    monkeypatch.setattr('backend.plugin.notification.service.notification_service.notification_new', _noop)
    monkeypatch.setattr(delivery_service, 'kick', _noop)
    monkeypatch.setattr(settings, 'NOTIFICATION_EXTERNAL_ENABLED', True)
    _call(client, _purge)
    yield
    _call(client, _purge)
    _call(client, _set_user, 'test', phone=None, status=1)


# ── 纯函数：四态 × 偏好 ─────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    ('mode', 'pref', 'configurable', 'expected'),
    [
        (PolicyMode.off, True, True, False),
        (PolicyMode.forced, False, True, True),
        (PolicyMode.default_on, None, True, True),
        (PolicyMode.default_on, False, True, False),
        (PolicyMode.default_off, None, True, False),
        (PolicyMode.default_off, True, True, True),
        # 不让人自己设的类型：个人偏好一律不看（库里留着一行旧偏好也不生效）
        (PolicyMode.default_off, True, False, False),
        (PolicyMode.default_on, False, False, True),
    ],
)
def test_policy_times_pref(
    mode: PolicyMode,
    pref: bool | None,  # ruff: ignore[boolean-type-hint-positional-argument] - parametrize 按位置传
    configurable: bool,  # ruff: ignore[boolean-type-hint-positional-argument] - parametrize 按位置传
    expected: bool,  # ruff: ignore[boolean-type-hint-positional-argument] - parametrize 按位置传
) -> None:
    assert wants(mode, pref=pref, configurable=configurable) is expected


def test_overrides_cannot_touch_inapp_or_unsupported_channels() -> None:
    kind = get_notification_kind('pytest.channel')
    assert kind is not None
    modes = effective_modes(kind, {'inapp': 'off', 'email': 'forced', 'bogus': 'forced'})
    assert modes[NotificationChannel.inapp] is PolicyMode.forced
    assert modes[NotificationChannel.email] is PolicyMode.forced


# ── 注册表守卫 ───────────────────────────────────────────────────────────────


class TestRegistry:
    def test_inapp_must_be_forced(self) -> None:
        with pytest.raises(ValueError, match='forced'):
            register_notification_kind(
                'pytest.bad_inapp', label='x', category=NotificationCategory.SYSTEM, defaults={'inapp': 'default_on'}
            )

    def test_broadcast_only_goes_inapp(self) -> None:
        with pytest.raises(ValueError, match='广播'):
            register_notification_kind(
                'pytest.bad_broadcast',
                label='x',
                category=NotificationCategory.SYSTEM,
                defaults={'inapp': 'forced', 'email': 'off'},
                broadcast=True,
            )

    def test_sms_needs_a_template(self) -> None:
        with pytest.raises(ValueError, match='sms_template'):
            register_notification_kind(
                'pytest.bad_sms', label='x', category=NotificationCategory.SYSTEM, defaults={'sms': 'default_off'}
            )

    def test_conflicting_redefinition_raises(self) -> None:
        with pytest.raises(ValueError, match='定义不同'):
            register_notification_kind(
                'pytest.channel', label='改了名字', category=NotificationCategory.SYSTEM, defaults={'inapp': 'forced'}
            )

    def test_every_sms_kind_points_at_a_registered_sms_template(self) -> None:
        """短信只能发审核过的模板：类型声明的模板码在短信插件里不存在，到发送时才报 —— 那时已经晚了"""
        from backend.plugin.sms.extensions import load_sms_extensions
        from backend.plugin.sms.templates import get_sms_template

        load_sms_extensions()
        missing = [k.code for k in list_notification_kinds() if k.sms_template and not get_sms_template(k.sms_template)]
        assert not missing

    def test_workflow_kinds_are_registered(self) -> None:
        from backend.plugin.notification.extensions import load_notification_extensions

        load_notification_extensions()
        codes = {k.code for k in list_notification_kinds()}
        assert {'workflow.task_assigned', 'workflow.remind', 'workflow.timeout', 'announcement'} <= codes
        assigned = get_notification_kind('workflow.task_assigned')
        assert assigned is not None
        assert not assigned.writes_inbox, '「新的待办」站内靠待办数红点，写站内行就在铃铛上重复了'


# ── 路由 → 投递行 ─────────────────────────────────────────────────────────────


class TestRouting:
    def test_default_off_writes_no_delivery(self, client: TestClient) -> None:
        uid = _call(client, _user_id, 'test')
        assert _call(client, _notify, [uid]) == 0
        assert _call(client, _deliveries) == []

    def test_forced_email_writes_a_pending_row_with_the_address(self, client: TestClient) -> None:
        uid = _call(client, _user_id, 'test')
        _call(client, _policy, 'pytest.channel', 'email', 'forced')
        assert _call(client, _notify, [uid]) == 1
        rows = _call(client, _deliveries)
        assert [(r.channel, r.status, r.address) for r in rows] == [('email', 'pending', 'test@example.com')]
        assert rows[0].notification_id is not None, '有站内行的类型，投递行要指回那一行'

    def test_missing_address_is_a_visible_skip_not_a_silent_one(self, client: TestClient) -> None:
        uid = _call(client, _user_id, 'test')
        _call(client, _policy, 'pytest.channel', 'sms', 'forced')
        assert _call(client, _notify, [uid]) == 0
        rows = _call(client, _deliveries)
        assert [(r.channel, r.status, r.reason) for r in rows] == [('sms', 'skipped', 'no_address')]

    def test_disabled_user_is_skipped(self, client: TestClient) -> None:
        uid = _call(client, _user_id, 'test')
        _call(client, _set_user, 'test', status=0)
        _call(client, _policy, 'pytest.channel', 'email', 'forced')
        _call(client, _notify, [uid])
        assert [r.reason for r in _call(client, _deliveries)] == ['user_disabled']

    def test_user_pref_turns_a_default_off_channel_on(self, client: TestClient) -> None:
        uid = _call(client, _user_id, 'test')

        async def _pref() -> None:
            async with async_test_db_session.begin() as db:
                db.add(NotificationPref(user_id=uid, kind='pytest.channel', channel='email', enabled=True))

        _call(client, _pref)
        assert _call(client, _notify, [uid]) == 1

    def test_master_switch_off_writes_inbox_only(self, client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
        uid = _call(client, _user_id, 'test')
        _call(client, _policy, 'pytest.channel', 'email', 'forced')

        async def _noop(db: object) -> None:  # ruff: ignore[unused-async]
            return None

        # 总闸由参数配置覆盖；顶掉加载，直接看 settings 的值
        monkeypatch.setattr('backend.plugin.notification.service.config.load_notification_config', _noop)
        monkeypatch.setattr(settings, 'NOTIFICATION_EXTERNAL_ENABLED', False)
        assert _call(client, _notify, [uid]) == 0
        assert _call(client, _deliveries) == []

    def test_rollback_takes_the_delivery_rows_with_it(self, client: TestClient) -> None:
        """🔴 outbox 的全部意义：业务回滚了，邮件就不该发"""
        uid = _call(client, _user_id, 'test')
        _call(client, _policy, 'pytest.channel', 'email', 'forced')
        _call(client, _notify, [uid], rollback=True)
        assert _call(client, _deliveries) == []


# ── worker 的状态机 ──────────────────────────────────────────────────────────


def _fake_email(monkeypatch: pytest.MonkeyPatch, outcome: senders.Outcome, calls: list[int] | None = None) -> None:
    async def _send(row: NotificationDelivery) -> senders.SendResult:
        if calls is not None:
            calls.append(row.id)
        await asyncio.sleep(0.05)  # 给并发那条用例留出交错的窗口
        return senders.SendResult(outcome, None if outcome is senders.Outcome.sent else 'boom', outcome.value)

    monkeypatch.setattr(senders, 'send_email', _send)


def _enqueue_one(client: TestClient) -> int:
    uid = _call(client, _user_id, 'test')
    _call(client, _policy, 'pytest.channel', 'email', 'forced')
    _call(client, _notify, [uid])
    (row,) = _call(client, _deliveries)
    return row.id


class TestWorker:
    def test_sent(self, client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
        _fake_email(monkeypatch, senders.Outcome.sent)
        _enqueue_one(client)
        _call(client, delivery_service.deliver_pending)
        (row,) = _call(client, _deliveries)
        assert (row.status, row.attempts, row.sent_time is not None) == ('sent', 1, True)

    def test_retryable_backs_off_then_exhausts(self, client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
        _fake_email(monkeypatch, senders.Outcome.retryable)

        async def _noop(db: object) -> None:  # ruff: ignore[unused-async]
            return None

        # worker 每轮从参数配置重读重试次数（库里是 4），顶掉加载才能用 settings 上的值
        monkeypatch.setattr('backend.plugin.notification.service.config.load_notification_config', _noop)
        monkeypatch.setattr(settings, 'NOTIFICATION_RETRY_MAX', 1)
        pk = _enqueue_one(client)
        _call(client, delivery_service.deliver_pending)
        (row,) = _call(client, _deliveries)
        assert row.status == 'failed'
        assert row.next_attempt_time is not None and row.next_attempt_time > timezone.now()
        # 还没到点：再扫一遍不动它
        _call(client, delivery_service.deliver_pending)
        assert _call(client, _deliveries)[0].attempts == 1

        async def _due_now() -> None:
            async with async_test_db_session.begin() as db:
                await notification_delivery_dao.settle(db, pk, next_attempt_time=timezone.now() - timedelta(seconds=1))

        _call(client, _due_now)
        _call(client, delivery_service.deliver_pending)
        (row,) = _call(client, _deliveries)
        assert (row.status, row.attempts, row.next_attempt_time) == ('exhausted', 2, None)

    def test_permanent_is_not_retried(self, client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
        _fake_email(monkeypatch, senders.Outcome.permanent)
        _enqueue_one(client)
        _call(client, delivery_service.deliver_pending)
        assert _call(client, _deliveries)[0].status == 'exhausted'

    def test_unknown_is_never_retried(self, client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
        """🔴 可能已经发出去了：重试就是重复发"""
        _fake_email(monkeypatch, senders.Outcome.unknown)
        _enqueue_one(client)
        _call(client, delivery_service.deliver_pending)
        (row,) = _call(client, _deliveries)
        assert (row.status, row.next_attempt_time) == ('unknown', None)

    def test_two_workers_send_each_row_once(self, client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
        calls: list[int] = []
        _fake_email(monkeypatch, senders.Outcome.sent, calls)
        pk = _enqueue_one(client)

        async def _race() -> None:
            # 直接让两个 worker 抢同一行：两遍完整的 deliver_pending 在单个循环里
            # 几乎不会在「取一批」和「抢占」之间交错，
            # 变异（去掉 claim 的状态条件）下照样绿 —— 实测过
            await asyncio.gather(delivery_service._deliver_one(pk), delivery_service._deliver_one(pk))

        _call(client, _race)
        assert calls == [pk]

    def test_stuck_in_sending_becomes_unknown_not_pending(self, client: TestClient) -> None:
        pk = _enqueue_one(client)

        async def _stick() -> None:
            async with async_test_db_session.begin() as db:
                await db.execute(
                    update(NotificationDelivery)
                    .where(NotificationDelivery.id == pk)
                    .values(status='sending', updated_time=timezone.now() - timedelta(hours=1))
                )

        _call(client, _stick)
        _call(client, delivery_service.deliver_pending)
        (row,) = _call(client, _deliveries)
        assert (row.status, row.reason) == ('unknown', 'stale')


class TestSenderClassification:
    def test_smtp_errors(self) -> None:
        import aiosmtplib

        perm = aiosmtplib.SMTPRecipientsRefused([])
        assert senders.classify_smtp_error(perm)[0] is senders.Outcome.permanent
        assert (
            senders.classify_smtp_error(aiosmtplib.SMTPResponseException(550, 'no such user'))[0]
            is senders.Outcome.permanent
        )
        assert (
            senders.classify_smtp_error(aiosmtplib.SMTPResponseException(451, 'try later'))[0]
            is senders.Outcome.retryable
        )
        assert senders.classify_smtp_error(aiosmtplib.SMTPConnectError('refused'))[0] is senders.Outcome.retryable

    def test_email_sender_reads_the_cause_of_gateway_error(
        self, client: TestClient, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        import aiosmtplib

        async def _boom(*args: object, **kwargs: object) -> None:  # ruff: ignore[unused-async]
            raise errors.GatewayError(msg='邮件发送失败') from aiosmtplib.SMTPRecipientsRefused([])

        monkeypatch.setattr('backend.plugin.email.utils.send.send_email', _boom)
        _enqueue_one(client)
        (row,) = _call(client, _deliveries)
        result = _call(client, senders.send_email, row)
        assert (result.outcome, result.reason) == (senders.Outcome.permanent, 'recipient_refused')

    @pytest.mark.parametrize(
        ('kind', 'expected'),
        [
            ('unknown', 'unknown'),
            ('network_unsent', 'retryable'),
            ('invalid_phone', 'permanent'),
            ('rate_limited', 'retryable'),
        ],
    )
    def test_sms_error_kinds(
        self, client: TestClient, monkeypatch: pytest.MonkeyPatch, kind: str, expected: str
    ) -> None:
        from backend.plugin.sms.errors import SmsSendError
        from backend.plugin.sms.service.sms_service import sms_service

        async def _boom(**kwargs: object) -> None:  # ruff: ignore[unused-async]
            raise SmsSendError(kind=kind, msg='x')

        monkeypatch.setattr(sms_service, 'send', _boom)
        spec = get_notification_kind('pytest.channel')
        row = NotificationDelivery(
            notification_id=None,
            user_id=1,
            kind='pytest.channel',
            channel='sms',
            address='13800000000',
            title='t',
            content='c',
            link=None,
            status='sending',
        )
        result = _call(client, senders.send_sms, row, spec)
        assert result.outcome.value == expected


# ── 接口 ─────────────────────────────────────────────────────────────────────


class TestApi:
    def test_policy_matrix_and_restore_default(self, client: TestClient, token_headers: dict[str, str]) -> None:
        r = client.put(
            f'{API}/policies',
            json={'items': [{'kind': 'pytest.channel', 'channel': 'email', 'mode': 'forced'}]},
            headers=token_headers,
        )
        assert r.status_code == 200, r.text
        rows = {p['kind']: p for p in client.get(f'{API}/policies', headers=token_headers).json()['data']}
        email = next(c for c in rows['pytest.channel']['cells'] if c['channel'] == 'email')
        assert (email['mode'], email['default']) == ('forced', 'default_off')
        # 改回默认值 = 删掉那一格
        client.put(
            f'{API}/policies',
            json={'items': [{'kind': 'pytest.channel', 'channel': 'email', 'mode': 'default_off'}]},
            headers=token_headers,
        )

        async def _count() -> int:
            async with async_test_db_session() as db:
                return len(
                    (
                        await db.scalars(select(NotificationPolicy).where(NotificationPolicy.kind == 'pytest.channel'))
                    ).all()
                )

        assert _call(client, _count) == 0

    @pytest.mark.parametrize(
        'item',
        [
            {'kind': 'pytest.channel', 'channel': 'inapp', 'mode': 'off'},
            {'kind': 'announcement', 'channel': 'email', 'mode': 'forced'},
            {'kind': 'pytest.nope', 'channel': 'email', 'mode': 'forced'},
        ],
    )
    def test_policy_rejects_cells_that_cannot_exist(
        self, client: TestClient, token_headers: dict[str, str], item: dict[str, str]
    ) -> None:
        r = client.put(f'{API}/policies', json={'items': [item]}, headers=token_headers)
        assert r.json()['code'] == 400, r.text

    def test_my_prefs_reject_forced_cells(self, client: TestClient, token_headers: dict[str, str]) -> None:
        """🔴 存得进去就是一个「界面显示已关闭、实际照发」的格子"""
        _call(client, _policy, 'pytest.channel', 'email', 'forced')
        r = client.put(
            f'{API}/prefs/me',
            json={'items': [{'kind': 'pytest.channel', 'channel': 'email', 'enabled': False}]},
            headers=token_headers,
        )
        assert r.json()['code'] == 400, r.text

    def test_my_prefs_round_trip(self, client: TestClient, token_headers: dict[str, str]) -> None:
        r = client.put(
            f'{API}/prefs/me',
            json={'items': [{'kind': 'pytest.channel', 'channel': 'email', 'enabled': True}]},
            headers=token_headers,
        )
        assert r.status_code == 200 and r.json()['code'] == 200, r.text
        data = client.get(f'{API}/prefs/me', headers=token_headers).json()['data']
        row = next(i for i in data['items'] if i['kind'] == 'pytest.channel')
        cells = {c['channel']: c for c in row['cells']}
        assert cells['email']['enabled'] is True and cells['email']['configurable'] is True
        assert cells['inapp']['configurable'] is False
        assert data['has_email'] is True
        assert all(i['kind'] != 'announcement' for i in data['items']), '不让人自己设的类型不出现在个人中心'

    def test_deliveries_list_masks_and_resend(
        self, client: TestClient, token_headers: dict[str, str], monkeypatch: pytest.MonkeyPatch
    ) -> None:
        _fake_email(monkeypatch, senders.Outcome.permanent)
        pk = _enqueue_one(client)
        page = client.get(f'{API}/deliveries', params={'kind': 'pytest.channel'}, headers=token_headers).json()['data']
        assert page['items'][0]['address'] == 't***@example.com'
        detail = client.get(f'{API}/deliveries/{pk}', headers=token_headers).json()['data']
        assert detail['address'] == 'test@example.com'
        # 待发的不能重发
        assert client.post(f'{API}/deliveries/{pk}/resend', headers=token_headers).json()['code'] == 409
        _call(client, delivery_service.deliver_pending)
        assert _call(client, _deliveries)[0].status == DeliveryStatus.exhausted.value
        assert client.post(f'{API}/deliveries/{pk}/resend', headers=token_headers).json()['code'] == 200
        (row,) = _call(client, _deliveries)
        assert (row.status, row.attempts) == ('pending', 0)
