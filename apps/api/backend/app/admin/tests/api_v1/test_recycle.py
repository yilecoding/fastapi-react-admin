"""回收站（#122 第二期）：删除只置标记、对象不动；还原 / 彻底删除 / 清空；到期由定时任务清除。

要守的都是「写错了不报错」的那一类：

- 删了的文件拿 ID 照样下得到（「删了」只是界面上看不见）
- 还原回来一批点开就「文件已丢失」的记录（对象其实已经被删了）
- 还原不把附件挂回去 —— 用户以为撤销了，公告上的附件却没了
- 定时清理删了还没到期的，或者到期的一直不删
- 回收站里还有文件的存储被放行删除（那批文件就永远还原不回来）—— 见 test_storage.py
"""

import asyncio
import uuid

from collections.abc import Generator
from datetime import timedelta
from pathlib import Path

import pytest

from sqlalchemy import create_engine, event, select, update
from sqlalchemy.orm import Session
from starlette.testclient import TestClient

from backend.app.admin.model import File
from backend.core.conf import settings
from backend.tests.utils.db import sync_test_db_url
from backend.utils.timezone import timezone

FILES = '/sys/files'
RECYCLE = '/sys/files/recycle'


def _root_url(path: str) -> str:
    return f'http://testserver{path}'


@pytest.fixture(autouse=True)
def isolated_upload_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Generator[Path, None, None]:
    """同 `test_file.py` 的同名 fixture：两棵落盘树都顶到 tmp，返回私有树"""
    from backend.utils import file_ops

    (tmp_path / 'upload').mkdir()
    (tmp_path / 'upload-public').mkdir()
    monkeypatch.setattr(file_ops, 'UPLOAD_DIR', tmp_path / 'upload')
    monkeypatch.setattr(file_ops, 'PUBLIC_UPLOAD_DIR', tmp_path / 'upload-public')
    monkeypatch.setattr(settings, 'FILE_RECYCLE_DAYS', 30)
    yield tmp_path / 'upload'


def _upload(client: TestClient, headers: dict[str, str], name: str = 'r.txt', *, public: bool = False) -> dict:
    # 内容带随机串：同名同内容会秒传复用上一轮的记录（file 分册那条）
    salt = uuid.uuid4().hex.encode()
    if public:
        from backend.app.admin.tests.api_v1.test_file import _png_bytes

        files = {'file': (name, _png_bytes() + salt, 'image/png')}
    else:
        files = {'file': (name, b'recycle ' + salt)}
    resp = client.post(f'{FILES}/upload', headers=headers, files=files, params={'public': True} if public else None)
    assert resp.status_code == 200 and resp.json()['code'] == 200, resp.text
    return resp.json()['data']


def _delete(client: TestClient, headers: dict[str, str], *pks: str) -> None:
    resp = client.request('DELETE', FILES, headers=headers, json={'pks': list(pks)})
    assert resp.json()['code'] == 200, resp.text


def _bin(client: TestClient, headers: dict[str, str]) -> list[dict]:
    return client.get(RECYCLE, headers=headers, params={'page': 1, 'size': 100}).json()['data']['items']


def _staff(client: TestClient) -> dict[str, str]:
    """种子里的普通员工：没有 sys:file:list / sys:file:del"""
    body = client.post('/auth/login/swagger', params={'username': 'sunqiang', 'password': '123456'}).json()
    return {'Authorization': f'{body["token_type"]} {body["access_token"]}'}


# ─── 删除 = 进回收站 ─────────────────────────────────────────────────────────


def test_delete_moves_to_bin_and_keeps_the_object(
    client: TestClient, token_headers: dict[str, str], isolated_upload_dir: Path
) -> None:
    data = _upload(client, token_headers)
    on_disk = isolated_upload_dir / data['path']
    _delete(client, token_headers, data['id'])

    assert on_disk.is_file(), '进回收站不该动对象 —— 还原要靠它'
    row = next(r for r in _bin(client, token_headers) if r['id'] == data['id'])
    # 到期时间 = 删除时间 + FILE_RECYCLE_DAYS，界面上的「剩余 N 天」就是它
    from datetime import datetime

    deleted = datetime.fromisoformat(row['deleted_time'])
    purge = datetime.fromisoformat(row['purge_time'])
    assert purge - deleted == timedelta(days=30)
    # 正常列表里没有
    listed = client.get(FILES, headers=token_headers, params={'page': 1, 'size': 100, 'name': 'r.txt'}).json()
    assert data['id'] not in [f['id'] for f in listed['data']['items']]


