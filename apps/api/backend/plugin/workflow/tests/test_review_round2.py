"""第二轮代码审查（PR #108）发现的问题，每条一个回归测试"""

from collections.abc import Callable
from typing import Any

from starlette.testclient import TestClient

from backend.plugin.workflow.tests.conftest import key, ok
from backend.plugin.workflow.tests.test_ops import FORM, _act, _detail, _start, _todo
from backend.plugin.workflow.tests.test_review_fixes import _approval, _drop_user_cache, _model, _publish, _sql
from backend.plugin.workflow.tests.test_timeouts import (  # ruff: ignore[unused-import] —— _no_push 是 autouse fixture
    _no_push,
    _run,
)

Login = Callable[[str], dict[str, str]]
Uid = Callable[[str], str]


def test_resubmit_onto_a_path_with_an_unpicked_select_node_is_400_not_auto_rejected(
    client: TestClient, token_headers: dict[str, str], login: Login, uid: Uid
) -> None:
    """被退回后改了金额，新路上多了「发起人自选」节点：要求选人，而不是取人为空、当场被自动驳回"""
    form = {'schemaVersion': 1, 'fields': [{'id': 'f_n', 'type': 'number', 'label': '金额'}]}
    model = _model(
        _approval(
            'n1',
            {'kind': 'user', 'user_ids': [uid('zhaolei')]},
            nxt={
                'type': 'condition',
                'id': 'c1',
                'name': 'c',
                'next': None,
                'branches': [
                    {
                        'id': 'b_big',
                        'name': '大额',
                        'when': {'all': [{'var': 'f_n', 'op': 'gt', 'value': 100}]},
                        'child': _approval('n_pick', {'kind': 'select_on_start'}),
                    },
                    {'id': 'b_def', 'name': '其他', 'default': True, 'child': None},
                ],
            },
        )
    )
    _publish(client, token_headers, 'PYTEST_R2_PICK', form, model)
    pk = _start(client, login, 'PYTEST_R2_PICK', form={'f_n': 5})
    ok(_act(client, login('zhaolei'), pk, 'send_back', target_node_id='start', opinion='改一下'))
    d = _detail(client, login('sunqiang'), pk)
    assert [n['id'] for n in d['select_nodes']] == ['n_pick']
    # 改成大额、不选人：拦住（单子还在发起人手上，没被驳回）
    resp = _act(client, login('sunqiang'), pk, 'approve', form={'f_n': 500})
    assert resp.json()['code'] == 400, resp.text
    assert _detail(client, login('sunqiang'), pk)['instance']['status'] == 'running'
    # 选了人：照常往下走
    ok(_act(client, login('sunqiang'), pk, 'approve', form={'f_n': 500}, selected={'n_pick': [uid('zhoumin')]}))
    ok(_act(client, login('zhaolei'), pk, 'approve'))
    assert _todo(client, login, 'zhoumin', pk) is not None


def test_timeout_approve_does_not_skip_required_editable_fields(
    client: TestClient, token_headers: dict[str, str], login: Login, uid: Uid
) -> None:
    """人事节点的「人事备注」可编辑 + 必填：超时不能替他同意（人点同意都过不去），退回成提醒"""
    form = {
        'schemaVersion': 1,
        'fields': [
            {'id': 'f', 'type': 'text', 'label': '事由'},
            {'id': 'f_hr', 'type': 'text', 'label': '人事备注', 'required': True},
        ],
    }
    node = _approval('n1', {'kind': 'user', 'user_ids': [uid('zhaolei')]}, perms={'f_hr': 'editable'})
    node['timeout'] = {'hours': 1, 'action': 'approve'}
    _publish(
        client,
        token_headers,
        'PYTEST_R2_TO',
        form,
        {
            'schemaVersion': 1,
            'root': {
                'type': 'start',
                'id': 'start',
                'fieldPerms': {'f_hr': 'hidden'},
                'next': node,
            },
        },
    )
    pk = _start(client, login, 'PYTEST_R2_TO', form={'f': 'x'})
    counts = _run(2)
    assert counts['approve'] == 0 and counts['remind'] >= 1
    d = _detail(client, login('sunqiang'), pk)
    assert d['instance']['status'] == 'running'
    assert any(r['action'] == 'timeout_remind' for r in d['records'])


def test_dept_with_a_disabled_leader_can_still_be_edited(
    client: TestClient, token_headers: dict[str, str], uid: Uid
) -> None:
    depts = client.get('/sys/depts', headers=token_headers, params={'code': 'TECH_BE'}).json()['data']

    def find(nodes: list[dict[str, Any]]) -> dict[str, Any] | None:
        for n in nodes:
            if n.get('code') == 'TECH_BE':
                return n
            hit = find(n.get('children') or [])
            if hit:
                return hit
        return None

    dept = find(depts)
    assert dept is not None and dept.get('leader_id') == uid('liuyang')
    body = {k: dept[k] for k in ('name', 'parent_id', 'sort', 'leader_id', 'phone', 'email', 'status') if k in dept}
    _sql("UPDATE sys_user SET status = 0 WHERE username = 'liuyang'")
    _drop_user_cache(uid('liuyang'))
    try:
        # 负责人没换（表单原样带回停用的那个 ID），只改别的：要能存
        resp = client.put(
            f'/sys/depts/{dept["id"]}', headers=token_headers, json={**body, 'sort': (body.get('sort') or 0) + 1}
        )
        assert resp.json()['code'] == 200, resp.text
        # 换成另一个停用的人：照样拦
        _sql("UPDATE sys_user SET status = 0 WHERE username = 'chenjing'")
        resp = client.put(
            f'/sys/depts/{dept["id"]}', headers=token_headers, json={**body, 'leader_id': uid('chenjing')}
        )
        assert resp.json()['code'] != 200
    finally:
        _sql("UPDATE sys_user SET status = 1 WHERE username IN ('liuyang', 'chenjing')")
        _drop_user_cache(uid('liuyang'))
        _drop_user_cache(uid('chenjing'))
        client.put(f'/sys/depts/{dept["id"]}', headers=token_headers, json=body)


