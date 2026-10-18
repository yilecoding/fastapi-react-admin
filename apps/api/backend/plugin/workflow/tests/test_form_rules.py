"""表单联动：自动计算 · 显示条件"""

from collections.abc import Callable
from typing import Any

import pytest

from starlette.testclient import TestClient

from backend.plugin.workflow.engine.flow import validate_publish
from backend.plugin.workflow.engine.form import FormDataError, form_rules, validate_form_data
from backend.plugin.workflow.tests.conftest import key, ok
from backend.plugin.workflow.tests.test_review_fixes import _approval, _model, _publish

Login = Callable[[str], dict[str, str]]
Uid = Callable[[str], str]

LEAVE_LIKE = {
    'schemaVersion': 1,
    'fields': [
        {'id': 'f_range', 'type': 'daterange', 'label': '时间', 'required': True},
        {'id': 'f_days', 'type': 'number', 'label': '天数', 'calc': {'kind': 'days', 'field': 'f_range'}},
        {
            'id': 'f_proof',
            'type': 'text',
            'label': '证明',
            'required': True,
            'visibleWhen': {'all': [{'var': 'f_days', 'op': 'gt', 'value': 3}]},
        },
    ],
}


def _flow(uid: Uid) -> dict[str, Any]:
    return _model({
        'type': 'condition',
        'id': 'c1',
        'name': 'c',
        'next': None,
        'branches': [
            {
                'id': 'b_long',
                'name': '超过 3 天',
                'when': {'all': [{'var': 'f_days', 'op': 'gt', 'value': 3}]},
                'child': _approval('n_long', {'kind': 'user', 'user_ids': [uid('zhaolei')]}),
            },
            {
                'id': 'b_def',
                'name': '其他',
                'default': True,
                'child': _approval('n_short', {'kind': 'user', 'user_ids': [uid('zhoumin')]}),
            },
        ],
    })


def _start(client: TestClient, login: Login, form: dict[str, Any]) -> Any:
    return client.post(
        '/sys/workflow/instances', headers=login('sunqiang'), json={'code': 'PYTEST_RULES', 'form': form, 'key': key()}
    )


def test_days_are_computed_server_side_and_drive_branches_and_visibility(
    client: TestClient, token_headers: dict[str, str], login: Login, uid: Uid
) -> None:
    _publish(client, token_headers, 'PYTEST_RULES', LEAVE_LIKE, _flow(uid))
    long_range = ['2026-11-02', '2026-11-06']

    # 填的天数不算数（1 天），按区间算是 5 天 → 证明变成必填
    resp = _start(client, login, {'f_range': long_range, 'f_days': 1})
    assert resp.json()['code'] == 400 and 'f_proof' in (resp.json()['data'] or {}), resp.text
    # 试算也按算出来的天数走：没传天数照样走「超过 3 天」
    steps = ok(
        client.post(
            '/sys/workflow/startable/PYTEST_RULES/preview',
            headers=login('sunqiang'),
            json={'form': {'f_range': long_range}},
        )
    )['steps']
    assert [s['node_id'] for s in steps] == ['n_long']

    pk = ok(_start(client, login, {'f_range': long_range, 'f_days': 1, 'f_proof': '病历'}))['instance_id']
    d = ok(client.get(f'/sys/workflow/instances/{pk}', headers=login('sunqiang')))
    assert d['form_data']['f_days'] == 5 and d['form_data']['f_proof'] == '病历'
    assert d['instance']['current_node_id'] == 'n_long'

    # 1 天：证明不显示 —— 不必填，填了也不存
    pk = ok(_start(client, login, {'f_range': ['2026-11-02', '2026-11-02'], 'f_proof': '多余的'}))['instance_id']
    d = ok(client.get(f'/sys/workflow/instances/{pk}', headers=login('sunqiang')))
    assert d['form_data'] == {'f_range': ['2026-11-02', '2026-11-02'], 'f_days': 1}
    assert d['instance']['current_node_id'] == 'n_short'


def test_approver_edit_recomputes_rules_over_the_whole_form() -> None:
    """审批人只能改「时间」，但天数和「证明」显不显示要跟着整份数据重算"""
    form = {**LEAVE_LIKE, 'fields': [{'id': 'f_reason', 'type': 'text', 'label': '事由'}, *LEAVE_LIKE['fields']]}
    before = {'f_reason': '回老家', 'f_range': ['2026-11-02', '2026-11-06'], 'f_days': 5, 'f_proof': '病历'}
    out = validate_form_data(form, {**before, 'f_range': ['2026-11-02', '2026-11-03']}, only={'f_range'}, base=before)
    # 别人填的「事由」原样留着；天数重算；证明不再显示 → 去掉
    assert out == {'f_reason': '回老家', 'f_range': ['2026-11-02', '2026-11-03'], 'f_days': 2}
    # 反过来改长了：证明变成必填，而它不归这个审批人填 —— 不挡他（不在 only 里）
    short = {'f_range': ['2026-11-02', '2026-11-02'], 'f_days': 1}
    out = validate_form_data(
        LEAVE_LIKE, {**short, 'f_range': ['2026-11-02', '2026-11-09']}, only={'f_range'}, base=short
    )
    assert out['f_days'] == 8 and 'f_proof' not in out
    # 归他填的话就要填
    with pytest.raises(FormDataError) as e:
        validate_form_data(
            LEAVE_LIKE, {**short, 'f_range': ['2026-11-02', '2026-11-09']}, only={'f_range', 'f_proof'}, base=short
        )
    assert 'f_proof' in e.value.errors


