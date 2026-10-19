"""流程定义：草稿 / 发布校验 / 版本 / 快照隔离"""

import copy

from collections.abc import Callable
from typing import Any

from starlette.testclient import TestClient

from backend.plugin.workflow.tests.conftest import key, ok

FORM = {
    'schemaVersion': 1,
    'fields': [
        {'id': 'f_amount', 'type': 'amount', 'label': '金额', 'required': True},
        {'id': 'f_note', 'type': 'text', 'label': '说明'},
    ],
}


def model(approver_ids: list[str], *, cond: bool = True) -> dict[str, Any]:
    approval = {
        'type': 'approval',
        'id': 'n1',
        'name': '审批',
        'mode': 'any',
        'assignee': {'kind': 'user', 'user_ids': approver_ids},
        'onEmpty': 'reject',
        'next': None,
    }
    if not cond:
        return {'schemaVersion': 1, 'root': {'type': 'start', 'id': 'start', 'next': approval}}
    return {
        'schemaVersion': 1,
        'root': {
            'type': 'start',
            'id': 'start',
            'next': {
                'type': 'condition',
                'id': 'c1',
                'name': '金额',
                'branches': [
                    {
                        'id': 'b_big',
                        'name': '大额',
                        'when': {'all': [{'var': 'f_amount', 'op': 'gte', 'value': '10000'}]},
                        'child': approval,
                    },
                    {'id': 'b_def', 'name': '其他', 'default': True, 'child': None},
                ],
                'next': None,
            },
        },
    }


def test_publish_rejects_errors_and_points_at_the_node(
    client: TestClient, token_headers: dict[str, str], uid: Callable[[str], str]
) -> None:
    bad = model([uid('zhaolei')])
    bad['root']['next']['branches'][1]['default'] = False  # 没有兜底分支
    bad['root']['next']['branches'][0]['when']['all'][0]['var'] = 'f_nope'  # 不存在的字段
    pk = ok(
        client.post(
            '/sys/workflow/definitions',
            headers=token_headers,
            json={'code': 'PYTEST_BAD', 'name': '坏流程', 'form': FORM, 'model': bad},
        )
    )['id']
    res = ok(client.post(f'/sys/workflow/definitions/{pk}/publish', headers=token_headers))
    assert res['published'] is False
    codes = {(i['code'], i.get('nodeId'), i.get('fieldId')) for i in res['issues'] if i['level'] == 'ERROR'}
    assert ('CONDITION_NO_DEFAULT', 'c1', None) in codes
    assert ('CONDITION_VAR_UNKNOWN', 'c1', 'f_nope') in codes
    # 没发布的定义不能发起
    resp = client.post(
        '/sys/workflow/instances', headers=token_headers, json={'code': 'PYTEST_BAD', 'form': {}, 'key': key()}
    )
    assert resp.json()['code'] == 404


def test_shape_error_is_one_issue_not_a_500(client: TestClient, token_headers: dict[str, str]) -> None:
    pk = ok(
        client.post(
            '/sys/workflow/definitions',
            headers=token_headers,
            json={'code': 'PYTEST_SHAPE', 'name': '形状错', 'form': FORM, 'model': {'root': {'type': 'oops'}}},
        )
    )['id']
    res = ok(client.post(f'/sys/workflow/definitions/{pk}/validate', headers=token_headers))
    assert [i['code'] for i in res['issues']] == ['SCHEMA_INVALID']


def test_running_instance_keeps_its_snapshot(
    client: TestClient,
    token_headers: dict[str, str],
    login: Callable[[str], dict[str, str]],
    uid: Callable[[str], str],
) -> None:
    """改了定义、发了 v2，在途实例照样按 v1 走（金额条件分支 + 金额归一成十进制字符串）"""
    m1 = model([uid('zhaolei')])
    pk = ok(
        client.post(
            '/sys/workflow/definitions',
            headers=token_headers,
            json={'code': 'PYTEST_SNAP', 'name': '快照', 'form': FORM, 'model': m1},
        )
    )['id']
    v1 = ok(client.post(f'/sys/workflow/definitions/{pk}/publish', headers=token_headers))
    assert v1['published'] is True and v1['version']['version_no'] == 1

    started = ok(
        client.post(
            '/sys/workflow/instances',
            headers=login('sunqiang'),
            json={'code': 'PYTEST_SNAP', 'form': {'f_amount': '12000.5'}, 'key': key()},
        )
    )
    inst = str(started['instance_id'])

    # 小额走兜底分支、没有审批节点 → 发起即通过
    small = ok(
        client.post(
            '/sys/workflow/instances',
            headers=login('sunqiang'),
            json={'code': 'PYTEST_SNAP', 'form': {'f_amount': '99'}, 'key': key()},
        )
    )
    d_small = ok(client.get(f'/sys/workflow/instances/{small["instance_id"]}', headers=login('sunqiang')))
    assert d_small['instance']['status'] == 'approved'

    m2 = copy.deepcopy(m1)
    m2['root']['next']['branches'][0]['child']['assignee']['user_ids'] = [uid('zhoumin')]
    ok(client.put(f'/sys/workflow/definitions/{pk}', headers=token_headers, json={'model': m2}))
    v2 = ok(client.post(f'/sys/workflow/definitions/{pk}/publish', headers=token_headers))
    assert v2['version']['version_no'] == 2
    versions = ok(client.get(f'/sys/workflow/definitions/{pk}/versions', headers=token_headers))
    assert [v['version_no'] for v in versions] == [2, 1]
    # 没改动再点一次发布：不出新版本
    again = ok(client.post(f'/sys/workflow/definitions/{pk}/publish', headers=token_headers))
    assert again['published'] is True and again['new_version'] is False
    assert again['version']['version_no'] == 2
    assert len(ok(client.get(f'/sys/workflow/definitions/{pk}/versions', headers=token_headers))) == 2

    d = ok(client.get(f'/sys/workflow/instances/{inst}', headers=login('sunqiang')))
    assert [t['assignee_name'] for t in d['tasks']] == ['赵磊']
    assert d['form_data']['f_amount'] == '12000.50'

    # 停用之后不能再发起，但在途的照样能办完
    ok(client.put(f'/sys/workflow/definitions/{pk}/status', headers=token_headers, json={'enabled': False}))
    resp = client.post(
        '/sys/workflow/instances',
        headers=login('sunqiang'),
        json={'code': 'PYTEST_SNAP', 'form': {'f_amount': '1'}, 'key': key()},
    )
    assert resp.json()['code'] == 404
    ok(
        client.post(
            f'/sys/workflow/instances/{inst}/actions',
            headers=login('zhaolei'),
            json={'action': 'approve', 'key': key()},
        )
    )
    assert (
        ok(client.get(f'/sys/workflow/instances/{inst}', headers=login('sunqiang')))['instance']['status'] == 'approved'
    )

    # 有过实例的定义不让删
    assert client.delete(f'/sys/workflow/definitions/{pk}', headers=token_headers).json()['code'] == 409


