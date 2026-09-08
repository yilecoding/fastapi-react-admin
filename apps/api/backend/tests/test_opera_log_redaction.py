"""操作日志的脱敏。

🔴 **这两条防的是同一件事：日志表本身变成凭据泄露面。** 改动前有两个洞，
都是静默的 —— 日志照常写、字段照常在，只是没打码：

1. `desensitization()` 只看**顶层** key，任何嵌一层的 `password` 全漏
2. **响应体根本不过脱敏** —— 它只被截断，然后原样落进 `sys_opera_log.response_body`
"""

import json

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
