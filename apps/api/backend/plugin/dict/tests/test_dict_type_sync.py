"""#395 ③：字典类型改编码 / 删除，要把冗余的 `sys_dict_data.type_code` 和 `fba:cache:dict` 一起带上。

修复前（实测，都是 HTTP 200）：
- 改编码：数据项的 `type_code` 还是旧的 —— 新编码查不到（404），旧编码的缓存继续返回两小时；
  之后再建一个复用旧编码的类型，会「继承」那批孤儿项
- 删类型：数据项跟着软删了，但下拉（`/type-codes/{code}`）继续从缓存返回已删的选项
"""

import uuid

from collections.abc import Iterator

import pytest
import sqlalchemy as sa

from starlette.testclient import TestClient

from backend.plugin.dict.model import DictData, DictType
from backend.tests.utils.data_change import engine

_RUN = uuid.uuid4().hex[:8]
TYPES = '/sys/dict-types'
DATAS = '/sys/dict-datas'
OLD = f'sy{_RUN}'
NEW = f'sn{_RUN}'


@pytest.fixture(autouse=True)
def _purge() -> Iterator[None]:
    yield
    with engine().begin() as conn:
        data, types = DictData.__table__, DictType.__table__
        conn.execute(sa.delete(data).where(data.c.type_code.in_([OLD, NEW])))
        conn.execute(sa.delete(types).where(types.c.code.in_([OLD, NEW])))


def _seed(client: TestClient, headers: dict[str, str]) -> str:
    assert client.post(TYPES, headers=headers, json={'name': f'同步{_RUN}', 'code': OLD}).json()['code'] == 200
    type_id = client.get(TYPES, headers=headers, params={'code': OLD}).json()['data']['items'][0]['id']
    item = {'type_id': type_id, 'label': '选项一', 'value': '1', 'sort': 0, 'status': 1}
    assert client.post(DATAS, headers=headers, json=item).json()['code'] == 200
    # 焐热缓存：先断言「有」，否则「被清掉」和「本来就没缓存」分不开
    warm = client.get(f'{DATAS}/type-codes/{OLD}', headers=headers).json()
    assert [d['label'] for d in warm['data']] == ['选项一']
    return type_id


def test_renaming_the_code_moves_the_items_and_drops_the_old_cache(
    client: TestClient, token_headers: dict[str, str]
) -> None:
    type_id = _seed(client, token_headers)

    body = {'name': f'同步{_RUN}', 'code': NEW}
    assert client.put(f'{TYPES}/{type_id}', headers=token_headers, json=body).json()['code'] == 200

    renamed = client.get(f'{DATAS}/type-codes/{NEW}', headers=token_headers).json()
    assert renamed['code'] == 200, renamed
    assert [d['label'] for d in renamed['data']] == ['选项一'], '数据项跟着类型走到新编码下'
    assert [d['type_code'] for d in renamed['data']] == [NEW]

    stale = client.get(f'{DATAS}/type-codes/{OLD}', headers=token_headers)
    assert stale.json()['code'] == 404, '旧编码不能再从缓存里返回'


def test_a_new_type_reusing_the_old_code_does_not_inherit_items(
    client: TestClient, token_headers: dict[str, str]
) -> None:
    type_id = _seed(client, token_headers)
    body = {'name': f'同步{_RUN}', 'code': NEW}
    assert client.put(f'{TYPES}/{type_id}', headers=token_headers, json=body).json()['code'] == 200

    assert client.post(TYPES, headers=token_headers, json={'name': f'复用{_RUN}', 'code': OLD}).json()['code'] == 200
    inherited = client.get(f'{DATAS}/type-codes/{OLD}', headers=token_headers).json()
    assert inherited['code'] == 404, f'新类型凭空带着别人的数据项：{inherited}'


def test_deleting_the_type_drops_the_cached_options(client: TestClient, token_headers: dict[str, str]) -> None:
    type_id = _seed(client, token_headers)

    assert client.request('DELETE', TYPES, headers=token_headers, json={'pks': [type_id]}).json()['code'] == 200

    after = client.get(f'{DATAS}/type-codes/{OLD}', headers=token_headers).json()
    assert after['code'] == 404, f'已删类型的选项还在从缓存返回：{after}'
