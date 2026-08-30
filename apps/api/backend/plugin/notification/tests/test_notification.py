"""站内通知接口测试

覆盖的是**这套设计里真正会静默出错**的那几处，不是凑覆盖率：

- 广播 vs 定向的可见性：广播不 fan-out 成 N 行，可见性完全靠 `recipient_id IS NULL`
  那一半 OR 条件。漏了它，表现是「公告一条都看不见」，不报错
- 未读数：NOT EXISTS 子查询算错的话，红点会常年挂着一个不掉的数字
- 标记已读幂等：重复点一条已读通知不能报错（也不能插出第二行撞唯一约束）
- 越权标记已读：别人的定向通知不能被标记 —— 那会往关联表里写出一行
  「A 读过一条只发给 B 的通知」，同时也泄漏了「这条 ID 存在」
- 公告发布 → 收件箱：`notice_service` 那条顺带写入的链路，断了不会有任何报错

⚠️ socket 推送在测试里被顶掉了（`_no_socket`）：`sio.emit` 要连 Redis 的
AsyncRedisManager，而推送失败本来就被 `_push()` 吞掉——不顶的话测试仍然会绿，
只是每条都要等一次连接超时。
"""

import asyncio

from collections.abc import Awaitable, Callable, Generator
from typing import TypeVar

import pytest

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.testclient import TestClient

from backend.database.db import create_database_async_engine, create_database_async_session, get_database_url
from backend.plugin.notification.model import Notification, NotificationRead

_T = TypeVar('_T')

NOTIFICATIONS = '/sys/notifications'
NOTICES = '/sys/notices'


@pytest.fixture(autouse=True)
def _no_socket(monkeypatch: pytest.MonkeyPatch) -> None:
    """把推送顶成 no-op —— 被测的是入库与可见性，不是 socket"""

    async def _noop(*args: object, **kwargs: object) -> None:  # ruff: ignore[unused-async] - 顶掉的原函数是 async，签名要对上
        return None

    monkeypatch.setattr('backend.plugin.notification.service.notification_service.notification_new', _noop)


def _run_on_test_db(work: Callable[[AsyncSession], Awaitable[_T]]) -> _T:
    """在一次性引擎上跑一段异步 DB 代码。

    🔴 **不能复用 `backend.tests.utils.db.async_test_db_session`**：那个引擎是
    模块级单例，连接池里的连接绑在 TestClient 用的那个事件循环上。测试里再
    `asyncio.run(...)` 是一个**新**循环，拿到同一个池里的连接就是
    `got Future attached to a different loop`（实测踩过，teardown 全红）。
    每次自己建一个引擎、用完 dispose，就与调用时的循环无关。
    """

    async def _main() -> _T:
        engine = create_database_async_engine(get_database_url(unittest=True))
        session_factory = create_database_async_session(engine)
        try:
            async with session_factory() as db:
                result = await work(db)
                await db.commit()
                return result
        finally:
            await engine.dispose()

    return asyncio.run(_main())


@pytest.fixture
def cleanup() -> Generator[list[str], None, None]:
    """收集本次用例造出来的通知标题，结束后连同**新增的已读标记**一起清干净。

    🔴 光删通知行不够，已读标记也要回滚。`test_read_all_clears_unread` 会把
    **种子里那几条**通知也标记成已读，而那些行不属于任何一个 title ——
    留着的话下一次跑 `unread=true` 一条都查不到，测试互相污染，
    表现是「单独跑绿、整文件跑红」。`fba_test` 同时也是 Playwright E2E 的库，
    用例必须把它还原成跑之前的样子。
    """
    titles: list[str] = []

    async def _snapshot(db: AsyncSession) -> set[int]:
        return {r[0] for r in (await db.execute(select(NotificationRead.id))).all()}

    before = _run_on_test_db(_snapshot)

    yield titles

    async def _purge(db: AsyncSession) -> None:
        fresh = {r[0] for r in (await db.execute(select(NotificationRead.id))).all()} - before
        if fresh:
            await db.execute(delete(NotificationRead).where(NotificationRead.id.in_(fresh)))
        for title in titles:
            rows = (await db.execute(select(Notification.id).where(Notification.title == title))).all()
            pks = [r[0] for r in rows]
            if pks:
                await db.execute(delete(NotificationRead).where(NotificationRead.notification_id.in_(pks)))
                await db.execute(delete(Notification).where(Notification.id.in_(pks)))

    _run_on_test_db(_purge)


