"""操作日志的脱敏。

🔴 **这两条防的是同一件事：日志表本身变成凭据泄露面。** 改动前有两个洞，
都是静默的 —— 日志照常写、字段照常在，只是没打码：

1. `desensitization()` 只看**顶层** key，任何嵌一层的 `password` 全漏
2. **响应体根本不过脱敏** —— 它只被截断，然后原样落进 `sys_opera_log.response_body`
"""

import json
import re

import pytest

from backend.core.conf import settings
from backend.middleware.opera_log_middleware import OperaLogMiddleware as M


def test_top_level_secret_is_redacted():
    assert M.desensitization({'username': 'a', 'password': 'x'}) == {'username': 'a', 'password': '[REDACTED]'}


def test_secret_nested_in_a_dict_is_redacted():
    """`{"data": {"password": ...}}` —— 改动前这里一个字符都不打码"""
    assert M.desensitization({'data': {'password': 'x'}}) == {'data': {'password': '[REDACTED]'}}


def test_secret_nested_in_a_list_is_redacted():
    """批量接口的典型形状：一个列表里每项都带密码"""
    got = M.desensitization({'data': {'items': [{'username': 'a', 'password': 'x'}]}})
    assert got['data']['items'][0] == {'username': 'a', 'password': '[REDACTED]'}


def test_every_configured_key_is_covered():
    """`OPERA_LOG_REDACT_KEYS` 是配置，别在测试里另抄一份会分叉的清单"""
    payload = {'wrap': [dict.fromkeys(settings.OPERA_LOG_REDACT_KEYS, 'secret')]}
    assert all(value == '[REDACTED]' for value in M.desensitization(payload)['wrap'][0].values())


def test_desensitization_does_not_mutate_the_input():
    """请求参数在别处还要用，脱敏必须返回新对象而不是就地改"""
    original = {'password': 'x'}
    M.desensitization(original)
    assert original == {'password': 'x'}


def test_deeply_nested_structure_does_not_blow_the_stack():
    payload = {}
    node = payload
    for _ in range(200):
        node['next'] = {}
        node = node['next']
    node['password'] = 'x'
    M.desensitization(payload)  # 深度超过上限时原样返回，不递归到爆栈


# --------------------------------------------------------------------------- 响应体


def test_json_response_body_is_redacted():
    raw = json.dumps({'data': {'created': [{'username': 'a', 'password': 'plain'}]}}).encode()
    got = json.loads(M.redact_body(raw, 'application/json'))
    assert got['data']['created'][0]['password'] == '[REDACTED]'
    assert b'plain' not in M.redact_body(raw, 'application/json')


def test_unparseable_json_body_is_not_logged_at_all():
    """fail-closed：结构读不出来就没法确认没有敏感字段，宁可少一条日志"""
    got = M.redact_body(b'{"truncated": ', 'application/json')
    assert b'truncated' not in got
    assert '未记录' in got.decode()


def test_oversized_json_body_is_not_logged_at_all():
    raw = b'{"a": "' + b'x' * (5 * 1024 * 1024) + b'"}'
    assert '未记录' in M.redact_body(raw, 'application/json').decode()


def test_plain_text_body_is_left_alone():
    """纯文本没有可按字段打码的结构，保持改动前的行为（原样截断）"""
    assert M.redact_body(b'hello', 'text/plain') == b'hello'


@pytest.mark.parametrize('raw', [b'', None])
def test_empty_body_is_passed_through(raw):
    assert M.redact_body(raw or b'', 'application/json') == b''


def test_redaction_happens_before_truncation():
    """🔴 顺序反了等于没脱敏 —— 截断后的片段不是合法 JSON，解析不了就没法打码"""
    payload = {'pad': 'y' * settings.OPERA_LOG_RESPONSE_MAX_SIZE, 'password': 'plain'}
    body = M.truncate_body(M.redact_body(json.dumps(payload).encode(), 'application/json'))
    assert 'plain' not in body
    assert '已截断' in body


def test_a_client_that_left_before_the_body_arrived_is_not_a_server_error():
    """浏览器在请求体还没传完时走了（跳页 / 关标签页会取消在途的 POST）：原来读请求体抛 `ClientDisconnect`，
    没人接，记成一条 ERROR + 几百行的栈、按 500 处理 —— 本地真跑（2026-10-24，登录后立刻跳页）时撞到的。
    客户端已经不在了，回什么它都收不到：按 499（client closed request）收掉，不记错误"""
    import asyncio

    from starlette.requests import Request

    async def receive():  # ruff: ignore[unused-async] —— ASGI 的 receive 必须是 async
        return {'type': 'http.disconnect'}

    scope = {
        'type': 'http',
        'method': 'POST',
        'path': '/api/v1/sys/workflow/instances',
        'raw_path': b'/api/v1/sys/workflow/instances',
        'query_string': b'',
        'headers': [(b'content-type', b'application/json'), (b'content-length', b'20')],
        'path_params': {},
        'client': ('127.0.0.1', 1),
        'server': ('127.0.0.1', 8000),
        'scheme': 'http',
    }
    called: list[bool] = []

    async def call_next(_request):  # ruff: ignore[unused-async] —— 中间件按 await 调它
        called.append(True)
        raise AssertionError('客户端都走了，不该再往下调路由')

    response = asyncio.run(M(app=None).dispatch(Request(scope, receive), call_next))
    assert response.status_code == 499
    assert called == []


