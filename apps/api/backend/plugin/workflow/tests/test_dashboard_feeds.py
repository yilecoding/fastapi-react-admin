"""工作台用到的审批数据（#202）：待办带超时 / 退回 / 转交 + 按要紧程度排 · 我发起的带进度 · 草稿和可发起的"""

from collections.abc import Callable
from typing import Any

from starlette.testclient import TestClient

from backend.plugin.workflow.tests.conftest import key, ok
from backend.plugin.workflow.tests.test_ops import FORM, _act, _start
from backend.plugin.workflow.tests.test_review_fixes import _approval, _model, _publish

Login = Callable[[str], dict[str, str]]
Uid = Callable[[str], str]


def _publish_one(client: TestClient, admin: dict[str, str], uid: Uid, code: str, who: str, timeout: Any = None) -> None:
    node = _approval('n1', {'kind': 'user', 'user_ids': [uid(who)]})
    if timeout:
        node['timeout'] = timeout
    _publish(client, admin, code, FORM, _model(node))


def _chain(client: TestClient, admin: dict[str, str], uid: Uid, code: str, *people: str) -> None:
    nxt: Any = None
    for i in range(len(people), 0, -1):
        nxt = _approval(f'n{i}', {'kind': 'user', 'user_ids': [uid(people[i - 1])]}, nxt=nxt)
    _publish(client, admin, code, FORM, _model(nxt))


def _todo_rows(client: TestClient, login: Login, who: str, **params: Any) -> list[dict[str, Any]]:
    return ok(client.get('/sys/workflow/inbox/todo', headers=login(who), params={'size': 100, **params}))['items']


def _initiated(client: TestClient, login: Login, who: str, pk: str) -> dict[str, Any]:
    rows = ok(client.get('/sys/workflow/inbox/initiated', headers=login(who), params={'size': 10, 'progress': True}))[
        'items'
    ]
    return next(r for r in rows if r['id'] == pk)


def test_todo_rows_carry_timeout_and_attention_sort(
    client: TestClient, token_headers: dict[str, str], login: Login, uid: Uid
) -> None:
    """加急 → 快到期 → 到手时间新的在前；每行带超时时间和到点做什么"""
    _publish_one(client, token_headers, uid, 'PYTEST_DASH_N', 'zhaolei')
    _publish_one(client, token_headers, uid, 'PYTEST_DASH_T48', 'zhaolei', {'hours': 48, 'action': 'approve'})
    _publish_one(client, token_headers, uid, 'PYTEST_DASH_T2', 'zhaolei', {'hours': 2, 'action': 'remind'})
    oldest = _start(client, login, 'PYTEST_DASH_N')
    t48 = _start(client, login, 'PYTEST_DASH_T48')
    t2 = _start(client, login, 'PYTEST_DASH_T2')
    urgent = ok(
        client.post(
            '/sys/workflow/instances',
            headers=login('sunqiang'),
            json={'code': 'PYTEST_DASH_N', 'form': {'f': '急'}, 'key': key(), 'urgent': True},
        )
    )['instance_id']
    newest = _start(client, login, 'PYTEST_DASH_N')
    mine = {oldest, t48, t2, urgent, newest}

    rows = [r for r in _todo_rows(client, login, 'zhaolei', sort='attention') if r['id'] in mine]
    assert [r['id'] for r in rows] == [urgent, t2, t48, newest, oldest]
    by_id = {r['id']: r for r in rows}
    assert by_id[t2]['timeout_action'] == 'remind' and by_id[t2]['due_time']
    assert by_id[t48]['timeout_action'] == 'approve'
    assert by_id[oldest]['due_time'] is None and by_id[oldest]['timeout_action'] is None
    # 发起人的部门名带上了（「王芳 · 市场运营中心」那一行）
    assert by_id[oldest]['initiator_dept']

    # 默认排序（审批中心）不变：加急在前，其余按到手时间倒序
    default = [r['id'] for r in _todo_rows(client, login, 'zhaolei') if r['id'] in mine]
    assert default == [urgent, newest, t2, t48, oldest]

    # 分页切的是排好之后的那一份
    page2 = ok(
        client.get(
            '/sys/workflow/inbox/todo', headers=login('zhaolei'), params={'size': 2, 'page': 2, 'sort': 'attention'}
        )
    )
    assert page2['total'] >= 5
    assert [r['id'] for r in page2['items']] == [
        r['id'] for r in _todo_rows(client, login, 'zhaolei', sort='attention')
    ][2:4]


