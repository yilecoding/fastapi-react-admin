"""短信配置接口（真实 HTTP + 测试库）：写错的东西不能存进去、密钥永不出门、默认只有一条、发测试短信。"""

from __future__ import annotations

import hashlib
import json

from typing import TYPE_CHECKING, Any

import pytest

from backend.core.conf import settings
from backend.database.redis import redis_client
from backend.middleware.opera_log_middleware import OperaLogMiddleware
from backend.plugin.sms.tests.conftest import CONFIGS, LOGS, NAME_PREFIX, PHONE_A

if TYPE_CHECKING:
    from collections.abc import Callable

    from starlette.testclient import TestClient

ALIYUN_BODY: dict[str, Any] = {
    'name': f'{NAME_PREFIX}aliyun',
    'provider': 'aliyun',
    'sign_name': '测试签名',
    'access_key_id': 'LTAI5t-pytest',
    'access_key_secret': 'super-secret-value-0123456789',
    'options': {'endpoint': 'dysmsapi.aliyuncs.com'},
    'templates': {'captcha': {'template_id': 'SMS_100000001', 'mapping': {'code': 'code'}}},
}


class TestCatalog:
    def test_providers_describe_fields_and_mapping(self, client: TestClient, token_headers: dict[str, str]) -> None:
        data = client.get(f'{CONFIGS}/providers', headers=token_headers).json()['data']
        by_code = {p['code']: p for p in data}
        assert {'aliyun', 'tencent', 'console'} <= set(by_code)
        aliyun, tencent, console = by_code['aliyun'], by_code['tencent'], by_code['console']
        assert aliyun['template_mapping'] == 'named' and tencent['template_mapping'] == 'ordered'
        # 凭据字段不进 options_schema（它们走加密列），其余字段都在
        assert aliyun['credential']['key_field'] == 'access_key_id'
        assert set(aliyun['options_schema']['properties']) == {'endpoint'}
        assert set(tencent['options_schema']['properties']) == {'sdk_app_id', 'region'}
        assert tencent['options_schema']['required'] == ['sdk_app_id']
        assert console['credential'] is None and console['options_schema']['properties'] == {}

    def test_templates_list_the_builtin_captcha(self, client: TestClient, token_headers: dict[str, str]) -> None:
        data = client.get(f'{CONFIGS}/templates', headers=token_headers).json()['data']
        captcha = next(t for t in data if t['code'] == 'captcha')
        assert captcha['params'] == ['code', 'minutes'] and captcha['sensitive'] == ['code']
        assert captcha['cooldown_seconds'] == 60 and captcha['daily_max_per_phone'] == 10


