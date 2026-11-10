"""把已经写进 `sys_opera_log` 的凭据打码（迁移 `aq000000operalogsecret` 调它）。

中间件原来漏了三类（`middleware` 分册）：参数配置的 key / value 形状（要打码的字段就叫 `value`）、列表请求体
（被 `str()` 成 Python repr、一个字符都不打码）、名单里没有的字段名
（`access_token` · `api_key` · `import_token` · `token`）。
中间件修好之后，**已经写进去的那些行**要另外清：它们留在表里，有操作日志查看权限的人都看得到。

只扫会写出这些东西的接口（`_PATHS`）：参数配置 · 登录 / 刷新 / 二次验证（响应里的访问令牌）· AI（模型密钥、确认令牌）·
导入（导入令牌）。打码的规则就是中间件那一条（`desensitization`），清完的行和新写的行长得一样。

🔴 **还有一处副本：打开「操作日志」页的那次请求本身也记了一条**（#283 评审）。它的响应体是一页别人的日志：
`args` 嵌在 JSON 里（`desensitization` 递归得到），响应体却是**转义过的字符串**（`\"key\": \"EMAIL_PASSWORD\"`），
既递归不进去、上面两条正则也认不出。这种行的响应体整段换成占位（它只是「谁看了一眼日志列表」）。

- `args` 里的 JSON、完整的 JSON 响应体：过一遍 `desensitization`
- `args.data` 里那段 repr（批量保存参数配置）：`ast.literal_eval` 读回来（只含 JSON 的值，读得回来），
  过 `desensitization`，按新写法放进 `args.json`
- 🔴 读不回来（响应超过上限被截断、repr 读不回来）而且里面有凭据：整段换成一句占位。
  结构读不出来就没法逐项打码，同中间件的 fail-closed
"""

import ast
import json
import re

from typing import Any

import sqlalchemy as sa

from sqlalchemy.engine import Connection

from backend.common.model import UniversalStr, UniversalText
from backend.common.secret_keys import is_secret_key_name
from backend.core.conf import settings
from backend.middleware.opera_log_middleware import OperaLogMiddleware

_PATHS = ('%/configs%', '%/auth/%', '%/ai/%', '%/import/%', '%/logs/opera%')
#: 文本里的 `"key": "EMAIL_PASSWORD"` / repr 里的 `'key': 'EMAIL_PASSWORD'`，抓出键名交给同一条规则判断
_KEY_IN_TEXT = re.compile(r"""["']key["']\s*:\s*["']([^"']*)["']""")
#: 文本里的 `"access_token": "<不是已打码的值>"`
_FIELD_IN_TEXT = re.compile(r"""["'](\w+)["']\s*:\s*["'](?!\[REDACTED\])""")
SCRUBBED = '[已清理：这里有凭据，原文读不回结构、无法逐项打码]'
SCRUBBED_VIEW = '[已清理：查看操作日志的这次请求，响应里是别的日志的原文]'
#: 同一个对象里的 `"value": "<不是已打码的值>"`
_VALUE_IN_TEXT = re.compile(r"""["']value["']\s*:\s*["'](?!\[REDACTED\])""")

_LOG = sa.Table(
    'sys_opera_log',
    sa.MetaData(),
    sa.Column('id', sa.BigInteger(), primary_key=True, autoincrement=False),
    sa.Column('path', UniversalStr(512)),
    sa.Column('args', sa.JSON()),
    sa.Column('response_body', UniversalText()),
)


def _has_secret(text: str) -> bool:
    for m in _KEY_IN_TEXT.finditer(text):
        if not is_secret_key_name(m.group(1)):
            continue
        # 看同一个对象（前一个 `{` 到后一个 `}`，截断的话到文本末尾）里的 value 有没有打过码 ——
        # 不看的话新中间件写下的「截断但已打码」的行会被整段换掉（#283 评审：重跑不幂等）
        start = text.rfind('{', 0, m.start()) + 1
        end = text.find('}', m.end())
        if _VALUE_IN_TEXT.search(text[start : end if end != -1 else len(text)]):
            return True
    redact = set(settings.OPERA_LOG_REDACT_KEYS)
    return any(m.group(1) in redact for m in _FIELD_IN_TEXT.finditer(text))


def scrub_args(args: Any) -> Any:
    """请求参数（JSON 列反序列化之后）。没有要改的原样返回同一个对象"""
    if not isinstance(args, dict):
        return args
    out = OperaLogMiddleware.desensitization(args)
    data = out.get('data')
    if isinstance(data, str) and _has_secret(data):
        try:
            parsed = ast.literal_eval(data)
        except (ValueError, SyntaxError, MemoryError, RecursionError):
            out['data'] = SCRUBBED
        else:
            del out['data']
            out['json'] = OperaLogMiddleware.desensitization(parsed)
    return args if out == args else out


def scrub_response_body(body: str | None, path: str = '') -> str | None:
    """响应体（文本列）。没有要改的原样返回"""
    if not body:
        return body
    if '/logs/opera' in path and ('"args"' in body or '"response_body"' in body):
        return SCRUBBED_VIEW
    try:
        payload = json.loads(body)
    except ValueError:
        return SCRUBBED if _has_secret(body) else body
    redacted = OperaLogMiddleware.desensitization(payload)
    return body if redacted == payload else json.dumps(redacted, ensure_ascii=False)


def scrub_logged_secrets(conn: Connection, *, batch: int = 500) -> int:
    """按主键分批扫一遍，返回改了几行。可以重复跑（清过的行再跑一遍不变）"""
    changed = 0
    last_id: int | None = None
    where = sa.or_(*(_LOG.c.path.like(p) for p in _PATHS))
    while True:
        query = sa.select(_LOG.c.id, _LOG.c.path, _LOG.c.args, _LOG.c.response_body).where(where)
        if last_id is not None:
            query = query.where(_LOG.c.id > last_id)
        rows = conn.execute(query.order_by(_LOG.c.id).limit(batch)).all()
        if not rows:
            return changed
        for row in rows:
            args = scrub_args(row.args)
            body = scrub_response_body(row.response_body, row.path)
            if args is not row.args or body is not row.response_body:
                conn.execute(sa.update(_LOG).where(_LOG.c.id == row.id).values(args=args, response_body=body))
                changed += 1
        last_id = rows[-1].id
