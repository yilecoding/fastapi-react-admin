"""公告的读者那一侧（#186）：人人能看的列表 / 详情 · 收件箱行认得出是哪条公告 · 隐藏就撤回 · 附件跟着公告走。

修之前（2026-10-30 实测）：

- 普通员工在铃铛 / 消息中心点公告，跳到管理页 `/plugins/notice`（守卫要 `sys:notice:add`）→ 403，而且这一下已经标了已读
- 挂在**隐藏**公告上的附件，普通员工照样下得到（200，字节一致），附件列表也列得出来
- 附件要先保存公告、再去「查看」抽屉里传 —— 状态默认「显示」，读者收到通知时附件还没挂上

用户用种子里的 `sunqiang`（普通员工：没有 `sys:file:list`，也没有公告的任何权限码）。
"""

import asyncio
import functools
import secrets
import uuid

from collections.abc import Awaitable, Callable, Generator
from datetime import timedelta
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from sqlalchemy import delete, select
from starlette.testclient import TestClient

from backend.app.admin.service.file_service import can_change_relations
from backend.app.admin.tests.api_v1.test_file import _docx_bytes, _png_bytes
from backend.core.conf import settings
from backend.plugin.notification.model import Notification, NotificationRead
from backend.plugin.notification.service import notification_service as ns_module
from backend.plugin.notification.service.notification_service import notification_service
from backend.tests.utils.db import async_test_db_session
from backend.utils.timezone import timezone

FILES = '/sys/files'
NOTICES = '/sys/notices'
FEED = '/sys/notices/feed'
INBOX = '/sys/notifications'


@pytest.fixture(autouse=True)
def isolated_upload_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Generator[None, None, None]:
    """同 `test_file.py` 的同名 fixture：两棵落盘树都顶到 tmp"""
    from backend.utils import file_ops

    (tmp_path / 'upload').mkdir()
    (tmp_path / 'upload-public').mkdir()
    monkeypatch.setattr(file_ops, 'UPLOAD_DIR', tmp_path / 'upload')
    monkeypatch.setattr(file_ops, 'PUBLIC_UPLOAD_DIR', tmp_path / 'upload-public')
    yield


def _call(client: TestClient, fn: Callable[..., Awaitable[Any]], *args: Any, **kwargs: Any) -> Any:
    return client.portal.call(functools.partial(fn, *args, **kwargs))


def _staff(client: TestClient) -> dict[str, str]:
    body = client.post('/auth/login/swagger', params={'username': 'sunqiang', 'password': '123456'}).json()
    return {'Authorization': f'{body["token_type"]} {body["access_token"]}'}


def _upload(client: TestClient, headers: dict[str, str], *, public: bool = False, name: str = '附件.docx') -> int:
    # 内容每次都要不同：同一人 + 同名 + 同内容会秒传复用上一轮的记录（磁盘上早没了）
    salt = uuid.uuid4().hex
    if public:
        files = {'file': ('公开.png', _png_bytes((secrets.randbelow(256), 0, 0)) + salt.encode(), 'image/png')}
    else:
        files = {'file': (name, _docx_bytes(salt), 'application/octet-stream')}
    resp = client.post(f'{FILES}/upload', headers=headers, files=files, params={'public': 'true'} if public else None)
    assert resp.status_code == 200 and resp.json()['code'] == 200, resp.text
    return resp.json()['data']['id']


async def _purge_inbox(source: str) -> None:
    """公告删除只是把收件箱那一行逻辑删除；测试库同时是 E2E 的库，行和已读标记都硬删掉"""
    async with async_test_db_session() as db:
        pks = list((await db.scalars(select(Notification.id).where(Notification.source == source))).all())
        if pks:
            await db.execute(delete(NotificationRead).where(NotificationRead.notification_id.in_(pks)))
            await db.execute(delete(Notification).where(Notification.id.in_(pks)))
        await db.commit()


