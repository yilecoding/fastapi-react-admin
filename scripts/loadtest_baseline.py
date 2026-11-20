#!/usr/bin/env python3
"""压测的对照组：同样的 FastAPI + uvicorn，但不带本项目的任何中间件、鉴权和审计。

给「性能与容量」页的数字找参照物 —— 光说「每秒 190 次」，读者不知道这算快还是慢。
同一台机器上测两个对照接口，和本项目的完整链路放在一起看：

    /ping    固定返回一段 JSON，什么都不做 —— FastAPI 本身的上限
    /users   一次分页查询：count + 取 20 行（同一个库、同样的连接池参数）—— 最简单的业务接口

起法（在 apps/api 下，复用后端的依赖）：

    BASELINE_DB_URL=postgresql+asyncpg://user:pass@127.0.0.1:5432/fba \\
      uv run python -m uvicorn --app-dir ../../scripts loadtest_baseline:app --port 8098

压法：

    pnpm loadtest --base-url http://127.0.0.1:8098 --path /ping --token x
    pnpm loadtest --base-url http://127.0.0.1:8098 --path /users --token x

`--token x` 只是让脚本跳过登录（这个对照服务不校验它）。响应照样包成 `{"code": 200, ...}`，
所以压测脚本按同一套「看信封」的规则判成败。
"""

import os

from fastapi import FastAPI
from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine

# 开着 /openapi 只为让压测开头那行认得出对方是对照组（见 loadtest.py 的 identify）
app = FastAPI(title='loadtest-baseline', docs_url=None, redoc_url=None, openapi_url='/openapi')

# 连接池参数和本项目默认值一致（database/db.py）：比的是「多了哪些功能」，不是「连接池调得好不好」
_engine = (
    create_async_engine(
        os.environ['BASELINE_DB_URL'], pool_size=10, max_overflow=20, pool_recycle=3600, pool_pre_ping=True
    )
    if os.environ.get('BASELINE_DB_URL')
    else None
)


@app.get('/ping')
async def ping() -> dict:
    return {'code': 200, 'msg': '请求成功', 'data': {'pong': True}}


@app.get('/users')
async def users() -> dict:
    if _engine is None:
        return {'code': 500, 'msg': '没配 BASELINE_DB_URL', 'data': None}
    async with _engine.connect() as conn:
        total = (await conn.execute(text('SELECT count(*) FROM sys_user WHERE deleted = 0'))).scalar_one()
        rows = (
            await conn.execute(
                text(
                    'SELECT id, username, nickname, email, status, created_time '
                    'FROM sys_user WHERE deleted = 0 ORDER BY id LIMIT 20'
                )
            )
        ).mappings()
        items = [{**r, 'id': str(r['id']), 'created_time': r['created_time'].isoformat()} for r in rows]
    return {'code': 200, 'msg': '请求成功', 'data': {'items': items, 'total': total}}
