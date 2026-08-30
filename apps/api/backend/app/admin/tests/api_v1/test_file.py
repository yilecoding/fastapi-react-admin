"""文件管理接口测试

覆盖的是**手工验过、并且真的踩过**的那些点，不是为了凑覆盖率：

- 文档类能不能传（旧代码的 `else: raise` 把 pdf/docx/xlsx 全挡了）
- 秒传去重的 key 带不带文件名（不带会丢掉用户起的名字）
- 每个读取路径有没有 `download_url`（只给上传响应加时，列表页预览拼出 `…undefined`）
- 路径穿越拦不拦
- 删除有没有连带清关联和磁盘文件
- 挂载是不是幂等
- `/static/upload` 那个无鉴权挂载有没有真关掉

⚠️ `UPLOAD_DIR` 由 `isolated_upload_dir` 顶到 tmp 目录。不顶的话测试会往
`backend/upload/`（开发环境真实的上传目录）里写垃圾文件。
"""

import zipfile

from collections.abc import Generator
from io import BytesIO
from pathlib import Path

import pytest

from starlette.testclient import TestClient

FILES = '/sys/files'


# ─── 测试用文件 ────────────────────────────────────────────────────────────────


def _svg_bytes() -> bytes:
    """一段"看起来是图片、实则可执行"的 SVG —— issue #56 的攻击样本"""
    return b'<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'


def _png_bytes(color: tuple[int, int, int] = (200, 30, 30)) -> bytes:
    """手搓一个 2x2 PNG —— 不为了一个 fixture 引 Pillow"""
    import struct
    import zlib

    raw = b''.join(b'\x00' + bytes(color) * 2 for _ in range(2))

    def chunk(tag: bytes, data: bytes) -> bytes:
        body = tag + data
        return struct.pack('>I', len(data)) + body + struct.pack('>I', zlib.crc32(body) & 0xFFFFFFFF)

    ihdr = struct.pack('>IIBBBBB', 2, 2, 8, 2, 0, 0, 0)
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', ihdr) + chunk(b'IDAT', zlib.compress(raw)) + chunk(b'IEND', b'')


def _zip_entry(name: str) -> zipfile.ZipInfo:
    """固定 mtime 的 `ZipInfo`。

    🔴 `ZipFile.writestr(name, data)` 传纯字符串时，内部拿 `time.localtime()`
    盖当前时刻的 DOS 时间戳写进 local file header —— `test_download_inline_and_
    attachment` 拿 `_docx_bytes()` 生成两次（一次上传、一次比对）做逐字节比较，
    两次调用跨过 DOS 时间戳 2 秒精度的边界就会在固定字节位置错开一位，
    偶发性地把测试打红（实测：`At index 10 diff: b'#' != b'$'`，正是 local file
    header 里 mod-time 那个字段）。固定成同一个 `date_time` 就与调用时刻无关。
    """
    info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
    info.compress_type = zipfile.ZIP_DEFLATED
    return info


def _docx_bytes(text: str = 'hello') -> bytes:
    """最小可用的 docx（zip + 两个 XML 部件）"""
    buf = BytesIO()
    with zipfile.ZipFile(buf, 'w', zipfile.ZIP_DEFLATED) as z:
        z.writestr(
            _zip_entry('[Content_Types].xml'),
            '<?xml version="1.0" encoding="UTF-8"?>'
            '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
            '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
            '<Default Extension="xml" ContentType="application/xml"/>'
            '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-'
            'officedocument.wordprocessingml.document.main+xml"/></Types>',
        )
        z.writestr(
            _zip_entry('_rels/.rels'),
            '<?xml version="1.0" encoding="UTF-8"?>'
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/'
            'relationships/officeDocument" Target="word/document.xml"/></Relationships>',
        )
        z.writestr(
            _zip_entry('word/document.xml'),
            '<?xml version="1.0" encoding="UTF-8"?>'
            '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
            f'<w:body><w:p><w:r><w:t>{text}</w:t></w:r></w:p></w:body></w:document>',
        )
    return buf.getvalue()