@pytest.fixture
def notices(client: TestClient, token_headers: dict[str, str]) -> Generator[list[int], None, None]:
    """收集本条用例建的公告 ID，结束后删掉公告、硬删收件箱行"""
    made: list[int] = []
    yield made
    if made:
        client.request('DELETE', NOTICES, headers=token_headers, json={'pks': made})
    for pk in made:
        _call(client, _purge_inbox, f'notice:{pk}')


def _create(client: TestClient, headers: dict[str, str], made: list[int], **body: Any) -> int:
    payload = {'title': f'pytest 公告 {uuid.uuid4().hex[:6]}', 'type': 1, 'status': 1, 'content': '<p>正文</p>', **body}
    resp = client.post(NOTICES, headers=headers, json=payload)
    assert resp.status_code == 200 and resp.json()['code'] == 200, resp.text
    pk = resp.json()['data']['id']
    made.append(pk)
    return pk


def _update(client: TestClient, headers: dict[str, str], pk: int, **changes: Any) -> None:
    current = client.get(f'{NOTICES}/{pk}', headers=headers).json()['data']
    body = {k: current[k] for k in ('title', 'type', 'status', 'content', 'pinned', 'level', 'expire_time')}
    resp = client.put(f'{NOTICES}/{pk}', headers=headers, json={**body, **changes})
    assert resp.status_code == 200 and resp.json()['code'] == 200, resp.text


def _feed(client: TestClient, headers: dict[str, str]) -> list[dict[str, Any]]:
    resp = client.get(FEED, headers=headers, params={'page': 1, 'size': 100})
    assert resp.status_code == 200, resp.text
    return resp.json()['data']['items']


def _inbox_rows(client: TestClient, headers: dict[str, str], pk: int) -> list[dict[str, Any]]:
    resp = client.get(INBOX, headers=headers, params={'page': 1, 'size': 100, 'category': 1})
    assert resp.status_code == 200, resp.text
    return [n for n in resp.json()['data']['items'] if n.get('source') == f'notice:{pk}']


def test_feed_shows_only_live_notices_pinned_first(
    client: TestClient, token_headers: dict[str, str], notices: list[int]
) -> None:
    yesterday = (timezone.now() - timedelta(days=1)).isoformat()
    tomorrow = (timezone.now() + timedelta(days=1)).isoformat()
    plain = _create(client, token_headers, notices)
    pinned = _create(client, token_headers, notices, pinned=True, level=2, expire_time=tomorrow)
    hidden = _create(client, token_headers, notices, status=0)
    expired = _create(client, token_headers, notices, expire_time=yesterday)

    staff = _staff(client)
    items = _feed(client, staff)
    ids = [n['id'] for n in items]
    # 先断言「有」：显示中的两条都在
    assert {str(plain), str(pinned)} <= set(ids)
    assert str(hidden) not in ids
    assert str(expired) not in ids
    # 置顶的排在所有不置顶的前面
    first_unpinned = next(i for i, n in enumerate(items) if not n['pinned'])
    assert ids.index(str(pinned)) < first_unpinned <= ids.index(str(plain))
    assert next(n for n in items if n['id'] == str(pinned))['level'] == 2

    # 详情：看得见的 200 带正文；隐藏 / 过期的 404（不区分，不泄露「这条存在」）
    detail = client.get(f'{FEED}/{plain}', headers=staff)
    assert detail.status_code == 200 and detail.json()['data']['content'] == '<p>正文</p>'
    for pk in (hidden, expired):
        assert client.get(f'{FEED}/{pk}', headers=staff).status_code == 404


def test_expired_at_creation_is_not_broadcast(
    client: TestClient, token_headers: dict[str, str], notices: list[int]
) -> None:
    """建出来就已经过期的不发：读者点进去是 404"""
    yesterday = (timezone.now() - timedelta(days=1)).isoformat()
    live = _create(client, token_headers, notices)
    expired = _create(client, token_headers, notices, expire_time=yesterday)
    staff = _staff(client)
    assert len(_inbox_rows(client, staff, live)) == 1
    assert _inbox_rows(client, staff, expired) == []