def test_definition_admin_needs_permission(client: TestClient, login: Callable[[str], dict[str, str]]) -> None:
    assert client.get('/sys/workflow/definitions', headers=login('sunqiang')).json()['code'] == 403
    # 发起页不要权限码
    startable = ok(client.get('/sys/workflow/startable', headers=login('sunqiang')))
    assert 'LEAVE' in [d['code'] for d in startable]
    form = ok(client.get('/sys/workflow/startable/LEAVE', headers=login('sunqiang')))
    assert form['form']['fields'][0]['id'] == 'f_type'


def test_directory_is_open_to_any_logged_in_user(
    client: TestClient, login: Callable[[str], dict[str, str]], uid: Callable[[str], str]
) -> None:
    """普通员工调不了 `/sys/users`，但审批里要选人 —— 通讯录只给最小字段"""
    assert client.get('/sys/users', headers=login('sunqiang')).json()['code'] == 403
    rows = ok(client.get('/sys/workflow/directory/users', headers=login('sunqiang'), params={'keyword': '赵'}))
    assert [r['nickname'] for r in rows] == ['赵磊']
    assert set(rows[0]) == {'id', 'nickname', 'username', 'dept_name'}
    rows = ok(
        client.get(
            '/sys/workflow/directory/users',
            headers=login('sunqiang'),
            params={'ids': f'{uid("zhaolei")},{uid("chenjing")}'},
        )
    )
    assert {r['nickname'] for r in rows} == {'赵磊', '陈静'}
    depts = ok(client.get('/sys/workflow/directory/depts', headers=login('sunqiang')))
    assert {'总部', '技术中心'} <= {d['name'] for d in depts}


def test_required_editable_field_must_be_filled_before_approving(
    client: TestClient,
    token_headers: dict[str, str],
    login: Callable[[str], dict[str, str]],
    uid: Callable[[str], str],
) -> None:
    """审批节点上「可编辑 + 必填」的字段：发起人不填（开始节点 hidden），审批人不填就不许同意"""
    form = {
        'schemaVersion': 1,
        'fields': [
            {'id': 'f_what', 'type': 'text', 'label': '事项', 'required': True},
            {'id': 'f_no', 'type': 'text', 'label': '登记号', 'required': True},
        ],
    }
    model = {
        'schemaVersion': 1,
        'root': {
            'type': 'start',
            'id': 'start',
            'fieldPerms': {'f_no': 'hidden'},
            'next': {
                'type': 'approval',
                'id': 'n1',
                'name': '登记',
                'mode': 'any',
                'assignee': {'kind': 'user', 'user_ids': [uid('wangfang')]},
                'onEmpty': 'reject',
                'fieldPerms': {'f_no': 'editable'},
                'next': None,
            },
        },
    }
    pk = ok(
        client.post(
            '/sys/workflow/definitions',
            headers=token_headers,
            json={'code': 'PYTEST_REQ', 'name': '登记', 'form': form, 'model': model},
        )
    )['id']
    assert ok(client.post(f'/sys/workflow/definitions/{pk}/publish', headers=token_headers))['published']
    # 发起时不用填 f_no（开始节点 hidden），也不会因为它必填被挡
    inst = ok(
        client.post(
            '/sys/workflow/instances',
            headers=login('sunqiang'),
            json={'code': 'PYTEST_REQ', 'form': {'f_what': '入职'}, 'key': key()},
        )
    )['instance_id']
    url = f'/sys/workflow/instances/{inst}/actions'
    resp = client.post(url, headers=login('wangfang'), json={'action': 'approve', 'key': key()})
    assert resp.json()['code'] == 400
    assert 'f_no' in resp.json()['data']
    ok(client.post(url, headers=login('wangfang'), json={'action': 'approve', 'key': key(), 'form': {'f_no': 'A-01'}}))
    d = ok(client.get(f'/sys/workflow/instances/{inst}', headers=token_headers))
    assert d['instance']['status'] == 'approved'
    assert d['form_data'] == {'f_what': '入职', 'f_no': 'A-01'}
