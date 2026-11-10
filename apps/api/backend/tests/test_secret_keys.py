"""「哪些键名的值是密钥」：后端这条规则和前端参数配置页打码的那条必须是同一条。

两份是不得不有的（前端打码、后端打码 / 审计各自要判断），但分叉了就是静默的：前端藏起来的值，
操作日志和数据变更记录里照样是明文。原来就分叉过 —— 后端区分大小写、没有 CREDENTIALS。
"""

import pathlib
import re

import pytest

from backend.common.secret_keys import SECRET_KEY_NAME, is_secret_key_name


def _repo_root() -> pathlib.Path:
    here = pathlib.Path(__file__).resolve()
    return next(p for p in here.parents if (p / 'pnpm-workspace.yaml').exists())


def test_the_rule_is_the_same_as_the_frontend_config_page() -> None:
    src = (_repo_root() / 'packages/platform/src/pages/config/api.ts').read_text(encoding='utf-8')
    found = re.search(r'export const isSecret = \(key: string\) => /(.+?)/([a-z]*)\.test\(key\)', src)
    assert found, '前端 isSecret 的写法变了，对账读不到 —— 改这里的正则，别删这条测试'
    pattern, flags = found.groups()
    assert pattern == SECRET_KEY_NAME.pattern
    assert ('i' in flags) == bool(SECRET_KEY_NAME.flags & re.IGNORECASE)


@pytest.mark.parametrize(
    'key',
    ['EMAIL_PASSWORD', 'smtp_password', 'OSS_SECRET', 'WECHAT_TOKEN', 'MAP_API_KEY', 'MAP_APIKEY', 'GCP_CREDENTIALS'],
)
def test_secret_by_suffix_ignoring_case(key: str) -> None:
    assert is_secret_key_name(key)


# 后缀匹配：`USER_PASSWORD_MIN_LENGTH` 是策略不是密码；不是字符串的一律不算
@pytest.mark.parametrize('key', ['USER_PASSWORD_MIN_LENGTH', 'TOKEN_EXPIRE_SECONDS', 'EMAIL_HOST', None, 123])
def test_not_secret(key: object) -> None:
    assert not is_secret_key_name(key)