def test_outsider_action_is_404_without_a_record(
    client: TestClient, token_headers: dict[str, str], login: Login, uid: Uid
) -> None:
    _publish(
        client,
        token_headers,
        'PYTEST_R2_OUT',
        FORM,
        _model(_approval('n1', {'kind': 'user', 'user_ids': [uid('zhaolei')]})),
    )
    pk = _start(client, login, 'PYTEST_R2_OUT')
    before = len(_detail(client, login('sunqiang'), pk)['records'])
    # 和这张单无关的人：和「ID 不存在」一模一样（404），不留记录
    resp = _act(client, login('wangfang'), pk, 'approve')
    assert resp.status_code == 404, resp.text
    missing = _act(client, login('wangfang'), '9' * 18, 'approve')
    assert missing.status_code == resp.status_code
    assert len(_detail(client, login('sunqiang'), pk)['records']) == before
    # 先断言「有」：真正的办理人照常能办
    ok(_act(client, login('zhaolei'), pk, 'approve'))


def test_malformed_values_are_400_not_500(
    client: TestClient, token_headers: dict[str, str], login: Login, uid: Uid
) -> None:
    form = {
        'schemaVersion': 1,
        'fields': [
            {'id': 'f_type', 'type': 'select', 'label': '类型', 'options': [{'label': 'A', 'value': 'a'}]},
            {'id': 'f_t', 'type': 'text', 'label': '文本'},
        ],
    }
    model = _model({
        'type': 'condition',
        'id': 'c1',
        'name': 'c',
        'next': None,
        'branches': [
            {
                'id': 'b1',
                'name': '是 x',
                'when': {'all': [{'var': 'f_t', 'op': 'eq', 'value': '1'}]},
                'child': _approval('n1', {'kind': 'user', 'user_ids': [uid('zhaolei')]}),
            },
            {
                'id': 'b_def',
                'name': '其他',
                'default': True,
                'child': _approval('n2', {'kind': 'user', 'user_ids': [uid('zhoumin')]}),
            },
        ],
    })
    _publish(client, token_headers, 'PYTEST_R2_BAD', form, model)
    for bad in ({'f_type': ['a']}, {'f_type': {'x': 1}}):
        resp = client.post(
            '/sys/workflow/instances',
            headers=login('sunqiang'),
            json={'code': 'PYTEST_R2_BAD', 'form': bad, 'key': key()},
        )
        assert resp.status_code == 400, (bad, resp.text)
    # 'sNaN' 这种串变成 Decimal 之后和**数字**比较会抛 InvalidOperation（和字符串比不会 —— 所以条件值要是数字）
    for word in ('NaN', 'sNaN', 'Infinity'):
        resp = client.post(
            '/sys/workflow/startable/PYTEST_R2_BAD/preview', headers=login('sunqiang'), json={'form': {'f_t': word}}
        )
        assert resp.json()['code'] == 200, resp.text
        assert [s['node_id'] for s in resp.json()['data']['steps']] == ['n2']
        ok(
            client.post(
                '/sys/workflow/instances',
                headers=login('sunqiang'),
                json={'code': 'PYTEST_R2_BAD', 'form': {'f_t': word}, 'key': key()},
            )
        )


def test_two_cc_nodes_to_the_actor_do_not_break_the_flow(
    client: TestClient, token_headers: dict[str, str], login: Login, uid: Uid
) -> None:
    """赵磊同意后连着两个抄送节点都抄给他自己：第二次不能重复插入（原来撞唯一约束 → 500，单子永远推不过去）"""
    cc = {'kind': 'user', 'user_ids': [uid('zhaolei')]}
    cc2 = {'type': 'cc', 'id': 'cc2', 'name': '抄送2', 'targets': [cc], 'next': None}
    cc1 = {'type': 'cc', 'id': 'cc1', 'name': '抄送1', 'targets': [cc], 'next': cc2}
    _publish(
        client,
        token_headers,
        'PYTEST_R2_CC',
        FORM,
        _model(_approval('n1', {'kind': 'user', 'user_ids': [uid('zhaolei')]}, nxt=cc1)),
    )
    pk = _start(client, login, 'PYTEST_R2_CC')
    ok(_act(client, login('zhaolei'), pk, 'approve'))
    d = _detail(client, login('sunqiang'), pk)
    assert d['instance']['status'] == 'approved'
    assert [c['user_id'] for c in d['ccs']] == [uid('zhaolei')]


def test_resubmit_from_an_old_request_keeps_the_draft(
    client: TestClient, token_headers: dict[str, str], login: Login, uid: Uid
) -> None:
    _publish(
        client,
        token_headers,
        'PYTEST_R2_DRAFT',
        FORM,
        _model(_approval('n1', {'kind': 'user', 'user_ids': [uid('zhaolei')]})),
    )
    me = login('sunqiang')
    ok(client.put('/sys/workflow/drafts/PYTEST_R2_DRAFT', headers=me, json={'form': {'f': '另一张没写完的'}}))
    ok(
        client.post(
            '/sys/workflow/instances',
            headers=me,
            json={'code': 'PYTEST_R2_DRAFT', 'form': {'f': '从旧单复制'}, 'key': key(), 'keep_draft': True},
        )
    )
    assert ok(client.get('/sys/workflow/drafts/PYTEST_R2_DRAFT', headers=me))['form'] == {'f': '另一张没写完的'}
