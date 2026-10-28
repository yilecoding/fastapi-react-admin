"""手机号唯一（issue #168 第一步）：管理员的三条写路径 —— 新建 / 编辑 / 批量导入 —— 都要查重；管理员改号要清掉本人验证。

绑定那条链（发码 / 验码）在 `plugin/sms/tests/test_phone_binding.py`。
"""

from __future__ import annotations

import asyncio
import io

from typing import TYPE_CHECKING, Any

import pytest

from openpyxl import Workbook
from sqlalchemy import text

from backend.core.conf import settings
from backend.database.db import create_database_async_engine, create_database_async_session, get_database_url

if TYPE_CHECKING:
    from collections.abc import Iterator

    from starlette.testclient import TestClient

PREFIX = 'pytest_phone_'
PHONE_X = '19900000011'
PHONE_Y = '19900000012'


@pytest.fixture(autouse=True)
def _purge() -> Iterator[None]:
    """前后硬删这批用户：逻辑删除会留行，而唯一约束带着 deleted 列，留着的行不撞约束但会让「已存在」判断串台"""

    async def _do() -> None:
        engine = create_database_async_engine(get_database_url(unittest=True))
        try:
            async with create_database_async_session(engine).begin() as db:
                await db.execute(
                    text('DELETE FROM sys_user_role WHERE user_id IN (SELECT id FROM sys_user WHERE username LIKE :p)'),
                    {'p': f'{PREFIX}%'},
                )
                await db.execute(text('DELETE FROM sys_user WHERE username LIKE :p'), {'p': f'{PREFIX}%'})
        finally:
            await engine.dispose()

    asyncio.run(_do())
    yield
    asyncio.run(_do())


@pytest.fixture
def refs(client: TestClient, token_headers: dict[str, str]) -> dict[str, Any]:
    dept = client.get('/sys/depts', headers=token_headers).json()['data'][0]
    role = client.get('/sys/roles/all', headers=token_headers).json()['data'][0]
    return {'dept_id': dept['id'], 'dept_code': dept['code'], 'role_id': role['id'], 'role_code': role['code']}


def _create(client: TestClient, headers: dict[str, str], refs: dict[str, Any], suffix: str, phone: str | None) -> Any:
    res = client.post(
        '/sys/users',
        headers=headers,
        json={
            'username': f'{PREFIX}{suffix}',
            'password': 'Tmp@123456',
            'nickname': suffix,
            'phone': phone,
            'dept_id': refs['dept_id'],
            'roles': [refs['role_id']],
        },
    )
    return res


def _mark_verified(pk: str) -> None:
    async def _do() -> None:
        engine = create_database_async_engine(get_database_url(unittest=True))
        try:
            async with create_database_async_session(engine).begin() as db:
                await db.execute(
                    text('UPDATE sys_user SET phone_verified_time = CURRENT_TIMESTAMP WHERE id = :pk'), {'pk': int(pk)}
                )
        finally:
            await engine.dispose()

    asyncio.run(_do())


def test_create_rejects_a_phone_already_bound(client: TestClient, token_headers: dict[str, str], refs: dict) -> None:
    assert _create(client, token_headers, refs, 'a', PHONE_X).json()['code'] == 200
    res = _create(client, token_headers, refs, 'b', PHONE_X)
    assert res.status_code == 409, res.text
    # 空号码的用户互不冲突
    assert _create(client, token_headers, refs, 'c', None).json()['code'] == 200
    assert _create(client, token_headers, refs, 'd', None).json()['code'] == 200


