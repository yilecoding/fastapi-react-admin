"""把已经写进 `sys_opera_log` 的参数配置密钥打码（迁移 `aq000000operalogsecret` 调它）。

操作日志原来认不出参数配置里的密钥（`{"key": "EMAIL_PASSWORD", "value": …}`，要打码的字段就叫 `value`），
批量保存的请求体还被 `str()` 成一段 Python repr、一个字符都不打码（`middleware` 分册）。中间件修好之后，
**已经写进去的那些行**要另外清：它们留在表里，有操作日志查看权限的人都看得到。

只扫路径里带 `/configs` 的行：会把参数配置的行写进请求 / 响应的只有参数配置那一组接口
（列表体的接口也只有它的批量保存）。打码的规则就是中间件那一条（`desensitization`），清完的行和新写的行长得一样。

- `args` 里的 JSON（新建 / 编辑）、完整的 JSON 响应体：过一遍 `desensitization`
- `args.data` 里那段 repr（批量保存）：`ast.literal_eval` 读回来（只含 JSON 的值，读得回来），
  过 `desensitization`，按新写法放进 `args.json`
- 🔴 读不回来（响应超过上限被截断、repr 读不回来）而且里面有像密钥的键：整段换成一句占位。
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
from backend.middleware.opera_log_middleware import OperaLogMiddleware

#: 文本里的 `"key": "EMAIL_PASSWORD"` / repr 里的 `'key': 'EMAIL_PASSWORD'`，抓出键名交给同一条规则判断
_KEY_IN_TEXT = re.compile(r"""["']key["']\s*:\s*["']([^"']*)["']""")
SCRUBBED = '[已清理：这里有参数配置的密钥，原文读不回结构、无法逐项打码]'

_LOG = sa.Table(
    'sys_opera_log',
    sa.MetaData(),
    sa.Column('id', sa.BigInteger(), primary_key=True, autoincrement=False),
    sa.Column('path', UniversalStr(512)),
    sa.Column('args', sa.JSON()),
    sa.Column('response_body', UniversalText()),
)


def _has_secret_row(text: str) -> bool:
    return any(is_secret_key_name(m.group(1)) for m in _KEY_IN_TEXT.finditer(text))


def scrub_args(args: Any) -> Any:
    """请求参数（JSON 列反序列化之后）。没有要改的原样返回同一个对象"""
    if not isinstance(args, dict):
        return args
    out = OperaLogMiddleware.desensitization(args)
    data = out.get('data')
    if isinstance(data, str) and _has_secret_row(data):
        try:
            parsed = ast.literal_eval(data)
        except (ValueError, SyntaxError, MemoryError, RecursionError):
            out['data'] = SCRUBBED
        else:
            del out['data']
            out['json'] = OperaLogMiddleware.desensitization(parsed)
    return args if out == args else out


def scrub_response_body(body: str | None) -> str | None:
    """响应体（文本列）。没有要改的原样返回"""
    if not body:
        return body
    try:
        payload = json.loads(body)
    except ValueError:
        return SCRUBBED if _has_secret_row(body) else body
    redacted = OperaLogMiddleware.desensitization(payload)
    return body if redacted == payload else json.dumps(redacted, ensure_ascii=False)


def scrub_config_secrets(conn: Connection, *, batch: int = 500) -> int:
    """按主键分批扫一遍，返回改了几行。可以重复跑（清过的行再跑一遍不变）"""
    changed = 0
    last_id: int | None = None
    while True:
        query = sa.select(_LOG.c.id, _LOG.c.args, _LOG.c.response_body).where(_LOG.c.path.like('%/configs%'))
        if last_id is not None:
            query = query.where(_LOG.c.id > last_id)
        rows = conn.execute(query.order_by(_LOG.c.id).limit(batch)).all()
        if not rows:
            return changed
        for row in rows:
            args = scrub_args(row.args)
            body = scrub_response_body(row.response_body)
            if args is not row.args or body is not row.response_body:
                conn.execute(sa.update(_LOG).where(_LOG.c.id == row.id).values(args=args, response_body=body))
                changed += 1
        last_id = rows[-1].id
