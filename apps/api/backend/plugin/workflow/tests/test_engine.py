"""纯函数：条件求值 / 树导航 / 表单校验 / 字段权限（不碰数据库）"""

import pytest

from backend.plugin.workflow.engine.flow import evaluate, index_nodes, pick_branch
from backend.plugin.workflow.engine.form import FormDataError, hidden_fields_for, validate_form_data


def test_condition_operators() -> None:
    v = {'amount': '12000.50', 'n': 3, 'tags': ['a', 'b'], 'kind': 'x', 'empty': ''}
    assert evaluate({'var': 'amount', 'op': 'gte', 'value': 10000}, v)
    assert not evaluate({'var': 'amount', 'op': 'lt', 'value': '10000'}, v)
    assert evaluate({'var': 'n', 'op': 'eq', 'value': '3'}, v)
    assert evaluate({'var': 'tags', 'op': 'contains', 'value': 'b'}, v)
    assert evaluate({'var': 'kind', 'op': 'in', 'value': ['x', 'y']}, v)
    assert evaluate({'var': 'kind', 'op': 'not_in', 'value': ['y']}, v)
    assert evaluate({'var': 'empty', 'op': 'empty'}, v)
    assert evaluate({'var': 'missing', 'op': 'empty'}, v)
    # 取不到的变量：除了 empty 之外都不成立，不抛异常
    assert not evaluate({'var': 'missing', 'op': 'gt', 'value': 1}, v)
    assert not evaluate({'var': 'missing', 'op': 'ne', 'value': 1}, v)
    # 类型对不上的大小比较不成立（字符串和数字不比大小）
    assert not evaluate({'var': 'kind', 'op': 'gt', 'value': 1}, v)
    assert evaluate(
        {
            'all': [
                {'var': 'n', 'op': 'gt', 'value': 1},
                {'any': [{'var': 'kind', 'op': 'eq', 'value': 'z'}, {'var': 'kind', 'op': 'eq', 'value': 'x'}]},
            ]
        },
        v,
    )


def test_branch_child_continues_after_condition() -> None:
    """分支子树最后一个节点的 next 是 null，但它走完是回到条件节点的出口，不是结束"""
    tail = {'type': 'cc', 'id': 'tail', 'targets': [], 'next': None}
    model = {
        'root': {
            'type': 'start',
            'id': 'start',
            'next': {
                'type': 'condition',
                'id': 'c',
                'branches': [
                    {
                        'id': 'b1',
                        'name': 'a',
                        'when': {'var': 'x', 'op': 'eq', 'value': 1},
                        'child': {'type': 'approval', 'id': 'in_branch', 'name': 'x', 'next': None},
                    },
                    {'id': 'b2', 'name': 'd', 'default': True, 'child': None},
                ],
                'next': tail,
            },
        }
    }
    nodes = index_nodes(model)
    assert nodes['in_branch'].after is tail
    assert nodes['c'].after is tail
    assert nodes['tail'].after is None
    assert pick_branch(nodes['c'].node, {'x': 1})['id'] == 'b1'
    assert pick_branch(nodes['c'].node, {'x': 2})['id'] == 'b2'


FORM = {
    'fields': [
        {'id': 'a', 'type': 'amount', 'label': '金额', 'required': True, 'precision': 2},
        {'id': 'u', 'type': 'user', 'label': '人'},
        {'id': 'm', 'type': 'multiselect', 'label': '多选', 'options': [{'label': 'A', 'value': 'a'}]},
        {
            'id': 't',
            'type': 'table',
            'label': '明细',
            'columns': [{'id': 'x', 'type': 'number', 'label': 'X', 'required': True}],
        },
        {'id': 'd', 'type': 'description', 'label': '说明', 'content': '只是文字'},
    ]
}


def test_form_validation_normalizes_and_rejects() -> None:
    out = validate_form_data(
        FORM, {'a': 1.1, 'u': '2049946297615646720', 'm': ['a', 'a'], 't': [{'x': 1, 'junk': 2}], 'zz': 1}
    )
    assert out == {'a': '1.10', 'u': '2049946297615646720', 'm': ['a'], 't': [{'x': 1}]}

    with pytest.raises(FormDataError) as e:
        validate_form_data(FORM, {'u': 2049946297615646720, 'm': ['b'], 't': [{}]})
    assert set(e.value.errors) == {'a', 'u', 'm', 't'}


def test_hidden_fields() -> None:
    schema = {'fields': [{'id': 'x', 'type': 'text', 'label': 'x'}, {'id': 'y', 'type': 'text', 'label': 'y'}]}
    n1 = {'id': 'n1', 'fieldPerms': {'y': 'hidden'}}
    n2 = {'id': 'n2', 'fieldPerms': {'y': 'editable'}}
    assert hidden_fields_for(schema, [n1, n2], see_all=True, participant_nodes=[]) == set()
    assert hidden_fields_for(schema, [n1, n2], see_all=False, participant_nodes=[n1]) == {'y'}
    assert hidden_fields_for(schema, [n1, n2], see_all=False, participant_nodes=[n1, n2]) == set()
    # 抄送人（没当过审批人）：任何节点藏了就看不到
    assert hidden_fields_for(schema, [n1, n2], see_all=False, participant_nodes=[]) == {'y'}
