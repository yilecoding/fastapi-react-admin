"""数据变更工具 `data_change_history`（#260）：按人说的名字找对象 · 手机号 / 邮箱不进模型上下文 · 找不到时说清楚。

数据经真实接口造（用户 / 部门的增改都会被拦截层记下来），工具经 dispatcher 跑（和网页对话同一条路）
"""

import asyncio
import json

from collections.abc import Iterator
from types import SimpleNamespace
from typing import Any

import pytest

from sqlalchemy import text
from starlette.testclient import TestClient

from backend.database.db import create_database_async_engine, create_database_async_session, get_database_url
from backend.plugin.ai.core.dispatcher import tool_dispatcher
from backend.plugin.ai.core.ports import RunContext, ToolCallRequest
from backend.plugin.ai.core.registry import load_builtin_tools

load_builtin_tools()

USERNAME = 'pytest_dc_ai'
NICKNAME = '审计张三'
OLD_PHONE = '13800138011'
NEW_PHONE = '13800138022'


async def _sql(statement: str, params: dict[str, Any]) -> None:
    engine = create_database_async_engine(get_database_url(unittest=True))
    try:
        async with engine.begin() as conn:
            await conn.execute(text(statement), params)
    finally:
        await engine.dispose()


async def _noop_audit(*_args: Any, **_kwargs: Any) -> None:  # ruff: ignore[unused-async]
    return


def run_tool(monkeypatch: pytest.MonkeyPatch, **arguments: Any) -> Any:
    monkeypatch.setattr(tool_dispatcher, '_audit', _noop_audit)
    superuser = SimpleNamespace(
        id=1, username='admin', nickname='admin', dept_id=None, is_superuser=True, is_staff=True, roles=[]
    )

    async def _main() -> Any:
        # 独立引擎：共享的 async_test_db_session 绑在 TestClient 的事件循环上
        engine = create_database_async_engine(get_database_url(unittest=True))
        try:
            async with create_database_async_session(engine)() as db:
                ctx = RunContext(user=superuser, conversation_id=1, db=db, provider=None)
                try:
                    return await tool_dispatcher.dispatch(
                        ToolCallRequest(call_id='dc', name='data_change_history', arguments=arguments), ctx
                    )
                finally:
                    await db.rollback()
        finally:
            await engine.dispose()

    return asyncio.run(_main())


def ok(outcome: Any) -> dict[str, Any]:
    """成功时 payload 是交给模型的那段 JSON 文本 —— 断言就断言模型真正看到的东西"""
    assert outcome.kind == 'ok', outcome.payload
    return json.loads(outcome.payload)


@pytest.fixture
def changed_user(client: TestClient, token_headers: dict[str, str]) -> Iterator[str]:
    """建一个人（带手机号），再换个手机号 —— 两条记录"""
    asyncio.run(_sql('DELETE FROM sys_user WHERE username = :u', {'u': USERNAME}))
    dept_id = client.get('/sys/depts', headers=token_headers).json()['data'][0]['id']
    role_id = client.get('/sys/roles/all', headers=token_headers).json()['data'][0]['id']
    body = {
        'username': USERNAME,
        'password': 'Tmp@123456',
        'nickname': NICKNAME,
        'phone': OLD_PHONE,
        'dept_id': dept_id,
        'roles': [role_id],
    }
    res = client.post('/sys/users', headers=token_headers, json=body).json()
    assert res['code'] == 200, res
    pk = res['data']['id']
    update = {k: v for k, v in body.items() if k != 'password'} | {'phone': NEW_PHONE}
    assert client.put(f'/sys/users/{pk}', headers=token_headers, json=update).json()['code'] == 200
    yield pk
    for stmt in (
        'DELETE FROM sys_data_change WHERE entity_id = :pk',
        'DELETE FROM sys_user_role WHERE user_id = :pk',
        'DELETE FROM sys_user WHERE id = :pk',
    ):
        asyncio.run(_sql(stmt, {'pk': int(pk)}))


