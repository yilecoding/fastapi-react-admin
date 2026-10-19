"""并发护栏（#107 阶段 1 的验收项）：两个会话**真的同时**对同一张单动手

TestClient 是串行的，测不出并发。这里起一个独立引擎、每个动作一个会话，用
`asyncio.gather` 同时发出去 —— 数据库驱动在线程里阻塞，事件循环不会把它们排成先后。
每种竞争跑多轮，提高真正撞上的概率。

⚠️ 只碰数据库、不碰 Redis：socket 推送 monkeypatch 成空操作（tests 分册「测试里不要
`asyncio.run()`」那条的前提就是别让共享的 Redis 客户端绑到这个临时循环上）。
"""

import asyncio
import json

from collections.abc import Callable
from typing import Any

import pytest

from sqlalchemy import select
from starlette.testclient import TestClient

from backend.database.db import create_database_async_engine, create_database_async_session, get_database_url
from backend.plugin.workflow.model import WfActionRecord, WfInstance, WfTask
from backend.plugin.workflow.service import runtime_service
from backend.plugin.workflow.service.runtime_service import Actor
from backend.plugin.workflow.tests.conftest import key, ok

ROUNDS = 5


async def _noop(*_: Any) -> None:
    await asyncio.sleep(0)


@pytest.fixture(autouse=True)
def _no_push(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(runtime_service, 'workflow_todo_changed', _noop)
    monkeypatch.setattr(runtime_service, 'notification_new', _noop)


@pytest.fixture(scope='module')
def actors(client: TestClient, token_headers: dict[str, str]) -> dict[str, Actor]:
    out = {}
    for name in ('sunqiang', 'zhaolei', 'zhoumin'):
        u = next(
            i
            for i in ok(client.get('/sys/users', headers=token_headers, params={'username': name}))['items']
            if i['username'] == name
        )
        out[name] = Actor(
            id=int(u['id']), nickname=u['nickname'], dept_id=int(u['dept_id']), is_superuser=False, perms=frozenset()
        )
    return out


def _definition(
    client: TestClient,
    headers: dict[str, str],
    code: str,
    mode: str,
    user_ids: list[str],
    *,
    field_perms: dict[str, str] | None = None,
) -> None:
    model = {
        'schemaVersion': 1,
        'root': {
            'type': 'start',
            'id': 'start',
            'next': {
                'type': 'approval',
                'id': 'n1',
                'name': '审批',
                'mode': mode,
                'assignee': {'kind': 'user', 'user_ids': user_ids},
                'onEmpty': 'reject',
                'fieldPerms': field_perms or {},
                'next': None,
            },
        },
    }
    form = {
        'schemaVersion': 1,
        'fields': [
            {'id': 'f', 'type': 'text', 'label': 'f'},
            {'id': 'g', 'type': 'text', 'label': 'g'},
        ],
    }
    pk = ok(
        client.post(
            '/sys/workflow/definitions',
            headers=headers,
            json={'code': code, 'name': code, 'form': form, 'model': model},
        )
    )['id']
    assert ok(client.post(f'/sys/workflow/definitions/{pk}/publish', headers=headers))['published']


def _start(client: TestClient, login: Callable[[str], dict[str, str]], code: str) -> int:
    data = ok(client.post('/sys/workflow/instances', headers=login('sunqiang'), json={'code': code, 'key': key()}))
    return int(data['instance_id'])


def _race(*calls: Callable[[Any], Any]) -> list[Any]:
    """同时跑这几个动作，返回每个的结果（或异常）"""

    async def run() -> list[Any]:
        engine = create_database_async_engine(get_database_url(unittest=True))
        maker = create_database_async_session(engine)

        async def one(fn: Callable[[Any], Any]) -> Any:
            async with maker() as s:
                try:
                    return await fn(s)
                except Exception as e:
                    return e

        try:
            return list(await asyncio.gather(*(one(c) for c in calls)))
        finally:
            await engine.dispose()

    return asyncio.run(run())


def _state(instance_id: int) -> dict[str, Any]:
    async def run() -> dict[str, Any]:
        engine = create_database_async_engine(get_database_url(unittest=True))
        maker = create_database_async_session(engine)
        try:
            async with maker() as s:
                inst = await s.get(WfInstance, instance_id)
                tasks = (await s.scalars(select(WfTask).where(WfTask.instance_id == instance_id))).all()
                recs = (await s.scalars(select(WfActionRecord).where(WfActionRecord.instance_id == instance_id))).all()
                return {
                    'status': inst.status,
                    'form': json.loads(inst.form_data),
                    'tasks': sorted((t.assignee_id, t.status, t.decision) for t in tasks),
                    'ok': [r.action for r in recs if r.result == 'ok'],
                    'rejected': [r.action for r in recs if r.result == 'rejected'],
                }
        finally:
            await engine.dispose()

    return asyncio.run(run())


def _approve(pk: int, actor: Actor) -> Callable[[Any], Any]:
    return lambda s: runtime_service.act(s, instance_id=pk, action='approve', actor=actor, key=key())


def test_cosign_last_two_approve_at_once(
    client: TestClient, token_headers: dict[str, str], login: Callable[[str], dict[str, str]], actors: dict[str, Actor]
) -> None:
    """会签最后两人同时同意：两个都要成功（认领冲突的那个自动重试），实例通过。

    avc-bp `28d95cdc` 的事故形状是「并发都读到 pending > 0 致节点卡死」——
    这里断言的就是那个反面：不卡在 running。
    """
    a, b = actors['zhaolei'], actors['zhoumin']
    _definition(client, token_headers, 'PYTEST_COSIGN', 'all', [str(a.id), str(b.id)])
    for _ in range(ROUNDS):
        pk = _start(client, login, 'PYTEST_COSIGN')
        results = _race(_approve(pk, a), _approve(pk, b))
        assert all(isinstance(r, dict) for r in results), results
        st = _state(pk)
        assert st['status'] == 'approved', st
        assert st['tasks'] == sorted([(a.id, 'done', 'approve'), (b.id, 'done', 'approve')])
        assert st['ok'].count('approve') == 2


def test_or_sign_two_approve_at_once(
    client: TestClient, token_headers: dict[str, str], login: Callable[[str], dict[str, str]], actors: dict[str, Actor]
) -> None:
    """或签两人同时同意：恰好一个成功，另一个被拒绝（并记下 rejected），不会推进两次"""
    a, b = actors['zhaolei'], actors['zhoumin']
    _definition(client, token_headers, 'PYTEST_ORSIGN', 'any', [str(a.id), str(b.id)])
    for _ in range(ROUNDS):
        pk = _start(client, login, 'PYTEST_ORSIGN')
        results = _race(_approve(pk, a), _approve(pk, b))
        oks = [r for r in results if isinstance(r, dict)]
        errs = [r for r in results if isinstance(r, runtime_service.ActionRejected)]
        assert len(oks) == 1 and len(errs) == 1, results
        st = _state(pk)
        assert st['status'] == 'approved'
        assert st['ok'].count('approve') == 1
        assert st['rejected'] == ['approve']
        assert sorted(s for _, s, _ in st['tasks']) == ['canceled', 'done']


def test_approve_and_withdraw_at_once(
    client: TestClient, token_headers: dict[str, str], login: Callable[[str], dict[str, str]], actors: dict[str, Actor]
) -> None:
    """同意和撤回同时发生：恰好一个生效，终态和赢家一致，不留办不掉的待办。

    avc-bp `44af1960`：「实例已终态却遗留一个 TODO 任务，审批人永远看到一条办不掉的待办」
    """
    a, init = actors['zhaolei'], actors['sunqiang']
    _definition(client, token_headers, 'PYTEST_SINGLE', 'any', [str(a.id)])
    for _ in range(ROUNDS):
        pk = _start(client, login, 'PYTEST_SINGLE')
        withdraw = lambda s, pk=pk: runtime_service.act(  # ruff: ignore[lambda-assignment]
            s, instance_id=pk, action='withdraw', actor=init, key=key(), opinion='不要了'
        )
        results = _race(_approve(pk, a), withdraw)
        oks = [r for r in results if isinstance(r, dict)]
        assert len(oks) == 1, results
        st = _state(pk)
        assert st['status'] in {'approved', 'withdrawn'}
        assert not [t for t in st['tasks'] if t[1] == 'pending'], st
        if st['status'] == 'approved':
            assert st['ok'].count('approve') == 1 and 'withdraw' not in st['ok']
        else:
            assert st['ok'].count('withdraw') == 1 and 'approve' not in st['ok']


def test_cosign_concurrent_form_edits_both_survive(
    client: TestClient, token_headers: dict[str, str], login: Callable[[str], dict[str, str]], actors: dict[str, Actor]
) -> None:
    """会签两人同时同意、各自改一个可编辑字段：两处修改都要留下。

    这条是**版本号**本身的守卫。上面三条竞争光靠「UPDATE 会锁行 + `status='running'`」
    就已经串行了 —— 实测把 `_claim` 里的 `version == inst.version` 去掉，那三条照样全绿。
    版本号真正挡的是**过期的读**：后到的那个人在别人提交之前就读出了实例，
    不强制重读的话，他 flush 的 `form_data` 是旧的，先到那个人改的字段被静默盖掉。
    """
    a, b = actors['zhaolei'], actors['zhoumin']
    _definition(
        client,
        token_headers,
        'PYTEST_COSIGN_EDIT',
        'all',
        [str(a.id), str(b.id)],
        field_perms={'f': 'editable', 'g': 'editable'},
    )
    for _ in range(ROUNDS):
        pk = _start(client, login, 'PYTEST_COSIGN_EDIT')
        results = _race(
            lambda s, pk=pk: runtime_service.act(
                s, instance_id=pk, action='approve', actor=a, key=key(), form_patch={'f': 'A'}
            ),
            lambda s, pk=pk: runtime_service.act(
                s, instance_id=pk, action='approve', actor=b, key=key(), form_patch={'g': 'B'}
            ),
        )
        assert all(isinstance(r, dict) for r in results), results
        st = _state(pk)
        assert st['status'] == 'approved'
        assert st['form'] == {'f': 'A', 'g': 'B'}, st['form']