def test_inbox_row_points_at_the_notice_and_shares_read_state(
    client: TestClient, token_headers: dict[str, str], notices: list[int]
) -> None:
    pk = _create(client, token_headers, notices)
    staff = _staff(client)

    (row,) = _inbox_rows(client, staff, pk)
    # 🔴 原来是 `/plugins/notice`：普通员工点进去 403
    assert row['link'] == f'/notification?notice={pk}'
    assert row['read_time'] is None

    item = next(n for n in _feed(client, staff) if n['id'] == str(pk))
    assert (item['notification_id'], item['read']) == (row['id'], False)

    # 在工作台点开（前端拿 notification_id 标已读）→ 铃铛那一行也已读，反过来同理：同一份已读状态
    assert client.put(f'{INBOX}/{row["id"]}/read', headers=staff).status_code == 200
    assert next(n for n in _feed(client, staff) if n['id'] == str(pk))['read'] is True
    assert _inbox_rows(client, staff, pk)[0]['read_time'] is not None
    # 管理员没读过：已读是按人的
    assert next(n for n in _feed(client, token_headers) if n['id'] == str(pk))['read'] is False


def test_hide_retracts_the_inbox_row_and_showing_again_resends(
    client: TestClient, token_headers: dict[str, str], notices: list[int]
) -> None:
    pk = _create(client, token_headers, notices)
    staff = _staff(client)
    (first,) = _inbox_rows(client, staff, pk)

    _update(client, token_headers, pk, status=0)
    # 🔴 原来隐藏之后标题还挂在所有人的铃铛里，点进去是「不存在」
    assert _inbox_rows(client, staff, pk) == []
    assert str(pk) not in [n['id'] for n in _feed(client, staff)]

    _update(client, token_headers, pk, status=1)
    (again,) = _inbox_rows(client, staff, pk)
    assert again['id'] != first['id']


def test_renaming_a_live_notice_renames_its_inbox_row(
    client: TestClient, token_headers: dict[str, str], notices: list[int]
) -> None:
    pk = _create(client, token_headers, notices, title='pytest 改名前')
    _update(client, token_headers, pk, title='pytest 改名后')
    staff = _staff(client)
    (row,) = _inbox_rows(client, staff, pk)  # 只改了标题：不重新发（还是一行）
    assert row['title'] == 'pytest 改名后'
    assert '改名后' in row['content']


def test_delete_retracts_the_inbox_row(client: TestClient, token_headers: dict[str, str], notices: list[int]) -> None:
    pk = _create(client, token_headers, notices)
    staff = _staff(client)
    assert len(_inbox_rows(client, staff, pk)) == 1
    client.request('DELETE', NOTICES, headers=token_headers, json={'pks': [pk]})
    assert _inbox_rows(client, staff, pk) == []


def test_attachments_follow_the_notice_visibility(
    client: TestClient, token_headers: dict[str, str], notices: list[int]
) -> None:
    file_pk = _upload(client, token_headers)
    staff = _staff(client)
    try:
        # 先断言「有」的反面：没挂上之前普通员工读不到这个私有文件
        assert client.get(f'{FILES}/{file_pk}/download', headers=staff).status_code == 404

        pk = _create(client, token_headers, notices, attachment_ids=[file_pk])
        assert next(n for n in _feed(client, staff) if n['id'] == str(pk))['attachment_count'] == 1
        assert _inbox_rows(client, staff, pk)[0]['attachment_count'] == 1
        assert client.get(f'{FILES}/{file_pk}/download', headers=staff).status_code == 200
        listed = client.get(f'{FILES}/targets/NOTICE/{pk}', headers=staff).json()['data']
        assert [f['id'] for f in listed] == [str(file_pk)]

        # 🔴 隐藏：修之前这里是 200（字节一致）+ 列表照样列得出
        _update(client, token_headers, pk, status=0)
        assert client.get(f'{FILES}/{file_pk}/download', headers=staff).status_code == 404
        assert client.get(f'{FILES}/targets/NOTICE/{pk}', headers=staff).json()['data'] == []
        # 管理端照常看得到（编辑表单里要预览）
        assert client.get(f'{FILES}/{file_pk}/download', headers=token_headers).status_code == 200

        # 过期同理
        _update(client, token_headers, pk, status=1, expire_time=(timezone.now() - timedelta(minutes=1)).isoformat())
        assert client.get(f'{FILES}/{file_pk}/download', headers=staff).status_code == 404
    finally:
        client.request('DELETE', FILES, headers=token_headers, json={'pks': [file_pk]})