def test_files_in_bin_are_not_readable(client: TestClient, token_headers: dict[str, str]) -> None:
    """🔴 回收站里的文件一律读不到 —— 否则「删了」只是界面上看不见，拿 ID 照样下"""
    private = _upload(client, token_headers)
    public = _upload(client, token_headers, 'pic.png', public=True)
    # 先断言「有」
    assert client.get(f'{FILES}/{private["id"]}/download', headers=token_headers).status_code == 200
    assert client.get(_root_url(public['public_url'])).status_code == 200

    _delete(client, token_headers, private['id'], public['id'])
    assert client.get(f'{FILES}/{private["id"]}', headers=token_headers).status_code == 404
    assert client.get(f'{FILES}/{private["id"]}/download', headers=token_headers).status_code == 404
    assert client.get(f'{FILES}/{private["id"]}/link', headers=token_headers).status_code == 404
    assert client.get(_root_url(public['public_url'])).status_code == 404


def test_statistics_counts_the_bin_separately(client: TestClient, token_headers: dict[str, str]) -> None:
    before = client.get(f'{FILES}/statistics', headers=token_headers).json()['data']
    data = _upload(client, token_headers)
    _delete(client, token_headers, data['id'])
    after = client.get(f'{FILES}/statistics', headers=token_headers).json()['data']
    assert after['total_count'] == before['total_count']
    assert after['recycle_count'] == before['recycle_count'] + 1
    assert after['recycle_size'] == before['recycle_size'] + data['size']
    assert after['recycle_days'] == 30


def test_reupload_after_delete_is_a_new_record(client: TestClient, token_headers: dict[str, str]) -> None:
    """秒传不复用回收站里的记录：复用了就是「上传成功，但文件在回收站里」"""
    content = b'same ' + uuid.uuid4().hex.encode()
    first = client.post(f'{FILES}/upload', headers=token_headers, files={'file': ('d.txt', content)}).json()['data']
    _delete(client, token_headers, first['id'])
    second = client.post(f'{FILES}/upload', headers=token_headers, files={'file': ('d.txt', content)}).json()['data']
    assert second['id'] != first['id']
    assert client.get(f'{FILES}/{second["id"]}/download', headers=token_headers).content == content


# ─── 还原 ───────────────────────────────────────────────────────────────────


def test_restore_brings_back_file_and_the_relations_that_delete_removed(
    client: TestClient, token_headers: dict[str, str]
) -> None:
    """🔴 还原 = 撤销那一次删除：删除时连带解开的附件关联要挂回去；之前手动「移除」的不挂"""
    data = _upload(client, token_headers)
    # 目标 ID 每轮都换：还原回来的文件会一直挂在目标上，固定 ID 的话第二轮就会看到上一轮的那条
    kept, removed = (str(uuid.uuid4().int % 10**15 + 10**15) for _ in range(2))
    for target_id in (kept, removed):
        client.post(
            f'{FILES}/relations',
            headers=token_headers,
            json={'file_ids': [data['id']], 'target_type': 'PYTEST_RB', 'target_id': target_id},
        )
    # removed 先手动从附件面板移除，再删文件
    client.request(
        'DELETE',
        f'{FILES}/relations',
        headers=token_headers,
        json={'file_ids': [data['id']], 'target_type': 'PYTEST_RB', 'target_id': removed},
    )
    _delete(client, token_headers, data['id'])
    assert client.get(f'{FILES}/targets/PYTEST_RB/{kept}', headers=token_headers).json()['data'] == []

    resp = client.put(f'{RECYCLE}/restore', headers=token_headers, json={'pks': [data['id']]})
    assert resp.json()['code'] == 200, resp.text
    assert client.get(f'{FILES}/{data["id"]}/download', headers=token_headers).status_code == 200
    attached = client.get(f'{FILES}/targets/PYTEST_RB/{kept}', headers=token_headers).json()['data']
    assert [f['id'] for f in attached] == [data['id']]
    assert client.get(f'{FILES}/targets/PYTEST_RB/{removed}', headers=token_headers).json()['data'] == [], (
        '之前手动移除的关联不该被还原挂回去'
    )
    assert data['id'] not in [r['id'] for r in _bin(client, token_headers)]


def test_restore_of_purged_or_live_file_fails(client: TestClient, token_headers: dict[str, str]) -> None:
    live = _upload(client, token_headers)
    gone = _upload(client, token_headers)
    _delete(client, token_headers, gone['id'])
    client.request('DELETE', RECYCLE, headers=token_headers, json={'pks': [gone['id']]})

    for pk in (live['id'], gone['id']):
        assert client.put(f'{RECYCLE}/restore', headers=token_headers, json={'pks': [pk]}).json()['code'] != 200


# ─── 彻底删除 / 清空 ─────────────────────────────────────────────────────────


