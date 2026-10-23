"""参数配置键名重复要报 409，不是 500。

🔴 原来 `t('error.config.key_exists', key=obj.key)` 和 `t()` 自己的第一个参数 `key` 撞名，
`TypeError: got multiple values for argument 'key'` —— 只在**撞重复**那一刻才炸，
平时的请求一条都碰不到它。修在 `t()` 的签名上（仅位置参数），这条钉住用户看得到的那一侧
"""

import asyncio
import uuid

from collections.abc import Iterator

import pytest

from sqlalchemy import delete
from starlette.testclient import TestClient

from backend.database.db import create_database_async_engine, get_database_url
from backend.plugin.config.model import Config

KEY = f'PYTEST_CONFLICT_{uuid.uuid4().hex[:8].upper()}'


@pytest.fixture
def _purge() -> Iterator[None]:
    yield

    async def _run() -> None:
        engine = create_database_async_engine(get_database_url(unittest=True))
        try:
            async with engine.begin() as conn:
                # 走模型不写裸 SQL：`key` 在 MySQL 是保留字，而双引号在 MySQL 里是字符串 —— 会静静地一行都不删
                await conn.execute(delete(Config.__table__).where(Config.__table__.c.key == KEY))
        finally:
            await engine.dispose()

    asyncio.run(_run())


@pytest.mark.usefixtures('_purge')
def test_a_duplicate_config_key_is_a_conflict_not_a_crash(client: TestClient, token_headers: dict[str, str]) -> None:
    body = {'name': 'pytest', 'key': KEY, 'value': 'x', 'is_frontend': False}
    first = client.post('/sys/configs', headers=token_headers, json=body)
    assert first.json()['code'] == 200, first.text  # 先断言「有」：第一条建得出来

    second = client.post('/sys/configs', headers=token_headers, json=body)
    assert second.status_code == 409, second.text
    assert KEY in second.json()['msg']
