"""分片上传（#122 第三期）：init → 逐片 PUT → complete，可续传、可取消。

要守的都是「写错了不报错」的那一类：

- 🔴 **分片入口绕过权限 / 白名单 / 大小上限**（ContiNew GHSA-j7qm-qprw-c53w，CVSS 8.5 就是这个）
- 某一片多传 / 少传了字节，拼出来的文件是截断或错位的，而接口返回成功
- 续传时把已经传过的片又传一遍（或者反过来：以为传过了、其实没有）
- 取消 / 完成之后，分片残留在存储里没人清
- 会话不是自己的也能写进去（upload_id 被别人拿到）
"""

import asyncio
import hashlib
import os

from collections.abc import AsyncIterator, Awaitable, Callable, Generator
from pathlib import Path
from typing import Any

import pytest

from starlette.testclient import TestClient

from backend.app.admin.tests.api_v1.test_storage import (  # ruff: ignore[unused-import]
    _BUCKET,
    _create_s3,
    _s3_resource,
    s3_endpoint,
)
from backend.core.conf import settings

FILES = '/sys/files'
MP = '/sys/files/multipart'
CHUNK = 64 * 1024  # 测试里把分片调小，几片就能覆盖「中间片 / 最后一片」两种大小


@pytest.fixture(autouse=True)
def isolated_upload_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Generator[Path, None, None]:
    """同 test_file.py：两棵落盘树顶到 tmp；分片调小

    ⚠️ 光设 `settings.FILE_CHUNK_SIZE` 不够：`policy()` / `init()` 第一句是 `load_file_config(db)`，
    会把 sys_config 里 FILE 组的值（8 MiB）setattr 回来 —— 所以连那次加载一起顶掉（同 conftest 的 `no_captcha`）。
    「界面上改了就生效」那一侧在 `test_upload_policy_config.py`
    """
    from backend.utils import file_ops

    async def _noop(_db: object) -> None:  # ruff: ignore[unused-async] - 顶掉的原函数是 async，签名要对上
        return None

    (tmp_path / 'upload').mkdir()
    (tmp_path / 'upload-public').mkdir()
    monkeypatch.setattr(file_ops, 'UPLOAD_DIR', tmp_path / 'upload')
    monkeypatch.setattr(file_ops, 'PUBLIC_UPLOAD_DIR', tmp_path / 'upload-public')
    monkeypatch.setattr('backend.app.admin.service.multipart_service.load_file_config', _noop)
    monkeypatch.setattr(settings, 'FILE_CHUNK_SIZE', CHUNK)
    yield tmp_path / 'upload'


@pytest.fixture(autouse=True)
def _purge_rows() -> Generator[None, None, None]:
    """收尾：硬删这条测试建的文件记录和 `PYTEST_` 存储（接口的删除是逻辑删除；不删的话 S3 那条第二次跑撞编码重复）"""
    from sqlalchemy import delete, func, select

    from backend.app.admin.model import File, Storage
    from backend.database.db import create_database_async_engine, create_database_async_session, get_database_url

    async def run(fn: Callable[[Any], Awaitable[Any]]) -> Any:
        engine = create_database_async_engine(get_database_url(unittest=True))
        try:
            async with create_database_async_session(engine)() as db:
                result = await fn(db)
                await db.commit()
                return result
        finally:
            await engine.dispose()

    async def high_water(db: Any) -> int:
        return (await db.execute(select(func.max(File.id)))).scalar() or 0

    async def purge(db: Any) -> None:
        storages = select(Storage.id).where(Storage.code.like('PYTEST_%')).scalar_subquery()
        await db.execute(delete(File).where((File.id > before) | File.storage_id.in_(storages)))
        await db.execute(delete(Storage).where(Storage.code.like('PYTEST_%')))

    # 雪花 ID 随时间递增、测试串行跑：比开始时最大的 ID 大的就是这条测试建的
    before = asyncio.run(run(high_water))
    yield
    asyncio.run(run(purge))


def _init(client: TestClient, headers: dict[str, str], name: str, size: int, **extra: object) -> dict:
    resp = client.post(MP, headers=headers, json={'name': name, 'size': size, **extra})
    assert resp.json()['code'] == 200, resp.text
    return resp.json()['data']


