"""存储管理（#122 第一期）的测试：真实 HTTP + 测试库 + 进程内的 S3 模拟服务（moto）。

要守的都是「写错了不报错」的那一类：

- 切默认存储之后**老文件**还能不能读（按记录上的 storage_id 读，不按当前默认）
- 秒传会不会跨存储命中（命中了新记录就指向别的存储里的对象）
- 密钥出不出接口；没配加密密钥时是拒绝还是静默存明文
- 删 / 停一个还有文件的存储会不会被放行
- 公开件在 S3 上时 `/uploads/{key}` 还通不通，私有件会不会被它漏出去
- 改了存储配置，进程里缓存的旧 operator 会不会继续用（多副本下 = 别的机器还连着旧桶）

⚠️ moto **不校验签名**，所以「错误的 SecretKey」在它上面测不出来（测试连接照样通过）。
设了 `STORAGE_TEST_S3_ENDPOINT`（+ `_ACCESS_KEY` / `_SECRET_KEY`）就改打那台真实的 S3 兼容服务
（RustFS / MinIO / …），全部用例照跑，并多出只在真服务上有意义的几条（凭据错误 / 桶不存在 / 预签名防篡改）。
本机的那台：`docker compose -f docker-compose.dev.yml --profile s3 up -d rustfs`，
账号 rustfsadmin / rustfs-secret-2026：

    STORAGE_TEST_S3_ENDPOINT=http://127.0.0.1:9100 STORAGE_TEST_S3_ACCESS_KEY=… STORAGE_TEST_S3_SECRET_KEY=… \
        uv run --no-sync pytest backend/app/admin/tests/api_v1/test_storage.py

🔴 它会在那台服务上建一个叫 `pytest-bucket` 的桶并**清空它** —— 别指到生产。
"""

import asyncio
import os

from collections.abc import Generator, Iterator
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

import httpx
import pytest

from sqlalchemy import delete, text
from starlette.testclient import TestClient

from backend.app.admin.model import File, Storage
from backend.core.conf import settings
from backend.database.db import create_database_async_engine, create_database_async_session, get_database_url

STORAGES = '/sys/storages'
FILES = '/sys/files'
_BUCKET = 'pytest-bucket'
_CODE_PREFIX = 'PYTEST_'
#: 真实 S3 兼容服务（见模块 docstring）；没设就用进程内的 moto
_REAL_ENDPOINT = os.environ.get('STORAGE_TEST_S3_ENDPOINT', '').rstrip('/') or None
_S3_ACCESS_KEY = os.environ.get('STORAGE_TEST_S3_ACCESS_KEY', 'pytest') if _REAL_ENDPOINT else 'pytest'
_S3_SECRET_KEY = os.environ.get('STORAGE_TEST_S3_SECRET_KEY', 'pytest') if _REAL_ENDPOINT else 'pytest-secret-value'
#: 本模块经接口传上去的文件 ID，收尾时硬删（接口的删除是逻辑删除，且 `_purge` 按存储删不到内置存储上的那些）
_UPLOADED: list[str] = []
real_s3_only = pytest.mark.skipif(_REAL_ENDPOINT is None, reason='moto 不校验签名 / 桶，这条只在真实 S3 服务上有意义')
_KEY = '2a7e4a278dd16c4f2b28afabf54ad386b86c47b357a851b4f38297628b3e8db0'


def _root_url(path: str) -> str:
    """`/uploads` 挂在站点根上，`client` 的 base_url 带着 `/api/v1`（见 test_file.py 同名函数）"""
    return f'http://testserver{path}'


# ─── fixtures ────────────────────────────────────────────────────────────────


def _s3_resource(endpoint: str):
    import boto3

    return boto3.resource(
        's3',
        endpoint_url=endpoint,
        aws_access_key_id=_S3_ACCESS_KEY,
        aws_secret_access_key=_S3_SECRET_KEY,
        region_name='us-east-1',
    )


@pytest.fixture(scope='module')
def s3_endpoint() -> Iterator[str]:
    """真实的 S3 兼容服务（环境变量指定），或进程内起一个 moto S3（真 HTTP，和真桶同一条请求路径）"""
    if _REAL_ENDPOINT:
        bucket = _s3_resource(_REAL_ENDPOINT).Bucket(_BUCKET)
        if not any(b['Name'] == _BUCKET for b in bucket.meta.client.list_buckets().get('Buckets', [])):
            bucket.create()
        # 真服务上的对象跨轮次留着（_purge 只硬删记录），断言「桶里只有一个 pdf」会被上一轮污染
        bucket.objects.all().delete()
        yield _REAL_ENDPOINT
        return

    from moto.server import ThreadedMotoServer

    server = ThreadedMotoServer(ip_address='127.0.0.1', port=0, verbose=False)
    server.start()
    host, port = server.get_host_and_port()
    endpoint = f'http://{host}:{port}'
    _s3_resource(endpoint).Bucket(_BUCKET).create()
    yield endpoint
    server.stop()