def test_update_replaces_the_attachment_set_in_order(
    client: TestClient, token_headers: dict[str, str], notices: list[int]
) -> None:
    a, b, c = (_upload(client, token_headers, name=f'{n}.docx') for n in 'abc')
    try:
        pk = _create(client, token_headers, notices, attachment_ids=[a, b])

        def listed() -> list[str]:
            return [f['id'] for f in client.get(f'{FILES}/targets/NOTICE/{pk}', headers=token_headers).json()['data']]

        assert listed() == [str(a), str(b)]
        _update(client, token_headers, pk, attachment_ids=[b, c])
        assert listed() == [str(b), str(c)]
        # 不带 attachment_ids = 不动附件（只改了别的字段的调用方）
        _update(client, token_headers, pk, title='pytest 只改标题')
        assert listed() == [str(b), str(c)]
        _update(client, token_headers, pk, attachment_ids=[])
        assert listed() == []
    finally:
        client.request('DELETE', FILES, headers=token_headers, json={'pks': [a, b, c]})


def test_put_without_the_new_fields_keeps_them(
    client: TestClient, token_headers: dict[str, str], notices: list[int]
) -> None:
    """只传老四样（标题 / 类型 / 状态 / 正文）的调用方，不能把置顶 / 级别 / 过期时间悄悄改回默认值"""
    tomorrow = (timezone.now() + timedelta(days=1)).isoformat()
    pk = _create(client, token_headers, notices, pinned=True, level=2, expire_time=tomorrow)
    resp = client.put(
        f'{NOTICES}/{pk}',
        headers=token_headers,
        json={'title': 'pytest 老调用方', 'type': 1, 'status': 1, 'content': '<p>改了正文</p>'},
    )
    assert resp.status_code == 200 and resp.json()['code'] == 200, resp.text
    after = client.get(f'{NOTICES}/{pk}', headers=token_headers).json()['data']
    assert (after['pinned'], after['level'], after['expire_time'] is not None) == (True, 2, True)
    assert after['title'] == 'pytest 老调用方'
    # 显式传 null 才是清掉
    _update(client, token_headers, pk, expire_time=None)
    assert client.get(f'{NOTICES}/{pk}', headers=token_headers).json()['data']['expire_time'] is None


def test_appended_attachments_get_distinct_sort(
    client: TestClient, token_headers: dict[str, str], notices: list[int]
) -> None:
    """`get_max_sort` 原来是 `scalar() or -1`：真实的最大值 0 被当成「没有」，追加的那个也拿到 0、和第一个撞号"""
    from backend.app.admin.model import FileRelation

    a, b = _upload(client, token_headers, name='first.docx'), _upload(client, token_headers, name='second.docx')
    try:
        pk = _create(client, token_headers, notices, attachment_ids=[a])
        _update(client, token_headers, pk, attachment_ids=[a, b])

        async def _sorts() -> list[int]:
            async with async_test_db_session() as db:
                stmt = select(FileRelation.sort).where(
                    FileRelation.target_type == 'NOTICE', FileRelation.target_id == int(pk), FileRelation.deleted == 0
                )
                return sorted((await db.scalars(stmt)).all())

        assert _call(client, _sorts) == [0, 1]
    finally:
        client.request('DELETE', FILES, headers=token_headers, json={'pks': [a, b]})


