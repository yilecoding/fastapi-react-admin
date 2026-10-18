"""审批运行时：走真实接口，用种子里的「请假」流程和演示账号

种子组织（三个方言一样，ID 不同）：

    总部(HQ, 无负责人)
    ├── 技术中心(TECH, 张伟 zhangwei)
    │   ├── 后端组(TECH_BE, 刘洋 liuyang)
    │   └── 前端组(TECH_FE, 陈静 chenjing)
    ├── 市场运营中心(MARKETING, 赵磊 zhaolei)   ← 孙强 sunqiang 在这里
    └── 财务人事中心(FINANCE, 王芳 wangfang)     ← 王芳是唯一的 FINANCE_STAFF

请假流程：直属主管 → (天数 > 3 ? 上级主管 : -) → 人事备案(FINANCE_STAFF) → 抄送交接人
"""

from collections.abc import Callable
from datetime import date, timedelta
from typing import Any

from starlette.testclient import TestClient

from backend.plugin.workflow.tests.conftest import key, ok

Login = Callable[[str], dict[str, str]]
Uid = Callable[[str], str]


def leave_form(uid: Uid, *, days: int = 2, handover: str | None = 'chenjing') -> dict[str, Any]:
    # 请假天数是从请假时间自动算的（种子里 f_days 配了 calc）—— 要几天就给几天的区间
    end = date(2026, 11, 2) + timedelta(days=days - 1)
    form: dict[str, Any] = {
        'f_type': 'annual',
        'f_range': ['2026-11-02', end.isoformat()],
        'f_reason': '家里有事',
    }
    if handover:
        form['f_handover'] = uid(handover)
    return form


def start(client: TestClient, headers: dict[str, str], form: dict[str, Any], code: str = 'LEAVE') -> str:
    data = ok(client.post('/sys/workflow/instances', headers=headers, json={'code': code, 'form': form, 'key': key()}))
    return str(data['instance_id'])


def act(client: TestClient, headers: dict[str, str], pk: str, action: str, **kw: Any) -> Any:
    return client.post(
        f'/sys/workflow/instances/{pk}/actions', headers=headers, json={'action': action, 'key': key(), **kw}
    )


def detail(client: TestClient, headers: dict[str, str], pk: str) -> dict[str, Any]:
    return ok(client.get(f'/sys/workflow/instances/{pk}', headers=headers))


def todo_ids(client: TestClient, headers: dict[str, str]) -> list[str]:
    return [str(i['id']) for i in ok(client.get('/sys/workflow/inbox/todo', headers=headers))['items']]


def caps(d: dict[str, Any]) -> set[str]:
    return {c['action'] for c in d['capabilities'] if c['enabled']}


# ── 主路径 ───────────────────────────────────────────────────────────────────


def test_short_leave_runs_to_approved(client: TestClient, login: Login, uid: Uid) -> None:
    """2 天：直属主管 → 人事备案（改人事备注）→ 抄送交接人 → 通过"""
    pk = start(client, login('sunqiang'), leave_form(uid))

    # 先断言「有」：待办真的到了赵磊那里，发起人自己没有同意 / 驳回
    assert pk in todo_ids(client, login('zhaolei'))
    mine = detail(client, login('sunqiang'), pk)
    assert caps(mine) == {'withdraw', 'remind'}
    assert mine['instance']['status'] == 'running'

    # 直属主管看不到「人事备注」—— 服务端裁掉的，schema 和数据里都没有
    leader_view = detail(client, login('zhaolei'), pk)
    assert {'approve', 'reject', 'transfer', 'cc'} <= caps(leader_view)
    assert 'f_hr_note' not in {f['id'] for f in leader_view['form_schema']['fields']}
    assert 'f_reason' in leader_view['form_data']
    ok(act(client, login('zhaolei'), pk, 'approve', opinion='同意'))
    assert pk not in todo_ids(client, login('zhaolei'))

    # 2 天走兜底分支，直接到人事备案
    hr_view = detail(client, login('wangfang'), pk)
    assert hr_view['field_perms']['f_hr_note'] == 'editable'
    # 人事备案节点 actions=[]：只剩必备的同意 / 驳回
    assert caps(hr_view) == {'approve', 'reject'}

    # 只读字段改不了，而且是**拒绝**，不是静默丢掉
    resp = act(client, login('wangfang'), pk, 'approve', form={'f_reason': '改掉'})
    assert resp.json()['code'] == 409, resp.text
    ok(act(client, login('wangfang'), pk, 'approve', form={'f_hr_note': '已登记'}))

    final = detail(client, login('sunqiang'), pk)
    assert final['instance']['status'] == 'approved'
    assert final['form_data']['f_reason'] == '家里有事'
    # 「人事备注」在开始节点上是 hidden：发起人自己也看不到（人事看得到）
    assert 'f_hr_note' not in final['form_data']
    assert detail(client, login('wangfang'), pk)['form_data']['f_hr_note'] == '已登记'
    actions = [r['action'] for r in final['records']]
    assert actions[:2] == ['start', 'approve']
    assert 'branch' in actions and 'cc' in actions
    # 轨迹里的改动前后值也按字段权限裁：人事看得到，发起人看不到
    hr_final = detail(client, login('wangfang'), pk)
    change = next(r for r in hr_final['records'] if r['detail'] and r['detail'].get('form_changes'))
    assert change['detail']['form_changes']['f_hr_note'] == {'from': None, 'to': '已登记'}
    assert not any(r['detail'] and r['detail'].get('form_changes') for r in final['records'])

    # 抄送到了交接人，并且发了站内通知
    cc_items = ok(client.get('/sys/workflow/inbox/cc', headers=login('chenjing')))['items']
    assert pk in [str(i['id']) for i in cc_items]
    notes = ok(client.get('/sys/notifications', headers=login('chenjing'), params={'category': 3}))['items']
    assert any(pk in (n['link'] or '') for n in notes)
    # 发起人收到「已通过」
    notes = ok(client.get('/sys/notifications', headers=login('sunqiang'), params={'category': 3}))['items']
    assert any(pk in (n['link'] or '') and '已通过' in n['title'] for n in notes)