def test_purge_deletes_object_and_leaves_no_way_back(
    client: TestClient, token_headers: dict[str, str], isolated_upload_dir: Path
) -> None:
    data = _upload(client, token_headers)
    on_disk = isolated_upload_dir / data['path']
    _delete(client, token_headers, data['id'])
    resp = client.request('DELETE', RECYCLE, headers=token_headers, json={'pks': [data['id']]})
    assert resp.json()['code'] == 200, resp.text
    assert not on_disk.exists()
    assert data['id'] not in [r['id'] for r in _bin(client, token_headers)]
    # 不能对正常文件「彻底删除」—— 那条接口只认回收站里的
    live = _upload(client, token_headers)
    assert client.request('DELETE', RECYCLE, headers=token_headers, json={'pks': [live['id']]}).json()['code'] != 200
    assert (isolated_upload_dir / live['path']).is_file()


def test_empty_bin(client: TestClient, token_headers: dict[str, str], isolated_upload_dir: Path) -> None:
    files = [_upload(client, token_headers, f'e{i}.txt') for i in range(3)]
    _delete(client, token_headers, *[f['id'] for f in files])
    assert client.delete(f'{RECYCLE}/all', headers=token_headers).json()['code'] == 200
    assert _bin(client, token_headers) == []
    assert not any((isolated_upload_dir / f['path']).exists() for f in files)
    # 空的再清一次也是成功
    assert client.delete(f'{RECYCLE}/all', headers=token_headers).json()['code'] == 200


