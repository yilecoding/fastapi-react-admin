"""迁移 `aq000000operalogsecret`：已经写进 `sys_opera_log` 的凭据要清掉。

按修之前真会写出来的几种形状往库里垫行（参数配置新建的 JSON · 批量保存的 repr · 完整的响应体 · 截断过的响应体 ·
登录响应里的访问令牌 · 模型密钥的 api_key），
跑 `scrub_logged_secrets`，再从库里读回来。走真库是因为 `args` 是 JSON 列：三个方言的读写各不相同，
函数在内存里对了不等于在库里对了。
"""

import asyncio
import json
import random
import uuid

from collections.abc import Iterator
from typing import Any

import pytest
import sqlalchemy as sa

from backend.app.admin.model import OperaLog
from backend.app.admin.utils.opera_log_scrub import SCRUBBED, SCRUBBED_VIEW, scrub_logged_secrets
from backend.database.db import create_database_async_engine, get_database_url
from backend.utils.timezone import timezone

_RUN = uuid.uuid4().hex[:8]
TRACE = f'pytest-olscrub-{_RUN}'
_BASE_ID = random.randint(8_000_000_000_000_000_000, 8_100_000_000_000_000_000)
CONFIGS = '/api/v1/sys/configs'

_ROW = {'key': 'EMAIL_PASSWORD', 'name': 'SMTP 授权码', 'value': 'leak-json'}
_HOST = {'key': 'EMAIL_HOST', 'name': 'SMTP 服务器', 'value': 'smtp.visible.example.com'}
#: 修之前会写出来的样子 —— (路径, args, response_body)
LEGACY: dict[str, tuple[str, Any, str | None]] = {
    'create': (CONFIGS, {'json': _ROW}, '{"code": 200, "msg": "请求成功", "data": null}'),
    # 批量保存：列表请求体被 `str()` 成 Python repr，记在 data 里
    'bulk': (CONFIGS, {'data': str([{'id': 1, **_ROW, 'value': 'leak-repr'}, {'id': 2, **_HOST}])}, None),
    'page': (f'{CONFIGS}/all', None, json.dumps({'code': 200, 'data': [{**_ROW, 'value': 'leak-body'}, _HOST]})),
    # 响应超过上限被截断：不是合法 JSON
    'truncated': (
        f'{CONFIGS}/all',
        None,
        '{"code": 200, "data": [{"key": "EMAIL_PASSWORD", "value": "leak-cut", "name": "SMTP 授权码"}, {"ke'
        '\n\n…[已截断，完整响应 20480 字节，上限 10240 字节]',
    ),
    # 对照：截断了但里面没有密钥类的行 —— 不该被清
    'truncated-plain': (f'{CONFIGS}/all', None, '{"code": 200, "data": [{"key": "EMAIL_HOST", "value": "h"}, {"ke'),
    # 名单原来漏掉的字段名：登录响应里的访问令牌（完整的 / 截断的）· 模型密钥的 api_key
    'login': ('/api/v1/auth/login', None, json.dumps({'code': 200, 'data': {'access_token': 'leak-jwt', 'x': 1}})),
    'login-cut': ('/api/v1/auth/refresh', None, '{"code": 200, "data": {"access_token": "leak-jwt-cut", "access_tok'),
    'provider': ('/api/v1/ai/providers', {'json': {'name': 'DeepSeek', 'api_key': 'leak-sk'}}, None),
    # 打开「操作日志」页那次请求自己的日志：响应是一页别人的日志，args 嵌在里面、响应体是转义过的字符串（#283 评审）
    'opera-view': (
        '/api/v1/logs/opera',
        {'query_params': {'page': '1'}},
        json.dumps({
            'code': 200,
            'data': {
                'items': [
                    {
                        'args': {'json': {'api_key': 'leak-view-sk'}},
                        'response_body': json.dumps({'data': [{'key': 'EMAIL_PASSWORD', 'value': 'leak-view-body'}]}),
                    }
                ]
            },
        }),
    ),
    # 对照：新中间件写下的「截断但已打码」—— 重跑不能把它整段换掉（#283 评审：原来不幂等）
    'cut-redacted': (
        f'{CONFIGS}/all',
        None,
        '{"code": 200, "data": [{"key": "EMAIL_PASSWORD", "value": "[REDACTED]", "name": "SMTP 授权码"}, {"ke',
    ),
    # 对照：别的接口，不在扫描范围里，原样不动
    'other': ('/api/v1/sys/users', {'json': {'nickname': 'x'}}, '{"code": 200}'),
}


