"""依次审批 · 退回 · 管理员改办理人 / 离职交接"""

from collections.abc import Callable
from typing import Any

from starlette.testclient import TestClient

from backend.plugin.workflow.tests.conftest import key, ok
from backend.plugin.workflow.tests.test_review_fixes import _approval, _model, _publish

Login = Callable[[str], dict[str, str]]
Uid = Callable[[str], str]

FORM = {'schemaVersion': 1, 'fields': [{'id': 'f', 'type': 'text', 'label': '事由'}]}


def _start(client: TestClient, login: Login, code: str, who: str = 'sunqiang', form: dict | None = None) -> str:
    return ok(
        client.post(
            '/sys/workflow/instances', headers=login(who), json={'code': code, 'form': form or {'f': 'x'}, 'key': key()}
        )
    )['instance_id']


def _todo(client: TestClient, login: Login, who: str, pk: str) -> dict[str, Any] | None:
    rows = ok(client.get('/sys/workflow/inbox/todo', headers=login(who), params={'size': 100}))['items']
    return next((r for r in rows if r['id'] == pk), None)


def _act(client: TestClient, headers: dict[str, str], pk: str, action: str, **body: Any) -> Any:
    return client.post(
        f'/sys/workflow/instances/{pk}/actions', headers=headers, json={'action': action, 'key': key(), **body}
    )


def _detail(client: TestClient, headers: dict[str, str], pk: str) -> dict[str, Any]:
    return ok(client.get(f'/sys/workflow/instances/{pk}', headers=headers))


def _caps(d: dict[str, Any]) -> set[str]:
    return {c['action'] for c in d['capabilities'] if c['enabled']}


# ── 依次审批 ─────────────────────────────────────────────────────────────────


def test_sequential_goes_one_by_one_in_configured_order(
    client: TestClient, token_headers: dict[str, str], login: Login, uid: Uid
) -> None:
    order = ['zhoumin', 'zhaolei', 'chenjing']  # 刻意不按 ID 排：顺序是配置里的顺序
    _publish(
        client,
        token_headers,
        'PYTEST_SEQ',
        FORM,
        _model(_approval('n1', {'kind': 'user', 'user_ids': [uid(u) for u in order]}, mode='seq')),
    )
    pk = _start(client, login, 'PYTEST_SEQ')
    for i, who in enumerate(order):
        # 只有轮到的那个人有待办，后面的人还没有
        assert _todo(client, login, who, pk) is not None, who
        for later in order[i + 1 :]:
            assert _todo(client, login, later, pk) is None, later
        d = _detail(client, login('sunqiang'), pk)
        assert [w['name'] for w in d['waiting']] == [_name(client, token_headers, u) for u in order[i + 1 :]]
        ok(_act(client, login(who), pk, 'approve'))
    assert _detail(client, login('sunqiang'), pk)['instance']['status'] == 'approved'


def _name(client: TestClient, admin: dict[str, str], username: str) -> str:
    items = ok(client.get('/sys/users', headers=admin, params={'username': username}))['items']
    return next(u['nickname'] for u in items if u['username'] == username)


def test_sequential_transfer_keeps_position_and_cannot_skip_ahead(
    client: TestClient, token_headers: dict[str, str], login: Login, uid: Uid
) -> None:
    order = ['zhaolei', 'zhoumin']
    _publish(
        client,
        token_headers,
        'PYTEST_SEQ_T',
        FORM,
        _model(_approval('n1', {'kind': 'user', 'user_ids': [uid(u) for u in order]}, mode='seq')),
    )
    pk = _start(client, login, 'PYTEST_SEQ_T')
    # 转给排在后面的人：他就要审两次 —— 拒绝
    assert _act(client, login('zhaolei'), pk, 'transfer', target_user_ids=[uid('zhoumin')]).json()['code'] == 409
    # 转给队列外的人：他办完，轮到的是原来排在赵磊后面的周敏
    ok(_act(client, login('zhaolei'), pk, 'transfer', target_user_ids=[uid('wangfang')]))
    ok(_act(client, login('wangfang'), pk, 'approve'))
    assert _todo(client, login, 'zhoumin', pk) is not None
    ok(_act(client, login('zhoumin'), pk, 'approve'))
    assert _detail(client, login('sunqiang'), pk)['instance']['status'] == 'approved'