@pytest.fixture
def bucket(s3_endpoint: str):
    return _s3_resource(s3_endpoint).Bucket(_BUCKET)


@pytest.fixture(autouse=True)
def _env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Generator[Path, None, None]:
    """内置存储顶到 tmp（同 test_file.py 的 isolated_upload_dir）+ 配上加密密钥"""
    from backend.utils import file_ops

    upload_dir = tmp_path / 'upload'
    public_dir = tmp_path / 'upload-public'
    upload_dir.mkdir()
    public_dir.mkdir()
    monkeypatch.setattr(file_ops, 'UPLOAD_DIR', upload_dir)
    monkeypatch.setattr(file_ops, 'PUBLIC_UPLOAD_DIR', public_dir)
    monkeypatch.setattr(settings, 'STORAGE_ENCRYPT_SECRET_KEY', _KEY)
    # 🔴 存储的 AK 为空时 OpenDAL 默认会捡环境里的 AWS_*（实测）；这里放一把假的，签名里出现它就是没关掉
    monkeypatch.setenv('AWS_ACCESS_KEY_ID', 'FROM_ENV_SHOULD_NOT_BE_USED')
    monkeypatch.setenv('AWS_SECRET_ACCESS_KEY', 'FROM_ENV_SHOULD_NOT_BE_USED')
    yield upload_dir


@pytest.fixture(autouse=True)
def _purge(client: TestClient, token_headers: dict[str, str]) -> Iterator[None]:
    """收尾：默认切回内置、硬删本文件建的存储和挂在它们上面的文件记录（接口的删除是逻辑删除）"""
    yield
    client.put(f'{STORAGES}/default', headers=token_headers, json={'storage_id': None})

    async def _do() -> None:
        engine = create_database_async_engine(get_database_url(unittest=True))
        try:
            async with create_database_async_session(engine)() as db:
                ids = [
                    row.id
                    for row in (
                        await db.execute(Storage.__table__.select().where(Storage.code.like(f'{_CODE_PREFIX}%')))
                    ).all()
                ]
                if ids:
                    await db.execute(delete(File).where(File.storage_id.in_(ids)))
                    await db.execute(delete(Storage).where(Storage.id.in_(ids)))
                if _UPLOADED:
                    await db.execute(delete(File).where(File.id.in_([int(i) for i in _UPLOADED])))
                    _UPLOADED.clear()
                await db.commit()
        finally:
            await engine.dispose()

    asyncio.run(_do())


def _create_s3(client: TestClient, headers: dict[str, str], endpoint: str, code: str = 'S3', **extra: object) -> str:
    body = {
        'name': 'pytest S3',
        'code': f'{_CODE_PREFIX}{code}',
        'type': 's3',
        'endpoint': endpoint,
        'bucket': _BUCKET,
        'region': 'us-east-1',
        'addressing': 'path',
        'access_key': _S3_ACCESS_KEY,
        'secret_key': _S3_SECRET_KEY,
        **extra,
    }
    resp = client.post(STORAGES, headers=headers, json=body)
    assert resp.status_code == 200, resp.text
    rows = client.get(STORAGES, headers=headers).json()['data']
    return next(r['id'] for r in rows if r['code'] == body['code'])


def _upload(
    client: TestClient,
    headers: dict[str, str],
    name: str,
    content: bytes,
    content_type: str | None = None,
    **params: object,
) -> dict:
    files = {'file': (name, content, content_type) if content_type else (name, content)}
    resp = client.post(f'{FILES}/upload', headers=headers, params=params, files=files)
    assert resp.status_code == 200, resp.text
    data = resp.json()['data']
    _UPLOADED.append(data['id'])
    return data


def _unique(text: bytes) -> bytes:
    """🔴 内置存储上的测试文件内容要带随机串：上传按「同一人 + 同名 + 同内容」秒传复用**上一轮**的记录，
    它指向的 tmp 目录早没了，下载 404 —— 看起来像是按存储读的逻辑坏了（file 分册里那条，这里踩了第二次）"""
    return text + b' ' + os.urandom(8).hex().encode()