def test_sum_of_a_table_column() -> None:
    form = {
        'schemaVersion': 1,
        'fields': [
            {
                'id': 't',
                'type': 'table',
                'label': '明细',
                'columns': [
                    {'id': 'amt', 'type': 'amount', 'label': '金额'},
                    {'id': 'n', 'type': 'number', 'label': '数量'},
                ],
            },
            {'id': 'total', 'type': 'amount', 'label': '合计', 'calc': {'kind': 'sum', 'field': 't', 'column': 'amt'}},
            {'id': 'qty', 'type': 'number', 'label': '总数', 'calc': {'kind': 'sum', 'field': 't', 'column': 'n'}},
        ],
    }
    out = validate_form_data(form, {'t': [{'amt': '10.2', 'n': 2}, {'amt': '20.3'}, {'n': 1}], 'total': '1'})
    assert out['total'] == '30.50' and out['qty'] == 3
    # 没有行：不给值（而不是 0）
    assert 'total' not in validate_form_data(form, {'t': []})
    # 试算吃没校验的数据：算不出来就当没有，不抛
    assert form_rules(form, {'t': [{'amt': 'abc'}]})[0].get('total') is None


def _issues(form: dict[str, Any], model: dict[str, Any]) -> set[str]:
    return {i['code'] for i in validate_publish(form, model) if i['level'] == 'ERROR'}


def test_publish_rejects_rules_that_cannot_work() -> None:
    model = {
        'schemaVersion': 1,
        'root': {
            'type': 'start',
            'id': 'start',
            'next': {
                'type': 'approval',
                'id': 'n1',
                'name': 'n1',
                'assignee': {'kind': 'initiator'},
                'onEmpty': 'skip',
                'fieldPerms': {'secret': 'hidden'},
                'next': None,
            },
        },
    }
    base = [{'id': 'secret', 'type': 'number', 'label': '薪资'}, {'id': 'r', 'type': 'daterange', 'label': '区间'}]

    def form(*extra: dict[str, Any]) -> dict[str, Any]:
        return {'schemaVersion': 1, 'fields': [*base, *extra]}

    assert _issues(form(), model) == set()
    # 显示条件引用后面的字段（会互相依赖）
    later = form(
        {'id': 'a', 'type': 'text', 'label': 'a', 'visibleWhen': {'all': [{'var': 'b', 'op': 'empty'}]}},
        {'id': 'b', 'type': 'text', 'label': 'b'},
    )
    assert 'VISIBLE_WHEN_ORDER' in _issues(later, model)
    # 引用对审批人隐藏的字段：看得到「出没出现」就推得出它的值
    leak = form({
        'id': 'a',
        'type': 'text',
        'label': 'a',
        'visibleWhen': {'all': [{'var': 'secret', 'op': 'gt', 'value': 1}]},
    })
    assert 'VISIBLE_WHEN_HIDDEN' in _issues(leak, model)
    # 天数要从日期区间算、自己得是数字
    assert 'CALC_SOURCE' in _issues(
        form({'id': 'd', 'type': 'number', 'label': 'd', 'calc': {'kind': 'days', 'field': 'secret'}}), model
    )
    assert 'CALC_TYPE' in _issues(
        form({'id': 'd', 'type': 'text', 'label': 'd', 'calc': {'kind': 'days', 'field': 'r'}}), model
    )
    assert (
        _issues(form({'id': 'd', 'type': 'number', 'label': 'd', 'calc': {'kind': 'days', 'field': 'r'}}), model)
        == set()
    )


def test_publish_rejects_duplicate_option_values() -> None:
    model = {'schemaVersion': 1, 'root': {'type': 'start', 'id': 'start', 'next': None}}
    opts = [{'label': '甲', 'value': 'opt1'}, {'label': '乙', 'value': 'opt1'}]
    form = {'schemaVersion': 1, 'fields': [{'id': 's', 'type': 'select', 'label': '类型', 'options': opts}]}
    assert 'FIELD_OPTION_DUPLICATE' in _issues(form, model)
    table = {
        'schemaVersion': 1,
        'fields': [
            {
                'id': 't',
                'type': 'table',
                'label': '明细',
                'columns': [
                    {'id': 'c', 'type': 'select', 'label': '列', 'options': opts},
                ],
            }
        ],
    }
    assert 'FIELD_OPTION_DUPLICATE' in _issues(table, model)
    ok_form = {'schemaVersion': 1, 'fields': [{'id': 's', 'type': 'select', 'label': '类型', 'options': opts[:1]}]}
    assert 'FIELD_OPTION_DUPLICATE' not in _issues(ok_form, model)
