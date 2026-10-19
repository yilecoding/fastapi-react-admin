"""审批附件：普通员工能传、只能挂自己的、隐藏字段里的附件连名字都不下发"""

import struct
import uuid
import zlib

from collections.abc import Callable, Generator
from pathlib import Path
from typing import Any

import pytest

from starlette.testclient import TestClient

from backend.plugin.workflow.tests.conftest import key, ok


def _png() -> bytes:
    """手搓一个 2x2 PNG（同 admin 测试里那个，不为一个 fixture 引 Pillow）"""
    raw = b''.join(b'\x00' + bytes((10, 120, 200)) * 2 for _ in range(2))

    def chunk(tag: bytes, data: bytes) -> bytes:
        body = tag + data
        return struct.pack('>I', len(data)) + body + struct.pack('>I', zlib.crc32(body) & 0xFFFFFFFF)

    ihdr = struct.pack('>IIBBBBB', 2, 2, 8, 2, 0, 0, 0)
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', ihdr) + chunk(b'IDAT', zlib.compress(raw)) + chunk(b'IEND', b'')


@pytest.fixture
def isolated_upload_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Generator[Path, None, None]:
    """落盘顶到 tmp（接缝是 `file_ops.upload_root()` 读的那两个模块级名字，见 admin 的 test_file）"""
    from backend.utils import file_ops

    (tmp_path / 'upload').mkdir()
    (tmp_path / 'upload-public').mkdir()
    monkeypatch.setattr(file_ops, 'UPLOAD_DIR', tmp_path / 'upload')
    monkeypatch.setattr(file_ops, 'PUBLIC_UPLOAD_DIR', tmp_path / 'upload-public')
    yield tmp_path / 'upload'


def _upload(client: TestClient, headers: dict[str, str], name: str) -> dict[str, Any]:
    # 内容带随机尾巴：同一人同名同内容会秒传复用**上一轮**的记录，它指向的 tmp 目录早没了（下载 404）
    content = _png() + uuid.uuid4().hex.encode()
    resp = client.post('/sys/workflow/files', headers=headers, files={'file': (name, content, 'image/png')})
    return ok(resp)


def _definition(client: TestClient, admin: dict[str, str], approver_id: str) -> None:
    form = {
        'schemaVersion': 1,
        'fields': [
            {'id': 'f_files', 'type': 'attachment', 'label': '附件', 'required': True},
            {'id': 'f_secret_files', 'type': 'attachment', 'label': '内部附件'},
        ],
    }
    model = {
        'schemaVersion': 1,
        'root': {
            'type': 'start',
            'id': 'start',
            'next': {
                'type': 'approval',
                'id': 'n1',
                'name': '审批',
                'mode': 'any',
                'assignee': {'kind': 'user', 'user_ids': [approver_id]},
                'onEmpty': 'reject',
                'fieldPerms': {'f_secret_files': 'hidden'},
                'next': None,
            },
        },
    }
    pk = ok(
        client.post(
            '/sys/workflow/definitions',
            headers=admin,
            json={'code': 'PYTEST_FILES', 'name': '附件', 'form': form, 'model': model},
        )
    )['id']
    assert ok(client.post(f'/sys/workflow/definitions/{pk}/publish', headers=admin))['published']


