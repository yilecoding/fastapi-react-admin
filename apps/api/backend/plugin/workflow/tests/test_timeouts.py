"""审批超时：提醒 / 自动同意 / 自动驳回。

直接调 `handle_timeouts`（celery 任务里调的就是它），给一个**未来的 now** —— 控制时间，不等待时间
（task 分册「控制时间，不要等待时间」）。独立引擎 + socket 推送打桩，同 `test_concurrency.py`。
"""

import asyncio

from collections.abc import Callable
from datetime import timedelta
from typing import Any

import pytest

from starlette.testclient import TestClient

from backend.database.db import create_database_async_engine, create_database_async_session, get_database_url
from backend.plugin.workflow.service import runtime_service
from backend.plugin.workflow.service.timeout_service import handle_timeouts
from backend.plugin.workflow.tests.test_ops import FORM, _detail, _start, _todo
from backend.plugin.workflow.tests.test_review_fixes import _approval, _model, _publish
from backend.utils.timezone import timezone

Login = Callable[[str], dict[str, str]]
Uid = Callable[[str], str]


async def _noop(*_: Any) -> None:
    await asyncio.sleep(0)


@pytest.fixture(autouse=True)
def _no_push(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(runtime_service, 'workflow_todo_changed', _noop)
    monkeypatch.setattr(runtime_service, 'notification_new', _noop)


def _run(hours_later: float) -> dict[str, int]:
    async def go() -> dict[str, int]:
        engine = create_database_async_engine(get_database_url(unittest=True))
        try:
            return await handle_timeouts(
                create_database_async_session(engine), now=timezone.now() + timedelta(hours=hours_later)
            )
        finally:
            await engine.dispose()

    return asyncio.run(go())


def _flow(client: TestClient, admin: dict[str, str], uid: Uid, code: str, action: str, hours: int = 24) -> None:
    first = _approval(
        'n1',
        {'kind': 'user', 'user_ids': [uid('zhaolei')]},
        nxt=_approval('n2', {'kind': 'user', 'user_ids': [uid('zhoumin')]}),
    )
    first['timeout'] = {'hours': hours, 'action': action}
    _publish(client, admin, code, FORM, _model(first))


def test_timeout_auto_approve(client: TestClient, token_headers: dict[str, str], login: Login, uid: Uid) -> None:
    _flow(client, token_headers, uid, 'PYTEST_TO_OK', 'approve')
    pk = _start(client, login, 'PYTEST_TO_OK')
    # 详情里能看到什么时候超时
    task = next(t for t in _detail(client, login('sunqiang'), pk)['tasks'] if t['node_id'] == 'n1')
    assert task['due_time'] is not None
    # 还没到点：不动
    _run(1)
    assert _todo(client, login, 'zhaolei', pk) is not None
    # 到点：自动同意，走到下一步；同意记录是系统做的
    assert _run(25)['approve'] >= 1
    d = _detail(client, login('sunqiang'), pk)
    assert d['instance']['current_node_id'] == 'n2'
    rec = next(r for r in d['records'] if r['action'] == 'timeout_approve')
    assert rec['actor_type'] == 'system' and '24' in rec['opinion']
    # 下一步的时钟从它到周敏手上才开始：同一个「现在」再扫一遍，周敏的待办不会被顺手同意
    _run(25)
    assert _todo(client, login, 'zhoumin', pk) is not None


def test_timeout_auto_reject(client: TestClient, token_headers: dict[str, str], login: Login, uid: Uid) -> None:
    _flow(client, token_headers, uid, 'PYTEST_TO_NO', 'reject', hours=2)
    pk = _start(client, login, 'PYTEST_TO_NO')
    assert _run(3)['reject'] >= 1
    d = _detail(client, login('sunqiang'), pk)
    assert d['instance']['status'] == 'rejected'
    assert any(r['action'] == 'timeout_reject' for r in d['records'])
    notes = client.get('/sys/notifications', headers=login('sunqiang'), params={'size': 50}).json()['data']['items']
    assert any('已驳回' in n['title'] for n in notes)


def test_timeout_remind_repeats_but_caps(
    client: TestClient, token_headers: dict[str, str], login: Login, uid: Uid
) -> None:
    _flow(client, token_headers, uid, 'PYTEST_TO_RE', 'remind', hours=2)
    pk = _start(client, login, 'PYTEST_TO_RE')

    def reminders() -> int:
        recs = _detail(client, login('sunqiang'), pk)['records']
        return sum(1 for r in recs if r['action'] == 'timeout_remind')

    _run(3)
    assert reminders() == 1
    _run(3)  # 同一个周期里再扫：不重复提醒
    assert reminders() == 1
    _run(5)  # 第二个周期
    assert reminders() == 2
    _run(100)  # 很久以后：最多三次
    _run(100)
    assert reminders() == 3
    # 提醒不改状态：还在赵磊手上
    assert _detail(client, login('sunqiang'), pk)['instance']['current_node_id'] == 'n1'


def test_no_take_back_after_the_next_step_timed_out(
    client: TestClient, token_headers: dict[str, str], login: Login, uid: Uid
) -> None:
    """赵磊同意 → 周敏那一步超时自动同意 → 赵磊不能再拿回（下一步已经有「人」处理过了）"""
    second = _approval(
        'n2',
        {'kind': 'user', 'user_ids': [uid('zhoumin')]},
        nxt=_approval('n3', {'kind': 'user', 'user_ids': [uid('chenjing')]}),
    )
    second['timeout'] = {'hours': 1, 'action': 'approve'}
    _publish(
        client,
        token_headers,
        'PYTEST_TO_TB',
        FORM,
        _model(_approval('n1', {'kind': 'user', 'user_ids': [uid('zhaolei')]}, nxt=second)),
    )
    pk = _start(client, login, 'PYTEST_TO_TB')
    from backend.plugin.workflow.tests.conftest import ok
    from backend.plugin.workflow.tests.test_ops import _act

    ok(_act(client, login('zhaolei'), pk, 'approve'))
    # 先断言「有」：超时之前赵磊能拿回
    assert 'take_back' in {c['action'] for c in _detail(client, login('zhaolei'), pk)['capabilities']}
    _run(2)
    assert _detail(client, login('sunqiang'), pk)['instance']['current_node_id'] == 'n3'
    assert 'take_back' not in {c['action'] for c in _detail(client, login('zhaolei'), pk)['capabilities']}