def _send(
    client: TestClient,
    headers: dict[str, str],
    cleanup: list[str],
    *,
    title: str,
    recipient_ids: list[str] | None = None,
    category: int = 0,
) -> None:
    cleanup.append(title)
    res = client.post(
        f'{NOTIFICATIONS}/send',
        headers=headers,
        json={
            'title': title,
            'content': f'{title} 的正文',
            'category': category,
            'recipient_ids': recipient_ids or [],
        },
    )
    assert res.status_code == 200, res.text


def _list(client: TestClient, headers: dict[str, str], **params: object) -> list[dict]:
    res = client.get(NOTIFICATIONS, headers=headers, params=params)
    assert res.status_code == 200, res.text
    return res.json()['data']['items']


def _unread_total(client: TestClient, headers: dict[str, str]) -> int:
    res = client.get(f'{NOTIFICATIONS}/unread-count', headers=headers)
    assert res.status_code == 200, res.text
    return res.json()['data']['total']


def _find(items: list[dict], title: str) -> dict | None:
    return next((i for i in items if i['title'] == title), None)


# ─── 可见性 ────────────────────────────────────────────────────────────────────


def test_broadcast_is_visible_without_fanout(
    client: TestClient, token_headers: dict[str, str], cleanup: list[str]
) -> None:
    """🔴 广播只有一行（`recipient_id` 为空），可见性全靠 OR 的另一半

    漏掉 `recipient_id IS NULL` 那一半，公告会一条都查不到，而接口照样 200。
    """
    _send(client, token_headers, cleanup, title='pytest 广播通知')
    item = _find(_list(client, token_headers), 'pytest 广播通知')
    assert item is not None
    assert item['recipient_id'] is None
    assert item['read_time'] is None


def test_targeted_notification_is_invisible_to_others(
    client: TestClient, token_headers: dict[str, str], cleanup: list[str]
) -> None:
    """定向给别人的通知，自己既看不到、也标不了已读"""
    other_id = '2049946297615646720'  # 种子里的 test 账号
    _send(client, token_headers, cleanup, title='pytest 定向给别人', recipient_ids=[other_id])
    assert _find(_list(client, token_headers), 'pytest 定向给别人') is None


def test_marking_someone_elses_notification_is_404(
    client: TestClient, token_headers: dict[str, str], cleanup: list[str]
) -> None:
    """🔴 看不见的通知不能标记已读

    能标的话，关联表里会长出「A 读过一条只发给 B 的通知」，
    而且这个写接口顺带确认了「这条 ID 存在」。
    """
    other_id = '2049946297615646720'
    _send(client, token_headers, cleanup, title='pytest 越权标记', recipient_ids=[other_id])

    async def _pk(db: AsyncSession) -> int:
        row = (await db.execute(select(Notification.id).where(Notification.title == 'pytest 越权标记'))).first()
        assert row is not None
        return row[0]

    pk = _run_on_test_db(_pk)
    res = client.put(f'{NOTIFICATIONS}/{pk}/read', headers=token_headers)
    assert res.status_code == 404, res.text


# ─── 未读数与已读 ──────────────────────────────────────────────────────────────


def test_unread_count_moves_with_read_state(
    client: TestClient, token_headers: dict[str, str], cleanup: list[str]
) -> None:
    """发一条 → 未读数 +1；标已读 → 回落"""
    before = _unread_total(client, token_headers)
    _send(client, token_headers, cleanup, title='pytest 未读计数')
    assert _unread_total(client, token_headers) == before + 1

    item = _find(_list(client, token_headers), 'pytest 未读计数')
    assert item is not None
    assert client.put(f'{NOTIFICATIONS}/{item["id"]}/read', headers=token_headers).status_code == 200
    assert _unread_total(client, token_headers) == before


