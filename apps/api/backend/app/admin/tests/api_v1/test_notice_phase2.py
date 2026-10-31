"""公告二期（#190）：发布范围 · 定时发布 + 过期撤回（`notice.sync_inbox`）· 新账号的「未读」
· 弹窗 / 横幅 / 登录页 · 阅读统计。

用种子里的真实账号（ID 每个方言不一样，按用户名 / 编码现查）：

| 账号 | 部门 | 角色 |
|---|---|---|
| `liuyang` | 后端组（技术中心的下级） | STAFF |
| `zhangwei` | 技术中心 | MANAGER |
| `sunqiang` | 市场运营中心 | STAFF |
| `zhoumin` | 总部 | VIEWER |

都没有公告的任何权限码（管理端的口 403），密码都是 123456。
"""

import asyncio
import uuid

from collections.abc import Callable, Generator, Iterator
from contextlib import contextmanager
from datetime import datetime, timedelta
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from sqlalchemy import delete, event, select, text, update
from starlette.testclient import TestClient

from backend.app.admin.model import Dept, Role, User
from backend.app.admin.tests.api_v1.test_file import _docx_bytes
from backend.app.admin.tests.api_v1.test_notice_reach import (
    FEED,
    FILES,
    INBOX,
    NOTICES,
    _call,
    _create,
    _feed,
    _inbox_rows,
    _purge_inbox,
    _update,
)
from backend.app.task.tasks.notice.tasks import sync_inbox_once
from backend.core.conf import settings
from backend.plugin.notice.model import Notice
from backend.plugin.notification.model import (
    Notification,
    NotificationAudience,
    NotificationBot,
    NotificationDelivery,
    NotificationRead,
)
from backend.plugin.notification.service import notification_service as ns_module
from backend.tests.utils.db import async_test_db_session, async_test_engine
from backend.utils.timezone import timezone

PUBLIC = '/sys/notices/public'
POPUPS = '/sys/notices/feed/popups'
BANNER = '/sys/notices/feed/banner'


@pytest.fixture(autouse=True)
def isolated_upload_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """同 `test_file.py` 的同名 fixture：两棵落盘树都顶到 tmp"""
    from backend.utils import file_ops

    (tmp_path / 'upload').mkdir()
    (tmp_path / 'upload-public').mkdir()
    monkeypatch.setattr(file_ops, 'UPLOAD_DIR', tmp_path / 'upload')
    monkeypatch.setattr(file_ops, 'PUBLIC_UPLOAD_DIR', tmp_path / 'upload-public')


@pytest.fixture
def notices(client: TestClient, token_headers: dict[str, str]) -> Generator[list[int], None, None]:
    """同 `test_notice_reach.py` 的同名 fixture：收集本条用例建的公告，结束后删公告（受众行跟着硬删）、硬删收件箱行"""
    made: list[int] = []
    yield made
    if made:
        client.request('DELETE', NOTICES, headers=token_headers, json={'pks': made})
    for pk in made:
        _call(client, _purge_inbox, f'notice:{pk}')


# ─── 工具 ──────────────────────────────────────────────────────────────────────


def _login(client: TestClient, username: str, password: str = '123456') -> dict[str, str]:
    body = client.post('/auth/login/swagger', params={'username': username, 'password': password}).json()
    assert 'access_token' in body, f'{username} 登录失败：{body}'
    return {'Authorization': f'{body["token_type"]} {body["access_token"]}'}


def _id_of(client: TestClient, model: Any, **where: Any) -> int:
    async def _q() -> int:
        async with async_test_db_session() as db:
            stmt = select(model.id).where(model.deleted == 0, *[getattr(model, k) == v for k, v in where.items()])
            pk = await db.scalar(stmt)
            assert pk is not None, f'{model.__name__} {where} 不存在'
            return pk

    return _call(client, _q)


def _set_columns(client: TestClient, pk: Any, **values: Any) -> None:
    """直接改库（模拟「时间过去了」）。

    🔴 走 Core 不走 `text()`：后者在 SQL Server 上把时区偏移丢掉、偏八小时（tests 分册）
    """

    async def _do() -> None:
        async with async_test_db_session.begin() as db:
            await db.execute(update(Notice).where(Notice.id == int(pk)).values(**values))

    _call(client, _do)


def _live_rows(client: TestClient, pk: Any) -> list[int]:
    async def _q() -> list[int]:
        async with async_test_db_session() as db:
            stmt = select(Notification.id).where(Notification.source == f'notice:{pk}', Notification.deleted == 0)
            return list((await db.scalars(stmt)).all())

    return _call(client, _q)


def _unread_rows(client: TestClient, headers: dict[str, str], pk: Any) -> list[dict[str, Any]]:
    resp = client.get(INBOX, headers=headers, params={'page': 1, 'size': 100, 'unread': True})
    assert resp.status_code == 200, resp.text
    return [n for n in resp.json()['data']['items'] if n.get('source') == f'notice:{pk}']


def _feed_ids(client: TestClient, headers: dict[str, str]) -> list[str]:
    return [n['id'] for n in _feed(client, headers)]


def _ids(resp: Any) -> list[str]:
    assert resp.status_code == 200, resp.text
    return [n['id'] for n in resp.json()['data']]


@pytest.fixture
def pushes(monkeypatch: pytest.MonkeyPatch) -> list[object]:
    """记下提交后推出去的 `notification:new`（不连 socket）"""
    seen: list[object] = []

    async def _record(user_id: object) -> None:  # ruff: ignore[unused-async] - 顶掉的原函数是 async
        seen.append(user_id)

    monkeypatch.setattr(ns_module, 'notification_new', _record)
    return seen


@pytest.fixture
def make_user(
    client: TestClient, token_headers: dict[str, str]
) -> Generator[Callable[[], tuple[int, dict]], None, None]:
    """现建一个新账号（总部 / STAFF）并登录 —— 新账号规则要「建号晚于公告」。

    收尾硬删（tests 分册：接口的删除是逻辑删除）
    """
    made: list[int] = []
    dept_id = _id_of(client, Dept, code='HQ')
    role_id = _id_of(client, Role, code='STAFF')

    def _make() -> tuple[int, dict[str, str]]:
        username = f'pytest_n2_{uuid.uuid4().hex[:8]}'
        res = client.post(
            '/sys/users',
            headers=token_headers,
            json={
                'username': username,
                'password': 'Tmp@123456',
                'nickname': '公告二期临时',
                'dept_id': str(dept_id),
                'roles': [str(role_id)],
            },
        )
        assert res.status_code == 200 and res.json()['code'] == 200, res.text
        pk = int(res.json()['data']['id'])
        made.append(pk)
        return pk, _login(client, username, 'Tmp@123456')

    yield _make

    async def _purge() -> None:
        async with async_test_db_session.begin() as db:
            for pk in made:
                await db.execute(delete(NotificationRead).where(NotificationRead.user_id == pk))
                await db.execute(text('DELETE FROM sys_user_role WHERE user_id = :pk'), {'pk': pk})
                await db.execute(delete(User).where(User.id == pk))

    if made:
        _call(client, _purge)