def test_dept_leader_skips_self_and_upper_level_is_skipped_when_empty(
    client: TestClient, login: Login, uid: Uid
) -> None:
    """刘洋自己就是后端组负责人：第 1 级往上找到张伟。5 天走「上级主管」，
    第 2 级要到总部 —— 总部没配负责人，onEmpty=skip，记一条跳过
    """
    pk = start(client, login('liuyang'), leave_form(uid, days=5))
    d = detail(client, login('liuyang'), pk)
    pending = [t for t in d['tasks'] if t['status'] == 'pending']
    assert [t['assignee_name'] for t in pending] == ['张伟']

    ok(act(client, login('zhangwei'), pk, 'approve'))
    d = detail(client, login('liuyang'), pk)
    branch = next(r for r in d['records'] if r['action'] == 'branch')
    assert branch['detail']['branch'] == 'b_long'
    assert any(r['action'] == 'skip' and r['node_id'] == 'n_upper' for r in d['records'])
    assert [t['assignee_name'] for t in d['tasks'] if t['status'] == 'pending'] == ['王芳']


def test_reject_needs_opinion_and_ends_instance(client: TestClient, login: Login, uid: Uid) -> None:
    pk = start(client, login('sunqiang'), leave_form(uid))
    resp = act(client, login('zhaolei'), pk, 'reject')
    assert resp.json()['code'] == 400
    assert detail(client, login('sunqiang'), pk)['instance']['status'] == 'running'

    ok(act(client, login('zhaolei'), pk, 'reject', opinion='项目上线期间'))
    d = detail(client, login('sunqiang'), pk)
    assert d['instance']['status'] == 'rejected'
    assert caps(d) == set()
    # 结束了还想再办：拒绝，并且记一条 rejected
    resp = act(client, login('zhaolei'), pk, 'approve')
    assert resp.json()['code'] == 409


def test_withdraw_notifies_those_who_already_approved(client: TestClient, login: Login, uid: Uid) -> None:
    pk = start(client, login('sunqiang'), leave_form(uid))
    ok(act(client, login('zhaolei'), pk, 'approve'))
    assert act(client, login('sunqiang'), pk, 'withdraw').json()['code'] == 400  # 原因必填
    ok(act(client, login('sunqiang'), pk, 'withdraw', opinion='不请了'))

    d = detail(client, login('sunqiang'), pk)
    assert d['instance']['status'] == 'withdrawn'
    assert not [t for t in d['tasks'] if t['status'] == 'pending']
    assert pk not in todo_ids(client, login('wangfang'))
    notes = ok(client.get('/sys/notifications', headers=login('zhaolei'), params={'category': 3}))['items']
    assert any(pk in (n['link'] or '') and '撤回' in n['title'] for n in notes)
    # 自己的动作不通知自己
    notes = ok(client.get('/sys/notifications', headers=login('sunqiang'), params={'category': 3}))['items']
    assert not any(pk in (n['link'] or '') and '撤回' in n['title'] for n in notes)