def test_a_client_that_left_while_the_route_ran_is_not_logged_as_a_success(monkeypatch):
    """另一条路：参数读完了、路由跑到一半客户端走了（`call_next` 抛 `ClientDisconnect`）。
    🔴 那个 `return` 在 try 里，finally 照样跑 —— 原来按默认值记了一条 code 200 / Success 的操作日志，
    审计里一个根本没执行完的请求成了「成功」"""
    import asyncio
    import time

    from types import SimpleNamespace

    from starlette.requests import ClientDisconnect, Request

    import backend.middleware.opera_log_middleware as mod

    from backend.utils.timezone import timezone

    monkeypatch.setattr(
        mod,
        'ctx',
        SimpleNamespace(
            perf_time=time.perf_counter(),
            start_time=timezone.now(),
            ip='127.0.0.1',
            country=None,
            region=None,
            city=None,
            user_agent=None,
            os=None,
            browser=None,
            device=None,
            get=lambda _key: None,
        ),
    )
    monkeypatch.setattr(mod, 'get_request_trace_id', lambda: 'trace')
    queue = asyncio.Queue()
    monkeypatch.setattr(M, 'opera_log_queue', queue)

    async def receive():  # ruff: ignore[unused-async] —— ASGI 的 receive 必须是 async
        return {'type': 'http.request', 'body': b'', 'more_body': False}

    scope = {
        'type': 'http',
        'method': 'GET',
        'path': f'{settings.FASTAPI_API_V1_PATH}/sys/workflow/todo',
        'raw_path': b'',
        'query_string': b'',
        'headers': [],
        'path_params': {},
        'client': ('127.0.0.1', 1),
        'server': ('127.0.0.1', 8000),
        'scheme': 'http',
        'user': SimpleNamespace(username='admin'),
    }

    async def call_next(_request):  # ruff: ignore[unused-async] —— 中间件按 await 调它
        raise ClientDisconnect

    response = asyncio.run(M(app=None).dispatch(Request(scope, receive), call_next))
    assert response.status_code == 499
    assert queue.empty(), f'没执行完的请求不该进操作日志：{queue.get_nowait()}'


def _request_args_for(path: str, body: bytes, content_type: bytes = b'application/json') -> dict | None:
    """让中间件读一份请求体（默认 `Content-Type: application/json`），返回它要记进操作日志的参数"""
    import asyncio

    from starlette.requests import Request

    async def receive():  # ruff: ignore[unused-async] —— ASGI 的 receive 必须是 async
        return {'type': 'http.request', 'body': body, 'more_body': False}

    scope = {
        'type': 'http',
        'method': 'PUT',
        'path': f'{settings.FASTAPI_API_V1_PATH}{path}',
        'raw_path': b'',
        'query_string': b'',
        'headers': [(b'content-type', content_type), (b'content-length', str(len(body)).encode())],
        'path_params': {},
        'client': ('127.0.0.1', 1),
        'server': ('127.0.0.1', 8000),
        'scheme': 'http',
    }
    return asyncio.run(M(app=None).get_request_args(Request(scope, receive)))


def test_a_body_that_claims_json_but_is_not_does_not_blow_up_before_the_route():
    """`Content-Type: application/json` 但请求体是截断 / 写错的 JSON：这个中间件在路由**之前**读请求体，
    原来 `request.json()` 的 `JSONDecodeError` 没人接 —— 任何接口收到一份坏 JSON 都是 500，路由层本该回的
    422（`json_invalid`）永远轮不到。#202 写个人偏好「非法 JSON 被拒」那条用例时撞到的。
    现在接住、记一个占位，交给路由层去拒（接口层的 422 由 `test_user_preference.py` 那条守着）"""
    body = b'{"value": {"cards": ['
    args = _request_args_for('/sys/users/me/preferences/dashboard.layout', body)
    assert args is not None
    assert args['body'] == {
        '_invalid_json': True,
        '_original_size': len(body),
        '_message': '请求体不是合法 JSON，无法脱敏，未记录原文',
    }
    assert 'json' not in args
    assert 'data' not in args


