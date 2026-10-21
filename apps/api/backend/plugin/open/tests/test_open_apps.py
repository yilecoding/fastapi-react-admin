"""应用管理接口的守卫测试（真实 HTTP + 测试库）。

要守的都是「写错了不报错」的那一类：

- 明文 SK 出现在不该出现的地方：详情 / 列表、操作日志的响应体
- 没配加密密钥时静默存明文
- 配置写错（不存在的 scope、非法 IP）—— 存得进去的话，表现是对方一律 403，看起来像「密钥坏了」
"""

import json

from datetime import timedelta

from starlette.testclient import TestClient

from backend.core.conf import settings
from backend.middleware.opera_log_middleware import OperaLogMiddleware
from backend.plugin.open.tests.conftest import CODE_PREFIX, MGMT, create_app, signed_get
from backend.utils.timezone import timezone


class TestSecretNeverLeaks:
    def test_plaintext_only_in_the_create_response(self, client: TestClient, token_headers: dict[str, str]) -> None:
        issued = create_app(client, token_headers)
        secret = issued['secret_key']
        assert secret.startswith('fra_sk_') and len(secret) > 40
        assert issued['access_key'].startswith('fra_ak_')

        detail = client.get(f'{MGMT}/{issued["id"]}', headers=token_headers)
        listing = client.get(MGMT, headers=token_headers, params={'page': 1, 'size': 50})
        for body in (detail.text, listing.text):
            # 先断言「有」：确认这条记录真的在响应里，否则「没有 SK」恒真
            assert issued['code'] in body
            assert issued['access_key'] in body
            assert secret not in body
            assert 'secret_cipher' not in body
        assert secret.startswith(detail.json()['data']['secret_hint'].rstrip('…'))

    def test_opera_log_redacts_the_secret(self, client: TestClient, token_headers: dict[str, str]) -> None:
        """拿真实的响应字节走一遍操作日志的脱敏 —— 字段名改了、脱敏名单漏了都会红"""
        response = client.post(
            MGMT, headers=token_headers, json={'code': f'{CODE_PREFIX}LOG', 'name': 'x', 'scopes': ['user:read']}
        )
        secret = response.json()['data']['secret_key']
        logged = OperaLogMiddleware.redact_body(response.content, 'application/json').decode()
        assert response.json()['data']['code'] in logged, '前置：日志里应该有这条记录'
        assert secret not in logged
        assert json.loads(logged)['data']['secret_key'] == '[REDACTED]'

    def test_reset_response_is_redacted_too(self, client: TestClient, token_headers: dict[str, str]) -> None:
        issued = create_app(client, token_headers)
        response = client.post(f'{MGMT}/{issued["id"]}/secret', headers=token_headers)
        new_secret = response.json()['data']['secret_key']
        logged = OperaLogMiddleware.redact_body(response.content, 'application/json').decode()
        assert new_secret not in logged

    def test_refuses_to_store_without_encryption_key(self, client: TestClient, token_headers: dict[str, str]) -> None:
        settings.OPEN_SECRET_KEY = ''
        response = client.post(
            MGMT, headers=token_headers, json={'code': f'{CODE_PREFIX}NOKEY', 'name': 'x', 'scopes': ['user:read']}
        )
        assert response.json()['code'] != 200
        assert 'OPEN_SECRET_KEY' in response.json()['msg']
        listing = client.get(MGMT, headers=token_headers, params={'name': f'{CODE_PREFIX}NOKEY'})
        assert listing.json()['data']['total'] == 0, '没配密钥时一行都不该写进去'


class TestConfigValidated:
    def test_unknown_scope_rejected(self, client: TestClient, token_headers: dict[str, str]) -> None:
        response = client.post(
            MGMT,
            headers=token_headers,
            json={'code': f'{CODE_PREFIX}BAD', 'name': 'x', 'scopes': ['user:read', 'user:write']},
        )
        assert response.json()['code'] == 400
        assert 'user:write' in response.json()['msg']

    def test_invalid_ip_rejected(self, client: TestClient, token_headers: dict[str, str]) -> None:
        response = client.post(
            MGMT,
            headers=token_headers,
            json={'code': f'{CODE_PREFIX}IP', 'name': 'x', 'scopes': ['user:read'], 'ip_whitelist': ['10.0.0.300']},
        )
        assert response.json()['code'] == 422

    def test_code_is_upper_and_unique(self, client: TestClient, token_headers: dict[str, str]) -> None:
        issued = create_app(client, token_headers, suffix='dup')
        assert issued['code'] == f'{CODE_PREFIX}DUP'
        again = client.post(
            MGMT, headers=token_headers, json={'code': f'{CODE_PREFIX}DUP', 'name': 'y', 'scopes': ['user:read']}
        )
        assert again.json()['code'] == 409

    def test_code_reusable_after_delete(self, client: TestClient, token_headers: dict[str, str]) -> None:
        issued = create_app(client, token_headers, suffix='RE')
        assert client.delete(f'{MGMT}/{issued["id"]}', headers=token_headers).json()['code'] == 200
        again = create_app(client, token_headers, suffix='RE')
        assert again['id'] != issued['id']