def _run(work: Any) -> Any:
    async def _go() -> Any:
        engine = create_database_async_engine(get_database_url(unittest=True))
        try:
            async with engine.begin() as conn:
                return await work(conn)
        finally:
            await engine.dispose()

    return asyncio.run(_go())


def _read() -> dict[str, tuple[Any, str | None]]:
    async def work(conn: Any) -> dict[str, tuple[Any, str | None]]:
        t = OperaLog.__table__
        rows = (
            await conn.execute(sa.select(t.c.title, t.c.args, t.c.response_body).where(t.c.trace_id == TRACE))
        ).all()
        return {r.title: (r.args, r.response_body) for r in rows}

    return _run(work)


@pytest.fixture
def legacy_rows() -> Iterator[None]:
    now = timezone.now()
    rows = [
        {
            'id': _BASE_ID + i,
            'trace_id': TRACE,
            'username': 'admin',
            'method': 'PUT',
            'title': name,  # 拿 title 认是哪一行
            'path': path,
            'ip': '127.0.0.1',
            'args': args,
            'response_body': body,
            'status': 1,
            'code': '200',
            'cost_time': 1.0,
            'opera_time': now,
            'created_time': now,
        }
        for i, (name, (path, args, body)) in enumerate(LEGACY.items())
    ]

    async def insert(conn: Any) -> None:
        await conn.execute(sa.insert(OperaLog.__table__), rows)

    async def purge(conn: Any) -> None:
        await conn.execute(sa.delete(OperaLog.__table__).where(OperaLog.__table__.c.trace_id == TRACE))

    _run(insert)
    try:
        yield
    finally:
        _run(purge)


@pytest.mark.usefixtures('legacy_rows')
def test_secrets_already_in_the_opera_log_are_scrubbed() -> None:
    before = _read()
    # 先断言「有」：垫进去的确实是泄漏的样子（JSON 列读回来是结构，不是字符串）
    assert before['create'][0]['json']['value'] == 'leak-json'
    assert 'leak-repr' in before['bulk'][0]['data']

    changed = _run(lambda conn: conn.run_sync(scrub_logged_secrets))
    after = _read()
    dumped = {name: json.dumps(args, ensure_ascii=False) + (body or '') for name, (args, body) in after.items()}
    for name, text in dumped.items():
        assert 'leak-' not in text, f'{name} 还留着密钥：{text}'

    assert after['create'][0] == {'json': {**_ROW, 'value': '[REDACTED]'}}
    # repr 读回结构、按新写法放进 json：键名和普通参数的值都还在，看得出那次改了什么
    assert after['bulk'][0] == {'json': [{'id': 1, **_ROW, 'value': '[REDACTED]'}, {'id': 2, **_HOST}]}
    assert json.loads(after['page'][1])['data'] == [{**_ROW, 'value': '[REDACTED]'}, _HOST]
    assert after['truncated'][1] == SCRUBBED
    assert json.loads(after['login'][1])['data'] == {'access_token': '[REDACTED]', 'x': 1}
    assert after['login-cut'][1] == SCRUBBED
    assert after['provider'][0] == {'json': {'name': 'DeepSeek', 'api_key': '[REDACTED]'}}
    assert after['opera-view'][1] == SCRUBBED_VIEW
    assert after['cut-redacted'] == before['cut-redacted']
    # 对照：没有密钥的截断响应、别的接口，原样不动
    assert after['truncated-plain'] == before['truncated-plain']
    assert after['other'] == before['other']
    # 共享的测试库里可能还有别的日志在扫描范围里，所以只能断言「至少」这 8 行
    assert changed >= 8

    # 再跑一遍：清过的行不再变
    _run(lambda conn: conn.run_sync(scrub_logged_secrets))
    assert _read() == after