# ── 退回 ─────────────────────────────────────────────────────────────────────


def _two_steps(client: TestClient, admin: dict[str, str], uid: Uid, code: str, first: dict | None = None) -> None:
    form = {'schemaVersion': 1, 'fields': [{'id': 'f', 'type': 'text', 'label': '事由', 'required': True}]}
    _publish(
        client,
        admin,
        code,
        form,
        _model(
            _approval(
                'n1',
                first or {'kind': 'user', 'user_ids': [uid('zhaolei')]},
                nxt=_approval('n2', {'kind': 'user', 'user_ids': [uid('zhoumin')]}),
            )
        ),
    )


def test_send_back_to_initiator_then_resubmit(
    client: TestClient, token_headers: dict[str, str], login: Login, uid: Uid
) -> None:
    _two_steps(client, token_headers, uid, 'PYTEST_BACK0')
    pk = _start(client, login, 'PYTEST_BACK0', form={'f': '第一版'})
    ok(_act(client, login('zhaolei'), pk, 'approve'))

    d = _detail(client, login('zhoumin'), pk)
    assert 'send_back' in _caps(d)
    assert [x['node_id'] for x in d['send_back_targets']] == ['start', 'n1']
    # 退回要写意见
    assert _act(client, login('zhoumin'), pk, 'send_back', target_node_id='start').json()['code'] == 400
    ok(_act(client, login('zhoumin'), pk, 'send_back', target_node_id='start', opinion='事由写清楚'))

    # 单还在跑，到了发起人手上：待办里有、收到通知、能改完重新提交，不能催办也不能驳回自己
    mine = _detail(client, login('sunqiang'), pk)
    assert mine['instance']['status'] == 'running'
    assert _todo(client, login, 'sunqiang', pk) is not None
    assert _caps(mine) >= {'approve', 'withdraw'} and not _caps(mine) & {'reject', 'remind', 'transfer', 'send_back'}
    assert mine['field_perms'] == {'f': 'editable'}
    notes = ok(client.get('/sys/notifications', headers=login('sunqiang'), params={'size': 50}))['items']
    assert any('被退回' in n['title'] for n in notes)
    assert _todo(client, login, 'zhoumin', pk) is None

    # 必填字段清空了不能提交；改好之后从头走：又到了赵磊
    assert _act(client, login('sunqiang'), pk, 'approve', form={'f': ''}).json()['code'] == 400
    ok(_act(client, login('sunqiang'), pk, 'approve', form={'f': '第二版'}))
    d = _detail(client, login('zhaolei'), pk)
    assert d['form_data']['f'] == '第二版' and d['instance']['current_node_id'] == 'n1'
    assert '第二版' in (d['instance']['summary'] or '')
    actions = [r['action'] for r in d['records']]
    assert 'send_back' in actions and 'resubmit' in actions
    ok(_act(client, login('zhaolei'), pk, 'approve'))
    ok(_act(client, login('zhoumin'), pk, 'approve'))
    assert _detail(client, login('sunqiang'), pk)['instance']['status'] == 'approved'


