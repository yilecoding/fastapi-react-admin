"""私有文件谁能读：公开的 / 上传人 / 文件管理员 / 业务模块说可以的。

🔴 原来 `GET /sys/files/{pk}/download` 只要登录 —— 雪花 ID 不是秘密（URL、日志、审批单的表单数据里都有），
拿到 ID 就能下载任何人的私有文件。读不了一律 404（403 等于告诉对方「这个 ID 存在」）。
审批附件那一支在 `plugin/workflow/tests/test_attachments.py`。
"""

import secrets
import uuid

from collections.abc import Generator
from pathlib import Path

import pytest

from starlette.testclient import TestClient

from backend.app.admin.tests.api_v1.test_file import _docx_bytes, _png_bytes

FILES = '/sys/files'
NOTICES = '/sys/notices'


@pytest.fixture(autouse=True)
def isolated_upload_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Generator[None, None, None]:
    """同 `test_file.py` 的同名 fixture：两棵落盘树都顶到 tmp"""
    from backend.utils import file_ops

    (tmp_path / 'upload').mkdir()
    (tmp_path / 'upload-public').mkdir()
    monkeypatch.setattr(file_ops, 'UPLOAD_DIR', tmp_path / 'upload')
    monkeypatch.setattr(file_ops, 'PUBLIC_UPLOAD_DIR', tmp_path / 'upload-public')
    yield


def _staff(client: TestClient) -> dict[str, str]:
    """种子里的普通员工：没有 sys:file:list"""
    body = client.post('/auth/login/swagger', params={'username': 'sunqiang', 'password': '123456'}).json()
    return {'Authorization': f'{body["token_type"]} {body["access_token"]}'}


def _upload(client: TestClient, headers: dict[str, str], *, public: bool = False) -> int:
    # 🔴 内容每次都要不同：上传按「同一人 + 同名 + 同内容」秒传复用旧记录，而旧记录指向上一轮的
    # tmp 目录 —— 磁盘上早没了，下载 404，看起来像是权限拦的
    salt = uuid.uuid4().hex
    if public:
        files = {'file': ('公开.png', _png_bytes((secrets.randbelow(256), 0, 0)) + salt.encode(), 'image/png')}
    else:
        files = {'file': ('机密.docx', _docx_bytes(salt), 'application/octet-stream')}
    resp = client.post(f'{FILES}/upload', headers=headers, files=files, params={'public': 'true'} if public else None)
    assert resp.status_code == 200 and resp.json()['code'] == 200, resp.text
    return resp.json()['data']['id']


def test_private_file_is_not_readable_by_id_alone(client: TestClient, token_headers: dict[str, str]) -> None:
    pk = _upload(client, token_headers)
    try:
        # 先断言「有」：上传人（管理员）读得到
        assert client.get(f'{FILES}/{pk}/download', headers=token_headers).status_code == 200
        staff = _staff(client)
        for url in (f'{FILES}/{pk}/download', f'{FILES}/{pk}'):
            resp = client.get(url, headers=staff)
            assert resp.status_code == 404, (url, resp.status_code, resp.text[:200])
        # 公开的照样谁都能读
        pub = _upload(client, token_headers, public=True)
        assert client.get(f'{FILES}/{pub}/download', headers=staff).status_code == 200
    finally:
        client.request('DELETE', FILES, headers=token_headers, json={'pks': [pk]})


def test_notice_attachment_readable_while_the_notice_exists(client: TestClient, token_headers: dict[str, str]) -> None:
    notice_id = client.post(
        NOTICES, headers=token_headers, json={'title': 'pytest 附件公告', 'type': 0, 'status': 1, 'content': '<p>x</p>'}
    ).json()['data']['id']
    pk = _upload(client, token_headers)
    staff = _staff(client)
    try:
        assert client.get(f'{FILES}/{pk}/download', headers=staff).status_code == 404
        resp = client.post(
            f'{FILES}/relations',
            headers=token_headers,
            json={'file_ids': [pk], 'target_type': 'NOTICE', 'target_id': notice_id},
        )
        assert resp.status_code == 200, resp.text
        # 挂到公告上之后：公告人人能看，附件跟着能下，附件列表里也有它
        assert client.get(f'{FILES}/{pk}/download', headers=staff).status_code == 200
        listed = client.get(f'{FILES}/targets/NOTICE/{notice_id}', headers=staff).json()['data']
        assert [f['id'] for f in listed] == [pk]
        # 公告删了：又读不到了
        client.request('DELETE', NOTICES, headers=token_headers, json={'pks': [notice_id]})
        assert client.get(f'{FILES}/{pk}/download', headers=staff).status_code == 404
    finally:
        client.request('DELETE', FILES, headers=token_headers, json={'pks': [pk]})
