"""按「键名」判断一个值是不是密钥：参数配置那种 `{"key": "EMAIL_PASSWORD", "value": "…"}` 的行。

字段名本身（`value`）看不出敏感，只能看同一行里的键名。三处共用这一条规则，**别各写一份**：

- 前端参数配置页打码：`packages/platform/src/pages/config/api.ts: isSecret`（`tests/test_secret_keys.py` 对账）
- 数据变更审计只记「改过」：`plugin/config/data_change.py`
- 操作日志打码：`middleware/opera_log_middleware.py: desensitization`

🔴 **后缀匹配，不是包含**：`USER_PASSWORD_MIN_LENGTH` 是策略，不是密码。**不分大小写**：管理员自己加的键可能是小写。
原来后端这份是区分大小写、没有 `CREDENTIALS` 的，和前端对不上（数据变更审计会把 `smtp_password` 的值原样记下来）。
"""

import re

SECRET_KEY_NAME = re.compile(r'(PASSWORD|SECRET|TOKEN|API_?KEY|CREDENTIALS?)$', re.IGNORECASE)


def is_secret_key_name(key: object) -> bool:
    """这个键名下的值是不是密钥。不是字符串的一律不算"""
    return isinstance(key, str) and SECRET_KEY_NAME.search(key) is not None