def test_editing_does_not_lose_an_attachment_sitting_in_the_recycle_bin(
    client: TestClient, token_headers: dict[str, str], notices: list[int]
) -> None:
    """附件文件进了回收站之后编辑公告（表单拿到的列表里没有它），从回收站还原回来它还挂在公告上"""
    a, b = _upload(client, token_headers, name='kept.docx'), _upload(client, token_headers, name='trashed.docx')
    try:
        pk = _create(client, token_headers, notices, attachment_ids=[a, b])
        client.request('DELETE', FILES, headers=token_headers, json={'pks': [b]})

        def listed() -> list[str]:
            return [f['id'] for f in client.get(f'{FILES}/targets/NOTICE/{pk}', headers=token_headers).json()['data']]

        assert listed() == [str(a)]
        _update(client, token_headers, pk, attachment_ids=[a])  # 表单照它看到的列表提交
        assert client.put(f'{FILES}/recycle/restore', headers=token_headers, json={'pks': [b]}).status_code == 200
        assert listed() == [str(a), str(b)]
    finally:
        client.request('DELETE', FILES, headers=token_headers, json={'pks': [a, b]})


def test_hiding_tells_online_clients_to_refetch(
    client: TestClient, token_headers: dict[str, str], notices: list[int], monkeypatch: pytest.MonkeyPatch
) -> None:
    """撤回不推的话，在线的人红点里还数着那一行，点进去是「已撤回」"""
    pk = _create(client, token_headers, notices)
    pushes: list[object] = []

    async def _record(user_id: object) -> None:  # ruff: ignore[unused-async] - 顶掉的原函数是 async
        pushes.append(user_id)

    monkeypatch.setattr(ns_module, 'notification_new', _record)
    _update(client, token_headers, pk, status=0)
    _call(client, asyncio.sleep, 0.05)  # 提交后的推送是 create_task 出去的
    assert pushes == [None]


def test_bad_attachment_rolls_back_the_whole_notice(
    client: TestClient, token_headers: dict[str, str], notices: list[int]
) -> None:
    """附件校验不过：公告、附件、广播一个都不落 —— 不会发出一条「附件挂一半」的公告"""
    public_pk = _upload(client, token_headers, public=True)
    try:
        for ids, needle in (([public_pk], '公开文件'), ([9_000_000_000_000_000_001], '附件不存在')):
            title = f'pytest 回滚 {uuid.uuid4().hex[:6]}'
            resp = client.post(
                NOTICES,
                headers=token_headers,
                json={'title': title, 'type': 1, 'status': 1, 'content': '<p>x</p>', 'attachment_ids': ids},
            )
            assert resp.status_code == 400, resp.text
            assert needle in resp.json()['msg']
            found = client.get(NOTICES, headers=token_headers, params={'page': 1, 'size': 10, 'title': title})
            assert found.json()['data']['items'] == []
    finally:
        client.request('DELETE', FILES, headers=token_headers, json={'pks': [public_pk]})


def test_cannot_attach_a_file_the_operator_cannot_read(
    client: TestClient, token_headers: dict[str, str], notices: list[int]
) -> None:
    """🔴 不校验的话，有发公告权限的人拿到别人私有文件的 ID（雪花 ID 不是秘密）就能借公告把它公开给所有人。

    走 service 而不是接口：种子里没有「能发公告、又不是超管」的账号，而超管什么文件都读得了
    """
    from backend.common.exception.errors import RequestError
    from backend.common.security.jwt import get_jwt_user
    from backend.plugin.notice.service.notice_service import _sync_attachments

    file_pk = _upload(client, token_headers)  # 管理员传的私有文件
    pk = _create(client, token_headers, notices)
    # 真实的用户快照（别的业务模块登记的读权限判断会读快照上的字段，造一个假的不够）
    me = client.get('/sys/users/me', headers=_staff(client)).json()['data']
    outsider = _call(client, get_jwt_user, int(me['id']))
    assert not outsider.is_superuser

    async def _attach(user: object) -> None:
        async with async_test_db_session() as db:
            # 接口下发的 ID 是字符串（雪花 ID 超出 JS 安全整数），直调 service 要转回 int
            await _sync_attachments(db, user=user, pk=int(pk), file_ids=[int(file_pk)])
            await db.rollback()

    try:
        with pytest.raises(RequestError):
            _call(client, _attach, outsider)
        # 对照：同一个人换成读得了这个文件的身份就挂得上（这条路径上没有别的原因会抛）
        _call(client, _attach, outsider.model_copy(update={'is_superuser': True}))
    finally:
        client.request('DELETE', FILES, headers=token_headers, json={'pks': [file_pk]})