def test_finds_a_user_by_nickname_and_never_hands_over_the_phone_number(
    monkeypatch: pytest.MonkeyPatch, changed_user: str
) -> None:
    """人说的是昵称，记录里存的是用户名；手机号只说「改过」—— 返回的东西会原样发给模型供应商"""
    outcome = run_tool(monkeypatch, name=NICKNAME)
    data = ok(outcome)
    assert data['objects'] == [{'type': '用户', 'name': USERNAME, 'id': changed_user}]
    assert [r['action'] for r in data['records']] == ['已修改', '已新建']  # 新的在前
    (phone,) = [c for c in data['records'][0]['changes'] if c['field'] == '手机号']
    assert phone == {'field': '手机号', 'value': '已修改（不给出具体值）'}
    assert OLD_PHONE not in outcome.payload and NEW_PHONE not in outcome.payload
    # 引用的名字（部门名）给的是名字，不是雪花 ID
    created_dept = next(c for c in data['records'][1]['changes'] if c['field'] == '部门')
    assert not str(created_dept['new']).isdigit()


def test_field_and_type_take_chinese_names(monkeypatch: pytest.MonkeyPatch, changed_user: str) -> None:
    data = ok(run_tool(monkeypatch, name=USERNAME, entity_type='用户', field='手机号'))
    # 新建那条也「改过」手机号（从无到有），两条都在
    assert len(data['records']) == 2
    # 不认识的字段：说清楚有哪些可选，模型能自己改正
    wrong = run_tool(monkeypatch, name=USERNAME, entity_type='用户', field='生日')
    assert wrong.kind == 'failed' and '可选' in wrong.payload and '手机号' in wrong.payload


def test_an_unknown_name_is_reported_not_answered_with_everything(
    monkeypatch: pytest.MonkeyPatch, changed_user: str
) -> None:
    """找不到就说找不到 —— 不能悄悄去掉这个条件、把全表最近的记录当答案"""
    assert run_tool(monkeypatch).kind == 'ok', '前置：不带名字能查'
    outcome = run_tool(monkeypatch, name='没有这个人XYZ')
    assert outcome.kind == 'failed' and '没有找到' in outcome.payload


def test_a_renamed_object_is_found_by_its_old_name_with_its_whole_history(
    monkeypatch: pytest.MonkeyPatch, client: TestClient, token_headers: dict[str, str]
) -> None:
    """改过名的部门：用旧名字也找得到，而且改名之后的记录一起带出来（按 ID 取，不按名字取）"""
    code = 'PYTEST_DC_AI'
    asyncio.run(_sql('DELETE FROM sys_dept WHERE code = :c', {'c': code}))
    body = {'code': code, 'name': '审计旧部门', 'status': 1, 'sort': 0}
    res = client.post('/sys/depts', headers=token_headers, json=body)
    assert res.json()['code'] == 200, res.text
    dept = client.get('/sys/depts', headers=token_headers, params={'code': code}).json()['data'][0]
    try:
        res = client.put(
            f'/sys/depts/{dept["id"]}', headers=token_headers, json={'name': '审计新部门', 'status': 1, 'sort': 0}
        )
        assert res.json()['code'] == 200, res.text
        records = ok(run_tool(monkeypatch, name='审计旧部门'))['records']
        assert [r['object'] for r in records] == ['部门「审计新部门」', '部门「审计旧部门」']
        (rename,) = [c for c in records[0]['changes'] if c['field'] == '部门名称']
        assert rename == {'field': '部门名称', 'old': '审计旧部门', 'new': '审计新部门'}
    finally:
        asyncio.run(_sql('DELETE FROM sys_data_change WHERE entity_id = :pk', {'pk': int(dept['id'])}))
        asyncio.run(_sql('DELETE FROM sys_dept WHERE id = :pk', {'pk': int(dept['id'])}))