def test_send_back_to_an_earlier_step_counts_votes_per_round(
    client: TestClient, token_headers: dict[str, str], login: Login, uid: Uid
) -> None:
    """退回到 n1 之后重走：上一轮在 n1 同意过的人，这一轮还没表态 —— 可以把这一轮转给他"""
    _two_steps(client, token_headers, uid, 'PYTEST_BACK1')
    pk = _start(client, login, 'PYTEST_BACK1')
    # 第一轮：赵磊转给王芳，王芳同意
    ok(_act(client, login('zhaolei'), pk, 'transfer', target_user_ids=[uid('wangfang')]))
    ok(_act(client, login('wangfang'), pk, 'approve'))
    # 周敏退回到 n1：审批人按规则重新解析，又是赵磊
    ok(_act(client, login('zhoumin'), pk, 'send_back', target_node_id='n1', opinion='再看看'))
    assert _todo(client, login, 'zhaolei', pk) is not None
    assert _todo(client, login, 'zhoumin', pk) is None
    batches = {t['batch'] for t in _detail(client, login('sunqiang'), pk)['tasks'] if t['node_id'] == 'n1'}
    assert len(batches) == 2
    # 第二轮：王芳这一轮没表过态，可以转给她
    ok(_act(client, login('zhaolei'), pk, 'transfer', target_user_ids=[uid('wangfang')]))
    ok(_act(client, login('wangfang'), pk, 'approve'))
    assert _detail(client, login('sunqiang'), pk)['instance']['current_node_id'] == 'n2'


def test_send_back_only_to_steps_already_passed(
    client: TestClient, token_headers: dict[str, str], login: Login, uid: Uid
) -> None:
    _two_steps(client, token_headers, uid, 'PYTEST_BACK2')
    pk = _start(client, login, 'PYTEST_BACK2')
    # 在 n1：只能退回给发起人，不能「退回」到后面的 n2，也不能退回到自己
    d = _detail(client, login('zhaolei'), pk)
    assert [x['node_id'] for x in d['send_back_targets']] == ['start']
    for bad in ('n2', 'n1', 'nope'):
        resp = _act(client, login('zhaolei'), pk, 'send_back', target_node_id=bad, opinion='x')
        assert resp.json()['code'] == 409, (bad, resp.text)
    # 只是看单的人（发起人）拿不到退回目标
    assert _detail(client, login('sunqiang'), pk)['send_back_targets'] == []


def test_send_back_can_be_turned_off_per_node(
    client: TestClient, token_headers: dict[str, str], login: Login, uid: Uid
) -> None:
    node = _approval('n1', {'kind': 'user', 'user_ids': [uid('zhaolei')]})
    node['actions'] = ['transfer']
    _publish(client, token_headers, 'PYTEST_BACK3', FORM, _model(node))
    pk = _start(client, login, 'PYTEST_BACK3')
    assert 'send_back' not in _caps(_detail(client, login('zhaolei'), pk))
    assert _act(client, login('zhaolei'), pk, 'send_back', target_node_id='start', opinion='x').json()['code'] == 409


# ── 改办理人 / 离职交接 ──────────────────────────────────────────────────────


def test_admin_reassigns_a_stuck_task(
    client: TestClient, token_headers: dict[str, str], login: Login, uid: Uid
) -> None:
    _publish(
        client,
        token_headers,
        'PYTEST_REASSIGN',
        FORM,
        _model(_approval('n1', {'kind': 'user', 'user_ids': [uid('zhaolei')]})),
    )
    pk = _start(client, login, 'PYTEST_REASSIGN')
    task_id = _todo(client, login, 'zhaolei', pk)['task_id']
    # 普通人没有这个能力
    assert 'reassign' not in _caps(_detail(client, login('zhaolei'), pk))
    assert (
        _act(client, login('zhaolei'), pk, 'reassign', task_id=task_id, target_user_ids=[uid('wangfang')]).json()[
            'code'
        ]
        == 409
    )
    # 不能改给发起人
    assert 'reassign' in _caps(_detail(client, token_headers, pk))
    resp = _act(client, token_headers, pk, 'reassign', task_id=task_id, target_user_ids=[uid('sunqiang')])
    assert resp.json()['code'] == 409
    ok(_act(client, token_headers, pk, 'reassign', task_id=task_id, target_user_ids=[uid('wangfang')]))
    assert _todo(client, login, 'zhaolei', pk) is None
    assert _todo(client, login, 'wangfang', pk) is not None
    rec = next(r for r in _detail(client, login('sunqiang'), pk)['records'] if r['action'] == 'reassign')
    assert rec['task_id'] == task_id and rec['target_user_name'] == _name(client, token_headers, 'wangfang')
    # 同一条待办再改一次：已经不是待办了
    resp = _act(client, token_headers, pk, 'reassign', task_id=task_id, target_user_ids=[uid('chenjing')])
    assert resp.json()['code'] == 409