def _put(client: TestClient, headers: dict[str, str], upload_id: str, part: int, data: bytes):
    return client.put(
        f'{MP}/{upload_id}/{part}',
        headers={**headers, 'Content-Type': 'application/octet-stream'},
        content=data,
    )


def _parts(data: bytes) -> list[bytes]:
    return [data[i : i + CHUNK] for i in range(0, len(data), CHUNK)]


def _upload_all(client: TestClient, headers: dict[str, str], name: str, data: bytes) -> dict:
    session = _init(client, headers, name, len(data))
    # 乱序传：服务端按片号拼，和到达顺序无关
    for n, chunk in reversed(list(enumerate(_parts(data), start=1))):
        assert _put(client, headers, session['upload_id'], n, chunk).json()['code'] == 200
    resp = client.post(f'{MP}/{session["upload_id"]}/complete', headers=headers)
    assert resp.json()['code'] == 200, resp.text
    return resp.json()['data']


def _staff(client: TestClient) -> dict[str, str]:
    """种子里的普通员工：没有 sys:file:upload"""
    body = client.post('/auth/login/swagger', params={'username': 'sunqiang', 'password': '123456'}).json()
    return {'Authorization': f'{body["token_type"]} {body["access_token"]}'}


def _part_files(root: Path) -> list[Path]:
    return [p for p in (root / '_multipart').rglob('*') if p.is_file()] if (root / '_multipart').exists() else []


# ─── 正常路径 ────────────────────────────────────────────────────────────────


def test_policy(client: TestClient, token_headers: dict[str, str]) -> None:
    data = client.get(f'{FILES}/upload-policy', headers=token_headers).json()['data']
    assert data == {'chunk_threshold': settings.FILE_CHUNK_THRESHOLD, 'chunk_size': CHUNK}


def test_round_trip_assembles_the_exact_bytes(
    client: TestClient, token_headers: dict[str, str], isolated_upload_dir: Path
) -> None:
    content = os.urandom(CHUNK * 3 + 1234)  # 3 片满的 + 一片余数
    record = _upload_all(client, token_headers, '大文件.zip', content)

    assert record['size'] == len(content)
    assert record['sha256'] == hashlib.sha256(content).hexdigest()
    assert record['original_name'] == '大文件.zip'
    assert record['content_type'] == 'application/zip'
    assert client.get(f'{FILES}/{record["id"]}/download', headers=token_headers).content == content
    # 分片和会话都清干净了
    assert _part_files(isolated_upload_dir) == []


def test_status_reports_uploaded_parts_for_resume(client: TestClient, token_headers: dict[str, str]) -> None:
    content = os.urandom(CHUNK * 2 + 10)
    session = _init(client, token_headers, 'resume.zip', len(content))
    assert session['total_parts'] == 3 and session['uploaded_parts'] == []
    _put(client, token_headers, session['upload_id'], 2, _parts(content)[1])
    status = client.get(f'{MP}/{session["upload_id"]}', headers=token_headers).json()['data']
    assert status['uploaded_parts'] == [2]
    # 续传：只补没传的，拼出来照样是对的
    for n in (1, 3):
        _put(client, token_headers, session['upload_id'], n, _parts(content)[n - 1])
    record = client.post(f'{MP}/{session["upload_id"]}/complete', headers=token_headers).json()['data']
    assert record['sha256'] == hashlib.sha256(content).hexdigest()


def test_same_part_twice_is_harmless(client: TestClient, token_headers: dict[str, str]) -> None:
    """网络重试会重发同一片：覆盖写，不重复计数"""
    content = os.urandom(CHUNK + 5)
    session = _init(client, token_headers, 'twice.zip', len(content))
    for _ in range(2):
        _put(client, token_headers, session['upload_id'], 1, _parts(content)[0])
    _put(client, token_headers, session['upload_id'], 2, _parts(content)[1])
    record = client.post(f'{MP}/{session["upload_id"]}/complete', headers=token_headers).json()['data']
    assert record['size'] == len(content)


def test_complete_dedups_like_a_normal_upload(client: TestClient, token_headers: dict[str, str]) -> None:
    content = os.urandom(CHUNK + 7)
    first = _upload_all(client, token_headers, 'dup.zip', content)
    second = _upload_all(client, token_headers, 'dup.zip', content)
    assert second['id'] == first['id']