def _user(*perms: str) -> SimpleNamespace:
    menus = [SimpleNamespace(id=i, perms=p, status=1, parent_id=None) for i, p in enumerate(perms, start=1)]
    return SimpleNamespace(is_superuser=False, roles=[SimpleNamespace(id=1, status=1, menus=menus)])


@pytest.mark.skipif(not settings.RBAC_ROLE_MENU_MODE, reason='权限码模型只在角色-菜单模式下成立')
def test_attaching_to_a_notice_needs_notice_permission() -> None:
    """🔴 挂到公告上 = 公开给所有登录用户。只有上传权限的人原来能往任意公告上挂任何文件"""
    assert can_change_relations(_user('sys:file:upload'), 'NOTICE') is False
    assert can_change_relations(_user('sys:file:upload'), 'NOTICE_CONTENT') is False
    assert can_change_relations(_user('sys:file:upload', 'sys:notice:edit'), 'NOTICE') is True
    assert can_change_relations(_user('sys:file:upload', 'sys:notice:add'), 'NOTICE_CONTENT') is True
    # 没登记的业务对象照旧只看上传权限
    assert can_change_relations(_user('sys:file:upload'), 'TICKET') is True


def test_attach_guard_steps_aside_in_casbin_mode(monkeypatch: pytest.MonkeyPatch) -> None:
    """casbin 模式下权限码模型不适用（`user_has_perm` 对非超管一律 False）：收紧就是公告管理员连正文图都挂不上"""
    monkeypatch.setattr(settings, 'RBAC_ROLE_MENU_MODE', False)
    assert can_change_relations(_user('sys:file:upload'), 'NOTICE') is True


def test_broadcast_pushes_only_after_commit(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    """🔴 原来写完那一行当场推：铃铛收到推送立刻重拉未读数，读到的是提交前的旧数。回滚了就不推"""
    pushes: list[object] = []

    async def _record(user_id: object) -> None:  # ruff: ignore[unused-async] - 顶掉的原函数是 async
        pushes.append(user_id)

    monkeypatch.setattr(ns_module, 'notification_new', _record)
    titles = [f'pytest 推送时机 {uuid.uuid4().hex[:6]}']

    async def _broadcast(*, commit: bool) -> int:
        async with async_test_db_session() as db:
            await notification_service.broadcast(
                db=db, title=titles[0], content='x', kind='announcement', source='notice:1'
            )
            before = len(pushes)
            if commit:
                await db.commit()
            else:
                # 回滚之后同一个会话再提交一次：回滚掉的那次推送不能在这时补出去
                await db.rollback()
                await db.commit()
            await asyncio.sleep(0.05)  # 提交后的推送是 create_task 出去的，让它跑一下
            return before

    try:
        assert _call(client, _broadcast, commit=False) == 0
        assert pushes == []
        assert _call(client, _broadcast, commit=True) == 0
        assert pushes == [None]
    finally:

        async def _cleanup() -> None:
            async with async_test_db_session() as db:
                await db.execute(delete(Notification).where(Notification.title == titles[0]))
                await db.commit()

        _call(client, _cleanup)