@pytest.fixture
def depts(client: TestClient) -> dict[str, int]:
    return {code: _id_of(client, Dept, code=code) for code in ('TECH', 'MARKETING', 'HQ')}


@pytest.fixture
def staff(client: TestClient) -> dict[str, dict[str, str]]:
    return {u: _login(client, u) for u in ('liuyang', 'zhangwei', 'sunqiang', 'zhoumin')}


# ─── 发布范围 ──────────────────────────────────────────────────────────────────


def test_dept_audience_reaches_sub_depts_and_nobody_else(
    client: TestClient,
    token_headers: dict[str, str],
    notices: list[int],
    depts: dict[str, int],
    staff: dict[str, dict[str, str]],
) -> None:
    """发给「技术中心」：后端组的 liuyang（下级部门）看得到；市场的 sunqiang 列表、详情、铃铛、标已读一律当它不存在"""
    pk = _create(client, token_headers, notices, audience=[{'kind': 'dept', 'target_id': str(depts['TECH'])}])
    inside, outside = staff['liuyang'], staff['sunqiang']

    # 先断言「有」：范围里的人哪儿都看得到
    assert str(pk) in _feed_ids(client, inside)
    assert client.get(f'{FEED}/{pk}', headers=inside).status_code == 200
    (row,) = _unread_rows(client, inside, pk)
    # 部门本身（不是下级）也在范围里
    assert str(pk) in _feed_ids(client, staff['zhangwei'])

    # 范围外：列表没有、详情 404、铃铛里没有那一行、未读数不算它、标已读 404（不能借写接口探出「这条存在」）
    assert str(pk) not in _feed_ids(client, outside)
    assert client.get(f'{FEED}/{pk}', headers=outside).status_code == 404
    assert _inbox_rows(client, outside, pk) == []
    assert _unread_rows(client, outside, pk) == []
    assert client.put(f'{INBOX}/{row["id"]}/read', headers=outside).status_code == 404
    # 总部是技术中心的**上级**：发给下级的，上级的人看不到
    assert str(pk) not in _feed_ids(client, staff['zhoumin'])

    # 全部已读也只碰得到看得见的：范围外的人点了「全部已读」，这一行不会多出他的已读标记
    assert client.put(f'{INBOX}/read-all', headers=outside).status_code == 200

    async def _readers() -> int:
        async with async_test_db_session() as db:
            return len(
                (
                    await db.scalars(
                        select(NotificationRead.id).where(NotificationRead.notification_id == int(row['id']))
                    )
                ).all()
            )

    assert _call(client, _readers) == 0


def test_role_and_user_audience(
    client: TestClient,
    token_headers: dict[str, str],
    notices: list[int],
    staff: dict[str, dict[str, str]],
) -> None:
    viewer_role = _id_of(client, Role, code='VIEWER')
    sunqiang = _id_of(client, User, username='sunqiang')
    by_role = _create(client, token_headers, notices, audience=[{'kind': 'role', 'target_id': str(viewer_role)}])
    by_user = _create(client, token_headers, notices, audience=[{'kind': 'user', 'target_id': str(sunqiang)}])

    assert str(by_role) in _feed_ids(client, staff['zhoumin'])
    assert len(_inbox_rows(client, staff['zhoumin'], by_role)) == 1
    assert str(by_role) not in _feed_ids(client, staff['sunqiang'])
    assert _inbox_rows(client, staff['sunqiang'], by_role) == []

    assert str(by_user) in _feed_ids(client, staff['sunqiang'])
    assert len(_inbox_rows(client, staff['sunqiang'], by_user)) == 1
    assert str(by_user) not in _feed_ids(client, staff['liuyang'])
    assert client.get(f'{FEED}/{by_user}', headers=staff['liuyang']).status_code == 404


def test_no_audience_means_everyone(
    client: TestClient,
    token_headers: dict[str, str],
    notices: list[int],
    staff: dict[str, dict[str, str]],
) -> None:
    pk = _create(client, token_headers, notices, audience=[])
    for headers in staff.values():
        assert str(pk) in _feed_ids(client, headers)
        assert len(_inbox_rows(client, headers, pk)) == 1


def test_attachment_of_a_targeted_notice_is_only_for_the_audience(
    client: TestClient,
    token_headers: dict[str, str],
    notices: list[int],
    depts: dict[str, int],
    staff: dict[str, dict[str, str]],
) -> None:
    """不在发布范围里的人拿到文件 ID 也下不了附件（附件权限和列表同一个 `readable_clause(viewer)`）"""
    files = {'file': ('范围附件.docx', _docx_bytes(uuid.uuid4().hex), 'application/octet-stream')}
    up = client.post(f'{FILES}/upload', headers=token_headers, files=files)
    assert up.status_code == 200 and up.json()['code'] == 200, up.text
    file_pk = up.json()['data']['id']
    try:
        pk = _create(
            client,
            token_headers,
            notices,
            attachment_ids=[file_pk],
            audience=[{'kind': 'dept', 'target_id': str(depts['TECH'])}],
        )
        assert client.get(f'{FILES}/{file_pk}/download', headers=staff['liuyang']).status_code == 200
        assert _inbox_rows(client, staff['liuyang'], pk)[0]['attachment_count'] == 1
        assert client.get(f'{FILES}/{file_pk}/download', headers=staff['sunqiang']).status_code == 404
        # 管理端照常（编辑表单要预览）
        assert client.get(f'{FILES}/{file_pk}/download', headers=token_headers).status_code == 200
    finally:
        client.request('DELETE', FILES, headers=token_headers, json={'pks': [file_pk]})


def test_audience_change_on_a_live_notice(
    client: TestClient,
    token_headers: dict[str, str],
    notices: list[int],
    depts: dict[str, int],
    staff: dict[str, dict[str, str]],
    pushes: list[object],
) -> None:
    """改发布范围不重发（还是那一行），但推一次让在线的人重拉；不传 `audience` = 不动，`[]` = 全员"""
    pk = _create(client, token_headers, notices, audience=[{'kind': 'dept', 'target_id': str(depts['TECH'])}])
    (before,) = _live_rows(client, pk)
    assert str(pk) not in _feed_ids(client, staff['sunqiang'])

    pushes.clear()
    _update(client, token_headers, pk, audience=[{'kind': 'dept', 'target_id': str(depts['MARKETING'])}])
    _call(client, asyncio.sleep, 0.05)  # 提交后的推送是 create_task 出去的
    assert pushes == [None]
    assert _live_rows(client, pk) == [before]
    assert str(pk) in _feed_ids(client, staff['sunqiang'])
    assert str(pk) not in _feed_ids(client, staff['liuyang'])

    # 不带 audience 的 PUT（老调用方）不动范围
    _update(client, token_headers, pk, title='pytest 只改标题')
    assert str(pk) not in _feed_ids(client, staff['liuyang'])
    # [] = 全员
    _update(client, token_headers, pk, audience=[])
    assert str(pk) in _feed_ids(client, staff['liuyang'])