def test_transfer(client: TestClient, login: Login, uid: Uid) -> None:
    pk = start(client, login('sunqiang'), leave_form(uid))
    # 不能转给发起人
    resp = act(client, login('zhaolei'), pk, 'transfer', target_user_ids=[uid('sunqiang')])
    assert resp.json()['code'] == 409
    ok(act(client, login('zhaolei'), pk, 'transfer', target_user_ids=[uid('zhoumin')], opinion='我出差'))
    assert pk not in todo_ids(client, login('zhaolei'))
    assert pk in todo_ids(client, login('zhoumin'))
    d = detail(client, login('zhoumin'), pk)
    mine = next(t for t in d['tasks'] if t['status'] == 'pending')
    assert mine['origin_assignee_id'] == uid('zhaolei')


def test_remind_is_throttled(client: TestClient, login: Login, uid: Uid) -> None:
    pk = start(client, login('sunqiang'), leave_form(uid))
    ok(act(client, login('sunqiang'), pk, 'remind'))
    resp = act(client, login('sunqiang'), pk, 'remind')
    assert resp.json()['code'] == 409
    d = detail(client, login('sunqiang'), pk)
    assert {c['action']: c['enabled'] for c in d['capabilities']}['remind'] is False
    notes = ok(client.get('/sys/notifications', headers=login('zhaolei'), params={'category': 3}))['items']
    assert sum(1 for n in notes if pk in (n['link'] or '') and '催办' in n['title']) == 1


# ── 幂等 / 权限 / 校验 ───────────────────────────────────────────────────────


def test_same_key_is_replayed_not_applied_twice(client: TestClient, login: Login, uid: Uid) -> None:
    k = key()
    body = {'code': 'LEAVE', 'form': leave_form(uid), 'key': k}
    first = ok(client.post('/sys/workflow/instances', headers=login('sunqiang'), json=body))
    second = ok(client.post('/sys/workflow/instances', headers=login('sunqiang'), json=body))
    assert first['instance_id'] == second['instance_id']
    assert second['replayed'] is True

    pk = str(first['instance_id'])
    k = key()
    payload = {'action': 'approve', 'key': k}
    ok(client.post(f'/sys/workflow/instances/{pk}/actions', headers=login('zhaolei'), json=payload))
    again = ok(client.post(f'/sys/workflow/instances/{pk}/actions', headers=login('zhaolei'), json=payload))
    assert again['replayed'] is True
    d = detail(client, login('sunqiang'), pk)
    assert sum(1 for r in d['records'] if r['action'] == 'approve') == 1


def test_outsider_sees_404_and_cannot_act(client: TestClient, login: Login, uid: Uid) -> None:
    pk = start(client, login('sunqiang'), leave_form(uid, handover=None))
    resp = client.get(f'/sys/workflow/instances/{pk}', headers=login('liuyang'))
    assert resp.json()['code'] == 404
    resp = act(client, login('liuyang'), pk, 'approve')
    # 动作接口和详情同一个口径：看不见就是 404（原来是 409，等于告诉对方这个 ID 存在，见 test_review_round2）
    assert resp.json()['code'] == 404
    # 先断言「有」：真正的审批人看得到
    assert detail(client, login('zhaolei'), pk)['instance']['id']


def test_form_is_validated_on_server(client: TestClient, login: Login, uid: Uid) -> None:
    form = leave_form(uid)
    del form['f_reason']
    resp = client.post(
        '/sys/workflow/instances', headers=login('sunqiang'), json={'code': 'LEAVE', 'form': form, 'key': key()}
    )
    assert resp.json()['code'] == 400
    assert 'f_reason' in resp.json()['data']

    # 人员 ID 必须是字符串（硬纪律 6）
    form = leave_form(uid)
    form['f_handover'] = int(uid('chenjing'))
    resp = client.post(
        '/sys/workflow/instances', headers=login('sunqiang'), json={'code': 'LEAVE', 'form': form, 'key': key()}
    )
    assert resp.json()['code'] == 400
    assert 'f_handover' in resp.json()['data']

    form = leave_form(uid)
    form['f_range'] = ['2026-11-05', '2026-11-01']
    resp = client.post(
        '/sys/workflow/instances', headers=login('sunqiang'), json={'code': 'LEAVE', 'form': form, 'key': key()}
    )
    assert resp.json()['code'] == 400


def test_monitor_and_terminate_need_permission(
    client: TestClient, login: Login, token_headers: dict[str, str], uid: Uid
) -> None:
    pk = start(client, login('sunqiang'), leave_form(uid))
    assert client.get('/sys/workflow/monitor', headers=login('sunqiang')).json()['code'] == 403
    assert 'terminate' not in caps(detail(client, login('sunqiang'), pk))

    # admin 是超管：能看监控、能终止，即使他不是参与人
    items = ok(client.get('/sys/workflow/monitor', headers=token_headers, params={'status': 'running'}))['items']
    assert pk in [str(i['id']) for i in items]
    assert 'terminate' in caps(detail(client, token_headers, pk))
    ok(act(client, token_headers, pk, 'terminate', opinion='重复提交'))
    assert detail(client, login('sunqiang'), pk)['instance']['status'] == 'terminated'
    assert pk not in todo_ids(client, login('zhaolei'))


