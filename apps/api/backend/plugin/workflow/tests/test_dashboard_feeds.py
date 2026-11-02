"""工作台用到的审批数据（#202）：待办带超时 / 退回 / 转交 + 按要紧程度排 · 我发起的带进度 · 草稿和可发起的"""

import json
import uuid

from collections.abc import Callable
from typing import Any

import pytest

from starlette.testclient import TestClient

from backend.plugin.workflow.engine import flow
from backend.plugin.workflow.service import query_service, runtime_service
from backend.plugin.workflow.tests.conftest import key, ok
from backend.plugin.workflow.tests.test_ops import FORM, _act, _detail, _start
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


# ── 代码评审（#203 之后）补的 ───────────────────────────────────────────────


def _marked(
    client: TestClient, login: Login, code: str, mark: str, n: int, *, who: str = 'sunqiang', urgent: int = 0
) -> list[str]:
    """发 n 张事由里带 `mark` 的单（前 `urgent` 张加急）。

    按 `mark` 搜就只有这几张 —— 共用的测试库里别的用例也给同一个人留了待办
    """
    return [
        ok(
            client.post(
                '/sys/workflow/instances',
                headers=login(who),
                json={'code': code, 'form': {'f': f'{mark} {i}'}, 'key': key(), 'urgent': i < urgent},
            )
        )['instance_id']
        for i in range(n)
    ]


def _attention_page(client: TestClient, login: Login, who: str, mark: str, size: int) -> dict[str, Any]:
    params = {'sort': 'attention', 'keyword': mark, 'size': size}
    return ok(client.get('/sys/workflow/inbox/todo', headers=login(who), params=params))


def test_next_steps_do_not_name_people_from_a_field_the_initiator_cannot_see(
    client: TestClient, token_headers: dict[str, str], login: Login, uid: Uid
) -> None:
    """🔴 第 3 步的审批人取自「复核人」字段，而这个字段对发起人隐藏（第 1 步审批人填）：
    详情页的预告对发起人是 masked，工作台的步骤条也不能写出那个人名 —— 只给节点名"""
    form = {
        'schemaVersion': 1,
        'fields': [{'id': 'f', 'type': 'text', 'label': '事由'}, {'id': 'f_rev', 'type': 'user', 'label': '复核人'}],
    }
    n3 = _approval('n3', {'kind': 'var_user', 'field': 'f_rev'})
    n2 = _approval('n2', {'kind': 'user', 'user_ids': [uid('zhoumin')]}, nxt=n3)
    n1 = _approval('n1', {'kind': 'user', 'user_ids': [uid('zhaolei')]}, perms={'f_rev': 'editable'}, nxt=n2)
    model = {
        'schemaVersion': 1,
        'root': {'type': 'start', 'id': 'start', 'fieldPerms': {'f_rev': 'hidden'}, 'next': n1},
    }
    _publish(client, token_headers, 'PYTEST_DASH_MASK', form, model)
    pk = _start(client, login, 'PYTEST_DASH_MASK')
    ok(_act(client, login('zhaolei'), pk, 'approve', form={'f_rev': uid('wangfang')}))

    # 前提：发起人的详情页预告里，第 3 步确实是遮掉的
    forecast = _detail(client, login('sunqiang'), pk)['forecast']
    assert [(s['node_id'], s.get('masked')) for s in forecast] == [('n3', True)]

    row = _initiated(client, login, 'sunqiang', pk)
    assert row['steps'] == [{'name': '赵磊', 'state': 'done'}, {'name': '周敏', 'state': 'current'}]
    assert row['next_steps'] == ['n3']
    assert '王芳' not in json.dumps(row, ensure_ascii=False)


def test_last_step_reads_the_timeout_actions_the_engine_records(
    client: TestClient, token_headers: dict[str, str], login: Login, uid: Uid, monkeypatch: pytest.MonkeyPatch
) -> None:
    """🔴 最后一步超时自动驳回：「最后一步结论」是那次超时，不是前一个人的同意。引擎记的动作名是
    `timeout_approve` / `timeout_reject`（`runtime_service.apply_timeout`），没有 `auto_approve` 这个名字"""
    from backend.plugin.workflow.tests.test_timeouts import _noop, _run

    monkeypatch.setattr(runtime_service, 'workflow_todo_changed', _noop)
    monkeypatch.setattr(runtime_service, 'notification_new', _noop)
    last = _approval('n2', {'kind': 'user', 'user_ids': [uid('zhoumin')]})
    last['timeout'] = {'hours': 2, 'action': 'reject'}
    _publish(
        client,
        token_headers,
        'PYTEST_DASH_TOREJ',
        FORM,
        _model(_approval('n1', {'kind': 'user', 'user_ids': [uid('zhaolei')]}, nxt=last)),
    )
    pk = _start(client, login, 'PYTEST_DASH_TOREJ')
    ok(_act(client, login('zhaolei'), pk, 'approve', opinion='可以'))
    _run(3)

    row = _initiated(client, login, 'sunqiang', pk)
    assert row['status'] == 'rejected'
    assert row['last']['action'] == 'timeout_reject'
    assert row['last']['actor_name'] is None
    assert row['steps'] == [{'name': '赵磊', 'state': 'done'}, {'name': '周敏', 'state': 'rejected'}]