def test_mark_read_is_idempotent(client: TestClient, token_headers: dict[str, str], cleanup: list[str]) -> None:
    """🔴 重复标记已读要成功且不改变计数

    幂等是靠「先查已读的、只插差集」实现的（三种方言的冲突语法各不相同，
    见 `crud_notification.mark_read`）。退化成无条件 INSERT 的话，
    第二次点会撞唯一约束 → 500。
    """
    _send(client, token_headers, cleanup, title='pytest 幂等已读')
    item = _find(_list(client, token_headers), 'pytest 幂等已读')
    assert item is not None

    assert client.put(f'{NOTIFICATIONS}/{item["id"]}/read', headers=token_headers).status_code == 200
    after_first = _unread_total(client, token_headers)
    assert client.put(f'{NOTIFICATIONS}/{item["id"]}/read', headers=token_headers).status_code == 200
    assert _unread_total(client, token_headers) == after_first


def test_unread_filter_splits_read_and_unread(
    client: TestClient, token_headers: dict[str, str], cleanup: list[str]
) -> None:
    """`unread=true/false` 要真的把两边分开（NOT EXISTS 与它的取反）"""
    _send(client, token_headers, cleanup, title='pytest 筛选未读')
    item = _find(_list(client, token_headers, unread=True), 'pytest 筛选未读')
    assert item is not None
    assert _find(_list(client, token_headers, unread=False), 'pytest 筛选未读') is None

    client.put(f'{NOTIFICATIONS}/{item["id"]}/read', headers=token_headers)
    assert _find(_list(client, token_headers, unread=True), 'pytest 筛选未读') is None
    assert _find(_list(client, token_headers, unread=False), 'pytest 筛选未读') is not None


def test_read_all_clears_unread(client: TestClient, token_headers: dict[str, str], cleanup: list[str]) -> None:
    """全部已读之后未读数必须是 0"""
    _send(client, token_headers, cleanup, title='pytest 全部已读 A')
    _send(client, token_headers, cleanup, title='pytest 全部已读 B')
    assert _unread_total(client, token_headers) > 0
    assert client.put(f'{NOTIFICATIONS}/read-all', headers=token_headers).status_code == 200
    assert _unread_total(client, token_headers) == 0


# ─── 公告发布 → 收件箱 ─────────────────────────────────────────────────────────


def test_publishing_a_notice_lands_in_the_inbox(
    client: TestClient, token_headers: dict[str, str], cleanup: list[str]
) -> None:
    """🔴 `status=显示` 的公告要顺带在收件箱里出现一条广播

    这条链路断了**不会有任何报错**：公告照样建出来、列表页照样显示，
    只是没人收得到。
    """
    title = 'pytest 公告发布链路'
    cleanup.append(title)
    created = client.post(
        NOTICES,
        headers=token_headers,
        json={'title': title, 'type': 1, 'status': 1, 'content': '<p>正文</p>'},
    )
    assert created.status_code == 200, created.text
    notice_id = created.json()['data']['id']
    try:
        item = _find(_list(client, token_headers, category=1), title)
        assert item is not None
        # 正文**不**复制进通知（会变成两份各自过期的真相），只留链接
        assert item['link'] == '/plugins/notice'
    finally:
        client.request('DELETE', NOTICES, headers=token_headers, json={'pks': [notice_id]})


def test_hidden_notice_does_not_notify(client: TestClient, token_headers: dict[str, str], cleanup: list[str]) -> None:
    """隐藏状态的公告不该打扰任何人 —— 它还没发布"""
    title = 'pytest 隐藏公告'
    cleanup.append(title)
    created = client.post(
        NOTICES,
        headers=token_headers,
        json={'title': title, 'type': 1, 'status': 0, 'content': '<p>草稿</p>'},
    )
    assert created.status_code == 200, created.text
    notice_id = created.json()['data']['id']
    try:
        assert _find(_list(client, token_headers, category=1), title) is None
    finally:
        client.request('DELETE', NOTICES, headers=token_headers, json={'pks': [notice_id]})