def test_back_and_transfer_are_told_apart(
    client: TestClient, token_headers: dict[str, str], login: Login, uid: Uid
) -> None:
    """退回给发起人的那条待办标 `back` + 谁退的 / 原因；转交过来的带「从谁那转来」"""
    _publish_one(client, token_headers, uid, 'PYTEST_DASH_BACK', 'zhaolei')
    pk = _start(client, login, 'PYTEST_DASH_BACK')
    before = next(r for r in _todo_rows(client, login, 'zhaolei') if r['id'] == pk)
    assert before['back'] is False and before['back_by'] is None and before['transferred_from'] is None

    ok(_act(client, login('zhaolei'), pk, 'transfer', target_user_ids=[uid('zhoumin')]))
    moved = next(r for r in _todo_rows(client, login, 'zhoumin') if r['id'] == pk)
    assert moved['transferred_from'] == '赵磊'

    ok(_act(client, login('zhoumin'), pk, 'send_back', target_node_id='start', opinion='发票抬头写错了'))
    back = next(r for r in _todo_rows(client, login, 'sunqiang') if r['id'] == pk)
    assert back['back'] is True
    assert back['back_by'] == '周敏'
    assert back['back_reason'] == '发票抬头写错了'


def test_initiated_progress_steps_and_next(
    client: TestClient, token_headers: dict[str, str], login: Login, uid: Uid
) -> None:
    """我发起的：走过的 ✓ / 当前 ◉（在谁手上、从什么时候）/ 后面推演出来的步骤 / 结束后最后一步结论"""
    _chain(client, token_headers, uid, 'PYTEST_DASH_PROG', 'zhaolei', 'zhoumin')
    pk = _start(client, login, 'PYTEST_DASH_PROG')

    row = _initiated(client, login, 'sunqiang', pk)
    assert row['steps'] == [{'name': '赵磊', 'state': 'current'}]
    assert row['handlers'] == ['赵磊'] and row['arrived_time']
    assert row['next_steps'] == ['周敏']
    assert row['back'] is False

    ok(_act(client, login('zhaolei'), pk, 'approve', opinion='可以'))
    row = _initiated(client, login, 'sunqiang', pk)
    assert row['steps'] == [{'name': '赵磊', 'state': 'done'}, {'name': '周敏', 'state': 'current'}]
    assert row['next_steps'] == []

    # 退回到发起人：步骤条从头算，后面是重新提交之后要走的；选了「直接回到我」就写回到谁
    ok(_act(client, login('zhoumin'), pk, 'send_back', target_node_id='start', opinion='补材料', resume=True))
    row = _initiated(client, login, 'sunqiang', pk)
    assert row['back'] is True and row['back_by'] == '周敏' and row['back_reason'] == '补材料'
    assert row['handlers'] == [] and row['current_node_name'] is None
    assert row['resume_to'] == 'n2'
    assert row['next_steps'] == ['周敏']

    ok(_act(client, login('sunqiang'), pk, 'approve', form={'f': '补好了'}))
    ok(_act(client, login('zhoumin'), pk, 'approve', opinion='注意交接'))
    row = _initiated(client, login, 'sunqiang', pk)
    assert row['status'] == 'approved'
    assert row['steps'] == [{'name': '周敏', 'state': 'done'}]
    assert row['next_steps'] == []
    assert row['last']['action'] == 'approve' and row['last']['actor_name'] == '周敏'
    assert row['last']['opinion'] == '注意交接'


def test_progress_needs_a_small_page(client: TestClient, login: Login) -> None:
    """每行要推演一遍后面的步骤：大页不给（工作台只要几条）"""
    resp = client.get('/sys/workflow/inbox/initiated', headers=login('sunqiang'), params={'size': 11, 'progress': True})
    assert resp.json()['code'] == 400, resp.text
    # 不带进度照旧能取大页
    assert ok(client.get('/sys/workflow/inbox/initiated', headers=login('sunqiang'), params={'size': 50}))['size'] == 50


def test_drafts_carry_name_and_summary_and_startable_counts(
    client: TestClient, token_headers: dict[str, str], login: Login, uid: Uid
) -> None:
    _publish_one(client, token_headers, uid, 'PYTEST_DASH_DRAFT', 'zhaolei')
    who = login('zhoumin')
    ok(client.put('/sys/workflow/drafts/PYTEST_DASH_DRAFT', headers=who, json={'form': {'f': '北京 2 天'}}))
    try:
        rows = ok(client.get('/sys/workflow/drafts', headers=who))
        row = next(r for r in rows if r['code'] == 'PYTEST_DASH_DRAFT')
        assert row['name'] == 'PYTEST_DASH_DRAFT'
        assert row['summary'] == '事由：北京 2 天'
    finally:
        client.delete('/sys/workflow/drafts/PYTEST_DASH_DRAFT', headers=who)

    def count() -> int:
        defs = ok(client.get('/sys/workflow/startable', headers=who))
        return next(d['my_recent_count'] for d in defs if d['code'] == 'PYTEST_DASH_DRAFT')

    assert count() == 0
    _start(client, login, 'PYTEST_DASH_DRAFT', who='zhoumin')
    _start(client, login, 'PYTEST_DASH_DRAFT', who='zhoumin')
    _start(client, login, 'PYTEST_DASH_DRAFT', who='sunqiang')
    # 只数自己的
    assert count() == 2