def test_a_broken_json_body_with_a_password_is_not_logged_in_plain_text():
    """🔴 上一条的修法第一版是「照原文记进 `data`」—— 解析不了就没法按字段脱敏，
    一份截断的 `PUT /me/password` 会把新旧两个密码明文写进 sys_opera_log（代码评审翻出来的）。
    同响应体那条 fail-closed：结构读不出来就不记原文"""
    body = b'{"old_password": "Old-Secret-1", "new_password": "New-Secret-2", "confirm_password": "New-Se'
    args = _request_args_for('/sys/users/me/password', body)
    dumped = json.dumps(args, ensure_ascii=False)
    # 先断言「有」：这一份请求确实被记了一笔（否则「没有明文」在什么都没记时也成立）
    assert args, '坏 JSON 的请求体一点痕迹都没留'
    assert 'Old-Secret-1' not in dumped, f'旧密码明文进了操作日志：{dumped}'
    assert 'New-Secret-2' not in dumped, f'新密码明文进了操作日志：{dumped}'


# --------------------------------------------------------------------------- 参数配置那种 key / value 形状


def test_a_secret_config_value_is_redacted_by_its_key_name():
    """🔴 参数配置的一行是 `{"key": "EMAIL_PASSWORD", "value": "<SMTP 授权码>"}`：要打码的是 `value`，
    而它就叫 `value` —— 按字段名的名单永远认不出来。保存参数配置、打开参数配置页，授权码原来都原样进了 sys_opera_log。
    认的是键名（`common/secret_keys.py`，和前端参数配置页打码同一条规则）"""
    rows = [
        {'key': 'EMAIL_PASSWORD', 'value': 'smtp-auth-code'},
        {'key': 'smtp_password', 'value': 'lower-case'},  # 不分大小写
        {'key': 'OSS_CREDENTIALS', 'value': 'cred-json'},
        {'key': 'EMAIL_HOST', 'value': 'smtp.example.com'},  # 对照：不是密钥的照记
        {'key': 'USER_PASSWORD_MIN_LENGTH', 'value': '8'},  # 后缀匹配：策略类的键不受影响
    ]
    got = M.desensitization({'json': rows})['json']
    assert [r['value'] for r in got] == ['[REDACTED]', '[REDACTED]', '[REDACTED]', 'smtp.example.com', '8']
    assert [r['key'] for r in got] == [r['key'] for r in rows], '键名要留着，看得出改的是哪一项'


def test_saving_a_secret_config_does_not_log_its_value():
    """走中间件读请求体那条路：批量保存参数配置的请求体是一个列表"""
    body = json.dumps([
        {'id': 1, 'name': 'SMTP 授权码', 'key': 'EMAIL_PASSWORD', 'value': 'smtp-auth-code', 'is_frontend': False}
    ]).encode()
    dumped = json.dumps(_request_args_for('/sys/configs', body), ensure_ascii=False)
    assert 'EMAIL_PASSWORD' in dumped  # 先断言「有」：这一行确实记下来了
    assert 'smtp-auth-code' not in dumped, f'SMTP 授权码进了操作日志：{dumped}'


def test_a_secret_config_value_in_a_response_is_redacted():
    """打开参数配置页（`GET /sys/configs/all`）的响应体里也有这一行"""
    raw = json.dumps({
        'code': 200,
        'data': [{'id': '1', 'key': 'EMAIL_PASSWORD', 'value': 'smtp-auth-code'}, {'key': 'EMAIL_HOST', 'value': 'h'}],
    }).encode()
    got = M.redact_body(raw, 'application/json').decode()
    assert 'EMAIL_PASSWORD' in got and '"h"' in got  # 先断言「有」
    assert 'smtp-auth-code' not in got


# --------------------------------------------------------------------------- 名单漏掉的凭据字段


def test_login_response_tokens_are_redacted():
    """🔴 登录 / 刷新 / 二次验证的响应体里是 `access_token`，原来不在名单里 —— 本机开发库实测 109 条 `/auth/login`
    的操作日志明文留着访问令牌，有操作日志查看权限的人在令牌有效期内拿它就能冒用"""
    raw = json.dumps({'code': 200, 'data': {'access_token': 'eyJhbGciOi.payload.sig', 'session_uuid': 's'}}).encode()
    got = M.redact_body(raw, 'application/json').decode()
    assert 'session_uuid' in got  # 先断言「有」
    assert 'eyJhbGciOi' not in got


def test_ai_provider_api_key_is_redacted():
    """🔴 模型密钥的请求体字段叫 `api_key`，原来不在名单里：新建 / 编辑时模型的 API Key 明文进操作日志"""
    got = M.desensitization({'json': {'name': 'DeepSeek', 'api_key': 'sk-live-0123456789'}})
    assert got['json']['name'] == 'DeepSeek'
    assert got['json']['api_key'] == '[REDACTED]'


