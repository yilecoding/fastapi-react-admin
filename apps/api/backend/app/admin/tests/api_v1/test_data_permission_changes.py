"""#281：数据权限进数据变更记录。

范围只是一捆规则的名字：范围名下记「名称 / 状态」和挂了哪些规则（集合字段，+ / −）；规则自己的改动记在规则名下 ——
改一条规则会影响所有挂着它的范围，看范围的记录看不出来，要去规则那边看。
"""

import uuid

from collections.abc import Iterator

import pytest
import sqlalchemy as sa

from starlette.testclient import TestClient

from backend.app.admin.model import DataRule, DataScope
from backend.app.admin.model.m2m import data_scope_rule
from backend.tests.utils.data_change import changes_of, engine, field

_RUN = uuid.uuid4().hex[:8].upper()
SCOPES = '/sys/data-scopes'
RULES = '/sys/data-rules'


def _id_of(model: type, name: str) -> int:
    table = model.__table__
    with engine().connect() as conn:
        return conn.execute(sa.select(table.c.id).where(table.c.name == name, table.c.deleted == 0)).scalar_one()


@pytest.fixture(autouse=True)
def _purge() -> Iterator[None]:
    yield
    # 接口的删除是逻辑删除：硬删本文件建的行（审计记录不删，见 `tests/utils/data_change.py`）
    with engine().begin() as conn:
        scope_ids = sa.select(DataScope.__table__.c.id).where(DataScope.__table__.c.name.like(f'DCP{_RUN}%'))
        conn.execute(sa.delete(data_scope_rule).where(data_scope_rule.c.data_scope_id.in_(scope_ids)))
        conn.execute(sa.delete(DataScope.__table__).where(DataScope.__table__.c.name.like(f'DCP{_RUN}%')))
        conn.execute(sa.delete(DataRule.__table__).where(DataRule.__table__.c.name.like(f'DCP{_RUN}%')))


def test_scope_and_rule_changes_are_recorded(client: TestClient, token_headers: dict[str, str]) -> None:
    rule_body = {
        'name': f'DCP{_RUN}-规则',
        'model': 'Dept',
        'column': 'code',
        'operator': 0,
        'expression': 0,
        'value': f'DCP{_RUN}',
    }
    assert client.post(RULES, headers=token_headers, json=rule_body).json()['code'] == 200
    rule = _id_of(DataRule, rule_body['name'])
    assert (
        client.post(SCOPES, headers=token_headers, json={'name': f'DCP{_RUN}-范围', 'status': 1}).json()['code'] == 200
    )
    scope = _id_of(DataScope, f'DCP{_RUN}-范围')

    def bind(rules: list[int]) -> None:
        res = client.put(f'{SCOPES}/{scope}/rules', headers=token_headers, json={'rules': rules})
        assert res.json()['code'] == 200, res.text

    bind([rule])
    edited_rule = {**rule_body, 'expression': 1}
    assert client.put(f'{RULES}/{rule}', headers=token_headers, json=edited_rule).json()['code'] == 200
    renamed = {'name': f'DCP{_RUN}-范围改名', 'status': 0}
    assert client.put(f'{SCOPES}/{scope}', headers=token_headers, json=renamed).json()['code'] == 200
    bind([])
    assert client.request('DELETE', RULES, headers=token_headers, json={'pks': [rule]}).json()['code'] == 200
    assert client.request('DELETE', SCOPES, headers=token_headers, json={'pks': [scope]}).json()['code'] == 200

    scope_records = changes_of('data_scope', scope)
    assert [r['action'] for r in scope_records] == ['create', 'update', 'update', 'update', 'delete']
    _, bound, edited, unbound, _ = scope_records
    assert field(bound, 'rules')['added'] == [{'id': str(rule), 'label': rule_body['name']}]
    assert field(edited, 'name')['new'] == f'DCP{_RUN}-范围改名'
    assert field(edited, 'status')['new_label'] == '停用'
    assert field(unbound, 'rules')['removed'] == [{'id': str(rule), 'label': rule_body['name']}]

    rule_records = changes_of('data_rule', rule)
    assert [r['action'] for r in rule_records] == ['create', 'update', 'delete']
    assert field(rule_records[1], 'expression') == {
        'field': 'expression',
        'label': '表达式',
        'old': 0,
        'new': 1,
        'old_label': '等于 ==',
        'new_label': '不等于 !=',
    }