def test_admin_list_and_detail_carry_attachment_count_and_audience(
    client: TestClient,
    token_headers: dict[str, str],
    notices: list[int],
    depts: dict[str, int],
) -> None:
    sunqiang = _id_of(client, User, username='sunqiang')
    files = {'file': ('管理端附件.docx', _docx_bytes(uuid.uuid4().hex), 'application/octet-stream')}
    up = client.post(f'{FILES}/upload', headers=token_headers, files=files)
    file_pk = up.json()['data']['id']
    try:
        title = f'pytest 管理列表 {uuid.uuid4().hex[:6]}'
        audience = [{'kind': 'dept', 'target_id': str(depts['TECH'])}, {'kind': 'user', 'target_id': str(sunqiang)}]
        pk = _create(client, token_headers, notices, title=title, attachment_ids=[file_pk], audience=audience)

        listed = client.get(NOTICES, headers=token_headers, params={'page': 1, 'size': 10, 'title': title})
        (item,) = listed.json()['data']['items']
        detail = client.get(f'{NOTICES}/{pk}', headers=token_headers).json()['data']
        for got in (item, detail):
            assert got['attachment_count'] == 1
            assert [(a['kind'], a['target_id']) for a in got['audience']] == [
                ('dept', str(depts['TECH'])),
                ('user', str(sunqiang)),
            ]
            assert got['audience'][0]['name'] == '技术中心'
            assert got['audience'][1]['name']  # 昵称（种子里各方言一致性不保证，只要有）
            assert (got['popup'], got['require_ack'], got['public'], got['publish_time']) == (False, False, False, None)
    finally:
        client.request('DELETE', FILES, headers=token_headers, json={'pks': [file_pk]})


def test_audience_targets_must_exist(
    client: TestClient,
    token_headers: dict[str, str],
    notices: list[int],
) -> None:
    """不存在的部门进了受众表谁也匹配不上 —— 这条公告就对所有人静默消失了"""
    title = f'pytest 坏范围 {uuid.uuid4().hex[:6]}'
    resp = client.post(
        NOTICES,
        headers=token_headers,
        json={
            'title': title,
            'type': 1,
            'status': 1,
            'content': '<p>x</p>',
            'audience': [{'kind': 'dept', 'target_id': '9000000000000000001'}],
        },
    )
    assert resp.status_code == 400, resp.text
    assert client.get(NOTICES, headers=token_headers, params={'title': title}).json()['data']['items'] == []


# ─── 校验 ──────────────────────────────────────────────────────────────────────


def test_switch_combinations_are_validated(
    client: TestClient,
    token_headers: dict[str, str],
    notices: list[int],
    depts: dict[str, int],
) -> None:
    base = {'type': 1, 'status': 1, 'content': '<p>x</p>'}
    dept = [{'kind': 'dept', 'target_id': str(depts['TECH'])}]

    # 必须确认但不弹窗：没有出口
    resp = client.post(NOTICES, headers=token_headers, json={**base, 'title': 'pytest 422a', 'require_ack': True})
    assert resp.status_code == 422, resp.text
    # 登录页可见 + 限定范围：自相矛盾
    resp = client.post(
        NOTICES, headers=token_headers, json={**base, 'title': 'pytest 422b', 'public': True, 'audience': dept}
    )
    assert resp.status_code == 422, resp.text
    # 先断言「合法的组合过得去」
    pk = _create(client, token_headers, notices, popup=True, require_ack=True)
    public_pk = _create(client, token_headers, notices, public=True)

    # PUT 按**生效后**的值判：库里已经是「登录页可见」，只传受众也不行；关掉弹窗而必须确认还开着也不行
    resp = client.put(f'{NOTICES}/{public_pk}', headers=token_headers, json={**base, 'title': 'x', 'audience': dept})
    assert resp.status_code == 422, resp.text
    resp = client.put(f'{NOTICES}/{pk}', headers=token_headers, json={**base, 'title': 'x', 'popup': False})
    assert resp.status_code == 422, resp.text


# ─── 定时发布 · 过期撤回（`notice.sync_inbox`） ───────────────────────────────────


def test_scheduled_notice_waits_and_the_task_publishes_it_once(
    client: TestClient,
    token_headers: dict[str, str],
    notices: list[int],
    staff: dict[str, dict[str, str]],
    pushes: list[object],
) -> None:
    later = (timezone.now() + timedelta(hours=1)).isoformat()
    pk = _create(client, token_headers, notices, publish_time=later)
    reader = staff['sunqiang']

    # 到点之前：读者看不到、不进收件箱
    assert _live_rows(client, pk) == []
    assert str(pk) not in _feed_ids(client, reader)
    assert client.get(f'{FEED}/{pk}', headers=reader).status_code == 404
    _call(client, sync_inbox_once)
    assert _live_rows(client, pk) == [], '没到点任务不该发'

    # 时间到了（直接改库模拟）：任务发一次，读者看得到、铃铛里有那一行，提交后推一次
    _set_columns(client, pk, publish_time=timezone.now() - timedelta(seconds=1))
    pushes.clear()
    stats = _call(client, sync_inbox_once)
    _call(client, asyncio.sleep, 0.05)
    assert stats['published'] >= 1
    assert None in pushes
    (row,) = _live_rows(client, pk)
    assert str(pk) in _feed_ids(client, reader)
    assert [r['id'] for r in _inbox_rows(client, reader, pk)] == [str(row)]  # 接口下发的雪花 ID 是字符串

    # 幂等：再跑两遍不重发
    _call(client, sync_inbox_once)
    _call(client, sync_inbox_once)
    assert _live_rows(client, pk) == [row]

    # 已经发出去的改成未来时间 = 撤回
    _update(client, token_headers, pk, publish_time=later)
    assert _live_rows(client, pk) == []
    assert str(pk) not in _feed_ids(client, reader)