class TestScopesAndState:
    def test_scope_list_comes_from_the_routes(self, client: TestClient, token_headers: dict[str, str]) -> None:
        items = client.get(f'{MGMT}/scopes', headers=token_headers).json()['data']
        by_scope = {i['scope']: i for i in items}
        assert by_scope['user:read']['path'] == '/api/open/v1/users'
        assert by_scope['user:read']['method'] == 'GET'
        assert by_scope['dept:read']['path'] == '/api/open/v1/depts'

    def test_expired_state_is_derived(self, client: TestClient, token_headers: dict[str, str]) -> None:
        past = (timezone.now() - timedelta(days=1)).isoformat()
        issued = create_app(client, token_headers, suffix='EXP', expire_time=past)
        detail = client.get(f'{MGMT}/{issued["id"]}', headers=token_headers).json()['data']
        assert detail['state'] == 'expired'
        expired = client.get(MGMT, headers=token_headers, params={'status': 2, 'size': 100}).json()['data']['items']
        assert issued['id'] in [i['id'] for i in expired]
        enabled = client.get(MGMT, headers=token_headers, params={'status': 1, 'size': 100}).json()['data']['items']
        assert issued['id'] not in [i['id'] for i in enabled]

    def test_openapi_export_contains_only_open_routes(self, client: TestClient, token_headers: dict[str, str]) -> None:
        doc = client.get(f'{MGMT}/openapi.json', headers=token_headers).json()
        paths = set(doc['paths'])
        assert '/api/open/v1/users' in paths
        assert '/api/open/v1/depts' in paths
        assert all(p.startswith('/api/open/') for p in paths), paths


class TestResetSecret:
    def test_old_secret_stops_working_immediately(self, client: TestClient, token_headers: dict[str, str]) -> None:
        issued = create_app(client, token_headers)
        assert signed_get(client, issued, '/users', params='limit=1').json()['code'] == 200

        reset = client.post(f'{MGMT}/{issued["id"]}/secret', headers=token_headers).json()['data']
        assert reset['access_key'] == issued['access_key'], 'AK 不变，对方只改一个配置项'
        old = signed_get(client, issued, '/users', params='limit=1')
        assert old.status_code == 401 and 'string_to_sign' in old.json()['data']
        assert signed_get(client, {**issued, 'secret_key': reset['secret_key']}, '/users').json()['code'] == 200

    def test_disable_and_delete_take_effect_immediately(
        self, client: TestClient, token_headers: dict[str, str]
    ) -> None:
        issued = create_app(client, token_headers)
        body = {'name': '测试系统', 'scopes': ['user:read'], 'status': 0}
        assert client.put(f'{MGMT}/{issued["id"]}', headers=token_headers, json=body).json()['code'] == 200
        assert signed_get(client, issued, '/users').status_code == 401

        body['status'] = 1
        client.put(f'{MGMT}/{issued["id"]}', headers=token_headers, json=body)
        assert signed_get(client, issued, '/users').status_code == 200

        client.delete(f'{MGMT}/{issued["id"]}', headers=token_headers)
        assert signed_get(client, issued, '/users').json()['msg'] == 'accessKey 无效'


def test_every_plugin_setting_is_a_declared_field() -> None:
    """🔴 plugin.toml 里的配置没在 `Settings` 里声明的话是 extra，进程环境变量覆盖不了 ——
    部署时用容器环境变量配 OPEN_SECRET_KEY 会被静默忽略（浏览器验收时真撞上了：只能报「未配置」）"""
    import rtoml

    from backend.core.conf import Settings
    from backend.core.path_conf import PLUGIN_DIR

    keys = rtoml.load(PLUGIN_DIR / 'open' / 'plugin.toml')['settings']
    assert 'OPEN_SECRET_KEY' in keys
    assert set(keys) <= set(Settings.model_fields), set(keys) - set(Settings.model_fields)
