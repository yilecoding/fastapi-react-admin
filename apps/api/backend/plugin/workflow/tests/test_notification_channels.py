"""审批流 × 通知渠道路由（#166）：真实接口 + 真实审批引擎，断言投递行。

- 「你有新的待办」**只**走本人开了的外部渠道，不写站内行（站内靠待办数红点）
- 催办默认走邮件（`workflow.remind` 的邮件是 default_on）
- 自己的动作不通知自己 —— 外部渠道也一样
"""

from collections.abc import Callable, Generator

import pytest

from sqlalchemy import delete, select
from starlette.testclient import TestClient

from backend.plugin.notification.model import Notification, NotificationDelivery, NotificationPref
from backend.plugin.notification.service import delivery_service
from backend.plugin.workflow.service import runtime_service
from backend.plugin.workflow.tests.conftest import ok
from backend.plugin.workflow.tests.test_runtime import act, leave_form, start
from backend.tests.utils.db import async_test_db_session

Login = Callable[[str], dict[str, str]]
Uid = Callable[[str], str]
PREFS = '/sys/notification-channels/prefs/me'


async def _purge() -> None:
    async with async_test_db_session.begin() as db:
        await db.execute(delete(NotificationDelivery).where(NotificationDelivery.kind.like('workflow.%')))
        await db.execute(delete(NotificationPref).where(NotificationPref.kind.like('workflow.%')))


async def _rows(user_id: int) -> list[NotificationDelivery]:
    async with async_test_db_session() as db:
        stmt = (
            select(NotificationDelivery)
            .where(NotificationDelivery.user_id == user_id)
            .order_by(NotificationDelivery.id)
        )
        return list((await db.scalars(stmt)).all())


async def _inbox_titles(user_id: int) -> list[str]:
    async with async_test_db_session() as db:
        return list((await db.scalars(select(Notification.title).where(Notification.recipient_id == user_id))).all())


@pytest.fixture(autouse=True)
def _isolate(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> Generator[None, None, None]:
    async def _noop(*args: object, **kwargs: object) -> None:  # ruff: ignore[unused-async]
        return None

    monkeypatch.setattr(runtime_service, 'workflow_todo_changed', _noop)
    monkeypatch.setattr(runtime_service, 'notification_new', _noop)
    monkeypatch.setattr(delivery_service, 'kick', _noop)
    client.portal.call(_purge)
    yield
    client.portal.call(_purge)


def test_new_todo_goes_only_to_the_channel_the_assignee_opted_into(client: TestClient, login: Login, uid: Uid) -> None:
    zhaolei = int(uid('zhaolei'))
    ok(
        client.put(
            PREFS,
            headers=login('zhaolei'),
            json={'items': [{'kind': 'workflow.task_assigned', 'channel': 'email', 'enabled': True}]},
        )
    )

    pk = start(client, login('sunqiang'), leave_form(uid))

    rows = client.portal.call(_rows, zhaolei)
    assigned = [r for r in rows if r.kind == 'workflow.task_assigned']
    assert [(r.channel, r.status) for r in assigned] == [('email', 'pending')]
    assert assigned[0].notification_id is None
    assert pk in (assigned[0].link or '')
    # 站内不写：铃铛上不出现「新的待办」（待办数红点已经说了这件事）
    assert not [t for t in client.portal.call(_inbox_titles, zhaolei) if t.startswith('新的待办')]


def test_new_todo_without_opt_in_writes_nothing(client: TestClient, login: Login, uid: Uid) -> None:
    start(client, login('sunqiang'), leave_form(uid))
    assert [r for r in client.portal.call(_rows, int(uid('zhaolei'))) if r.kind == 'workflow.task_assigned'] == []


def test_remind_emails_the_assignee_by_default(client: TestClient, login: Login, uid: Uid) -> None:
    pk = start(client, login('sunqiang'), leave_form(uid))
    ok(act(client, login('sunqiang'), pk, 'remind'))
    rows = [r for r in client.portal.call(_rows, int(uid('zhaolei'))) if r.kind == 'workflow.remind']
    assert [(r.channel, r.status, r.address) for r in rows] == [('email', 'pending', 'zhaolei@example.com')]
    # 发起人自己不收（自己的动作不通知自己）
    assert [r for r in client.portal.call(_rows, int(uid('sunqiang'))) if r.kind == 'workflow.remind'] == []