def test_counts(client: TestClient, login: Login, uid: Uid) -> None:
    before = ok(client.get('/sys/workflow/inbox/counts', headers=login('zhaolei')))['todo']
    start(client, login('sunqiang'), leave_form(uid))
    after = ok(client.get('/sys/workflow/inbox/counts', headers=login('zhaolei')))['todo']
    assert after == before + 1


def test_initiator_cannot_fill_fields_hidden_at_start(
    client: TestClient, login: Login, uid: Uid, token_headers: dict[str, str]
) -> None:
    """开始节点上 hidden 的字段：发起人传了也不收（不报错，直接不要），详情里也看不到"""
    form = leave_form(uid)
    form['f_hr_note'] = '我自己写的人事备注'
    pk = start(client, login('sunqiang'), form)
    full = detail(client, token_headers, pk)
    # 先断言「有」：管理员（看全部）那里这个字段在，只是没值 —— 发起人传的被丢掉了
    assert 'f_hr_note' in {f['id'] for f in full['form_schema']['fields']}
    assert 'f_hr_note' not in full['form_data']
    assert full['form_data']['f_reason'] == '家里有事'
    mine = detail(client, login('sunqiang'), pk)
    assert 'f_hr_note' not in {f['id'] for f in mine['form_schema']['fields']}


def test_on_empty_admin_goes_to_superuser_but_never_back_to_the_initiator(
    client: TestClient, login: Login, uid: Uid, token_headers: dict[str, str]
) -> None:
    """「请假」第一个节点是直属主管、找不到时转给管理员。

    回归：`superusers()` 原来写 `is_superuser.is_(True)`，SQL Server 上编译成 `IS 1` → 500。
    两个发起人各验一半：
    - 周敏在总部（没配负责人）→ 转给管理员 admin
    - admin 自己也在总部 → 找不到主管，也**不能**转回给他自己 → 没人可办，自动驳回
    """
    pk = start(client, login('zhoumin'), leave_form(uid))
    d = detail(client, token_headers, pk)
    # 按 ID 比，不按昵称：三个方言的种子里 admin 的昵称不一样（PG 那份叫「用户88888」）
    assert [t['assignee_id'] for t in d['tasks'] if t['status'] == 'pending'] == [uid('admin')]

    pk = start(client, token_headers, leave_form(uid))
    d = detail(client, token_headers, pk)
    assert d['instance']['status'] == 'rejected'
    assert not [t for t in d['tasks'] if t['assignee_id'] == d['instance']['initiator_id']]
    assert any(r['action'] == 'auto_reject' for r in d['records'])


def test_preview_matches_what_actually_happens(client: TestClient, login: Login, uid: Uid) -> None:
    """发起页的流程预告和真实推进必须一致（同一套规则，见 engine/simulate.py）。

    刘洋请 5 天：直属主管 = 张伟（刘洋自己是后端组负责人，往上找）→ 超过 3 天走上级主管 →
    第 2 级到总部、没负责人 → 跳过 → 人事备案（王芳）→ 抄送交接人（陈静）
    """
    form = leave_form(uid, days=5)
    prev = ok(client.post('/sys/workflow/startable/LEAVE/preview', headers=login('liuyang'), json={'form': form}))
    got = [(s['node_id'], s['outcome'], [u['name'] for u in s['users']]) for s in prev['steps']]
    assert got == [
        ('n_leader', 'ok', ['张伟']),
        ('n_upper', 'skip', []),
        ('n_hr', 'ok', ['王芳']),
        ('cc_handover', 'ok', ['陈静']),
    ]
    # 改成 2 天：条件分支跟着变，不再有「上级主管」
    form2 = leave_form(uid, days=2)
    prev2 = ok(client.post('/sys/workflow/startable/LEAVE/preview', headers=login('liuyang'), json={'form': form2}))
    assert [s['node_id'] for s in prev2['steps']] == ['n_leader', 'n_hr', 'cc_handover']

    # 真走一遍：每一步的办理人和预告一致
    pk = start(client, login('liuyang'), form)
    d = detail(client, login('liuyang'), pk)
    assert [(s['node_id'], [u['name'] for u in s['users']]) for s in d['forecast']] == [
        ('n_upper', []),
        ('n_hr', ['王芳']),
        ('cc_handover', ['陈静']),
    ]
    ok(act(client, login('zhangwei'), pk, 'approve'))
    d = detail(client, login('liuyang'), pk)
    assert [t['assignee_name'] for t in d['tasks'] if t['status'] == 'pending'] == ['王芳']
    assert [s['node_id'] for s in d['forecast']] == ['cc_handover']
