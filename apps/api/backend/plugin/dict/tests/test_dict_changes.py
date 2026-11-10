"""#281：字典类型 · 字典项进数据变更记录。

字典项单独算一类对象，所属类型按引用存当时的类型名；`type_code` 是冗余副本，不另记。
"""

import uuid

from collections.abc import Iterator

import pytest
import sqlalchemy as sa

from starlette.testclient import TestClient

from backend.plugin.dict.model import DictData, DictType
from backend.tests.utils.data_change import changes_of, engine, field

_RUN = uuid.uuid4().hex[:8]
TYPES = '/sys/dict-types'
DATAS = '/sys/dict-datas'


@pytest.fixture(autouse=True)
def _purge() -> Iterator[None]:
    yield
    # 接口的删除是逻辑删除：硬删本文件建的行（审计记录不删，见 `tests/utils/data_change.py`）
    with engine().begin() as conn:
        conn.execute(sa.delete(DictData.__table__).where(DictData.__table__.c.type_code == f'dc{_RUN}'))
        conn.execute(sa.delete(DictType.__table__).where(DictType.__table__.c.code == f'dc{_RUN}'))


def test_type_and_item_changes_are_recorded(client: TestClient, token_headers: dict[str, str]) -> None:
    code = f'dc{_RUN}'
    assert client.post(TYPES, headers=token_headers, json={'name': f'审计{_RUN}', 'code': code}).json()['code'] == 200
    type_id = client.get(TYPES, headers=token_headers, params={'code': code}).json()['data']['items'][0]['id']
    item = {'type_id': type_id, 'label': '待处理', 'value': '1', 'sort': 0, 'status': 1}
    assert client.post(DATAS, headers=token_headers, json=item).json()['code'] == 200
    with engine().connect() as conn:
        table = DictData.__table__
        data_id = conn.execute(sa.select(table.c.id).where(table.c.type_code == code)).scalar_one()

    edited = {**item, 'label': '处理中', 'status': 0}
    assert client.put(f'{DATAS}/{data_id}', headers=token_headers, json=edited).json()['code'] == 200
    renamed = {'name': f'审计改名{_RUN}', 'code': code}
    assert client.put(f'{TYPES}/{type_id}', headers=token_headers, json=renamed).json()['code'] == 200
    assert client.request('DELETE', DATAS, headers=token_headers, json={'pks': [data_id]}).json()['code'] == 200
    assert client.request('DELETE', TYPES, headers=token_headers, json={'pks': [type_id]}).json()['code'] == 200

    items = changes_of('dict_data', data_id)
    assert [r['action'] for r in items] == ['create', 'update', 'delete']
    created, edit, _ = items
    assert field(created, 'type_id')['new_label'] == f'审计{_RUN}', '所属类型存当时的名字'
    assert field(created, 'type_code') is None, '类型编码是冗余副本，不另记'
    assert field(edit, 'label') == {'field': 'label', 'label': '标签', 'old': '待处理', 'new': '处理中'}
    assert field(edit, 'status')['new_label'] == '停用'

    types = changes_of('dict_type', type_id)
    assert [r['action'] for r in types] == ['create', 'update', 'delete']
    assert field(types[1], 'name')['new'] == f'审计改名{_RUN}'
