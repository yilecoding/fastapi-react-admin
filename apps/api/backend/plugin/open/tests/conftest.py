import asyncio
import importlib.util
import json
import os

from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest

from sqlalchemy import delete, select
from starlette.testclient import TestClient

from backend.core.conf import settings
from backend.database.db import create_database_async_engine, create_database_async_session, get_database_url
from backend.plugin.open.model import OpenApiLog, OpenApp

SDK_DIR = Path(__file__).resolve().parents[1] / 'sdk'
MGMT = '/open-apps'
OPEN_BASE = 'http://testserver/api/open/v1'
CODE_PREFIX = 'PYTEST_'


def _load_sdk() -> Any:
    """按文件路径加载 Python 参考实现 —— 它是给对方整个拷走的独立文件，不是 backend 的一部分"""
    spec = importlib.util.spec_from_file_location('fra_open_sign', SDK_DIR / 'python' / 'fra_open_sign.py')
    module = importlib.util.module_from_spec(spec)  # type: ignore[arg-type]
    spec.loader.exec_module(module)  # type: ignore[union-attr]
    return module


sdk = _load_sdk()


def run_db(fn: Any) -> Any:
    """每次起独立的异步引擎（复用全局引擎会撞上「Future attached to a different loop」，task 分册记过）"""

    async def _do() -> Any:
        engine = create_database_async_engine(get_database_url(unittest=True))
        try:
            async with create_database_async_session(engine)() as db:
                result = await fn(db)
                await db.commit()
                return result
        finally:
            await engine.dispose()

    return asyncio.run(_do())


@pytest.fixture(autouse=True)
def _secret_key() -> Iterator[None]:
    original = settings.OPEN_SECRET_KEY
    settings.OPEN_SECRET_KEY = os.urandom(32).hex()
    yield
    settings.OPEN_SECRET_KEY = original


@pytest.fixture(autouse=True)
def _purge() -> Iterator[None]:
    """硬删本目录建的应用和它们的调用日志（接口的删除是逻辑删除）"""
    yield

    async def _do(db: Any) -> None:
        ids = list((await db.execute(select(OpenApp.id).where(OpenApp.code.like(f'{CODE_PREFIX}%')))).scalars())
        if ids:
            await db.execute(delete(OpenApiLog).where(OpenApiLog.app_id.in_(ids)))
        await db.execute(delete(OpenApiLog).where(OpenApiLog.access_key.like('fra_ak_PYTEST%')))
        await db.execute(delete(OpenApp).where(OpenApp.code.like(f'{CODE_PREFIX}%')))

    run_db(_do)


def create_app(client: TestClient, headers: dict[str, str], suffix: str = 'A', **cfg: Any) -> dict[str, Any]:
    body = {'code': f'{CODE_PREFIX}{suffix}', 'name': '测试系统', 'scopes': ['user:read', 'dept:read'], **cfg}
    response = client.post(MGMT, headers=headers, json=body)
    assert response.json()['code'] == 200, response.text
    return response.json()['data']


def signed_get(
    client: TestClient,
    issued: dict[str, Any],
    path: str,
    *,
    params: str = '',
    secret: str | None = None,
    timestamp: str | None = None,
    nonce: str | None = None,
    extra_headers: dict[str, str] | None = None,
) -> Any:
    url = f'{OPEN_BASE}{path}' + (f'?{params}' if params else '')
    headers = sdk.sign_headers(
        'GET',
        url,
        b'',
        access_key=issued['access_key'],
        secret_key=secret or issued['secret_key'],
        timestamp=timestamp,
        nonce=nonce,
    )
    return client.get(url, headers={**headers, **(extra_headers or {})})


def logs_of(app_id: str | int) -> list[OpenApiLog]:
    async def _do(db: Any) -> list[OpenApiLog]:
        rows = (
            await db.execute(select(OpenApiLog).where(OpenApiLog.app_id == int(app_id)).order_by(OpenApiLog.id))
        ).scalars()
        return list(rows)

    return run_db(_do)


def vectors() -> dict[str, Any]:
    return json.loads((SDK_DIR / 'test_vectors.json').read_text(encoding='utf-8'))