# ─── fixtures ────────────────────────────────────────────────────────────────


@pytest.fixture(autouse=True)
def isolated_upload_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Generator[Path, None, None]:
    """
    把两棵落盘树都顶到 tmp，返回**私有**树。

    接缝是 `file_ops.upload_root()` —— 它在**调用时**读 `file_ops` 的模块级
    `UPLOAD_DIR` / `PUBLIC_UPLOAD_DIR`，所以只要补这两个名字就够了：
    `file_service` 也走 `upload_root()`，会跟着一起生效。

    ⚠️ 改 `path_conf` 上的那两个**没用** —— 各模块是在顶层
    `from ... import UPLOAD_DIR` 把值拷进自己命名空间的。
    也不要退回「逐个模块 setattr」：`upload_root()` 存在的意义就是把选根
    收成一处，测试也该顶在同一处，否则新增调用方时又要补一遍。

    两棵树都要顶。只顶私有树的话，公开上传会写进**真实的**
    `backend/upload-public/`，而那个目录是 `/uploads` 静态挂出去的。
    """
    from backend.utils import file_ops

    upload_dir = tmp_path / 'upload'
    public_dir = tmp_path / 'upload-public'
    upload_dir.mkdir()
    public_dir.mkdir()
    monkeypatch.setattr(file_ops, 'UPLOAD_DIR', upload_dir)
    monkeypatch.setattr(file_ops, 'PUBLIC_UPLOAD_DIR', public_dir)
    yield upload_dir


