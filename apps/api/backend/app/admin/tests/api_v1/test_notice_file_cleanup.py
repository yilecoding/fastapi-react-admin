"""issue #63：删除公告要连带解除挂在它上面的附件/内联图关联。

放在 `app/admin/tests` 而不是 `plugin/notice` 下——这条钉住的其实是
`sys_file_relation` 这个跨模块契约（公告只是当前唯一真实使用它的业务对象），
和 `test_file.py` 是同一个关注点，只是触发方是公告删除。

`plugin/notice/api.ts` 的常量：`NOTICE` 是附件面板用的 target_type，
`NOTICE_CONTENT` 是正文内联图用的——公告删除必须把两种都解除，
否则任意登录用户仍能通过 `GET /sys/files/targets/{target_type}/{target_id}`
查到"已删除"公告曾经挂过的文件。
"""

from collections.abc import Generator
from pathlib import Path

import pytest

from starlette.testclient import TestClient

FILES = '/sys/files'
NOTICES = '/sys/notices'


@pytest.fixture(autouse=True)
def isolated_upload_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Generator[None, None, None]:
    """同 `test_file.py` 的同名 fixture——两棵落盘树都顶到 tmp，理由见那边的注释"""
    from backend.utils import file_ops

    upload_dir = tmp_path / 'upload'
    public_dir = tmp_path / 'upload-public'
    upload_dir.mkdir()
    public_dir.mkdir()
    monkeypatch.setattr(file_ops, 'UPLOAD_DIR', upload_dir)
    monkeypatch.setattr(file_ops, 'PUBLIC_UPLOAD_DIR', public_dir)
    yield


def _png_bytes() -> bytes:
    import struct
    import zlib

    raw = b''.join(b'\x00' + bytes((10, 20, 30)) * 2 for _ in range(2))

    def chunk(tag: bytes, data: bytes) -> bytes:
        body = tag + data
        return struct.pack('>I', len(data)) + body + struct.pack('>I', zlib.crc32(body) & 0xFFFFFFFF)

    ihdr = struct.pack('>IIBBBBB', 2, 2, 8, 2, 0, 0, 0)
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', ihdr) + chunk(b'IDAT', zlib.compress(raw)) + chunk(b'IEND', b'')


def test_deleting_notice_unmounts_both_attachment_and_inline_image_relations(
    client: TestClient, token_headers: dict[str, str]
) -> None:
    create_resp = client.post(
        NOTICES,
        json={'title': 'pytest 公告', 'type': 0, 'status': 1, 'content': '<p>正文</p>'},
        headers=token_headers,
    )
    assert create_resp.status_code == 200, create_resp.text
    notice_id = create_resp.json()['data']['id']

    upload_resp = client.post(
        f'{FILES}/upload', headers=token_headers, files={'file': ('a.png', _png_bytes(), 'image/png')}
    )
    assert upload_resp.status_code == 200, upload_resp.text
    attachment_file_id = upload_resp.json()['data']['id']

    upload_resp2 = client.post(
        f'{FILES}/upload', headers=token_headers, files={'file': ('b.png', _png_bytes(), 'image/png')}
    )
    assert upload_resp2.status_code == 200, upload_resp2.text
    inline_file_id = upload_resp2.json()['data']['id']

    try:
        for target_type, file_id in (('NOTICE', attachment_file_id), ('NOTICE_CONTENT', inline_file_id)):
            attach_resp = client.post(
                f'{FILES}/relations',
                json={'file_ids': [file_id], 'target_type': target_type, 'target_id': notice_id},
                headers=token_headers,
            )
            assert attach_resp.status_code == 200, attach_resp.text

        # 删除前：两种 target_type 都应该能查到挂载的文件
        for target_type in ('NOTICE', 'NOTICE_CONTENT'):
            before = client.get(f'{FILES}/targets/{target_type}/{notice_id}', headers=token_headers)
            assert before.status_code == 200
            assert len(before.json()['data']) == 1, f'{target_type} 应该挂着一个文件'

        delete_resp = client.request('DELETE', NOTICES, json={'pks': [notice_id]}, headers=token_headers)
        assert delete_resp.status_code == 200, delete_resp.text

        # 删除后：两种 target_type 都不应该再查到任何文件——
        # 不是"公告没了所以查不到"，是 sys_file_relation 里的行本身要被解除
        for target_type in ('NOTICE', 'NOTICE_CONTENT'):
            after = client.get(f'{FILES}/targets/{target_type}/{notice_id}', headers=token_headers)
            assert after.status_code == 200
            assert after.json()['data'] == [], (
                f'公告删除之后，{target_type} 类型的关联应该已经解除，'
                f'不能再被 GET /sys/files/targets/{{type}}/{{id}} 查到'
            )
    finally:
        client.request('DELETE', FILES, json={'pks': [attachment_file_id, inline_file_id]}, headers=token_headers)