def test_handover_moves_everything_it_can_and_lists_the_rest(
    client: TestClient, token_headers: dict[str, str], login: Login, uid: Uid
) -> None:
    _publish(
        client,
        token_headers,
        'PYTEST_HANDOVER',
        FORM,
        _model(_approval('n1', {'kind': 'user', 'user_ids': [uid('liuyang')]})),
    )
    a = _start(client, login, 'PYTEST_HANDOVER', who='sunqiang')
    b = _start(client, login, 'PYTEST_HANDOVER', who='zhoumin')
    c = _start(client, login, 'PYTEST_HANDOVER', who='wangfang')  # 接手的人就是发起人：交不过去
    holders = {h['user_id']: h for h in ok(client.get('/sys/workflow/handover', headers=token_headers))}
    assert holders[uid('liuyang')]['count'] == 3 and holders[uid('liuyang')]['active'] is True
    # 普通人调不了
    resp = client.post(
        '/sys/workflow/handover',
        headers=login('zhaolei'),
        json={'from_user_id': uid('liuyang'), 'to_user_id': uid('wangfang'), 'key': key()},
    )
    assert resp.json()['code'] != 200

    k = key()
    body = {'from_user_id': uid('liuyang'), 'to_user_id': uid('wangfang'), 'key': k}
    res = ok(client.post('/sys/workflow/handover', headers=token_headers, json=body))
    assert res['moved'] == 2
    assert [s['instance_id'] for s in res['skipped']] == [c] and res['skipped'][0]['reason']
    for pk in (a, b):
        assert _todo(client, login, 'wangfang', pk) is not None
    assert _todo(client, login, 'liuyang', c) is not None
    # 同一个键再点一次：交过的不会再交一遍
    assert ok(client.post('/sys/workflow/handover', headers=token_headers, json=body))['moved'] == 0


def test_handover_lists_disabled_holders(
    client: TestClient, token_headers: dict[str, str], login: Login, uid: Uid
) -> None:
    """离职 = 账号停用。停用的人手上的待办也要列出来、交得出去（选人控件里根本选不到他）"""
    from backend.plugin.workflow.tests.test_review_fixes import _drop_user_cache, _sql

    node = _approval('n1', {'kind': 'user', 'user_ids': [uid('chenjing')]})
    _publish(client, token_headers, 'PYTEST_HANDOVER2', FORM, _model(node))
    pk = _start(client, login, 'PYTEST_HANDOVER2')
    _sql("UPDATE sys_user SET status = 0 WHERE username = 'chenjing'")
    _drop_user_cache(uid('chenjing'))
    try:
        holders = {h['user_id']: h for h in ok(client.get('/sys/workflow/handover', headers=token_headers))}
        assert holders[uid('chenjing')]['active'] is False and holders[uid('chenjing')]['count'] >= 1
        body = {'from_user_id': uid('chenjing'), 'to_user_id': uid('zhaolei'), 'key': key()}
        assert ok(client.post('/sys/workflow/handover', headers=token_headers, json=body))['moved'] >= 1
        assert _todo(client, login, 'zhaolei', pk) is not None
    finally:
        _sql("UPDATE sys_user SET status = 1 WHERE username = 'chenjing'")
        _drop_user_cache(uid('chenjing'))