def test_task_publishes_only_once_under_concurrency(
    client: TestClient,
    token_headers: dict[str, str],
    notices: list[int],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """两个 worker 同时发同一条：锁住公告再判「还没有挂着的行」，只发一次。

    编排：第一个进了广播（已经判过「没有行」）就停下等；第二个这时去锁同一条公告 ——
    有锁就排队，等第一个提交之后再判，看到那一行就不发；没锁的话第二个也判「没有行」，发第二行
    """
    from backend.plugin.notice.service import notice_service as svc

    pk = _create(client, token_headers, notices, publish_time=(timezone.now() + timedelta(hours=1)).isoformat())
    _set_columns(client, pk, publish_time=timezone.now() - timedelta(seconds=1))
    original = svc.notification_service.broadcast
    calls: list[int] = []

    async def _slow_first(**kwargs: Any) -> Any:
        calls.append(1)
        if len(calls) == 1:
            await asyncio.sleep(0.5)  # 第一个拿着锁停一会儿，让第二个撞上来
        return await original(**kwargs)

    monkeypatch.setattr(svc.notification_service, 'broadcast', _slow_first)

    async def _one() -> bool:
        async with async_test_db_session.begin() as db:
            return await svc.notice_service.publish_scheduled(db=db, pk=int(pk))

    async def _race() -> list[bool]:
        first = asyncio.create_task(_one())
        await asyncio.sleep(0.1)
        second = asyncio.create_task(_one())
        return list(await asyncio.gather(first, second))

    results = _call(client, _race)
    assert sorted(results) == [False, True], results
    assert len(_live_rows(client, pk)) == 1


@pytest.mark.parametrize(('first', 'second'), [('task', 'edit'), ('edit', 'edit'), ('task', 'delete')])
def test_an_edit_queues_behind_whoever_is_aligning_the_inbox(
    client: TestClient,
    token_headers: dict[str, str],
    notices: list[int],
    monkeypatch: pytest.MonkeyPatch,
    pushes: list[object],
    first: str,
    second: str,
) -> None:
    """🔴 编辑也要先锁住公告、再看「有没有挂着的行」：和定时任务、和同一个编辑点了两下排队，一条公告只挂一行。

    原来编辑不锁：另一边（任务 / 第一次提交）已经判过「没有行」、正停在广播里还没提交，编辑读到的也是「没有行」，
    于是各发一行。铃铛里同一条出现两次；而弹窗看的是「任一行未读」、`notification_id` 给的是最新那行 ——
    必须确认的点了「我已阅读」标的是新行、旧行还未读，弹窗永远关不掉。

    编排同上一条：第一个停在广播里（拿着锁），第二个（编辑，只改标题）这时撞上来。
    删除不拿这把锁也排得上：它先 UPDATE 公告行（同一行上的锁），之后才去撤收件箱行 —— 撤得到任务刚发的那一行
    """
    from backend.plugin.notice.schema.notice import DeleteNoticeParam, UpdateNoticeParam
    from backend.plugin.notice.service import notice_service as svc

    pk = _create(client, token_headers, notices, publish_time=(timezone.now() + timedelta(hours=1)).isoformat())
    # 到点了、任务还没跑：没有收件箱行。任务和编辑都会判「该看见、没有行 → 发」
    _set_columns(client, pk, publish_time=timezone.now() - timedelta(seconds=1))
    assert _live_rows(client, pk) == []
    original = svc.notification_service.broadcast
    calls: list[int] = []

    async def _slow_first(**kwargs: Any) -> Any:
        calls.append(1)
        if len(calls) == 1:
            await asyncio.sleep(0.5)
        return await original(**kwargs)

    monkeypatch.setattr(svc.notification_service, 'broadcast', _slow_first)

    async def _task() -> None:
        async with async_test_db_session.begin() as db:
            await svc.notice_service.publish_scheduled(db=db, pk=int(pk))

    async def _edit() -> None:
        title = f'pytest 并发编辑 {uuid.uuid4().hex[:6]}'
        obj = UpdateNoticeParam(title=title, type=1, status=1, content='<p>正文</p>')
        async with async_test_db_session.begin() as db:
            await svc.notice_service.update(db=db, user=None, pk=int(pk), obj=obj)

    async def _delete() -> None:
        async with async_test_db_session.begin() as db:
            await svc.notice_service.delete(db=db, obj=DeleteNoticeParam(pks=[int(pk)]))

    racers = {'task': _task, 'edit': _edit, 'delete': _delete}

    async def _race() -> None:
        a = asyncio.create_task(racers[first]())
        await asyncio.sleep(0.1)
        b = asyncio.create_task(racers[second]())
        await asyncio.gather(a, b)

    _call(client, _race)
    # 先断言「有」：确实发出去了（不是两边都没发）
    assert len(calls) >= 1
    assert len(_live_rows(client, pk)) == (0 if second == 'delete' else 1)


def test_task_retracts_a_naturally_expired_notice(
    client: TestClient,
    token_headers: dict[str, str],
    notices: list[int],
    staff: dict[str, dict[str, str]],
    pushes: list[object],
) -> None:
    """#186 时自然过期不撤回（没有事件可挂），铃铛里点进去是「已撤回或已过期」。现在任务每分钟扫一次"""
    pk = _create(client, token_headers, notices, expire_time=(timezone.now() + timedelta(hours=1)).isoformat())
    assert len(_live_rows(client, pk)) == 1
    _call(client, sync_inbox_once)
    assert len(_live_rows(client, pk)) == 1, '没过期不该撤'

    _set_columns(client, pk, expire_time=timezone.now() - timedelta(seconds=1))
    pushes.clear()
    stats = _call(client, sync_inbox_once)
    _call(client, asyncio.sleep, 0.05)
    assert stats['retracted'] >= 1
    assert _live_rows(client, pk) == []
    assert _inbox_rows(client, staff['sunqiang'], pk) == []
    assert None in pushes


def test_task_does_not_resend_legacy_notices_without_inbox_rows(
    client: TestClient,
    token_headers: dict[str, str],
    notices: list[int],
) -> None:
    """🔴 没定发布时间、又没有收件箱行的（#186 之前发的、认领不上的）不归任务管 —— 否则第一次跑就把老公告全员重发一遍"""
    pk = _create(client, token_headers, notices)

    async def _drop_row() -> None:
        async with async_test_db_session.begin() as db:
            await db.execute(delete(Notification).where(Notification.source == f'notice:{pk}'))

    _call(client, _drop_row)
    assert _live_rows(client, pk) == []
    _call(client, sync_inbox_once)
    assert _live_rows(client, pk) == []


# ─── 新账号的「未读」 ──────────────────────────────────────────────────────────


def test_new_account_does_not_inherit_old_broadcasts_as_unread(
    client: TestClient,
    token_headers: dict[str, str],
    notices: list[int],
    make_user: Callable[[], tuple[int, dict[str, str]]],
) -> None:
    old = _create(client, token_headers, notices)
    old_popup = _create(client, token_headers, notices, popup=True)
    must_ack = _create(client, token_headers, notices, popup=True, require_ack=True)
    user_id, me = make_user()
    new = _create(client, token_headers, notices)

    joined = client.get('/sys/users/me', headers=me).json()['data']['join_time']
    # 建号之前的广播：不计红点，列表里阅读时间回填成建号时间，工作台上是已读
    for pk in (old, old_popup):
        assert _unread_rows(client, me, pk) == []
    (row,) = _inbox_rows(client, me, old)
    # 按时刻比，不按字符串比：两边的时区偏移写法可以不一样（PostgreSQL 读回来是 UTC）
    assert datetime.fromisoformat(row['read_time']) == datetime.fromisoformat(joined)
    feed = {n['id']: n for n in _feed(client, me)}
    assert feed[str(old)]['read'] is True
    # 先断言「有」：建号之后发的照常是未读
    assert len(_unread_rows(client, me, new)) == 1
    assert feed[str(new)]['read'] is False

    # 🔴 例外：必须确认的弹窗只认显式已读 —— 新来的人也要点「我已阅读」
    popups = _ids(client.get(POPUPS, headers=me))
    assert str(must_ack) in popups
    assert str(old_popup) not in popups
    assert feed[str(must_ack)]['read'] is False
    # 🔴 铃铛 / 消息中心是同一个口径：那一行是未读、要确认，不回填阅读时间，红点和 `requires_ack_count` 都算它。
    # 原来收件箱这一侧照样吃新账号规则：铃铛里是已读（没有红点、没有「需确认」），弹窗却要他点「我已阅读」
    (ack_row,) = _unread_rows(client, me, must_ack)
    assert ack_row['read_time'] is None and ack_row['requires_ack'] is True
    assert client.get(f'{INBOX}/unread-count', headers=me).json()['data']['requires_ack_count'] >= 1

    # 阅读统计同一个口径：不必确认的，建号晚于发布的人不算未读；必须确认的算
    def unread_users(pk: Any) -> set[str]:
        resp = client.get(f'{NOTICES}/{pk}/reads', headers=token_headers, params={'read': False, 'size': 200})
        assert resp.status_code == 200, resp.text
        return {r['user_id'] for r in resp.json()['data']['items']}

    assert str(user_id) not in unread_users(old)
    assert str(user_id) in unread_users(must_ack)

    # 点了「我已阅读」就不再弹
    nid = next(n for n in client.get(POPUPS, headers=me).json()['data'] if n['id'] == str(must_ack))['notification_id']
    assert client.put(f'{INBOX}/{nid}/read', headers=me).status_code == 200
    assert str(must_ack) not in _ids(client.get(POPUPS, headers=me))
    assert str(user_id) not in unread_users(must_ack)
    assert _unread_rows(client, me, must_ack) == []


def test_read_all_does_not_acknowledge_for_the_reader(
    client: TestClient,
    token_headers: dict[str, str],
    notices: list[int],
    staff: dict[str, dict[str, str]],
) -> None:
    """🔴 「全部已读」只标得掉普通的；必须确认的那一行留着未读，只能单条确认
    （读者抽屉 / 弹窗 / 移动端详情的「我已阅读」）

    原来 `read-all` 只按未读取 ID，铃铛 / 消息中心 / 移动端点一下「全部已读」就替人把「我已阅读」点掉了：
    弹窗不再弹，阅读统计里他成了「已读」，而他从没看过正文
    """
    must_ack = _create(client, token_headers, notices, popup=True, require_ack=True)
    plain = _create(client, token_headers, notices)
    me = staff['sunqiang']
    # 🔴 再来一条**没有来源**的（管理端点名发的）：排除条件写成 `NOT (source IN (…))` 的话，`source IS NULL` 那一行
    # 算出来是 NULL 而不是真 —— 只要库里有一条必须确认的公告，「全部已读」就静默地跳过所有系统消息
    direct_title = f'pytest 点名 {uuid.uuid4().hex[:6]}'
    sent = client.post(
        f'{INBOX}/send',
        headers=token_headers,
        json={
            'title': direct_title,
            'content': '没有来源的系统消息',
            'category': 0,
            'recipient_ids': [str(_id_of(client, User, username='sunqiang'))],
        },
    )
    assert sent.status_code == 200, sent.text

    async def _purge_direct() -> None:
        async with async_test_db_session.begin() as db:
            pks = list((await db.scalars(select(Notification.id).where(Notification.title == direct_title))).all())
            if pks:
                await db.execute(delete(NotificationRead).where(NotificationRead.notification_id.in_(pks)))
                await db.execute(delete(NotificationDelivery).where(NotificationDelivery.notification_id.in_(pks)))
                await db.execute(delete(Notification).where(Notification.id.in_(pks)))

    try:
        _read_all_skips_must_ack(client, me, must_ack, plain, direct_title)
    finally:
        _call(client, _purge_direct)


def _read_all_skips_must_ack(
    client: TestClient, me: dict[str, str], must_ack: Any, plain: Any, direct_title: str
) -> None:
    def direct_rows(*, unread: bool) -> list[dict[str, Any]]:
        resp = client.get(INBOX, headers=me, params={'page': 1, 'size': 100, 'unread': unread, 'title': direct_title})
        assert resp.status_code == 200, resp.text
        return resp.json()['data']['items']

    # 列表那一行告诉前端「这条要打开确认」：消息中心据此不摆「标为已读」
    (ack_row,) = _unread_rows(client, me, must_ack)
    (plain_row,) = _unread_rows(client, me, plain)
    (direct_row,) = direct_rows(unread=True)
    assert ack_row['requires_ack'] is True
    assert plain_row['requires_ack'] is False
    assert direct_row['source'] is None and direct_row['requires_ack'] is False
    assert client.get(f'{INBOX}/unread-count', headers=me).json()['data']['requires_ack_count'] >= 1

    assert client.put(f'{INBOX}/read-all', headers=me).status_code == 200

    # 先断言「标掉了」：普通的那一行、没有来源的那一行确实被全部已读覆盖到了，不是接口什么都没做
    assert _unread_rows(client, me, plain) == []
    assert direct_rows(unread=True) == []
    assert [r['id'] for r in direct_rows(unread=False)] == [direct_row['id']]
    assert [r['id'] for r in _unread_rows(client, me, must_ack)] == [ack_row['id']]
    assert str(must_ack) in _ids(client.get(POPUPS, headers=me))
    assert next(n for n in _feed(client, me) if n['id'] == str(must_ack))['read'] is False
    # 剩下的未读全是必须确认的：前端拿 `total - requires_ack_count` 判「全部已读」还有没有东西可标
    count = client.get(f'{INBOX}/unread-count', headers=me).json()['data']
    assert count['total'] == count['requires_ack_count'] >= 1

    # 单条确认照常生效（「我已阅读」走的就是它）
    assert client.put(f'{INBOX}/{ack_row["id"]}/read', headers=me).status_code == 200
    assert _unread_rows(client, me, must_ack) == []
    assert str(must_ack) not in _ids(client.get(POPUPS, headers=me))
    assert _inbox_rows(client, me, must_ack)[0]['requires_ack'] is True


def test_a_must_ack_row_whose_notice_is_gone_becomes_an_ordinary_row(
    client: TestClient,
    token_headers: dict[str, str],
    notices: list[int],
    staff: dict[str, dict[str, str]],
    make_user: Callable[[], tuple[int, dict[str, str]]],
) -> None:
    """🔴 必须确认的公告过期了、任务还没扫到（最多 60 秒，任务也可能被停了）：收件箱那一行不能再要求「打开确认」。

    原来照样要：读者抽屉已经 404（点不到「我已阅读」）、弹窗不再弹，那一行又不给「标记已读」、「全部已读」跳过它 ——
    一个谁也清不掉的红点。所以「必须确认」只认**还发着**的公告（`live_clause`），之后它就是普通的一行
    """
    must_ack = _create(client, token_headers, notices, popup=True, require_ack=True)
    newcomer_id, newcomer = make_user()  # 建号晚于公告
    me = staff['sunqiang']

    def acks() -> int:
        return client.get(f'{INBOX}/unread-count', headers=me).json()['data']['requires_ack_count']

    def unread_users() -> set[str]:
        resp = client.get(f'{NOTICES}/{must_ack}/reads', headers=token_headers, params={'read': False, 'size': 200})
        assert resp.status_code == 200, resp.text
        return {r['user_id'] for r in resp.json()['data']['items']}

    # 先断言「有」：还发着的时候那一行要确认，新来的人也要（新账号规则对必须确认的不适用）
    (row,) = _unread_rows(client, me, must_ack)
    assert row['requires_ack'] is True
    assert [r['requires_ack'] for r in _unread_rows(client, newcomer, must_ack)] == [True]
    assert str(newcomer_id) in unread_users()
    before = acks()

    _set_columns(client, must_ack, expire_time=timezone.now() - timedelta(seconds=1))
    assert client.get(f'{FEED}/{must_ack}', headers=me).status_code == 404
    assert _live_rows(client, must_ack) == [int(row['id'])]  # 任务没跑：那一行还挂着
    (row,) = _unread_rows(client, me, must_ack)
    assert row['requires_ack'] is False
    assert acks() == before - 1
    # 成了普通的一行：新账号规则照常（建号之前发的算已读），阅读统计同一个口径
    assert _unread_rows(client, newcomer, must_ack) == []
    assert str(newcomer_id) not in unread_users()

    # 「全部已读」标得掉它
    assert client.put(f'{INBOX}/read-all', headers=me).status_code == 200
    assert _unread_rows(client, me, must_ack) == []


# ─── 弹窗 · 横幅 · 登录页 ────────────────────────────────────────────────────────


def test_popups_until_read_in_order_with_content(
    client: TestClient,
    token_headers: dict[str, str],
    notices: list[int],
    staff: dict[str, dict[str, str]],
) -> None:
    plain = _create(client, token_headers, notices, popup=True, content='<p>弹窗正文</p>')
    urgent = _create(client, token_headers, notices, popup=True, level=2)
    pinned = _create(client, token_headers, notices, popup=True, pinned=True)
    not_popup = _create(client, token_headers, notices)
    me = staff['sunqiang']

    resp = client.get(POPUPS, headers=me)
    items = resp.json()['data']
    ids = _ids(resp)
    assert {str(plain), str(urgent), str(pinned)} <= set(ids)
    assert str(not_popup) not in ids
    # 置顶 → 级别 → 新到旧
    assert ids.index(str(pinned)) < ids.index(str(urgent)) < ids.index(str(plain))
    by_id = {n['id']: n for n in items}
    assert by_id[str(plain)]['content'] == '<p>弹窗正文</p>'
    assert by_id[str(plain)]['popup'] is True and by_id[str(plain)]['notification_id']

    # 看过（标已读）就不再弹；已读是按人的
    assert client.put(f'{INBOX}/{by_id[str(plain)]["notification_id"]}/read', headers=me).status_code == 200
    assert str(plain) not in _ids(client.get(POPUPS, headers=me))
    assert str(plain) in _ids(client.get(POPUPS, headers=staff['liuyang']))


def test_banner_is_pinned_urgent_and_unread(
    client: TestClient,
    token_headers: dict[str, str],
    notices: list[int],
    staff: dict[str, dict[str, str]],
) -> None:
    banner = _create(client, token_headers, notices, pinned=True, level=2)
    only_pinned = _create(client, token_headers, notices, pinned=True, level=1)
    only_urgent = _create(client, token_headers, notices, level=2)
    me = staff['sunqiang']

    resp = client.get(BANNER, headers=me)
    ids = _ids(resp)
    assert str(banner) in ids
    assert str(only_pinned) not in ids and str(only_urgent) not in ids
    assert len(ids) <= 3
    item = next(n for n in resp.json()['data'] if n['id'] == str(banner))
    assert 'content' not in item

    # 关掉横幅 = 标已读
    assert client.put(f'{INBOX}/{item["notification_id"]}/read', headers=me).status_code == 200
    assert str(banner) not in _ids(client.get(BANNER, headers=me))


def test_public_endpoint_is_anonymous_plain_text_and_rate_limited(
    client: TestClient,
    token_headers: dict[str, str],
    notices: list[int],
) -> None:
    long_text = '长' * 300
    content = f'<p>第一段<b>加粗</b></p><img src="/uploads/secret.png"><script>alert(1)</script><p>{long_text}</p>'
    public = _create(client, token_headers, notices, public=True, content=content)
    private = _create(client, token_headers, notices)
    hidden = _create(client, token_headers, notices, public=True, status=0)

    # 不带任何凭据
    resp = client.get(PUBLIC)
    assert resp.status_code == 200, resp.text
    items = {n['id']: n for n in resp.json()['data']}
    assert str(public) in items
    assert str(private) not in items and str(hidden) not in items
    item = items[str(public)]
    assert set(item) == {'id', 'title', 'level', 'pinned', 'publish_time', 'created_time', 'summary'}
    assert item['publish_time'] is None
    summary = item['summary']
    assert summary.startswith(('第一段 加粗 长', '第一段加粗 长')), summary
    assert '<' not in summary and 'uploads' not in summary and 'alert' not in summary
    assert len(summary) == 200 and summary.endswith('…')

    # 浏览器里留着一个过期 / 坏的 token：登录页照样拉得到（路径在 JWT 白名单里）
    assert client.get(PUBLIC, headers={'Authorization': 'Bearer not-a-real-token'}).status_code == 200


def test_public_carries_the_publish_time_of_a_scheduled_notice(
    client: TestClient,
    token_headers: dict[str, str],
    notices: list[int],
) -> None:
    """定时发布的公告，登录页显示的时间要和读者看到的一样（`publish_time ?? created_time`）。

    原来只给 `created_time`：一条昨天建好、今天才到点的公告，登录页上写着昨天
    """
    later = (timezone.now() + timedelta(hours=1)).isoformat()
    pk = _create(client, token_headers, notices, public=True, publish_time=later)
    assert str(pk) not in _ids(client.get(PUBLIC))

    _set_columns(client, pk, publish_time=timezone.now() - timedelta(seconds=1))
    item = next(n for n in client.get(PUBLIC).json()['data'] if n['id'] == str(pk))
    stored = client.get(f'{NOTICES}/{pk}', headers=token_headers).json()['data']['publish_time']
    assert item['publish_time'] is not None
    # 按时刻比，不按字符串比（各方言读回来的偏移写法可以不一样）
    assert datetime.fromisoformat(item['publish_time']) == datetime.fromisoformat(stored)


def test_public_endpoint_is_rate_limited(client: TestClient, rate_limiter: None) -> None:
    """匿名接口不限流就是一个随便刷的口子（每个 IP 每分钟 30 次）。

    不断言「恰好第 31 次」：限流桶在 Redis 里活一分钟，一分钟内重跑时桶里已经有上一轮的数
    """
    codes = [client.get(PUBLIC).status_code for _ in range(31)]
    assert 429 in codes, codes
    assert set(codes[: codes.index(429)]) <= {200}, codes


def test_public_never_shows_a_targeted_notice(
    client: TestClient,
    token_headers: dict[str, str],
    notices: list[int],
    depts: dict[str, int],
) -> None:
    """写入时已经不许「登录页可见 + 有发布范围」；直接改库造出来的也不上登录页（查询里再要求一次没有受众行）"""
    pk = _create(client, token_headers, notices, public=True)
    assert str(pk) in _ids(client.get(PUBLIC))

    async def _add_audience() -> None:
        async with async_test_db_session.begin() as db:
            db.add(NotificationAudience(source=f'notice:{pk}', kind='dept', target_id=depts['TECH']))

    _call(client, _add_audience)
    assert str(pk) not in _ids(client.get(PUBLIC))


# ─── 阅读统计 ──────────────────────────────────────────────────────────────────


def test_reads_statistics_follow_the_audience(
    client: TestClient,
    token_headers: dict[str, str],
    notices: list[int],
    depts: dict[str, int],
    staff: dict[str, dict[str, str]],
) -> None:
    pk = _create(client, token_headers, notices, audience=[{'kind': 'dept', 'target_id': str(depts['TECH'])}])
    url = f'{NOTICES}/{pk}/reads'

    def page(*, read: bool) -> dict[str, Any]:
        resp = client.get(url, headers=token_headers, params={'read': read, 'page': 1, 'size': 200})
        assert resp.status_code == 200, resp.text
        return resp.json()['data']

    unread = page(read=False)
    names = {r['username'] for r in unread['items']}
    # 技术中心和它的下级（后端组 liuyang、前端组 chenjing）都在；范围外的不在
    assert {'zhangwei', 'liuyang', 'chenjing'} <= names
    assert not names & {'sunqiang', 'zhoumin', 'admin'}
    assert (unread['read_count'], unread['unread_count'], unread['total']) == (0, len(names), len(names))
    assert page(read=True)['items'] == []

    (row,) = _inbox_rows(client, staff['liuyang'], pk)
    assert client.put(f'{INBOX}/{row["id"]}/read', headers=staff['liuyang']).status_code == 200

    read = page(read=True)
    (reader,) = read['items']
    assert reader['username'] == 'liuyang' and reader['dept_name'] == '后端组' and reader['read_time']
    assert (read['read_count'], read['unread_count'], read['total']) == (1, len(names) - 1, 1)
    assert 'liuyang' not in {r['username'] for r in page(read=False)['items']}

    # 管理端的口：普通员工 403
    assert client.get(url, headers=staff['sunqiang']).status_code == 403


def test_reads_of_an_unpublished_notice_are_empty(
    client: TestClient,
    token_headers: dict[str, str],
    notices: list[int],
) -> None:
    """还没发到任何人手里（没到发布时间）：两边都是空的，不是「全员未读」"""
    pk = _create(client, token_headers, notices, publish_time=(timezone.now() + timedelta(hours=1)).isoformat())
    data = client.get(f'{NOTICES}/{pk}/reads', headers=token_headers, params={'read': False}).json()['data']
    assert (data['items'], data['read_count'], data['unread_count']) == ([], 0, 0)


# ─── 读者列表不读正文 ────────────────────────────────────────────────────────────


def test_feed_list_does_not_select_the_content_column(
    client: TestClient,
    token_headers: dict[str, str],
    notices: list[int],
    staff: dict[str, dict[str, str]],
) -> None:
    _create(client, token_headers, notices, content='<p>' + '正文' * 1000 + '</p>')
    seen: list[str] = []

    def _record(conn: Any, cursor: Any, statement: str, *args: Any) -> None:
        seen.append(statement)

    event.listen(async_test_engine.sync_engine, 'before_cursor_execute', _record)
    try:
        assert _feed(client, staff['sunqiang'])
    finally:
        event.remove(async_test_engine.sync_engine, 'before_cursor_execute', _record)
    notice_selects = [s for s in seen if 'FROM sys_notice' in s and 'sys_notice.title' in s]
    # 先断言「有」：确实查了公告列表（否则「没读正文」在没查的时候也成立）
    assert notice_selects, seen
    assert not [s for s in notice_selects if 'sys_notice.content' in s]


# ─── 有发布范围的不推群机器人 ─────────────────────────────────────────────────────


def test_targeted_notice_is_not_pushed_to_group_bots(
    client: TestClient,
    token_headers: dict[str, str],
    notices: list[int],
    depts: dict[str, int],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """群机器人发进的是一整个群，管不了「只给技术中心看」"""
    from backend.plugin.notification.service import bot_service, config

    enqueued: list[str] = []

    async def _noop(_db: object) -> None:  # ruff: ignore[unused-async] - 顶掉的原函数是 async
        return None

    async def _enqueue(db: object, *, kind: Any, title: str, **_: Any) -> int:  # ruff: ignore[unused-async]
        enqueued.append(title)
        return 0

    monkeypatch.setattr(config, 'load_notification_config', _noop)
    monkeypatch.setattr(bot_service, 'enqueue_bots', _enqueue)
    monkeypatch.setattr(settings, 'NOTIFICATION_EXTERNAL_ENABLED', True)

    _create(client, token_headers, notices, title='pytest 全员推群')
    _create(
        client,
        token_headers,
        notices,
        title='pytest 限定范围不推群',
        audience=[{'kind': 'dept', 'target_id': str(depts['TECH'])}],
    )
    # 先断言「有」：全员的那条确实推了
    assert enqueued == ['pytest 全员推群']


def test_widening_to_everyone_pushes_the_group_bots_once(
    client: TestClient,
    token_headers: dict[str, str],
    notices: list[int],
    depts: dict[str, int],
    monkeypatch: pytest.MonkeyPatch,
    pushes: list[object],
) -> None:
    """🔴 发布时有范围、没推群机器人；之后放宽成全员，那一条就该补推 —— 原来永远不推（只推一次让在线的人重拉）。

    补推挂在**挂着的那一行**收件箱行上（站内不重发），推过一次就不再推：全员 → 限定 → 全员，群里不能出现两次
    """
    import os

    from backend.plugin.notification.service import config, delivery_service

    async def _noop(_db: object) -> None:  # ruff: ignore[unused-async] - 顶掉的原函数是 async
        return None

    kicks: list[int] = []

    async def _kick() -> None:  # ruff: ignore[unused-async] - 顶掉的原函数是 async
        kicks.append(1)

    # 外部渠道总闸由参数配置覆盖：顶掉加载，直接看 settings（同 `plugin/notification/tests/test_bots.py`）
    monkeypatch.setattr(config, 'load_notification_config', _noop)
    monkeypatch.setattr(delivery_service, 'kick', _kick)
    monkeypatch.setattr(settings, 'NOTIFICATION_EXTERNAL_ENABLED', True)
    monkeypatch.setattr(settings, 'NOTIFICATION_ENCRYPT_SECRET_KEY', os.urandom(32).hex())
    monkeypatch.setattr(settings, 'NOTIFICATION_BOT_EXTRA_URL_PREFIXES', '')

    created = client.post(
        '/sys/notification-channels/bots',
        headers=token_headers,
        json={
            'name': f'pytest 二期群 {uuid.uuid4().hex[:6]}',
            'platform': 'feishu',
            'webhook_url': 'https://open.feishu.cn/open-apis/bot/v2/hook/0123456789abcdef-pytest-n2',
            'kinds': ['announcement'],
        },
    ).json()
    assert created['code'] == 200, created
    bot_id = int(created['data']['id'])

    async def _deliveries() -> list[NotificationDelivery]:
        async with async_test_db_session() as db:
            stmt = select(NotificationDelivery).where(NotificationDelivery.bot_id == bot_id)
            return list((await db.scalars(stmt.order_by(NotificationDelivery.id))).all())

    async def _purge() -> None:
        async with async_test_db_session.begin() as db:
            await db.execute(delete(NotificationDelivery).where(NotificationDelivery.bot_id == bot_id))
            await db.execute(delete(NotificationBot).where(NotificationBot.id == bot_id))

    tech = [{'kind': 'dept', 'target_id': str(depts['TECH'])}]
    try:
        title = f'pytest 放宽补推 {uuid.uuid4().hex[:6]}'
        pk = _create(client, token_headers, notices, title=title, audience=tech)
        assert _call(client, _deliveries) == []  # 有范围：不推
        (row,) = _live_rows(client, pk)

        _update(client, token_headers, pk, audience=[])
        _call(client, asyncio.sleep, 0.05)  # 提交后的踢是 create_task 出去的
        (delivery,) = _call(client, _deliveries)
        assert (delivery.notification_id, delivery.status, delivery.title) == (row, 'pending', title)
        assert kicks == [1]
        assert _live_rows(client, pk) == [row]  # 站内还是那一行

        # 收窄再放宽：这一行已经推过群，不再推第二次
        _update(client, token_headers, pk, audience=tech)
        _update(client, token_headers, pk, audience=[])
        assert len(_call(client, _deliveries)) == 1

        # 发布时就是全员的（发布那一下推过群）：收窄再放宽同样不再推 —— 发布时的那一行投递也要认得出是这一行的
        everyone = _create(client, token_headers, notices, title=f'pytest 全员再放宽 {uuid.uuid4().hex[:6]}')
        (everyone_row,) = _live_rows(client, everyone)
        assert [d.notification_id for d in _call(client, _deliveries)][-1] == everyone_row
        _update(client, token_headers, everyone, audience=tech)
        _update(client, token_headers, everyone, audience=[])
        assert len(_call(client, _deliveries)) == 2
    finally:
        _call(client, _purge)


# ─── 每个请求都走的查询：一条，不是一串 ──────────────────────────────────────────


@contextmanager
def _statements() -> Iterator[list[str]]:
    """记下这段时间里打到测试库的每一条 SQL"""
    seen: list[str] = []

    def _record(conn: Any, cursor: Any, statement: str, *args: Any) -> None:
        seen.append(statement)

    event.listen(async_test_engine.sync_engine, 'before_cursor_execute', _record)
    try:
        yield seen
    finally:
        event.remove(async_test_engine.sync_engine, 'before_cursor_execute', _record)


def test_viewer_dept_chain_is_one_query_and_walks_like_the_loop(client: TestClient) -> None:
    """「看的人」的部门链（本部门 + 所有上级）每个请求都要构造（未读数、每一次附件下载权限）。
    原来一层一条 SELECT；现在一条递归 CTE，口径和原来那段循环（`dept_dao.get_ancestor_ids`，结构检查还在用它）
    逐个部门对得上：    遇到删了的部门停在它那里（它自己算、它的上级不算），库里有环（修查环之前写进去的）也不死循环
    """
    from backend.app.admin.crud.crud_dept import dept_dao
    from backend.plugin.notification.audience import viewer_of

    def who(dept_id: int) -> SimpleNamespace:
        return SimpleNamespace(id=1, dept_id=dept_id, roles=[], join_time=timezone.now())

    async def _scenario(change: str) -> tuple[set[int], int, dict[str, int]]:
        async with async_test_db_session() as db:
            try:
                ids = {
                    code: await db.scalar(select(Dept.id).where(Dept.code == code, Dept.deleted == 0))
                    for code in ('HQ', 'TECH', 'TECH_BE')
                }
                if change == 'deleted':
                    await db.execute(update(Dept).where(Dept.id == ids['TECH']).values(deleted=ids['TECH']))
                elif change == 'cycle':
                    await db.execute(update(Dept).where(Dept.id == ids['HQ']).values(parent_id=ids['TECH_BE']))
                with _statements() as seen:
                    chain = set((await viewer_of(db, who(ids['TECH_BE']))).dept_ids)
                # 每个部门（含删了的）都和原来那段循环对得上
                for (pk,) in (await db.execute(select(Dept.id))).all():
                    got = set((await viewer_of(db, who(pk))).dept_ids)
                    assert got == set(await dept_dao.get_ancestor_ids(db, pk)), (change, pk)
                return chain, len([s for s in seen if 'sys_dept' in s]), ids
            finally:
                await db.rollback()

    chain, queries, ids = _call(client, _scenario, 'plain')
    assert chain == {ids['TECH_BE'], ids['TECH'], ids['HQ']}
    assert queries == 1
    chain, _, ids = _call(client, _scenario, 'deleted')
    assert chain == {ids['TECH_BE'], ids['TECH']}
    chain, _, ids = _call(client, _scenario, 'cycle')
    assert chain == {ids['TECH_BE'], ids['TECH'], ids['HQ']}


def test_unread_count_is_one_scan(client: TestClient, staff: dict[str, dict[str, str]]) -> None:
    """铃铛的未读数每次收件箱变动都要重拉：按分类的数和「要确认的」数在同一条查询里出来，不再扫两遍"""
    with _statements() as seen:
        resp = client.get(f'{INBOX}/unread-count', headers=staff['sunqiang'])
    assert resp.status_code == 200, resp.text
    data = resp.json()['data']
    assert set(data) == {'total', 'requires_ack_count', 'by_category'}
    assert data['total'] == sum(data['by_category'].values()) >= data['requires_ack_count']
    scans = [s for s in seen if 'count(' in s.lower() and 'sys_notification' in s]
    assert len(scans) == 1, scans


def test_reads_counts_each_tab_once(client: TestClient, token_headers: dict[str, str], notices: list[int]) -> None:
    """阅读统计：当前页签的人数分页已经数过了（`total`），只另数另一个页签"""
    pk = _create(client, token_headers, notices)
    with _statements() as seen:
        resp = client.get(f'{NOTICES}/{pk}/reads', headers=token_headers, params={'read': False, 'page': 1, 'size': 5})
    assert resp.status_code == 200, resp.text
    data = resp.json()['data']
    assert data['unread_count'] == data['total'] > 0 and data['read_count'] == 0
    counts = [s for s in seen if 'count(' in s.lower() and 'sys_user' in s]
    assert len(counts) == 2, counts