def _png() -> bytes:
    from backend.app.admin.tests.api_v1.test_file import _png_bytes

    return _png_bytes()


# ─── 列表 / 内置存储 ─────────────────────────────────────────────────────────


def test_builtin_is_listed_first_and_default(client: TestClient, token_headers: dict[str, str]) -> None:
    rows = client.get(STORAGES, headers=token_headers).json()['data']
    assert rows[0]['id'] == 'builtin'
    assert rows[0]['builtin'] is True
    # 表里没有默认时，内置存储就是默认（测试库是干净的，_purge 每条收尾都切回内置）
    assert rows[0]['is_default'] is True


def test_requires_permission(client: TestClient) -> None:
    assert client.get(STORAGES).status_code == 401


# ─── 密钥 ───────────────────────────────────────────────────────────────────


def test_secret_never_leaves_the_server(client: TestClient, token_headers: dict[str, str], s3_endpoint: str) -> None:
    pk = _create_s3(client, token_headers, s3_endpoint)
    text = client.get(STORAGES, headers=token_headers).text
    assert _S3_SECRET_KEY not in text
    assert 'secret_cipher' not in text
    row = next(r for r in client.get(STORAGES, headers=token_headers).json()['data'] if r['id'] == pk)
    assert row['secret_hint'] and _S3_SECRET_KEY not in row['secret_hint']


def test_refuses_to_store_secret_without_encrypt_key(
    client: TestClient, token_headers: dict[str, str], s3_endpoint: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    """🔴 fail-closed：没配 STORAGE_ENCRYPT_SECRET_KEY 时拒绝，**不**静默存明文"""
    monkeypatch.setattr(settings, 'STORAGE_ENCRYPT_SECRET_KEY', '')
    resp = client.post(
        STORAGES,
        headers=token_headers,
        json={
            'name': 'x',
            'code': f'{_CODE_PREFIX}NOKEY',
            'type': 's3',
            'endpoint': s3_endpoint,
            'bucket': _BUCKET,
            'access_key': 'a',
            'secret_key': 'b',
        },
    )
    assert resp.status_code != 200
    assert 'STORAGE_ENCRYPT_SECRET_KEY' in resp.json()['msg']
    assert all(r['code'] != f'{_CODE_PREFIX}NOKEY' for r in client.get(STORAGES, headers=token_headers).json()['data'])


# ─── 配置校验 ────────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    'endpoint',
    [
        'http://169.254.169.254/latest/meta-data',  # 云主机元数据（含临时凭据）
        'http://[fe80::1]:9000',
        'http://0.0.0.0:9000',
        'ftp://minio:9000',
        'http://user:pass@minio:9000',
        # `.port` 对这两种抛 ValueError，要翻成 400 而不是 500
        'http://minio:9000x',
        'http://minio:99999',
    ],
)
def test_rejects_dangerous_endpoints(client: TestClient, token_headers: dict[str, str], endpoint: str) -> None:
    resp = client.post(
        STORAGES,
        headers=token_headers,
        json={
            'name': 'x',
            'code': f'{_CODE_PREFIX}SSRF',
            'type': 's3',
            'endpoint': endpoint,
            'bucket': _BUCKET,
            'access_key': 'a',
            'secret_key': 'b',
        },
    )
    assert resp.status_code != 200, endpoint