@pytest.fixture
def uploaded(client: TestClient, token_headers: dict[str, str]) -> Generator[dict, None, None]:
    """传一个 docx 上去，用完删掉"""
    resp = client.post(
        f'{FILES}/upload',
        headers=token_headers,
        files={
            'file': (
                '契约文本.docx',
                _docx_bytes(),
                'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            )
        },
    )
    resp.raise_for_status()
    data = resp.json()['data']
    yield data
    client.request('DELETE', FILES, headers=token_headers, json={'pks': [data['id']]})


# ─── 上传 ────────────────────────────────────────────────────────────────────


def test_upload_document(client: TestClient, token_headers: dict[str, str], isolated_upload_dir: Path) -> None:
    """文档类必须能传 —— 旧代码只放图片/视频，docx 会被判「此文件格式暂不支持」"""
    resp = client.post(
        f'{FILES}/upload',
        headers=token_headers,
        files={'file': ('季度报告.docx', _docx_bytes(), 'application/octet-stream')},
    )
    assert resp.status_code == 200
    data = resp.json()['data']

    assert data['type'] == 'document'
    assert data['ext'] == 'docx'
    assert data['original_name'] == '季度报告.docx'
    # 落盘名带随机后缀，与展示名分离
    assert data['name'] != data['original_name']
    assert data['name'].endswith('.docx')
    # id / created_by 是雪花字符串，不是数字（硬纪律 6）
    assert isinstance(data['id'], str)
    assert isinstance(data['created_by'], str)
    assert len(data['sha256']) == 64
    # 落盘按 YYYY/MM/DD 分目录：`name` 是纯文件名，`path` 才是相对路径
    assert '/' not in data['name']
    assert (isolated_upload_dir / data['name']).exists() is False
    from backend.utils.timezone import timezone

    today = timezone.now().strftime('%Y/%m/%d')
    assert (isolated_upload_dir / today / data['name']).is_file()

    client.request('DELETE', FILES, headers=token_headers, json={'pks': [data['id']]})


def test_upload_image_classified(client: TestClient, token_headers: dict[str, str]) -> None:
    resp = client.post(f'{FILES}/upload', headers=token_headers, files={'file': ('dot.png', _png_bytes(), 'image/png')})
    assert resp.status_code == 200
    data = resp.json()['data']
    assert data['type'] == 'image'
    client.request('DELETE', FILES, headers=token_headers, json={'pks': [data['id']]})


def test_upload_rejects_unlisted_ext(client: TestClient, token_headers: dict[str, str]) -> None:
    """白名单之外的扩展名必须挡住，且是 400 而不是 500"""
    resp = client.post(
        f'{FILES}/upload', headers=token_headers, files={'file': ('evil.py', b'print(1)', 'text/x-python')}
    )
    assert resp.status_code == 400
    assert 'py' in resp.json()['msg']


def test_upload_rejects_extensionless(client: TestClient, token_headers: dict[str, str]) -> None:
    resp = client.post(f'{FILES}/upload', headers=token_headers, files={'file': ('README', b'x', 'text/plain')})
    assert resp.status_code == 400


def test_upload_strips_path_traversal(
    client: TestClient, token_headers: dict[str, str], isolated_upload_dir: Path
) -> None:
    """
    `UploadFile.filename` 完全由客户端控制，Starlette 原样透传。
    `../../` 必须被剥掉，且落点不能跑出 UPLOAD_DIR。
    """
    resp = client.post(
        f'{FILES}/upload',
        headers=token_headers,
        files={'file': ('../../../../pwned.png', _png_bytes((1, 2, 3)), 'image/png')},
    )
    assert resp.status_code == 200
    data = resp.json()['data']

    assert '/' not in data['name'] and '\\' not in data['name']
    assert '..' not in data['name']
    # 落点在 UPLOAD_DIR 的日期目录里，且 UPLOAD_DIR 之外没有被写出任何东西
    written = list(isolated_upload_dir.rglob(data['name']))
    assert len(written) == 1
    assert written[0].is_relative_to(isolated_upload_dir)
    assert not (isolated_upload_dir.parent / 'pwned.png').exists()

    client.request('DELETE', FILES, headers=token_headers, json={'pks': [data['id']]})


# ─── 秒传去重 ─────────────────────────────────────────────────────────────────


def test_dedup_same_name_same_content(client: TestClient, token_headers: dict[str, str]) -> None:
    """同名同内容 → 复用记录，磁盘上只留一份"""
    payload = {'file': ('dup.docx', _docx_bytes('same'), 'application/octet-stream')}
    first = client.post(f'{FILES}/upload', headers=token_headers, files=payload).json()['data']
    second = client.post(
        f'{FILES}/upload',
        headers=token_headers,
        files={'file': ('dup.docx', _docx_bytes('same'), 'application/octet-stream')},
    ).json()['data']

    assert first['id'] == second['id']
    assert first['name'] == second['name']

    client.request('DELETE', FILES, headers=token_headers, json={'pks': [first['id']]})


def test_dedup_keeps_renamed_copy(client: TestClient, token_headers: dict[str, str]) -> None:
    """
    🔴 回归测试：**改名后重传必须是一条新记录**。

    只按 sha256 去重时，`a.docx` 改名成 `季度报告.docx` 再传会命中旧记录 ——
    列表里仍显示 `a.docx`、按新名字还搜不到。去重 key 因此带上了 original_name。
    """
    body = _docx_bytes('renamed')
    first = client.post(
        f'{FILES}/upload', headers=token_headers, files={'file': ('原名.docx', body, 'application/octet-stream')}
    ).json()['data']
    second = client.post(
        f'{FILES}/upload', headers=token_headers, files={'file': ('新名字.docx', body, 'application/octet-stream')}
    ).json()['data']

    assert first['id'] != second['id']
    assert second['original_name'] == '新名字.docx'
    # 内容相同 → 校验和相同；但两条记录各自可独立删除，所以磁盘各存一份
    assert first['sha256'] == second['sha256']
    assert first['name'] != second['name']

    client.request('DELETE', FILES, headers=token_headers, json={'pks': [first['id'], second['id']]})


def test_check_by_sha256(client: TestClient, token_headers: dict[str, str], uploaded: dict) -> None:
    hit = client.get(f'{FILES}/check', headers=token_headers, params={'sha256': uploaded['sha256']})
    assert hit.status_code == 200
    assert hit.json()['data']['id'] == uploaded['id']

    # 没命中不是错误，是「这份文件还没传过」—— 必须 200 + data=None，
    # 返回 fail() 会让前端把正常的首次上传当成故障
    miss = client.get(f'{FILES}/check', headers=token_headers, params={'sha256': 'a' * 64})
    assert miss.status_code == 200
    assert miss.json()['data'] is None


def test_check_name_matches_upload_dedup(client: TestClient, token_headers: dict[str, str], uploaded: dict) -> None:
    """带 name 的 /check 要和 upload 的去重口径一致，否则「命中」了还是会重传"""
    same = client.get(
        f'{FILES}/check',
        headers=token_headers,
        params={'sha256': uploaded['sha256'], 'name': uploaded['original_name']},
    )
    assert same.json()['data']['id'] == uploaded['id']

    other = client.get(
        f'{FILES}/check', headers=token_headers, params={'sha256': uploaded['sha256'], 'name': '别的名字.docx'}
    )
    assert other.json()['data'] is None


# ─── 读取 ────────────────────────────────────────────────────────────────────


def test_download_url_on_every_read_path(client: TestClient, token_headers: dict[str, str], uploaded: dict) -> None:
    """
    🔴 回归测试：**列表 / 详情 / 附件三个读取路径都要带 `download_url`**。

    它曾经只在上传响应里有，列表接口返回不带它的模型 →
    前端预览拼出 `http://127.0.0.1:8000undefined` → 弹窗「文件加载失败」。
    现在是详情模型上的 computed_field。
    """
    expected = f'/api/v1/sys/files/{uploaded["id"]}/download'
    assert uploaded['download_url'] == expected

    detail = client.get(f'{FILES}/{uploaded["id"]}', headers=token_headers).json()['data']
    assert detail['download_url'] == expected

    listing = client.get(FILES, headers=token_headers, params={'page': 1, 'size': 50}).json()['data']
    row = next(i for i in listing['items'] if i['id'] == uploaded['id'])
    assert row['download_url'] == expected


def test_download_inline_and_attachment(client: TestClient, token_headers: dict[str, str], uploaded: dict) -> None:
    inline = client.get(f'{FILES}/{uploaded["id"]}/download', headers=token_headers)
    assert inline.status_code == 200
    assert inline.headers['content-disposition'].startswith('inline;')
    # 中文原名走 RFC 6266 的 filename*，不能只有会被截断的 ASCII 段
    assert "filename*=UTF-8''" in inline.headers['content-disposition']
    assert inline.headers['accept-ranges'] == 'bytes'
    assert inline.content == _docx_bytes()

    attached = client.get(
        f'{FILES}/{uploaded["id"]}/download', headers=token_headers, params={'disposition': 'attachment'}
    )
    assert attached.headers['content-disposition'].startswith('attachment;')


def test_download_requires_auth(client: TestClient, uploaded: dict) -> None:
    """裸请求必须 401 —— 这是撤掉 /static/upload 之后唯一的读取通道"""
    assert client.get(f'{FILES}/{uploaded["id"]}/download').status_code == 401


def test_static_upload_mount_is_gone(client: TestClient, uploaded: dict) -> None:
    """
    `/static/upload/<name>` 曾经是无鉴权静态挂载。

    ⚠️ 光删那条 mount 不够 —— UPLOAD_DIR 原来在 STATIC_DIR 里，
    会被 `/static` 父级挂载连带公开。所以 UPLOAD_DIR 已搬出 STATIC_DIR。
    """
    resp = client.get(f'/static/upload/{uploaded["name"]}', headers={})
    assert resp.status_code == 404


def test_detail_not_found(client: TestClient, token_headers: dict[str, str]) -> None:
    assert client.get(f'{FILES}/1', headers=token_headers).status_code == 404


# ─── 列表与统计 ───────────────────────────────────────────────────────────────


def test_list_filters(client: TestClient, token_headers: dict[str, str], uploaded: dict) -> None:
    by_name = client.get(FILES, headers=token_headers, params={'page': 1, 'size': 20, 'name': '契约'})
    ids = [i['id'] for i in by_name.json()['data']['items']]
    assert uploaded['id'] in ids

    by_type = client.get(FILES, headers=token_headers, params={'page': 1, 'size': 20, 'type': 'document'})
    assert all(i['type'] == 'document' for i in by_type.json()['data']['items'])

    # 分类不匹配时应当查不到
    as_image = client.get(FILES, headers=token_headers, params={'page': 1, 'size': 20, 'type': 'image'})
    assert uploaded['id'] not in [i['id'] for i in as_image.json()['data']['items']]


def test_statistics_shape(client: TestClient, token_headers: dict[str, str], uploaded: dict) -> None:
    data = client.get(f'{FILES}/statistics', headers=token_headers).json()['data']
    assert data['total_count'] >= 1
    assert data['total_size'] >= uploaded['size']
    # 各分类之和要等于总数，否则聚合口径和总计口径对不上
    assert sum(data['type_counts'].values()) == data['total_count']
    assert sum(data['type_sizes'].values()) == data['total_size']
    assert data['type_counts'].get('document', 0) >= 1


# ─── 附件关联 ─────────────────────────────────────────────────────────────────


def test_attach_detach_and_idempotency(client: TestClient, token_headers: dict[str, str], uploaded: dict) -> None:
    target = {'target_type': 'PYTEST', 'target_id': '9001'}
    url = f'{FILES}/relations'

    assert client.post(url, headers=token_headers, json={'file_ids': [uploaded['id']], **target}).status_code == 200

    listed = client.get(f'{FILES}/targets/PYTEST/9001', headers=token_headers).json()['data']
    assert [i['id'] for i in listed] == [uploaded['id']]
    assert listed[0]['download_url'].endswith('/download')

    # 重复挂载是幂等成功（后端跳过已挂的），不是失败 ——
    # 接口层不能照抄别处的 `if count > 0 else fail()`
    assert client.post(url, headers=token_headers, json={'file_ids': [uploaded['id']], **target}).status_code == 200
    assert len(client.get(f'{FILES}/targets/PYTEST/9001', headers=token_headers).json()['data']) == 1

    # 卸载只删关联，文件本身还在
    assert (
        client.request('DELETE', url, headers=token_headers, json={'file_ids': [uploaded['id']], **target}).status_code
        == 200
    )
    assert client.get(f'{FILES}/targets/PYTEST/9001', headers=token_headers).json()['data'] == []
    assert client.get(f'{FILES}/{uploaded["id"]}', headers=token_headers).status_code == 200


def test_attach_rejects_unknown_file(client: TestClient, token_headers: dict[str, str]) -> None:
    resp = client.post(
        f'{FILES}/relations',
        headers=token_headers,
        json={'file_ids': ['1'], 'target_type': 'PYTEST', 'target_id': '9002'},
    )
    assert resp.status_code == 404


# ─── 删除 ────────────────────────────────────────────────────────────────────


def test_delete_cascades_relations_and_disk(
    client: TestClient, token_headers: dict[str, str], isolated_upload_dir: Path
) -> None:
    """删文件要连带清掉关联和磁盘文件 —— 留下关联会让业务侧查到一批空洞"""
    created = client.post(
        f'{FILES}/upload',
        headers=token_headers,
        files={'file': ('待删.docx', _docx_bytes('bye'), 'application/octet-stream')},
    ).json()['data']
    on_disk = isolated_upload_dir / created['path']
    assert on_disk.is_file()

    client.post(
        f'{FILES}/relations',
        headers=token_headers,
        json={'file_ids': [created['id']], 'target_type': 'PYTEST', 'target_id': '9003'},
    )

    assert client.request('DELETE', FILES, headers=token_headers, json={'pks': [created['id']]}).status_code == 200

    assert client.get(f'{FILES}/{created["id"]}', headers=token_headers).status_code == 404
    assert client.get(f'{FILES}/targets/PYTEST/9003', headers=token_headers).json()['data'] == []
    assert not on_disk.exists()


def test_delete_missing_reports_failure(client: TestClient, token_headers: dict[str, str]) -> None:
    """删不存在的记录不该报成功 —— 否则前端会把「什么都没删」当成删掉了"""
    resp = client.request('DELETE', FILES, headers=token_headers, json={'pks': ['1']})
    assert resp.json()['code'] != 200


# ─── 日期目录 ─────────────────────────────────────────────────────────────────


def test_stored_under_date_dir(client: TestClient, token_headers: dict[str, str], isolated_upload_dir: Path) -> None:
    """
    落盘按 `YYYY/MM/DD` 分目录。

    分目录不是为了「一个目录放不下」，是为了按周期备份/归档/过期，
    以及让 `ls` / `tar` / `find` 在几十万文件之后还能用。
    """
    from backend.utils.timezone import timezone

    created = client.post(
        f'{FILES}/upload',
        headers=token_headers,
        files={'file': ('分目录.docx', _docx_bytes('dated'), 'application/octet-stream')},
    ).json()['data']

    today = timezone.now().strftime('%Y/%m/%d')
    # path 是相对路径（含日期目录），name 是纯文件名 —— 两者分工不能混
    assert created['path'] == f'{today}/{created["name"]}'
    assert (isolated_upload_dir / created['path']).is_file()

    # 读取路径认这个相对路径
    assert client.get(f'{FILES}/{created["id"]}/download', headers=token_headers).status_code == 200

    client.request('DELETE', FILES, headers=token_headers, json={'pks': [created['id']]})


def test_delete_removes_nested_file_and_prunes_dirs(
    client: TestClient, token_headers: dict[str, str], isolated_upload_dir: Path
) -> None:
    """
    🔴 回归测试：**删除必须能删掉日期目录里的文件**。

    `delete_file` 原来用 `strip_path()` 把全部路径成分剥掉，
    `2026/08/21/x.docx` 会被剥成 `x.docx` → 指向 UPLOAD_DIR 根 → 文件不存在 →
    `missing_ok=True` 一声不响地什么都没删。表现是「库里删干净了、磁盘上越积越多」，
    日志里连一条 warning 都没有。

    顺带验空目录回收：删完最后一个文件后，YYYY/MM/DD 三级都不该留着。
    """
    created = client.post(
        f'{FILES}/upload',
        headers=token_headers,
        files={'file': ('待清理.docx', _docx_bytes('prune'), 'application/octet-stream')},
    ).json()['data']

    on_disk = isolated_upload_dir / created['path']
    assert on_disk.is_file()
    assert '/' in created['path']

    assert client.request('DELETE', FILES, headers=token_headers, json={'pks': [created['id']]}).status_code == 200

    assert not on_disk.exists()
    # 空掉的日期目录被回收，UPLOAD_DIR 自己保留
    assert list(isolated_upload_dir.iterdir()) == []
    assert isolated_upload_dir.is_dir()


def test_delete_rejects_escaping_path(isolated_upload_dir: Path) -> None:
    """
    `delete_file` 换成 `is_relative_to` 之后要**同时**满足两件事：
    允许子目录、拦住 `../../`。前者是日期目录的前提，后者是安全边界。
    """
    from backend.utils.file_ops import delete_file

    outsider = isolated_upload_dir.parent / 'do-not-touch.txt'
    outsider.write_text('keep me', encoding='utf-8')

    delete_file('../do-not-touch.txt')
    assert outsider.is_file(), 'delete_file 不该能删到 UPLOAD_DIR 之外'

    # 空字符串 / UPLOAD_DIR 自身都要拒绝，别把整个上传目录 unlink 掉
    delete_file('')
    delete_file('.')
    assert isolated_upload_dir.is_dir()


# ─── 公开子树的准入（issue #56：SVG 存储型 XSS） ────────────────────────────────


def test_public_upload_rejects_svg(client: TestClient, token_headers: dict[str, str]) -> None:
    """SVG 不能进公开无鉴权子树 —— 即使 core/conf.py 把它算作"图片"

    SVG 是可执行的 XML 文档，落进 `/uploads` 被当独立文档直接导航打开，
    就是一个完整的存储型 XSS。回归测试钉住：请求必须被拒绝，且不能有
    `sys_file` 记录被创建（`verify_public` 必须在落盘*之前*就否掉）。
    """
    resp = client.post(
        f'{FILES}/upload',
        headers=token_headers,
        params={'public': True},
        files={'file': ('logo.svg', _svg_bytes(), 'image/svg+xml')},
    )
    assert resp.status_code != 200, 'SVG 走 public=true 必须被拒绝'

    # 确认没有留下孤儿记录：按同一个 sha256 查重应该查不到
    import hashlib

    sha256 = hashlib.sha256(_svg_bytes()).hexdigest()
    check = client.get(f'{FILES}/check', headers=token_headers, params={'sha256': sha256})
    assert check.json()['data'] is None, '被拒绝的公开 SVG 不应该在 sys_file 里留下记录'


def test_public_upload_still_accepts_png(client: TestClient, token_headers: dict[str, str]) -> None:
    """回归对照组：真正的图片走 public=true 必须还能成功

    只测"SVG 被拒绝"不够——不能顺手把合法的公开图片路径也堵死。
    """
    upload_resp = client.post(
        f'{FILES}/upload',
        headers=token_headers,
        params={'public': True},
        files={'file': ('cover.png', _png_bytes(), 'image/png')},
    )
    assert upload_resp.status_code == 200, upload_resp.text
    data = upload_resp.json()['data']
    try:
        assert data['is_public'] is True
        assert data['public_url'], '公开图片必须带 public_url'
    finally:
        client.request('DELETE', FILES, headers=token_headers, json={'pks': [data['id']]})


def test_public_uploads_static_mount_sets_hardening_headers(tmp_path: Path) -> None:
    """`/uploads` 挂载必须带 `X-Content-Type-Options`/CSP —— 纵深防御的第二道闸

    不经过完整 app（`app.mount` 在应用启动时就把目录烤进了 StaticFiles 实例，
    没法用 `isolated_upload_dir` 那套 monkeypatch 顶替），直接单测
    `_PublicUploadsStaticFiles` 这个类本身：即便以后有格式绕过了
    `verify_public`，这层头也是第二道防线。
    """
    from backend.core.registrar import _PublicUploadsStaticFiles

    (tmp_path / 'cover.png').write_bytes(_png_bytes())
    app = _PublicUploadsStaticFiles(directory=tmp_path)

    # ⚠️ 不能用 `with TestClient(app) as ...`——那会触发 lifespan 握手，
    # 而 `StaticFiles.__call__` 只认 `scope["type"] == "http"`，会在
    # lifespan scope 上直接 assert 失败。这个类只当 sub-app 被 `app.mount()`
    # 挂在一个完整应用下面，lifespan 由外层应用接管；这里只测 HTTP 请求路径，
    # 不进 `with` 块就不会有 lifespan 事件。
    static_client = TestClient(app)
    resp = static_client.get('/cover.png')
    assert resp.status_code == 200
    assert resp.content == _png_bytes()
    assert resp.headers['x-content-type-options'] == 'nosniff'
    assert 'content-security-policy' in resp.headers
