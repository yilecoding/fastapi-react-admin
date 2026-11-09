"""数据变更审计（#260 二期）：第三方账号的绑定 / 解绑记在用户名下。

绑定走真的回调处理（`login_or_binding` 的绑定分支，第三方那一步不经过 —— 直接给它用户信息）：
回调请求不带登录态，操作人要从 state 里取，不然记成「系统」绑的。解绑是逻辑删除，走真接口。
"""

import json

from collections.abc import Iterator
from typing import Any

import pytest

from sqlalchemy import text
from starlette.testclient import TestClient

from backend.core.conf import settings
from backend.database.redis import redis_client
from backend.plugin.oauth2.enums import UserSocialType
from backend.plugin.oauth2.service.oauth2_service import oauth2_service
from backend.tests.utils.db import async_test_db_session
from backend.utils.timezone import timezone

SID = 'pytest-dc-social'
STATE = 'pytest-dc-social-state'


async def _purge(since: Any = None, uid: Any = None) -> None:
    async with async_test_db_session.begin() as db:
        await db.execute(text('DELETE FROM sys_user_social WHERE sid = :sid'), {'sid': SID})
        if since is not None:
            await db.execute(
                text(
                    "DELETE FROM sys_data_change WHERE entity_type = 'user' AND entity_id = :uid AND created_time >= :t"
                ),
                {'uid': int(uid), 't': since},
            )


@pytest.fixture
def admin_id(client: TestClient, token_headers: dict[str, str]) -> Iterator[str]:
    client.portal.call(_purge)
    started = timezone.now()
    uid = client.get('/sys/users/me', headers=token_headers).json()['data']['id']
    yield uid
    client.portal.call(_purge, started, uid)


async def _bind_through_callback(uid: str) -> None:
    await redis_client.set(
        f'{settings.OAUTH2_STATE_REDIS_PREFIX}:{STATE}', json.dumps({'type': 'binding', 'user_id': int(uid)}), ex=60
    )
    async with async_test_db_session.begin() as db:
        await oauth2_service.login_or_binding(
            db=db,
            request=None,  # type: ignore[arg-type]  # 绑定分支用不到
            response=None,  # type: ignore[arg-type]
            background_tasks=None,  # type: ignore[arg-type]
            user={'id': SID, 'login': 'pytest-dc', 'name': 'pytest-dc'},
            social=UserSocialType.github,
            state=STATE,
        )


def _social_records(client: TestClient, token_headers: dict[str, str], uid: str) -> list[dict[str, Any]]:
    res = client.get(
        '/logs/changes',
        headers=token_headers,
        params={'entity_type': 'user', 'entity_id': uid, 'field': 'socials', 'size': 50},
    ).json()
    assert res['code'] == 200, res
    return list(reversed(res['data']['items']))


def _socials(record: dict[str, Any]) -> dict[str, Any]:
    return next(c for c in record['changes'] if c['field'] == 'socials')


def test_binding_and_unbinding_land_on_the_user(
    client: TestClient, token_headers: dict[str, str], admin_id: str
) -> None:
    assert 'Github' not in client.get('/oauth2/me/bindings', headers=token_headers).json()['data'], '前置：没绑过'
    before = len(_social_records(client, token_headers, admin_id))

    client.portal.call(_bind_through_callback, admin_id)
    *_, bound = _social_records(client, token_headers, admin_id)
    assert bound['actor_name'] == 'admin' and bound['source'] == 'oauth2' and bound['source_ref'] == 'Github'
    assert _socials(bound) == {
        'field': 'socials',
        'label': '第三方账号',
        'added': [{'id': 'Github', 'label': 'GitHub'}],
        'removed': [],
    }
    assert SID not in json.dumps(bound), '第三方那边的用户 ID 不记'

    # 解绑是逻辑删除（deleted = id）：被标删的行不能还算「绑着」
    res = client.delete('/oauth2/me/unbinding', headers=token_headers, params={'source': 'Github'}).json()
    assert res['code'] == 200, res
    *_, unbound = _social_records(client, token_headers, admin_id)
    assert unbound['actor_name'] == 'admin' and unbound['source'] == 'web'
    assert _socials(unbound)['removed'] == [{'id': 'Github', 'label': 'GitHub'}]
    assert _socials(unbound)['added'] == []
    assert len(_social_records(client, token_headers, admin_id)) == before + 2