def test_rotated_encrypt_key_is_a_visible_storage_error(
    client: TestClient, token_headers: dict[str, str], s3_endpoint: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    """换了 STORAGE_ENCRYPT_SECRET_KEY（或密文损坏）：AES 解填充抛裸 ValueError，
    要翻成「存储不可用」/ 404，不能是裸 500"""
    pk = _create_s3(client, token_headers, s3_endpoint)
    client.put(f'{STORAGES}/default', headers=token_headers, json={'storage_id': pk})
    data = _upload(client, token_headers, 'rotated.png', _png(), public=True)
    monkeypatch.setattr(settings, 'STORAGE_ENCRYPT_SECRET_KEY', 'ff' * 32)
    assert client.get(_root_url(data['public_url']), follow_redirects=False).status_code == 404
    resp = client.get(f'{FILES}/{data["id"]}/download', headers=token_headers)
    assert resp.status_code == 500 and resp.json()['msg'], resp.text
    assert 'ValueError' not in resp.text and 'padding' not in resp.text.lower()
    # 删记录照常，只是对象删不掉
    assert client.request('DELETE', FILES, headers=token_headers, json={'pks': [data['id']]}).status_code == 200


def test_private_network_endpoint_is_allowed(client: TestClient, token_headers: dict[str, str]) -> None:
    """⚠️ 私网**不拦**：MinIO 跑在内网是这个功能最主要的用法（拦了就没法用）"""
    _create_s3(client, token_headers, 'http://10.0.0.1:9000', code='PRIVNET')


@pytest.mark.parametrize('root', ['relative/dir', '/'])
def test_local_storage_root_must_be_absolute_and_not_root(
    client: TestClient, token_headers: dict[str, str], root: str
) -> None:
    resp = client.post(
        STORAGES,
        headers=token_headers,
        json={'name': 'x', 'code': f'{_CODE_PREFIX}LOCAL', 'type': 'local', 'root': root},
    )
    assert resp.status_code != 200


def test_local_storage_root_cannot_be_under_static(client: TestClient, token_headers: dict[str, str]) -> None:
    """🔴 `/static` 无鉴权挂出去，根目录放进去 = 私有文件对任何人可读（UPLOAD_DIR 当年就是这么被连带公开的）"""
    from backend.core.path_conf import STATIC_DIR

    resp = client.post(
        STORAGES,
        headers=token_headers,
        json={'name': 'x', 'code': f'{_CODE_PREFIX}STATIC', 'type': 'local', 'root': str(STATIC_DIR / 'files')},
    )
    assert resp.status_code != 200


def test_code_and_type_are_immutable(client: TestClient, token_headers: dict[str, str], s3_endpoint: str) -> None:
    pk = _create_s3(client, token_headers, s3_endpoint)
    resp = client.put(
        f'{STORAGES}/{pk}',
        headers=token_headers,
        json={
            'name': 'renamed',
            'code': 'HACKED',
            'type': 'local',
            'endpoint': s3_endpoint,
            'bucket': _BUCKET,
            'access_key': _S3_ACCESS_KEY,
        },
    )
    assert resp.status_code == 200, resp.text
    row = next(r for r in client.get(STORAGES, headers=token_headers).json()['data'] if r['id'] == pk)
    assert (row['name'], row['code'], row['type']) == ('renamed', f'{_CODE_PREFIX}S3', 's3')


# ─── 测试连接 ────────────────────────────────────────────────────────────────


def test_probe_ok_and_cleans_up(client: TestClient, token_headers: dict[str, str], s3_endpoint: str, bucket) -> None:
    pk = _create_s3(client, token_headers, s3_endpoint)
    data = client.post(f'{STORAGES}/{pk}/test', headers=token_headers).json()['data']
    assert data['ok'] is True, data
    assert not [o.key for o in bucket.objects.all() if o.key.endswith('.fra-probe')], '探测对象没删掉'


@real_s3_only
def test_probe_wrong_secret_is_permission_denied(
    client: TestClient, token_headers: dict[str, str], s3_endpoint: str
) -> None:
    """🔴 凭据错误要报成「凭据无效」，不是「连不上」也不是 500 —— 且不回显上游原文（SignatureDoesNotMatch 那段 XML）"""
    pk = _create_s3(client, token_headers, s3_endpoint, code='BADKEY', secret_key='definitely-wrong')
    resp = client.post(f'{STORAGES}/{pk}/test', headers=token_headers)
    assert resp.status_code == 200
    data = resp.json()['data']
    assert data['ok'] is False
    assert 'SignatureDoesNotMatch' not in data['message'] and '<' not in data['message']
    assert '凭据' in data['message'] or 'credentials' in data['message'].lower()


@real_s3_only
def test_probe_missing_bucket_is_reported_as_not_found(
    client: TestClient, token_headers: dict[str, str], s3_endpoint: str
) -> None:
    """S3 的 NoSuchBucket 被 OpenDAL 归成 ConfigInvalid —— 要翻成「桶不存在」，不是「配置不合法」"""
    pk = _create_s3(client, token_headers, s3_endpoint, code='NOBUCKET', bucket='pytest-no-such-bucket')
    data = client.post(f'{STORAGES}/{pk}/test', headers=token_headers).json()['data']
    assert data['ok'] is False
    assert '<' not in data['message']
    assert '桶不存在' in data['message'] or 'bucket does not exist' in data['message'].lower()


@real_s3_only
def test_presigned_link_cannot_be_tampered(client: TestClient, token_headers: dict[str, str], s3_endpoint: str) -> None:
    """🔴 预签名地址里的 key / 有效期 / 文件名都在签名里：改任何一个都要 403（moto 不验签，这条只在真服务上成立）"""
    import re

    pk = _create_s3(client, token_headers, s3_endpoint)
    client.put(f'{STORAGES}/default', headers=token_headers, json={'storage_id': pk})
    data = _upload(client, token_headers, 'signed.txt', b'signed content')
    url = client.get(f'{FILES}/{data["id"]}/link', headers=token_headers).json()['data']['url']
    assert httpx.get(url).status_code == 200
    suffix = data['name'].rsplit('_', 1)[1]  # `<stem>_<16 位 hex>.txt` 里的随机段，一定是 ASCII、一定在 URL 里
    assert suffix in url
    assert httpx.get(url.replace(suffix, 'x' * len(suffix))).status_code == 403, '换了 key 还能下'
    sig = re.search(r'X-Amz-Signature=([0-9a-f]+)', url).group(1)
    assert httpx.get(url.replace(sig, ('0' if sig[0] != '0' else '1') + sig[1:])).status_code == 403
    assert httpx.get(re.sub(r'X-Amz-Expires=\d+', 'X-Amz-Expires=604800', url)).status_code == 403, '改了有效期还能下'


@real_s3_only
def test_upload_with_wrong_secret_fails_visibly(
    client: TestClient, token_headers: dict[str, str], s3_endpoint: str
) -> None:
    """默认存储的凭据错了：上传必须报错，**不能**留下一条指向不存在对象的记录（硬纪律 9）"""
    pk = _create_s3(client, token_headers, s3_endpoint, code='BADUP', secret_key='definitely-wrong')
    client.put(f'{STORAGES}/default', headers=token_headers, json={'storage_id': pk})
    payload = _unique(b'nope')
    resp = client.post(f'{FILES}/upload', headers=token_headers, files={'file': ('x.txt', payload)})
    assert resp.status_code != 200 or resp.json().get('code') != 200, resp.text
    import hashlib

    sha = hashlib.sha256(payload).hexdigest()
    check = client.get(f'{FILES}/check', headers=token_headers, params={'sha256': sha, 'name': 'x.txt'})
    assert check.json()['data'] is None


def test_probe_unreachable_is_a_result_not_an_error(client: TestClient, token_headers: dict[str, str]) -> None:
    """连不通是**测试结果**（ok=false），不是接口失败 —— 而且不回显上游原文"""
    pk = _create_s3(client, token_headers, 'http://127.0.0.1:1', code='DEAD')
    resp = client.post(f'{STORAGES}/{pk}/test', headers=token_headers)
    assert resp.status_code == 200
    data = resp.json()['data']
    assert data['ok'] is False
    assert 'tcp' not in data['message'].lower() and '127.0.0.1' not in data['message']


# ─── 上传 / 下载 / 秒传 ──────────────────────────────────────────────────────


def test_upload_to_s3_then_download_and_presign(
    client: TestClient, token_headers: dict[str, str], s3_endpoint: str, bucket, _env: Path
) -> None:
    pk = _create_s3(client, token_headers, s3_endpoint, root='tenant-a')
    assert client.put(f'{STORAGES}/default', headers=token_headers, json={'storage_id': pk}).status_code == 200

    content = os.urandom(3 * 1024 * 1024 + 17)
    data = _upload(client, token_headers, '季度报告.pdf', content)
    assert str(data['storage_id']) == str(pk)
    # 落进桶里 `<root>/private/<日期>/<名字>`，本地盘上什么都没有
    keys = [o.key for o in bucket.objects.all()]
    assert f'tenant-a/private/{data["path"]}' in keys, keys
    assert not any(_env.rglob('*.pdf'))

    # 后端代理下载：字节一致、文件名带过去
    resp = client.get(f'{FILES}/{data["id"]}/download', headers=token_headers, params={'disposition': 'attachment'})
    assert resp.status_code == 200
    assert resp.content == content
    assert 'attachment' in resp.headers['content-disposition']
    # 流式代理也要有 Content-Length（存储现查的大小）：没有它浏览器的下载条只会转圈
    assert int(resp.headers['content-length']) == len(content)

    # 预签名直连：不带任何凭据就能取，文件名经 response-content-disposition 带过去
    link = client.get(f'{FILES}/{data["id"]}/link', headers=token_headers).json()['data']
    assert link['url'] and link['expires_in'] == settings.STORAGE_PRESIGN_EXPIRE_SECONDS
    query = parse_qs(urlsplit(link['url']).query)
    assert 'attachment' in query['response-content-disposition'][0]
    # 签名用的是存储里配的 key，不是环境变量里那把（_env 放了一把假的）
    assert query['X-Amz-Credential'][0].startswith(f'{_S3_ACCESS_KEY}/')
    direct = httpx.get(link['url'])
    assert direct.status_code == 200 and direct.content == content

    # 秒传在同一个存储里照常命中
    again = _upload(client, token_headers, '季度报告.pdf', content)
    assert again['id'] == data['id']
    pdfs = [o.key for o in bucket.objects.all() if o.key.endswith('.pdf')]
    assert len(pdfs) == 1, f'秒传后多出来的副本没删掉：{pdfs}'


def test_builtin_storage_has_no_presigned_link(client: TestClient, token_headers: dict[str, str]) -> None:
    data = _upload(client, token_headers, 'a.txt', _unique(b'hello'))
    link = client.get(f'{FILES}/{data["id"]}/link', headers=token_headers)
    assert link.status_code == 200
    assert link.json()['data']['url'] is None


def test_switching_default_does_not_move_old_files(
    client: TestClient, token_headers: dict[str, str], s3_endpoint: str
) -> None:
    """🔴 切默认存储只影响新上传，老文件按**自己的** storage_id 读"""
    old_content = _unique(b'on builtin')
    old = _upload(client, token_headers, 'old.txt', old_content)
    assert old['storage_id'] is None

    pk = _create_s3(client, token_headers, s3_endpoint)
    client.put(f'{STORAGES}/default', headers=token_headers, json={'storage_id': pk})
    new = _upload(client, token_headers, 'new.txt', b'on s3')
    assert str(new['storage_id']) == str(pk)

    # 内置文件在 S3 为默认时照样能读，反过来也一样
    assert client.get(f'{FILES}/{old["id"]}/download', headers=token_headers).content == old_content
    client.put(f'{STORAGES}/default', headers=token_headers, json={'storage_id': None})
    assert client.get(f'{FILES}/{new["id"]}/download', headers=token_headers).content == b'on s3'


def test_dedup_never_crosses_storages(client: TestClient, token_headers: dict[str, str], s3_endpoint: str) -> None:
    """🔴 秒传只在同一个存储里复用：跨存储命中 = 新记录指向别的存储里的对象"""
    content = _unique(b'same content, same name')
    first = _upload(client, token_headers, 'dup.txt', content)

    pk = _create_s3(client, token_headers, s3_endpoint)
    client.put(f'{STORAGES}/default', headers=token_headers, json={'storage_id': pk})
    import hashlib

    sha = hashlib.sha256(content).hexdigest()
    # /check 和 upload 同一个口径：默认存储换了，就不算「传过」
    check = client.get(f'{FILES}/check', headers=token_headers, params={'sha256': sha, 'name': 'dup.txt'})
    assert check.json()['data'] is None
    second = _upload(client, token_headers, 'dup.txt', content)
    assert second['id'] != first['id']
    assert str(second['storage_id']) == str(pk)


def test_delete_file_removes_object(
    client: TestClient, token_headers: dict[str, str], s3_endpoint: str, bucket
) -> None:
    pk = _create_s3(client, token_headers, s3_endpoint)
    client.put(f'{STORAGES}/default', headers=token_headers, json={'storage_id': pk})
    data = _upload(client, token_headers, 'gone.txt', b'bye')
    assert any(o.key.endswith(data['path']) for o in bucket.objects.all())

    assert client.request('DELETE', FILES, headers=token_headers, json={'pks': [data['id']]}).status_code == 200
    # 进回收站：对象还在（还原要靠它）
    assert any(o.key.endswith(data['path']) for o in bucket.objects.all())
    purge = client.request('DELETE', f'{FILES}/recycle', headers=token_headers, json={'pks': [data['id']]})
    assert purge.status_code == 200
    assert not any(o.key.endswith(data['path']) for o in bucket.objects.all()), '彻底删除了、桶里留孤儿'


def test_missing_object_is_reported_as_missing(
    client: TestClient, token_headers: dict[str, str], s3_endpoint: str, bucket
) -> None:
    """对象被人在桶里删了：报「文件已丢失」（404），不是 500，也不是发出一半响应头再断"""
    pk = _create_s3(client, token_headers, s3_endpoint)
    client.put(f'{STORAGES}/default', headers=token_headers, json={'storage_id': pk})
    data = _upload(client, token_headers, 'vanish.txt', b'x')
    bucket.Object(f'private/{data["path"]}').delete()
    resp = client.get(f'{FILES}/{data["id"]}/download', headers=token_headers)
    assert resp.status_code == 404


# ─── 公开件 ─────────────────────────────────────────────────────────────────


def test_public_upload_on_s3_redirects_to_presigned(
    client: TestClient, token_headers: dict[str, str], s3_endpoint: str
) -> None:
    pk = _create_s3(client, token_headers, s3_endpoint)
    client.put(f'{STORAGES}/default', headers=token_headers, json={'storage_id': pk})
    data = _upload(client, token_headers, 'cover.png', _png(), public=True, content_type='text/html')
    # URL 形状不随存储变 —— 已经存进富文本正文里的地址不用改
    assert data['public_url'].startswith('/uploads/')

    resp = client.get(_root_url(data['public_url']), follow_redirects=False)
    assert resp.status_code == 302
    location = resp.headers['location']
    # 🔴 重定向的缓存必须短于签名有效期，否则浏览器会拿着过期的地址去请求
    max_age = int(resp.headers['cache-control'].split('max-age=')[1])
    assert max_age < settings.STORAGE_PRESIGN_EXPIRE_SECONDS
    # 预签名里带的 response-content-type 是按扩展名定的，不是客户端声明的（这里故意声明成 text/html）
    assert parse_qs(urlsplit(location).query)['response-content-type'] == ['image/png']
    assert httpx.get(location).content == _png()


def test_public_upload_with_public_base_url_redirects_there(
    client: TestClient, token_headers: dict[str, str], s3_endpoint: str
) -> None:
    pk = _create_s3(client, token_headers, s3_endpoint, public_base_url='https://cdn.example.com/assets/')
    client.put(f'{STORAGES}/default', headers=token_headers, json={'storage_id': pk})
    data = _upload(client, token_headers, 'logo.png', _png(), public=True)
    resp = client.get(_root_url(data['public_url']), follow_redirects=False)
    assert resp.status_code == 302
    assert resp.headers['location'] == f'https://cdn.example.com/assets/{data["path"]}'


def test_private_s3_file_is_not_served_by_uploads(
    client: TestClient, token_headers: dict[str, str], s3_endpoint: str
) -> None:
    pk = _create_s3(client, token_headers, s3_endpoint)
    client.put(f'{STORAGES}/default', headers=token_headers, json={'storage_id': pk})
    data = _upload(client, token_headers, 'secret.png', _png())
    assert data['public_url'] is None
    assert client.get(_root_url(f'/uploads/{data["path"]}'), follow_redirects=False).status_code == 404


# ─── 默认 / 启停 / 删除的规则 ───────────────────────────────────────────────


def test_default_cannot_be_disabled_or_deleted(
    client: TestClient, token_headers: dict[str, str], s3_endpoint: str
) -> None:
    pk = _create_s3(client, token_headers, s3_endpoint)
    client.put(f'{STORAGES}/default', headers=token_headers, json={'storage_id': pk})
    assert client.put(f'{STORAGES}/{pk}/status', headers=token_headers, json={'status': 0}).status_code != 200
    assert client.delete(f'{STORAGES}/{pk}', headers=token_headers).status_code != 200


def test_disabled_storage_cannot_become_default(
    client: TestClient, token_headers: dict[str, str], s3_endpoint: str
) -> None:
    pk = _create_s3(client, token_headers, s3_endpoint)
    assert client.put(f'{STORAGES}/{pk}/status', headers=token_headers, json={'status': 0}).status_code == 200
    assert client.put(f'{STORAGES}/default', headers=token_headers, json={'storage_id': pk}).status_code != 200


def test_storage_with_files_cannot_be_deleted(
    client: TestClient, token_headers: dict[str, str], s3_endpoint: str
) -> None:
    pk = _create_s3(client, token_headers, s3_endpoint)
    client.put(f'{STORAGES}/default', headers=token_headers, json={'storage_id': pk})
    data = _upload(client, token_headers, 'keep.txt', b'keep')
    client.put(f'{STORAGES}/default', headers=token_headers, json={'storage_id': None})

    resp = client.delete(f'{STORAGES}/{pk}', headers=token_headers)
    assert resp.status_code != 200
    row = next(r for r in client.get(STORAGES, headers=token_headers).json()['data'] if r['id'] == pk)
    assert row['file_count'] == 1

    # 🔴 删进回收站之后**仍然拦**：对象还在这个存储里，删了存储就永远还原不回来
    client.request('DELETE', FILES, headers=token_headers, json={'pks': [data['id']]})
    assert client.delete(f'{STORAGES}/{pk}', headers=token_headers).status_code != 200
    row = next(r for r in client.get(STORAGES, headers=token_headers).json()['data'] if r['id'] == pk)
    assert (row['file_count'], row['recycled_count']) == (0, 1)

    # 彻底删除之后才放行
    client.request('DELETE', f'{FILES}/recycle', headers=token_headers, json={'pks': [data['id']]})
    assert client.delete(f'{STORAGES}/{pk}', headers=token_headers).status_code == 200


def test_storage_with_live_exports_cannot_be_deleted(
    client: TestClient, token_headers: dict[str, str], s3_endpoint: str, bucket
) -> None:
    """🔴 导出文件也落在存储里，但不进 `sys_file` —— 上面那条「有文件不能删」看不见它们。
    删了存储，导出记录上的「下载」就全是 404，过期清理也找不到存储去删对象"""
    pk = _create_s3(client, token_headers, s3_endpoint)
    client.put(f'{STORAGES}/default', headers=token_headers, json={'storage_id': pk})
    job = client.post('/sys/users/export', headers=token_headers, json={}).json()['data']
    client.put(f'{STORAGES}/default', headers=token_headers, json={'storage_id': None})

    async def _job_sql(statement: str) -> None:
        engine = create_database_async_engine(get_database_url(unittest=True))
        try:
            async with engine.begin() as conn:
                await conn.execute(text(statement), {'pk': int(job['id'])})
        finally:
            await engine.dispose()

    try:
        # 先断言「有」：导出确实落在了这个存储里（否则「删不掉」可能是别的原因）
        assert job['status'] == 2, job
        assert any(obj.key.endswith(f'{job["id"]}.xlsx') for obj in bucket.objects.all())
        resp = client.delete(f'{STORAGES}/{pk}', headers=token_headers).json()
        assert resp['code'] != 200
        assert '导出' in resp['msg'], resp['msg']

        # 过期清理之后（状态变成「已过期」、对象已删）才放行
        asyncio.run(_job_sql('UPDATE sys_export_job SET status = 4 WHERE id = :pk'))
        assert client.delete(f'{STORAGES}/{pk}', headers=token_headers).json()['code'] == 200
    finally:
        asyncio.run(_job_sql('DELETE FROM sys_export_job WHERE id = :pk'))


def test_disabled_storage_still_serves_its_files(
    client: TestClient, token_headers: dict[str, str], s3_endpoint: str
) -> None:
    """停用只拦「设为默认」，不拦读 —— 停一个存储 = 一批文件全 404 是不可接受的"""
    pk = _create_s3(client, token_headers, s3_endpoint)
    client.put(f'{STORAGES}/default', headers=token_headers, json={'storage_id': pk})
    data = _upload(client, token_headers, 'still.txt', b'readable')
    client.put(f'{STORAGES}/default', headers=token_headers, json={'storage_id': None})
    assert client.put(f'{STORAGES}/{pk}/status', headers=token_headers, json={'status': 0}).status_code == 200
    assert client.get(f'{FILES}/{data["id"]}/download', headers=token_headers).content == b'readable'


# ─── 配置变更要立刻生效（多副本） ─────────────────────────────────────────────


def test_config_change_is_not_masked_by_operator_cache(
    client: TestClient, token_headers: dict[str, str], s3_endpoint: str
) -> None:
    """🔴 operator 按 `(id, updated_time)` 缓存：改了配置就用新的。

    只按 id 缓存的话，这一台改完配置自己会清，**别的副本**还拿着旧 operator ——
    这里用「同一进程里先用一次、再改配置」模拟那种状态：缓存里已经有旧的了
    """
    pk = _create_s3(client, token_headers, s3_endpoint)
    assert client.post(f'{STORAGES}/{pk}/test', headers=token_headers).json()['data']['ok'] is True
    body = {'name': 'pytest S3', 'endpoint': 'http://127.0.0.1:1', 'bucket': _BUCKET, 'access_key': 'pytest'}
    assert client.put(f'{STORAGES}/{pk}', headers=token_headers, json=body).status_code == 200
    assert client.post(f'{STORAGES}/{pk}/test', headers=token_headers).json()['data']['ok'] is False