def test_attachments(
    client: TestClient,
    token_headers: dict[str, str],
    login: Callable[[str], dict[str, str]],
    uid: Callable[[str], str],
    isolated_upload_dir: Path,
) -> None:
    _definition(client, token_headers, uid('zhaolei'))

    # 普通员工（没有 sys:file:upload，也不是 is_staff 的话 RBAC 不放 POST）照样能传
    mine = _upload(client, login('sunqiang'), '发票.png')
    assert mine['name'] == '发票.png'
    secret = _upload(client, login('sunqiang'), '内部.png')
    others = _upload(client, login('chenjing'), '别人的.png')
    # 先断言「有」：文件真的落盘了
    assert any(isolated_upload_dir.rglob('*.png'))

    # 挂别人的文件：拒绝（否则审批单就是一条读别人私有文件的通道）
    resp = client.post(
        '/sys/workflow/instances',
        headers=login('sunqiang'),
        json={'code': 'PYTEST_FILES', 'form': {'f_files': [str(others['id'])]}, 'key': key()},
    )
    assert resp.json()['code'] == 400, resp.text

    inst = ok(
        client.post(
            '/sys/workflow/instances',
            headers=login('sunqiang'),
            json={
                'code': 'PYTEST_FILES',
                'form': {'f_files': [str(mine['id'])], 'f_secret_files': [str(secret['id'])]},
                'key': key(),
            },
        )
    )['instance_id']

    # 发起人：两个附件的名字都有
    d = ok(client.get(f'/sys/workflow/instances/{inst}', headers=login('sunqiang')))
    assert {v['name'] for v in d['files'].values()} == {'发票.png', '内部.png'}
    # 审批人：内部附件那个字段是 hidden —— 字段、值、文件名都不下发
    d = ok(client.get(f'/sys/workflow/instances/{inst}', headers=login('zhaolei')))
    assert 'f_secret_files' not in d['form_data']
    assert {v['name'] for v in d['files'].values()} == {'发票.png'}

    # 下载权限跟着「看不看得见」走（原来只要登录、拿到 ID 就能下）
    def dl(who: str, f: dict[str, Any]) -> int:
        return client.get(f'/sys/files/{f["id"]}/download', headers=login(who)).status_code

    assert dl('sunqiang', secret) == 200  # 上传人
    assert dl('zhaolei', mine) == 200  # 审批人看得到的字段
    assert dl('zhaolei', secret) == 404  # 对审批人 hidden 的字段：详情里没有，下载也不行
    assert dl('zhoumin', mine) == 404  # 和这张单无关的人


def test_removed_attachment_is_no_longer_readable_through_the_request(
    client: TestClient,
    token_headers: dict[str, str],
    login: Callable[[str], dict[str, str]],
    uid: Callable[[str], str],
    isolated_upload_dir: Path,
) -> None:
    """审批人在可编辑的附件字段里删掉一个：这张单不再是读那个文件的理由（关联跟着删）"""
    form = {'schemaVersion': 1, 'fields': [{'id': 'f_files', 'type': 'attachment', 'label': '附件'}]}
    model = {
        'schemaVersion': 1,
        'root': {
            'type': 'start',
            'id': 'start',
            'next': {
                'type': 'approval',
                'id': 'n1',
                'name': '审批',
                'mode': 'any',
                'assignee': {'kind': 'user', 'user_ids': [uid('zhaolei')]},
                'onEmpty': 'reject',
                'fieldPerms': {'f_files': 'editable'},
                'next': {
                    'type': 'approval',
                    'id': 'n2',
                    'name': '复核',
                    'mode': 'any',
                    'assignee': {'kind': 'user', 'user_ids': [uid('zhoumin')]},
                    'onEmpty': 'reject',
                    'next': None,
                },
            },
        },
    }
    pk = ok(
        client.post(
            '/sys/workflow/definitions',
            headers=token_headers,
            json={'code': 'PYTEST_FILES2', 'name': '附件2', 'form': form, 'model': model},
        )
    )['id']
    assert ok(client.post(f'/sys/workflow/definitions/{pk}/publish', headers=token_headers))['published']
    keep = _upload(client, login('sunqiang'), '留着.png')
    drop = _upload(client, login('sunqiang'), '删掉.png')
    inst = ok(
        client.post(
            '/sys/workflow/instances',
            headers=login('sunqiang'),
            json={
                'code': 'PYTEST_FILES2',
                'form': {'f_files': [str(keep['id']), str(drop['id'])]},
                'key': key(),
            },
        )
    )['instance_id']

    def dl(who: str, f: dict[str, Any]) -> int:
        return client.get(f'/sys/files/{f["id"]}/download', headers=login(who)).status_code

    # 先断言「有」：当前审批人两个都下得到（复核人这时还没轮到，不是参与人，本来就 404）
    assert dl('zhaolei', keep) == 200 and dl('zhaolei', drop) == 200
    ok(
        client.post(
            f'/sys/workflow/instances/{inst}/actions',
            headers=login('zhaolei'),
            json={'action': 'approve', 'key': key(), 'form': {'f_files': [str(keep['id'])]}},
        )
    )
    assert dl('zhoumin', keep) == 200
    assert dl('zhoumin', drop) == 404