def test_a_step_that_sent_the_form_back_is_not_a_green_tick(
    client: TestClient, token_headers: dict[str, str], login: Login, uid: Uid
) -> None:
    """退回写的是 `decision='send_back'`：步骤条上那一步是「退回」，不是同意"""
    _chain(client, token_headers, uid, 'PYTEST_DASH_SB', 'zhaolei', 'zhoumin')
    pk = _start(client, login, 'PYTEST_DASH_SB')
    ok(_act(client, login('zhaolei'), pk, 'approve'))
    ok(_act(client, login('zhoumin'), pk, 'send_back', target_node_id='n1', opinion='再看看'))
    row = _initiated(client, login, 'sunqiang', pk)
    assert row['steps'] == [
        {'name': '赵磊', 'state': 'done'},
        {'name': '周敏', 'state': 'sent_back'},
        {'name': '赵磊', 'state': 'current'},
    ]


def test_attention_sort_keeps_the_oldest_when_over_the_cap_and_counts_everything(
    client: TestClient, token_headers: dict[str, str], login: Login, uid: Uid, monkeypatch: pytest.MonkeyPatch
) -> None:
    """🔴 超过一次取的上限时：留下的是最老的（最可能已经超时的），`total` 是全量数、不是取回来的条数"""
    _publish_one(client, token_headers, uid, 'PYTEST_DASH_CAP', 'zhaolei')
    mark = f'CAP{uuid.uuid4().hex[:10]}'
    oldest, middle, newest = _marked(client, login, 'PYTEST_DASH_CAP', mark, 3)
    monkeypatch.setattr(query_service, '_ATTENTION_SORT_CAP', 2)

    page = _attention_page(client, login, 'zhaolei', mark, 10)
    assert page['total'] == 3
    assert [r['id'] for r in page['items']] == [middle, oldest]  # 取回来的两条照常按到手时间新的在前
    assert newest not in [r['id'] for r in page['items']]


def test_urgent_and_returned_totals_count_beyond_the_page(
    client: TestClient, token_headers: dict[str, str], login: Login, uid: Uid
) -> None:
    """大标题「其中 M 件加急」和「退回给我」的数是全量的，不是从取回来的那一页里数"""
    _publish_one(client, token_headers, uid, 'PYTEST_DASH_CNT', 'zhaolei')
    mark = f'CNT{uuid.uuid4().hex[:10]}'
    _marked(client, login, 'PYTEST_DASH_CNT', mark, 3, urgent=2)
    page = _attention_page(client, login, 'zhaolei', mark, 1)
    assert (page['total'], page['urgent_total'], page['returned_total'], len(page['items'])) == (3, 2, 0, 1)

    # 退回给发起人的两张：孙强手上两条「改完重新提交」
    back = f'BCK{uuid.uuid4().hex[:10]}'
    for pk in _marked(client, login, 'PYTEST_DASH_CNT', back, 2):
        ok(_act(client, login('zhaolei'), pk, 'send_back', target_node_id='start', opinion='补材料'))
    page = _attention_page(client, login, 'sunqiang', back, 1)
    assert (page['total'], page['returned_total'], len(page['items'])) == (2, 2, 1)
    # SQL 里按「办理人就是发起人」数的，和逐行按开始节点认的 `back` 必须是同一回事
    full = _attention_page(client, login, 'sunqiang', back, 10)
    assert sum(r['back'] for r in full['items']) == full['returned_total']


def test_transfer_source_is_the_latest_hand_not_the_first(
    client: TestClient, token_headers: dict[str, str], login: Login, uid: Uid
) -> None:
    """🔴 A → B → C 转交：C 看到的是「B 转交给你」。`origin_assignee_id` 是链上最初那个人，拿它说就成了「A 转交给你」；
    管理员改派要说成改派"""
    _publish_one(client, token_headers, uid, 'PYTEST_DASH_HAND', 'zhaolei')
    pk = _start(client, login, 'PYTEST_DASH_HAND')
    ok(_act(client, login('zhaolei'), pk, 'transfer', target_user_ids=[uid('zhoumin')]))
    ok(_act(client, login('zhoumin'), pk, 'transfer', target_user_ids=[uid('wangfang')]))
    row = next(r for r in _todo_rows(client, login, 'wangfang') if r['id'] == pk)
    assert (row['transferred_from'], row['transfer_kind']) == ('周敏', 'transfer')

    admin = ok(client.get('/sys/users/me', headers=token_headers))['nickname']
    ok(_act(client, token_headers, pk, 'reassign', task_id=row['task_id'], target_user_ids=[uid('chenjing')]))
    row = next(r for r in _todo_rows(client, login, 'chenjing') if r['id'] == pk)
    assert (row['transferred_from'], row['transfer_kind']) == (admin, 'reassign')


def test_todo_rows_index_each_snapshot_once(
    client: TestClient, token_headers: dict[str, str], login: Login, uid: Uid, monkeypatch: pytest.MonkeyPatch
) -> None:
    """同一个流程版本的几行只建一次节点索引（审批中心默认的待办列表也走这里）"""
    _publish_one(client, token_headers, uid, 'PYTEST_DASH_IDX', 'zhaolei', {'hours': 24, 'action': 'remind'})
    mark = f'IDX{uuid.uuid4().hex[:10]}'
    _marked(client, login, 'PYTEST_DASH_IDX', mark, 3)
    calls = 0
    real = flow.index_nodes

    def counting(model: Any) -> Any:
        nonlocal calls
        calls += 1
        return real(model)

    monkeypatch.setattr(query_service, 'index_nodes', counting)
    monkeypatch.setattr(runtime_service, 'index_nodes', counting)
    for sort in ('attention', None):
        calls = 0
        params = {'keyword': mark, 'size': 10, **({'sort': sort} if sort else {})}
        page = ok(client.get('/sys/workflow/inbox/todo', headers=login('zhaolei'), params=params))
        assert len(page['items']) == 3 and all(r['due_time'] for r in page['items'])
        assert calls == 1, (sort, calls)