def test_update_rejects_a_phone_already_bound_and_clears_verification(
    client: TestClient, token_headers: dict[str, str], refs: dict
) -> None:
    a = _create(client, token_headers, refs, 'a', PHONE_X).json()['data']['id']
    b = _create(client, token_headers, refs, 'b', PHONE_Y).json()['data']['id']
    _mark_verified(b)
    assert client.get(f'/sys/users/{b}', headers=token_headers).json()['data']['phone_verified_time'] is not None

    def body(pk: str, phone: str) -> dict[str, Any]:
        cur = client.get(f'/sys/users/{pk}', headers=token_headers).json()['data']
        return {
            'username': cur['username'],
            'nickname': cur['nickname'],
            'email': cur['email'],
            'phone': phone,
            'dept_id': refs['dept_id'],
            'roles': [refs['role_id']],
        }

    # b 想改成 a 的号：409
    assert client.put(f'/sys/users/{b}', headers=token_headers, json=body(b, PHONE_X)).status_code == 409
    # b 号码不变地改别的字段：验证时间保留
    assert client.put(f'/sys/users/{b}', headers=token_headers, json=body(b, PHONE_Y)).json()['code'] == 200
    assert client.get(f'/sys/users/{b}', headers=token_headers).json()['data']['phone_verified_time'] is not None
    # 🔴 管理员把 b 的号改掉：原来那次本人验证不再算数
    assert client.put(f'/sys/users/{b}', headers=token_headers, json=body(b, '19900000013')).json()['code'] == 200
    after = client.get(f'/sys/users/{b}', headers=token_headers).json()['data']
    assert after['phone'] == '19900000013' and after['phone_verified_time'] is None
    assert a  # a 没被动过


def test_update_without_a_phone_key_keeps_the_verification(
    client: TestClient, token_headers: dict[str, str], refs: dict
) -> None:
    """请求体里不带 phone（exclude_unset，号码原样不动）：验证时间也要原样不动。
    只比 `obj.phone != user.phone` 会把它清掉 —— 号没变、手机登录失效，界面上看不出"""
    pk = _create(client, token_headers, refs, 'c', PHONE_X).json()['data']['id']
    _mark_verified(pk)
    cur = client.get(f'/sys/users/{pk}', headers=token_headers).json()['data']
    body = {
        'username': cur['username'],
        'nickname': cur['nickname'] + '2',
        'email': cur['email'],
        'dept_id': refs['dept_id'],
        'roles': [refs['role_id']],
    }
    assert client.put(f'/sys/users/{pk}', headers=token_headers, json=body).json()['code'] == 200
    after = client.get(f'/sys/users/{pk}', headers=token_headers).json()['data']
    assert after['phone'] == PHONE_X and after['phone_verified_time'] is not None
    # 显式传 null 才是「清空号码」，这时验证跟着没了
    assert client.put(f'/sys/users/{pk}', headers=token_headers, json={**body, 'phone': None}).json()['code'] == 200
    after = client.get(f'/sys/users/{pk}', headers=token_headers).json()['data']
    assert after['phone'] is None and after['phone_verified_time'] is None


def _xlsx(rows: list[list[Any]]) -> bytes:
    wb = Workbook()
    ws = wb.active
    ws.append(['username', 'nickname', 'email', 'phone', 'dept_code', 'role_codes'])
    for row in rows:
        ws.append(row)
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


def test_import_catches_duplicate_phones_in_file_and_in_db(
    client: TestClient, token_headers: dict[str, str], refs: dict, monkeypatch: pytest.MonkeyPatch
) -> None:
    """文件内两行同号 → 第二行红；库里已有的号 → 那一行红。只校验不落库（预览接口）"""
    monkeypatch.setattr(settings, 'USER_IMPORT_DEFAULT_PASSWORD', 'Pytest@Imp1')
    assert _create(client, token_headers, refs, 'db', PHONE_X).json()['code'] == 200
    raw = _xlsx([
        [f'{PREFIX}i1', '', '', PHONE_Y, refs['dept_code'], refs['role_code']],
        [f'{PREFIX}i2', '', '', PHONE_Y, refs['dept_code'], refs['role_code']],
        [f'{PREFIX}i3', '', '', PHONE_X, refs['dept_code'], refs['role_code']],
    ])
    res = client.post(
        '/sys/users/import/preview',
        headers=token_headers,
        files={'file': ('u.xlsx', raw, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')},
    )
    data = res.json()['data']
    assert data['valid'] == 1, data['rows']
    assert data['rows'][0]['ok'] is True
    assert data['rows'][1]['ok'] is False and any(PHONE_Y in e for e in data['rows'][1]['errors'])
    assert data['rows'][2]['ok'] is False