class TestSecretsNeverLeak:
    def test_secret_only_as_mask(self, client: TestClient, token_headers: dict[str, str], encrypt_key: str) -> None:
        res = client.post(CONFIGS, headers=token_headers, json=ALIYUN_BODY)
        assert res.json()['code'] == 200, res.text
        listing = client.get(CONFIGS, headers=token_headers, params={'name': ALIYUN_BODY['name']})
        item = next(i for i in listing.json()['data']['items'] if i['name'] == ALIYUN_BODY['name'])
        detail = client.get(f'{CONFIGS}/{item["id"]}', headers=token_headers)
        for body in (listing.text, detail.text):
            assert ALIYUN_BODY['access_key_id'] in body, '前置：这条记录真的在响应里'
            assert ALIYUN_BODY['access_key_secret'] not in body
            assert 'secret_cipher' not in body and 'access_key_secret' not in body
        mask = detail.json()['data']['secret_mask']
        assert mask.startswith('supe') and mask.endswith('6789') and '*' in mask
        assert isinstance(detail.json()['data']['id'], str), '雪花 ID 一律字符串（硬纪律 6）'

    def test_request_body_secret_is_redacted_in_opera_log(self) -> None:
        """拿真实的请求体走一遍操作日志的脱敏 —— 字段名改了、脱敏名单漏了都会红"""
        redacted = OperaLogMiddleware.desensitization(json.loads(json.dumps(ALIYUN_BODY)))
        assert redacted['access_key_id'] == ALIYUN_BODY['access_key_id'], '前置：别的字段原样保留'
        assert redacted['access_key_secret'] != ALIYUN_BODY['access_key_secret']

    def test_missing_encrypt_key_refuses_to_store(
        self, client: TestClient, token_headers: dict[str, str], monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """🔴 没配密钥就拒绝保存，不静默存明文"""
        monkeypatch.setattr(settings, 'SMS_ENCRYPT_SECRET_KEY', '')
        res = client.post(CONFIGS, headers=token_headers, json=ALIYUN_BODY)
        assert res.json()['code'] == 500 and 'SMS_ENCRYPT_SECRET_KEY' in res.json()['msg']
        listing = client.get(CONFIGS, headers=token_headers, params={'name': ALIYUN_BODY['name']}).json()
        assert not [i for i in listing['data']['items'] if i['name'] == ALIYUN_BODY['name']]

    def test_console_needs_no_key(
        self, client: TestClient, token_headers: dict[str, str], monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setattr(settings, 'SMS_ENCRYPT_SECRET_KEY', '')
        body = {
            **ALIYUN_BODY,
            'name': f'{NAME_PREFIX}console-nokey',
            'provider': 'console',
            'options': {},
            'access_key_id': None,
            'access_key_secret': None,
        }
        body['templates'] = {'captcha': {'template_id': 'X', 'mapping': {'code': 'code'}}}
        assert client.post(CONFIGS, headers=token_headers, json=body).json()['code'] == 200


class TestValidationAtSave:
    """写错的键名、模板码、参数名一律 400 —— 否则要到发送时才失败，看起来像通道坏了"""

    @pytest.mark.parametrize(
        ('patch', 'fragment'),
        [
            ({'provider': 'huawei'}, 'huawei'),  # 未知厂商
            ({'options': {'endpiont': 'x'}}, 'endpiont'),  # options 键名拼错
            ({'templates': {'captch': {'template_id': 'S', 'mapping': {'code': 'code'}}}}, 'captch'),  # 模板码拼错
            ({'templates': {'captcha': {'template_id': 'S', 'mapping': {'code': 'cdoe'}}}}, 'cdoe'),  # 参数名拼错
            ({'templates': {'captcha': {'template_id': 'S', 'mapping': ['code']}}}, '变量名'),  # 阿里云要按变量名
            ({'templates': {'captcha': {'template_id': '', 'mapping': {'code': 'code'}}}}, 'template_id'),
            ({'templates': {'captcha': {'template_id': 'S' * 65, 'mapping': {'code': 'code'}}}}, '64'),  # 超过列宽
            ({'access_key_secret': None}, '凭据'),  # 凭据为空
            ({'status': 0, 'is_default': True}, '默认'),
        ],
    )
    def test_bad_input_is_400(
        self, client: TestClient, token_headers: dict[str, str], encrypt_key: str, patch: dict[str, Any], fragment: str
    ) -> None:
        res = client.post(CONFIGS, headers=token_headers, json={**ALIYUN_BODY, **patch})
        assert res.json()['code'] == 400, res.text
        assert fragment in res.json()['msg'], res.json()['msg']

    def test_tencent_mapping_must_be_ordered(
        self, client: TestClient, token_headers: dict[str, str], encrypt_key: str
    ) -> None:
        body = {
            **ALIYUN_BODY,
            'name': f'{NAME_PREFIX}tencent',
            'provider': 'tencent',
            'options': {'sdk_app_id': '1400000000'},
            'templates': {'captcha': {'template_id': '100001', 'mapping': {'code': 'code'}}},
        }
        res = client.post(CONFIGS, headers=token_headers, json=body)
        assert res.json()['code'] == 400 and '位置' in res.json()['msg']
        body['templates'] = {'captcha': {'template_id': '100001', 'mapping': ['code', 'minutes']}}
        assert client.post(CONFIGS, headers=token_headers, json=body).json()['code'] == 200

    def test_tencent_requires_sdk_app_id(
        self, client: TestClient, token_headers: dict[str, str], encrypt_key: str
    ) -> None:
        body = {**ALIYUN_BODY, 'name': f'{NAME_PREFIX}tencent2', 'provider': 'tencent', 'options': {}, 'templates': {}}
        res = client.post(CONFIGS, headers=token_headers, json=body)
        assert res.json()['code'] == 400 and 'sdk_app_id' in res.json()['msg']

    def test_duplicate_name_is_409(
        self, client: TestClient, token_headers: dict[str, str], make_config: Callable[..., dict[str, Any]]
    ) -> None:
        first = make_config('dup')
        res = client.post(
            CONFIGS, headers=token_headers, json={'name': first['name'], 'provider': 'console', 'sign_name': 'x'}
        )
        assert res.json()['code'] == 409


class TestDefaultAndUpdate:
    def test_set_default_leaves_exactly_one(
        self, client: TestClient, token_headers: dict[str, str], make_config: Callable[..., dict[str, Any]]
    ) -> None:
        a = make_config('d1', is_default=True)
        b = make_config('d2')
        assert a['is_default'] and not b['is_default']
        assert client.put(f'{CONFIGS}/{b["id"]}/default', headers=token_headers).json()['code'] == 200
        items = client.get(CONFIGS, headers=token_headers, params={'name': NAME_PREFIX, 'size': 50}).json()['data'][
            'items'
        ]
        defaults = [i['name'] for i in items if i['is_default']]
        assert defaults == [b['name']]

    def test_disabled_cannot_be_default(
        self, client: TestClient, token_headers: dict[str, str], make_config: Callable[..., dict[str, Any]]
    ) -> None:
        c = make_config('dis', status=0)
        res = client.put(f'{CONFIGS}/{c["id"]}/default', headers=token_headers)
        assert res.json()['code'] == 400

    def test_update_keeps_secret_when_blank_and_replaces_when_given(
        self, client: TestClient, token_headers: dict[str, str], encrypt_key: str
    ) -> None:
        client.post(CONFIGS, headers=token_headers, json=ALIYUN_BODY)
        item = next(
            i
            for i in client.get(CONFIGS, headers=token_headers, params={'name': ALIYUN_BODY['name']}).json()['data'][
                'items'
            ]
        )
        before = item['secret_mask']

        body = {k: v for k, v in ALIYUN_BODY.items() if k != 'access_key_secret'} | {
            'remark': 'edited',
            'access_key_secret': '',
        }
        assert client.put(f'{CONFIGS}/{item["id"]}', headers=token_headers, json=body).json()['code'] == 200
        after = client.get(f'{CONFIGS}/{item["id"]}', headers=token_headers).json()['data']
        assert after['secret_mask'] == before and after['remark'] == 'edited'

        body['access_key_secret'] = 'another-secret-value-9876543210'
        assert client.put(f'{CONFIGS}/{item["id"]}', headers=token_headers, json=body).json()['code'] == 200
        rotated = client.get(f'{CONFIGS}/{item["id"]}', headers=token_headers).json()['data']['secret_mask']
        assert rotated != before and rotated.startswith('anot')

    def test_switching_provider_requires_a_new_secret(
        self, client: TestClient, token_headers: dict[str, str], encrypt_key: str
    ) -> None:
        """🔴 换厂商不给新密钥 → 400。否则存下来的是「厂商是腾讯云、密钥是阿里云的」，每次发送都鉴权失败"""
        client.post(CONFIGS, headers=token_headers, json=ALIYUN_BODY)
        item = next(
            i
            for i in client.get(CONFIGS, headers=token_headers, params={'name': ALIYUN_BODY['name']}).json()['data'][
                'items'
            ]
        )
        body = {k: v for k, v in ALIYUN_BODY.items() if k != 'access_key_secret'} | {
            'provider': 'tencent',
            'options': {'sdk_app_id': '1400000000'},
            'templates': {'captcha': {'template_id': '100001', 'mapping': ['code', 'minutes']}},
        }
        res = client.put(f'{CONFIGS}/{item["id"]}', headers=token_headers, json=body)
        assert res.json()['code'] == 400 and 'secret_key' in res.json()['msg'], res.text
        # 同厂商不给密钥照旧允许（留空 = 不改）
        same = {k: v for k, v in ALIYUN_BODY.items() if k != 'access_key_secret'}
        assert client.put(f'{CONFIGS}/{item["id"]}', headers=token_headers, json=same).json()['code'] == 200
        body['access_key_secret'] = 'tencent-secret-key-0123456789'
        assert client.put(f'{CONFIGS}/{item["id"]}', headers=token_headers, json=body).json()['code'] == 200

    def test_update_validates_like_create(
        self, client: TestClient, token_headers: dict[str, str], make_config: Callable[..., dict[str, Any]]
    ) -> None:
        c = make_config('upd')
        body = {
            'name': c['name'],
            'provider': 'console',
            'sign_name': 'x',
            'templates': {'captcha': {'template_id': 'X', 'mapping': {'code': 'nope'}}},
        }
        assert client.put(f'{CONFIGS}/{c["id"]}', headers=token_headers, json=body).json()['code'] == 400

    def test_delete_hides_from_list(
        self, client: TestClient, token_headers: dict[str, str], make_config: Callable[..., dict[str, Any]]
    ) -> None:
        c = make_config('del')
        assert client.delete(f'{CONFIGS}/{c["id"]}', headers=token_headers).json()['code'] == 200
        assert client.get(f'{CONFIGS}/{c["id"]}', headers=token_headers).json()['code'] == 404
        assert client.delete(f'{CONFIGS}/{c["id"]}', headers=token_headers).json()['code'] == 400


class TestSendTest:
    def test_console_test_sms_is_accepted_and_logged(
        self, client: TestClient, token_headers: dict[str, str], make_config: Callable[..., dict[str, Any]]
    ) -> None:
        c = make_config('t1')
        res = client.post(
            f'{CONFIGS}/{c["id"]}/test',
            headers=token_headers,
            json={'phone': PHONE_A, 'template_id': 'DEV_X', 'params': {'code': '8888'}},
        )
        data = res.json()['data']
        assert res.json()['code'] == 200 and data['status'] == 'accepted', res.text
        assert data['log_id'] and isinstance(data['log_id'], str)
        assert '8888' in data['provider_msg']

        logs = client.get(LOGS, headers=token_headers, params={'phone': PHONE_A, 'template': 'test'}).json()['data'][
            'items'
        ]
        assert [log['id'] for log in logs] == [data['log_id']]
        assert logs[0]['status'] == 1 and logs[0]['provider'] == 'console' and logs[0]['config_id'] == c['id']
        # 「今日已发」跟着涨
        after = client.get(f'{CONFIGS}/{c["id"]}', headers=token_headers).json()['data']
        assert after['today_sent'] >= 1

    def test_params_shape_must_match_provider(
        self, client: TestClient, token_headers: dict[str, str], make_config: Callable[..., dict[str, Any]]
    ) -> None:
        c = make_config('t2')
        res = client.post(
            f'{CONFIGS}/{c["id"]}/test',
            headers=token_headers,
            json={'phone': PHONE_A, 'template_id': 'X', 'params': ['1']},
        )
        assert res.json()['code'] == 400 and '变量名' in res.json()['msg']

    def test_bad_phone_is_422(
        self, client: TestClient, token_headers: dict[str, str], make_config: Callable[..., dict[str, Any]]
    ) -> None:
        c = make_config('t3')
        res = client.post(
            f'{CONFIGS}/{c["id"]}/test', headers=token_headers, json={'phone': '12345', 'template_id': 'X'}
        )
        assert res.status_code == 422

    def test_test_endpoint_is_rate_limited_per_operator(
        self,
        client: TestClient,
        token_headers: dict[str, str],
        make_config: Callable[..., dict[str, Any]],
        rate_limiter: None,
    ) -> None:
        c = make_config('t4')

        # 计数窗口在 Redis 里活一分钟：上一轮 pytest 的 5 次会漏进这一轮（AI MCP 限流那条记过）。
        # bucket key 是 `<前缀>:<策略摘要>:<sha256(标识符)>`，按标识符的摘要删
        me = client.get('/sys/users/me', headers=token_headers).json()['data']['id']
        digest = hashlib.sha256(f'sms-test:{me}'.encode()).hexdigest()

        async def _reset_bucket() -> None:
            keys = await redis_client.keys(f'{settings.REQUEST_LIMITER_REDIS_PREFIX}:*:{digest}*')
            if keys:
                await redis_client.delete(*keys)

        client.portal.call(_reset_bucket)
        body = {'phone': PHONE_A, 'template_id': 'X', 'params': {'code': '1'}}
        codes = [
            client.post(f'{CONFIGS}/{c["id"]}/test', headers=token_headers, json=body).status_code for _ in range(7)
        ]
        assert codes.count(200) == 5 and codes.count(429) == 2, codes