def test_abort_removes_parts_and_session(
    client: TestClient, token_headers: dict[str, str], isolated_upload_dir: Path
) -> None:
    content = os.urandom(CHUNK * 2)
    session = _init(client, token_headers, 'abort.zip', len(content))
    _put(client, token_headers, session['upload_id'], 1, _parts(content)[0])
    assert _part_files(isolated_upload_dir), '前置：分片应该已经落盘'
    assert client.delete(f'{MP}/{session["upload_id"]}', headers=token_headers).json()['code'] == 200
    assert _part_files(isolated_upload_dir) == []
    assert client.get(f'{MP}/{session["upload_id"]}', headers=token_headers).status_code == 404


# ─── 闸门：和普通上传同一套 ───────────────────────────────────────────────────


@pytest.mark.parametrize(
    ('name', 'size', 'public'),
    [
        ('evil.exe', 1000, False),  # 扩展名不在白名单
        ('noext', 1000, False),  # 没有扩展名
        ('big.zip', 100 * 1024 * 1024 + 1, False),  # 超过压缩包上限
        ('doc.pdf', 1000, True),  # 公开件只收图片
        ('logo.svg', 1000, True),  # 公开子树不收 svg（存储型 XSS）
    ],
)
def test_init_runs_the_same_checks_as_upload(
    client: TestClient, token_headers: dict[str, str], name: str, size: int, *, public: bool
) -> None:
    resp = client.post(MP, headers=token_headers, json={'name': name, 'size': size, 'public': public})
    assert resp.json()['code'] != 200, resp.text


def test_every_multipart_endpoint_needs_upload_permission(client: TestClient, token_headers: dict[str, str]) -> None:
    """🔴 ContiNew 的分片接口四个都没挂权限 —— 任何登录用户都能传"""
    session = _init(client, token_headers, 'perm.zip', CHUNK)
    staff = _staff(client)
    uid = session['upload_id']
    assert client.post(MP, headers=staff, json={'name': 'x.zip', 'size': 10}).status_code == 403
    assert client.get(f'{MP}/{uid}', headers=staff).status_code == 403
    assert _put(client, staff, uid, 1, b'x' * CHUNK).status_code == 403
    assert client.post(f'{MP}/{uid}/complete', headers=staff).status_code == 403
    assert client.delete(f'{MP}/{uid}', headers=staff).status_code == 403


def test_part_size_is_enforced(client: TestClient, token_headers: dict[str, str]) -> None:
    """每片的大小在写入时卡死：多一个字节、少一个字节都不收，片号越界不收"""
    content = os.urandom(CHUNK + 100)
    uid = _init(client, token_headers, 'size.zip', len(content))['upload_id']
    assert _put(client, token_headers, uid, 1, content[: CHUNK - 1]).json()['code'] != 200
    assert _put(client, token_headers, uid, 1, content[: CHUNK + 1]).json()['code'] != 200
    assert _put(client, token_headers, uid, 2, content[CHUNK:] + b'!').json()['code'] != 200
    assert _put(client, token_headers, uid, 3, b'x').json()['code'] != 200
    assert _put(client, token_headers, uid, 0, b'x').json()['code'] != 200
    assert client.get(f'{MP}/{uid}', headers=token_headers).json()['data']['uploaded_parts'] == []


