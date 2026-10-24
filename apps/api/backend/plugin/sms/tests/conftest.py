"""短信插件测试的公共夹具。

- `encrypt_key`：给 `SMS_ENCRYPT_SECRET_KEY` 一个临时值（.env 里没配的话带凭据的配置存不进去）
- `purge_sms_rows`：硬删本轮建的 `sms_config` / `sms_log`（配置接口的删除是逻辑删除，日志不会自己清）
- `make_config`：经**真实接口**建一条配置，返回详情 dict
"""

from __future__ import annotations

import asyncio
import os

from typing import TYPE_CHECKING, Any

import pytest

from sqlalchemy import delete

from backend.core.conf import settings
from backend.database.db import create_database_async_engine, create_database_async_session, get_database_url
from backend.plugin.sms.model import SmsConfig, SmsLog

if TYPE_CHECKING:
    from collections.abc import Callable, Iterator

    from starlette.testclient import TestClient

CONFIGS = '/sms/configs'
LOGS = '/sms/logs'
#: 本轮建的配置都带这个前缀，收尾按它硬删
NAME_PREFIX = 'pytest-sms-'
#: 测试用的号码段：真实号码里 `1999xxxxxxx` 是电信的，这里只在控制台厂商上用，不会真发
PHONE_A = '19900000001'
PHONE_B = '19900000002'
PHONE_C = '19900000003'


def run_sync(coro: Any) -> Any:
    """在独立引擎 / 独立循环里做数据库清理（不能复用绑在 TestClient 循环上的会话）"""
    return asyncio.run(coro)


async def _purge() -> None:
    engine = create_database_async_engine(get_database_url(unittest=True))
    try:
        async with create_database_async_session(engine)() as db:
            await db.execute(delete(SmsLog).where(SmsLog.phone.in_([PHONE_A, PHONE_B, PHONE_C])))
            await db.execute(delete(SmsConfig).where(SmsConfig.name.like(f'{NAME_PREFIX}%')))
            await db.commit()
    finally:
        await engine.dispose()


@pytest.fixture(autouse=True)
def purge_sms_rows() -> Iterator[None]:
    """前后各清一次：上一轮崩掉留下的 live 行会让「同名已存在」误伤这一轮"""
    run_sync(_purge())
    yield
    run_sync(_purge())


@pytest.fixture
def encrypt_key(monkeypatch: pytest.MonkeyPatch) -> str:
    key = os.urandom(32).hex()
    monkeypatch.setattr(settings, 'SMS_ENCRYPT_SECRET_KEY', key)
    return key


@pytest.fixture
def make_config(client: TestClient, token_headers: dict[str, str], encrypt_key: str) -> Callable[..., dict[str, Any]]:
    """经真实接口建一条配置并读回详情。默认是控制台厂商 + captcha 模板"""

    def _make(suffix: str = 'a', **overrides: Any) -> dict[str, Any]:
        body: dict[str, Any] = {
            'name': f'{NAME_PREFIX}{suffix}',
            'provider': 'console',
            'sign_name': '测试签名',
            'templates': {'captcha': {'template_id': 'DEV_CAPTCHA', 'mapping': {'code': 'code', 'minutes': 'minutes'}}},
            **overrides,
        }
        res = client.post(CONFIGS, headers=token_headers, json=body)
        assert res.status_code == 200 and res.json()['code'] == 200, res.text
        listing = client.get(
            CONFIGS, headers=token_headers, params={'name': body['name'], 'page': 1, 'size': 10}
        ).json()
        items = [i for i in listing['data']['items'] if i['name'] == body['name']]
        assert len(items) == 1, listing
        return items[0]

    return _make
