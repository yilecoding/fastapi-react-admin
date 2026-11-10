"""#281：模型密钥（AI 服务商）· MCP 凭据的改动进数据变更记录。

API Key 密文、MCP 令牌的 sha256 只记「改过」；明文、密文、哈希都不能进记录。掩码 / 前几位跟着变，不另记；
「最近使用时间」每次鉴权都写，不出记录。
"""

import os
import uuid

from collections.abc import Iterator

import pytest
import sqlalchemy as sa

from starlette.testclient import TestClient

from backend.core.conf import settings
from backend.plugin.ai.model import AiMcpClient, AiProvider
from backend.tests.utils.data_change import (
    assert_never_recorded,
    changes_of,
    column_value,
    engine,
    field,
    write_in_session,
)
from backend.utils.timezone import timezone

_RUN = uuid.uuid4().hex[:8]
PROVIDERS = '/ai/providers'
CLIENTS = '/ai/mcp-clients'


@pytest.fixture(autouse=True)
def _env(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    monkeypatch.setattr(settings, 'AI_ENCRYPT_SECRET_KEY', os.urandom(32).hex())
    yield
    # 接口的删除是逻辑删除：硬删本文件建的行
    with engine().begin() as conn:
        conn.execute(sa.delete(AiProvider.__table__).where(AiProvider.__table__.c.name.like(f'pytest-dc-{_RUN}%')))
        conn.execute(
            sa.delete(AiMcpClient.__table__).where(AiMcpClient.__table__.c.client_id.like(f'pytest-dc-{_RUN}%'))
        )


def _provider_id(name: str) -> int:
    table = AiProvider.__table__
    with engine().connect() as conn:
        return conn.execute(sa.select(table.c.id).where(table.c.name == name)).scalar_one()


def test_provider_lifecycle_is_recorded_without_the_api_key(client: TestClient, token_headers: dict[str, str]) -> None:
    name = f'pytest-dc-{_RUN}'
    key_a, key_b = f'sk-leak-a-{_RUN}', f'sk-leak-b-{_RUN}'
    base = {
        'name': name,
        'provider_type': 'deepseek',
        'base_url': 'https://api.deepseek.com/v1',
        'model': 'deepseek-chat',
    }
    assert client.post(PROVIDERS, headers=token_headers, json={**base, 'api_key': key_a}).json()['code'] == 200
    pk = _provider_id(name)
    ciphers = [column_value(AiProvider, pk, 'api_key_cipher')]
    edited_body = {**base, 'model': 'deepseek-reasoner', 'use_proxy': True, 'api_key': key_b}
    assert client.put(f'{PROVIDERS}/{pk}', headers=token_headers, json=edited_body).json()['code'] == 200
    ciphers.append(column_value(AiProvider, pk, 'api_key_cipher'))
    assert client.delete(f'{PROVIDERS}/{pk}', headers=token_headers).json()['code'] == 200

    records = changes_of('ai_provider', pk)
    assert [r['action'] for r in records] == ['create', 'update', 'delete']
    edited = records[1]
    assert field(edited, 'model')['old'] == 'deepseek-chat' and field(edited, 'model')['new'] == 'deepseek-reasoner'
    assert field(edited, 'use_proxy')['old_label'] == '否' and field(edited, 'use_proxy')['new_label'] == '是'
    assert field(edited, 'api_key_cipher') == {'field': 'api_key_cipher', 'label': 'API Key', 'secret': True}
    assert field(edited, 'api_key_mask') is None
    assert_never_recorded(records, key_a, key_b, *ciphers)


def test_mcp_client_lifecycle_is_recorded_without_the_token(client: TestClient, token_headers: dict[str, str]) -> None:
    body = {'client_id': f'pytest-dc-{_RUN}', 'name': '测试系统', 'act_as': ['test']}
    issued = client.post(CLIENTS, headers=token_headers, json=body).json()['data']
    pk = issued['id']
    hashes = [column_value(AiMcpClient, pk, 'token_sha256')]
    edited_body = {'name': '改名的系统', 'act_as': ['test'], 'allow_write': True}
    assert client.put(f'{CLIENTS}/{pk}', headers=token_headers, json=edited_body).json()['code'] == 200
    rotated = client.post(f'{CLIENTS}/{pk}/rotate', headers=token_headers).json()['data']
    hashes.append(column_value(AiMcpClient, pk, 'token_sha256'))

    # 每次鉴权都写「最近使用时间」：不出记录（先断言它真的写了）
    before = len(changes_of('ai_mcp_client', pk))
    table = AiMcpClient.__table__
    write_in_session(sa.update(table).where(table.c.id == int(pk)).values(last_used_time=timezone.now()))
    assert column_value(AiMcpClient, pk, 'last_used_time') is not None
    assert len(changes_of('ai_mcp_client', pk)) == before

    assert client.delete(f'{CLIENTS}/{pk}', headers=token_headers).json()['code'] == 200
    records = changes_of('ai_mcp_client', pk)
    assert [r['action'] for r in records] == ['create', 'update', 'update', 'delete']
    _, edited, rerolled, _ = records
    assert field(edited, 'allow_write')['old_label'] == '否' and field(edited, 'allow_write')['new_label'] == '是'
    assert field(edited, 'name')['new'] == '改名的系统'
    assert [c['field'] for c in rerolled['changes']] == ['token_sha256'], '前几位（hint）跟着变，不另记'
    assert field(rerolled, 'token_sha256') == {'field': 'token_sha256', 'label': '令牌', 'secret': True}
    assert_never_recorded(records, issued['mcp_token'], rotated['mcp_token'], *hashes)