def test_recycle_disabled_deletes_immediately(
    client: TestClient, token_headers: dict[str, str], isolated_upload_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """`FILE_RECYCLE_DAYS = 0`：不启用回收站，删除即彻底删除（第二期之前的行为）"""
    monkeypatch.setattr(settings, 'FILE_RECYCLE_DAYS', 0)
    data = _upload(client, token_headers)
    _delete(client, token_headers, data['id'])
    assert not (isolated_upload_dir / data['path']).exists()
    assert data['id'] not in [r['id'] for r in _bin(client, token_headers)]
    assert client.get(f'{FILES}/statistics', headers=token_headers).json()['data']['recycle_days'] == 0


# ─── 提交失败时对象不能先没（#394 ④）────────────────────────────────────────


def _fail_commit_when_purged(file_ids: list[str]):
    """这个请求要提交「已清除」时让提交失败（只认这几个文件，别的会话的提交不碰）"""
    ids = [int(i) for i in file_ids]

    def fail(session: Session) -> None:
        purged = session.connection().scalars(select(File.id).where(File.id.in_(ids), File.purged_time.is_not(None)))
        if purged.first() is not None:
            raise RuntimeError('purge commit failed')

    return fail


@pytest.mark.parametrize('how', ['purge', 'empty', 'no-bin'])
def test_a_failed_commit_keeps_the_object(
    client: TestClient,
    token_headers: dict[str, str],
    isolated_upload_dir: Path,
    monkeypatch: pytest.MonkeyPatch,
    how: str,
) -> None:
    """🔴 先删对象再提交：提交失败时记录还在（可还原 / 没删掉），对象却没了，点开 404 ——
    正是 `_purge_objects` 注释说「不可接受」的方向"""
    data = _upload(client, token_headers)
    on_disk = isolated_upload_dir / data['path']
    if how == 'no-bin':
        monkeypatch.setattr(settings, 'FILE_RECYCLE_DAYS', 0)
    else:
        _delete(client, token_headers, data['id'])
    assert on_disk.is_file()

    fail = _fail_commit_when_purged([data['id']])
    event.listen(Session, 'before_commit', fail)
    try:
        with pytest.raises(RuntimeError, match='purge commit failed'):
            if how == 'purge':
                client.request('DELETE', RECYCLE, headers=token_headers, json={'pks': [data['id']]})
            elif how == 'empty':
                client.delete(f'{RECYCLE}/all', headers=token_headers)
            else:
                client.request('DELETE', FILES, headers=token_headers, json={'pks': [data['id']]})
    finally:
        event.remove(Session, 'before_commit', fail)

    try:
        assert on_disk.is_file(), '提交失败了，对象却已经删了'
        if how == 'no-bin':
            assert client.get(f'{FILES}/{data["id"]}', headers=token_headers).status_code == 200
        else:
            assert data['id'] in [r['id'] for r in _bin(client, token_headers)]
    finally:
        # 别把这条记录留在共享库的回收站 / 文件列表里（数回收站行数的测试会被它带偏）
        if how == 'no-bin':
            client.request('DELETE', FILES, headers=token_headers, json={'pks': [data['id']]})
        else:
            client.request('DELETE', RECYCLE, headers=token_headers, json={'pks': [data['id']]})


def test_one_failing_object_delete_does_not_strand_the_rest(monkeypatch: pytest.MonkeyPatch) -> None:
    """对象删除挪到了提交之后（后台任务 / 定时任务的 `await`）：那时记录已经标成已清除，
    一个对象抛了异常就停下的话，同批剩下的（Starlette 的 BackgroundTasks 还会连后面几批一起跳过）永远成孤儿"""
    import asyncio

    from backend.app.admin.service import file_service as module

    deleted: list[str] = []

    async def flaky(_target: object, path: str) -> None:
        await asyncio.sleep(0)
        if path == 'a':
            raise OSError('NAS mount hung')
        deleted.append(path)

    monkeypatch.setattr(module, 'delete_object', flaky)
    asyncio.run(module._delete_objects([(object(), 'a'), (object(), 'b'), (object(), 'c')]))  # type: ignore[list-item]
    assert deleted == ['b', 'c']


# ─── 权限 ───────────────────────────────────────────────────────────────────


def test_bin_needs_permissions(client: TestClient, token_headers: dict[str, str]) -> None:
    data = _upload(client, token_headers)
    _delete(client, token_headers, data['id'])
    staff = _staff(client)
    assert client.get(RECYCLE, headers=staff).status_code == 403
    assert client.put(f'{RECYCLE}/restore', headers=staff, json={'pks': [data['id']]}).status_code == 403
    assert client.request('DELETE', RECYCLE, headers=staff, json={'pks': [data['id']]}).status_code == 403
    assert client.delete(f'{RECYCLE}/all', headers=staff).status_code == 403
    # 仍在回收站里，没被动过
    assert data['id'] in [r['id'] for r in _bin(client, token_headers)]


# ─── 定时清理 ────────────────────────────────────────────────────────────────


def _backdate(pk: str, days: float) -> None:
    """把删除时间往前拨（不等真实时间）"""
    engine = create_engine(sync_test_db_url(), future=True)
    try:
        with engine.begin() as conn:
            conn.execute(
                update(File).where(File.id == int(pk)).values(deleted_time=timezone.now() - timedelta(days=days))
            )
    finally:
        engine.dispose()


def _run_purge_task(**kw: object) -> str:
    """同 test_prune_logs.run_prune：任务自己开会话，要换到测试库，且每次独立引擎（不然撞事件循环）"""
    import backend.app.task.tasks.maintenance.tasks as mod

    from backend.app.task.tasks.maintenance.tasks import purge_recycled_files
    from backend.database.db import create_database_async_engine, create_database_async_session, get_database_url

    engine = create_database_async_engine(get_database_url(unittest=True))
    original = mod.async_db_session
    mod.async_db_session = create_database_async_session(engine)

    async def go() -> str:
        try:
            return await purge_recycled_files(**kw)
        finally:
            await engine.dispose()

    try:
        return asyncio.run(go())
    finally:
        mod.async_db_session = original


def test_purge_task_only_removes_expired(
    client: TestClient, token_headers: dict[str, str], isolated_upload_dir: Path
) -> None:
    expired = [_upload(client, token_headers, f'old{i}.txt') for i in range(3)]
    fresh = _upload(client, token_headers, 'new.txt')
    _delete(client, token_headers, *[f['id'] for f in expired], fresh['id'])
    for f in expired:
        _backdate(f['id'], 31)
    _backdate(fresh['id'], 29)

    # batch=2：3 个到期的要走两批才清完（「分批」本身也被这条钉住）
    msg = _run_purge_task(batch=2)
    assert '3 个' in msg, msg
    remaining = [r['id'] for r in _bin(client, token_headers)]
    assert fresh['id'] in remaining
    assert not any(f['id'] in remaining for f in expired)
    assert (isolated_upload_dir / fresh['path']).is_file()
    assert not any((isolated_upload_dir / f['path']).exists() for f in expired)


def test_migration_backfill_semantics(client: TestClient, token_headers: dict[str, str]) -> None:
    """已经标了 purged_time 的删除记录（迁移回填的那批 = 第二期之前删的）不在回收站里、也还原不了"""
    data = _upload(client, token_headers)
    _delete(client, token_headers, data['id'])
    engine = create_engine(sync_test_db_url(), future=True)
    try:
        with engine.begin() as conn:
            conn.execute(update(File).where(File.id == int(data['id'])).values(purged_time=timezone.now()))
    finally:
        engine.dispose()
    assert data['id'] not in [r['id'] for r in _bin(client, token_headers)]
    assert client.put(f'{RECYCLE}/restore', headers=token_headers, json={'pks': [data['id']]}).json()['code'] != 200