def test_oversized_part_is_cut_off_while_streaming() -> None:
    """不带 Content-Length（分块传输）时边收边数，超了当场断开 —— 不是收完再判。

    走 service 测：TestClient 会先把整个请求体读完再交给应用，经它测不出「收到一半就断」
    """
    from backend.common.exception import errors

    consumed = 0

    async def body() -> AsyncIterator[bytes]:  # ruff: ignore[unused-async] - 异步生成器，ruff 误报
        nonlocal consumed
        for _ in range(50):
            consumed += 1
            yield b'x' * (CHUNK // 2)

    async def short() -> AsyncIterator[bytes]:  # ruff: ignore[unused-async] - 异步生成器，ruff 误报
        yield b'x' * (CHUNK - 1)

    async def go(svc: Any, db: Any) -> None:
        uid = (await svc.init(db=db, user_id=1, name='stream.zip', size=CHUNK * 2, public=False))['upload_id']
        try:
            with pytest.raises(errors.RequestError):
                await svc.put_part(db=db, upload_id=uid, part=1, user_id=1, body=body(), content_length=None)
            # 反方向：少了也不收。带 Content-Length 的请求在入口就被挡了，没带的只能靠收完之后那一道
            with pytest.raises(errors.RequestError):
                await svc.put_part(db=db, upload_id=uid, part=1, user_id=1, body=short(), content_length=None)
            assert (await svc.status(upload_id=uid, user_id=1))['uploaded_parts'] == []
        finally:
            await svc.abort(db=db, upload_id=uid, user_id=1)

    _with_service(go)
    # 一片 = 两块；第三块进来就超了。收完 50 块才判的实现这里是 50
    assert consumed == 3


def test_opera_log_never_reads_binary_bodies() -> None:
    """🔴 操作日志中间件在路由之前读请求体：分片的 PUT 被它读了，就是整片先进内存、再当乱码写进日志"""
    from starlette.requests import Request

    from backend.middleware.opera_log_middleware import OperaLogMiddleware

    async def receive() -> dict:  # ruff: ignore[unused-async] - ASGI 的 receive 必须是 async
        raise AssertionError('操作日志不该读二进制请求体')

    scope = {
        'type': 'http',
        'method': 'PUT',
        'path': f'{settings.FASTAPI_API_V1_PATH}{MP}/{"a" * 32}/1',
        'query_string': b'',
        'headers': [(b'content-type', b'application/octet-stream')],
        'path_params': {},
    }
    middleware = OperaLogMiddleware.__new__(OperaLogMiddleware)
    args = asyncio.run(middleware.get_request_args(Request(scope, receive)))
    assert args == {'body': {'_binary': True, '_original_size': None}}


def test_concurrent_complete_is_refused(client: TestClient, token_headers: dict[str, str]) -> None:
    """双击 / 网络重试会同时发两次 complete：只让一个去拼，另一个 409（否则是两份对象、两条记录）"""
    content = os.urandom(CHUNK + 1)
    uid = _init(client, token_headers, 'twice-complete.zip', len(content))['upload_id']
    for n, chunk in enumerate(_parts(content), start=1):
        _put(client, token_headers, uid, n, chunk)
    lock = f'{settings.FILE_MULTIPART_REDIS_PREFIX}:{uid}:lock'

    async def hold(*, on: bool) -> None:
        from backend.database.redis import RedisCli

        cli = RedisCli()
        try:
            await (cli.set(lock, '1', ex=60) if on else cli.delete(lock))
        finally:
            await cli.aclose()

    asyncio.run(hold(on=True))
    try:
        assert client.post(f'{MP}/{uid}/complete', headers=token_headers).status_code == 409
    finally:
        asyncio.run(hold(on=False))
    # 锁放掉之后照常完成：被拒的那次没有把会话弄坏
    assert client.post(f'{MP}/{uid}/complete', headers=token_headers).json()['code'] == 200


def test_complete_with_missing_parts_fails(client: TestClient, token_headers: dict[str, str]) -> None:
    content = os.urandom(CHUNK * 2)
    uid = _init(client, token_headers, 'missing.zip', len(content))['upload_id']
    _put(client, token_headers, uid, 1, _parts(content)[0])
    assert client.post(f'{MP}/{uid}/complete', headers=token_headers).json()['code'] != 200


def test_complete_rechecks_limits(
    client: TestClient, token_headers: dict[str, str], monkeypatch: pytest.MonkeyPatch
) -> None:
    """init 之后管理员调低了上限：complete 时要拒（只在 init 校验一次就是开了个时间窗）"""
    content = os.urandom(CHUNK * 2)
    uid = _init(client, token_headers, 'limit.zip', len(content))['upload_id']
    for n, chunk in enumerate(_parts(content), start=1):
        _put(client, token_headers, uid, n, chunk)
    monkeypatch.setattr(settings, 'UPLOAD_ARCHIVE_SIZE_MAX', CHUNK)
    assert client.post(f'{MP}/{uid}/complete', headers=token_headers).json()['code'] != 200


@pytest.mark.parametrize('upload_id', ['../../etc', 'a' * 31, 'Z' * 32])
def test_malformed_upload_id_is_404(client: TestClient, token_headers: dict[str, str], upload_id: str) -> None:
    """upload_id 会被拼进 Redis key 和存储 key —— 形状不对一律当不存在"""
    assert client.get(f'{MP}/{upload_id}', headers=token_headers).status_code in (404, 422)


@pytest.mark.parametrize('suffix', [':parts', ':lock'])
def test_upload_id_cannot_reach_the_sibling_redis_keys(
    client: TestClient, token_headers: dict[str, str], suffix: str
) -> None:
    """🔴 真实的 upload_id 拼上 `:parts` / `:lock` 正好是会话旁边那两个 key（一个集合、一个 '1'）——
    不校验形状的话拿它们当会话读，前者 WRONGTYPE、后者 json 解出来是个 int，两个都是 500"""
    content = os.urandom(CHUNK + 1)
    uid = _init(client, token_headers, 'sibling.zip', len(content))['upload_id']
    _put(client, token_headers, uid, 1, _parts(content)[0])  # `:parts` 集合存在了
    lock = f'{settings.FILE_MULTIPART_REDIS_PREFIX}:{uid}:lock'

    async def hold(*, on: bool) -> None:
        from backend.database.redis import RedisCli

        cli = RedisCli()
        try:
            await (cli.set(lock, '1', ex=60) if on else cli.delete(lock))
        finally:
            await cli.aclose()

    asyncio.run(hold(on=True))
    try:
        assert client.get(f'{MP}/{uid}{suffix}', headers=token_headers).status_code == 404
    finally:
        asyncio.run(hold(on=False))
        client.delete(f'{MP}/{uid}', headers=token_headers)


def _with_service(fn: Callable[[Any, Any], Awaitable[None]]) -> None:
    """直接调 service：独立的引擎 + 独立的 Redis

    `redis_client` 绑在 TestClient 的事件循环上（test_ai_write_tools 记过），在这里的 asyncio.run 里用会撞循环
    """
    import backend.app.admin.service.multipart_service as mod

    from backend.database.db import create_database_async_engine, create_database_async_session, get_database_url
    from backend.database.redis import RedisCli

    async def go() -> None:
        engine = create_database_async_engine(get_database_url(unittest=True))
        original = mod.redis_client
        mod.redis_client = RedisCli()
        try:
            async with create_database_async_session(engine)() as db:
                await fn(mod.multipart_service, db)
        finally:
            await mod.redis_client.aclose()
            mod.redis_client = original
            await engine.dispose()

    asyncio.run(go())


def test_session_belongs_to_its_owner() -> None:
    """别人的 upload_id：读 / 写 / 完成 / 取消都当不存在（直接测 service，种子里没有第二个有上传权限的普通账号）"""
    from backend.common.exception import errors

    async def go(svc: Any, db: Any) -> None:
        uid = (await svc.init(db=db, user_id=1, name='a.zip', size=10, public=False))['upload_id']

        async def one_byte() -> AsyncIterator[bytes]:  # ruff: ignore[unused-async] - 异步生成器，ruff 误报
            yield b'x'

        for call in (
            svc.status(upload_id=uid, user_id=2),
            svc.put_part(db=db, upload_id=uid, part=1, user_id=2, body=one_byte(), content_length=None),
            svc.complete(db=db, upload_id=uid, user_id=2),
            svc.abort(db=db, upload_id=uid, user_id=2),
        ):
            with pytest.raises(errors.NotFoundError):
                await call
        await svc.abort(db=db, upload_id=uid, user_id=1)

    _with_service(go)


# ─── 存储 ───────────────────────────────────────────────────────────────────


def test_multipart_on_s3(
    client: TestClient,
    token_headers: dict[str, str],
    monkeypatch: pytest.MonkeyPatch,
    s3_endpoint: str,  # ruff: ignore[redefined-while-unused] - pytest 按参数名注入上面 import 进来的 fixture
) -> None:
    """默认存储是 S3 时：分片落在桶里的 private/_multipart/，拼完对象在桶里、分片清干净；
    过期会话的分片定时任务也清得掉（S3 上「目录」是公共前缀，和本地的列目录不是一条代码路径）。

    `STORAGE_TEST_S3_ENDPOINT` 指向真服务（比如 RustFS）时跑真服务，否则进程内 moto（同 test_storage）
    """
    monkeypatch.setattr(settings, 'STORAGE_ENCRYPT_SECRET_KEY', os.urandom(32).hex())
    pk = _create_s3(client, token_headers, s3_endpoint, code='MULTIPART')
    client.put('/sys/storages/default', headers=token_headers, json={'storage_id': pk})
    bucket = _s3_resource(s3_endpoint).Bucket(_BUCKET)
    try:
        content = os.urandom(CHUNK * 2 + 3)
        record = _upload_all(client, token_headers, 's3.zip', content)
        assert str(record['storage_id']) == str(pk)
        assert client.get(f'{FILES}/{record["id"]}/download', headers=token_headers).content == content
        keys = [o.key for o in bucket.objects.all()]
        assert any(k.endswith(record['path']) for k in keys)
        assert not [k for k in keys if '/_multipart/' in k], keys

        # 传了一片就走了、会话过期 → 定时任务按公共前缀找到它、删掉
        stale = _init(client, token_headers, 'stale.zip', len(content))['upload_id']
        _put(client, token_headers, stale, 1, _parts(content)[0])
        assert [o.key for o in bucket.objects.filter(Prefix=f'private/_multipart/{stale}/')], '前置：分片在桶里'
        _expire_session(stale)
        assert '1 个' in _run_cleanup_task()
        assert not [o.key for o in bucket.objects.all() if '/_multipart/' in o.key]
    finally:
        client.put('/sys/storages/default', headers=token_headers, json={'storage_id': None})


# ─── 定时清理 ────────────────────────────────────────────────────────────────


def test_stale_parts_are_purged_by_the_task(
    client: TestClient, token_headers: dict[str, str], isolated_upload_dir: Path
) -> None:
    """会话过期（Redis key 没了）留下的分片由 `maintenance.purge_stale_multipart` 清掉；活着的会话不动"""
    content = os.urandom(CHUNK * 2)
    dead = _init(client, token_headers, 'dead.zip', len(content))['upload_id']
    alive = _init(client, token_headers, 'alive.zip', len(content))['upload_id']
    for uid in (dead, alive):
        _put(client, token_headers, uid, 1, _parts(content)[0])
    assert len(_part_files(isolated_upload_dir)) == 2

    _expire_session(dead)
    # 不是我们起的名字（有人手工放进来的）不碰
    foreign = isolated_upload_dir / '_multipart' / 'not-an-upload-id' / 'keep.txt'
    foreign.parent.mkdir(parents=True)
    foreign.write_text('x')
    msg = _run_cleanup_task()
    assert '1 个' in msg, msg
    remaining = {p.parent.name for p in _part_files(isolated_upload_dir)}
    assert remaining == {alive, 'not-an-upload-id'}
    client.delete(f'{MP}/{alive}', headers=token_headers)


def _expire_session(upload_id: str) -> None:
    """模拟会话过期：删掉会话 key（分片集合留着也无所谓，任务只看会话在不在）"""

    async def go() -> None:
        from backend.database.redis import RedisCli

        cli = RedisCli()
        try:
            await cli.delete(f'{settings.FILE_MULTIPART_REDIS_PREFIX}:{upload_id}')
        finally:
            await cli.aclose()

    asyncio.run(go())


def _run_cleanup_task() -> str:
    """同 test_recycle._run_purge_task：任务自己开会话 / 用 Redis，换成独立的（不然撞事件循环）"""
    import backend.app.task.tasks.maintenance.tasks as mod
    import backend.database.redis as redis_module

    from backend.app.task.tasks.maintenance.tasks import purge_stale_multipart
    from backend.database.db import create_database_async_engine, create_database_async_session, get_database_url
    from backend.database.redis import RedisCli

    engine = create_database_async_engine(get_database_url(unittest=True))
    original_session, original_redis = mod.async_db_session, redis_module.redis_client
    mod.async_db_session = create_database_async_session(engine)

    async def go() -> str:
        cli = RedisCli()
        redis_module.redis_client = cli
        try:
            return await purge_stale_multipart()
        finally:
            await cli.aclose()
            await engine.dispose()

    try:
        return asyncio.run(go())
    finally:
        mod.async_db_session, redis_module.redis_client = original_session, original_redis