#: 名字像凭据、其实不是的字段（各写一句为什么）。新加的字段名撞上 `_CREDENTIAL_LIKE` 又不在打码名单里，
#: 守卫就红 —— 要么进 `OPERA_LOG_REDACT_KEYS`，要么在这里说清楚它为什么不是凭据
_NOT_CREDENTIALS = {
    'token_type': '固定值 Bearer',
    'access_token_expire_time': '过期时间',
    'refresh_token_expire_time': '过期时间',
    'secret_hint': '密钥前几位，界面上就显示着',
    'secret_mask': '掩码',
    'api_key_mask': '掩码',
    'token_hint': '令牌前几位',
    'has_secret': '有没有配，布尔',
    'clear_sign_secret': '要不要清掉，布尔',
    'encrypt_key_ready': '服务端配没配加密密钥，布尔',
    'secret_field': '凭据字段的名字（短信厂商描述）',
    'secret_label': '凭据字段的显示名',
    'keyed': '防篡改链配没配密钥，布尔',
    'other_key': '换密钥之前签的行数',
    'prompt_tokens': 'AI 用量计数',
    'completion_tokens': 'AI 用量计数',
    'credential': '短信厂商的凭据字段描述（字段名、显示名），不是值',
    'secret_id': '腾讯云的 SecretId，相当于 AccessKey ID（公开标识）；只在 SDK 的配置模型里，请求里叫 access_key_id',
    'secret_prev_expire_time': '旧签名密钥的过期时间',
    'password_expire_days_remaining': '密码还剩几天过期',
}
_CREDENTIAL_LIKE = re.compile(r'password|secret|token|api_?key|credential', re.IGNORECASE)


def test_every_credential_like_field_in_the_api_is_redacted():
    """守卫：请求 / 响应 schema 里名字像凭据的字段，都要在 `OPERA_LOG_REDACT_KEYS` 里。
    `api_key`、`access_token` 都是这么漏的：名单是按字段名一个个加的，新接口用了个新名字就没人想起来"""
    from pydantic import BaseModel
    from pydantic_settings import BaseSettings

    import backend.main  # ruff: ignore[unused-import] —— 把各模块、各插件的 schema 都 import 进来

    def walk(cls: type) -> set[type]:
        out = set()
        for sub in cls.__subclasses__():
            out |= {sub, *walk(sub)}
        return out

    names = {
        name
        for model in walk(BaseModel)
        if model.__module__.startswith('backend.') and not issubclass(model, BaseSettings)
        for name in getattr(model, 'model_fields', {})
        if _CREDENTIAL_LIKE.search(name)
    }
    assert {'password', 'api_key', 'access_token'} <= names, '前置：扫得到真接口的 schema'
    missing = sorted(names - set(settings.OPERA_LOG_REDACT_KEYS) - set(_NOT_CREDENTIALS))
    assert not missing, f'这些字段名像凭据、操作日志却不打码：{missing}'


@pytest.mark.parametrize('content_type', [b'application/merge-patch+json', b'text/plain', b'application/x-unknown'])
def test_a_json_body_under_another_content_type_is_still_redacted(content_type: bytes) -> None:
    """#283 评审：FastAPI 把 `*+json` 也按 JSON 解析，中间件原来只认 `application/json`，其余一律原样记文本 ——
    `merge-patch+json` 发的 `api_key`、`text/plain` 发的密码（路由层 422，但中间件在它前面）都明文进日志"""
    body = json.dumps({'name': 'x', 'api_key': 'sk-live-plain', 'password': 'P@ss-plain'}).encode()
    args = _request_args_for('/sys/users/me', body, content_type)
    dumped = json.dumps(args, ensure_ascii=False)
    assert '"name": "x"' in dumped  # 先断言「有」
    assert 'sk-live-plain' not in dumped and 'P@ss-plain' not in dumped, dumped


def test_a_non_json_text_body_is_still_logged_as_text() -> None:
    """对照：读不成 JSON 的纯文本照旧原样记（没有可按字段打码的结构）"""
    args = _request_args_for('/sys/users/me', b'just some text', b'text/plain')
    assert args == {'data': 'just some text'}


def test_a_broken_plus_json_body_is_not_logged_in_plain_text() -> None:
    """`*+json` 要和 `application/json` 走同一支：解析不了就记占位。只靠「先当文本、能解析就打码」兜的话，
    截断的 `merge-patch+json` 读不成 JSON，会原样当文本记下来"""
    body = b'{"api_key": "sk-live-cut", "name": "x'
    args = _request_args_for('/sys/users/me', body, b'application/merge-patch+json')
    assert args and args['body']['_invalid_json'] is True
    assert 'sk-live-cut' not in json.dumps(args, ensure_ascii=False)
