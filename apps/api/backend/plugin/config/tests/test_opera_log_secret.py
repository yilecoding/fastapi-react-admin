"""参数配置里的密钥（SMTP 授权码之类）不能进操作日志。

🔴 参数配置的一行是 `{"key": "EMAIL_PASSWORD", "value": "<授权码>"}`。
操作日志按**字段名**打码（`OPERA_LOG_REDACT_KEYS`），
而要打码的那个字段叫 `value` —— 名单里永远不会有它。于是新建 / 编辑 / 批量保存的请求体、打开参数配置页的响应体，
都把授权码原样写进了 `sys_opera_log`。现在中间件认 key / value 这种形状，按键名判断（`common/secret_keys.py`）。

走真接口、截住入队的那一条：单测证明得了 `desensitization()` 对，证明不了每条路都经过它。
"""

import asyncio
import json
import uuid

from collections.abc import Iterator

import pytest

from sqlalchemy import delete
from starlette.testclient import TestClient

from backend.app.admin.schema.opera_log import CreateOperaLogParam
from backend.database.db import create_database_async_engine, get_database_url
from backend.middleware.opera_log_middleware import OperaLogMiddleware
from backend.plugin.config.model import Config

_RUN = uuid.uuid4().hex[:8].upper()
TYPE = f'pytest_olr_{_RUN.lower()}'
SECRET_KEY = f'PYTEST_{_RUN}_SMTP_PASSWORD'
PLAIN_KEY = f'PYTEST_{_RUN}_SMTP_HOST'
#: 每一步写进去的密钥都不一样，哪一步漏了一眼看得出
SECRETS = [f'olr-secret-{i}-{_RUN}' for i in range(3)]
VISIBLE = f'smtp.{_RUN.lower()}.example.com'


@pytest.fixture
def captured(monkeypatch: pytest.MonkeyPatch) -> Iterator[list[CreateOperaLogParam]]:
    logs: list[CreateOperaLogParam] = []

    def _capture(_cls: type, opera_log_in: CreateOperaLogParam) -> bool:
        logs.append(opera_log_in)
        return True

    monkeypatch.setattr(OperaLogMiddleware, 'enqueue', classmethod(_capture))
    yield logs

    async def _purge() -> None:
        engine = create_database_async_engine(get_database_url(unittest=True))
        try:
            async with engine.begin() as conn:
                # 走模型不写裸 SQL：`key` 在 MySQL 是保留字
                await conn.execute(delete(Config.__table__).where(Config.__table__.c.type == TYPE))
        finally:
            await engine.dispose()

    asyncio.run(_purge())


def _row(key: str, value: str) -> dict[str, object]:
    return {'name': 'pytest', 'type': TYPE, 'key': key, 'value': value, 'is_frontend': False}


def test_secret_config_values_never_reach_the_opera_log(
    client: TestClient, token_headers: dict[str, str], captured: list[CreateOperaLogParam]
) -> None:
    for body in (_row(SECRET_KEY, SECRETS[0]), _row(PLAIN_KEY, VISIBLE)):
        assert client.post('/sys/configs', headers=token_headers, json=body).json()['code'] == 200
    rows = client.get('/sys/configs/all', headers=token_headers, params={'type': TYPE}).json()['data']
    secret = next(r for r in rows if r['key'] == SECRET_KEY)

    # 编辑一行 · 批量保存（参数配置页的「保存」）
    edited = client.put(f'/sys/configs/{secret["id"]}', headers=token_headers, json=_row(SECRET_KEY, SECRETS[1]))
    assert edited.json()['code'] == 200
    bulk = [{**_row(SECRET_KEY, SECRETS[2]), 'id': secret['id']}]
    assert client.put('/sys/configs', headers=token_headers, json=bulk).json()['code'] == 200
    # 打开参数配置页：列表的两种读法，响应体里都有这一行
    client.get('/sys/configs/all', headers=token_headers, params={'type': TYPE})
    client.get('/sys/configs', headers=token_headers, params={'type': TYPE})

    logs = [log for log in captured if '/sys/configs' in log.path]
    dumped = [json.dumps(log.args, ensure_ascii=False) + (log.response_body or '') for log in logs]
    # 先断言「有」：这几条请求都记下来了，而且记下的内容里确实有这一行（否则「没有明文」在什么都没记时也成立）
    assert len(logs) == 7, [f'{log.method} {log.path}' for log in captured]
    about_secret = [text for i, text in enumerate(dumped) if i != 1]  # 第 2 条是新建那一行普通参数
    assert all(SECRET_KEY in text for text in about_secret), '记下的请求 / 响应里找不到这一行'
    # 对照：不是密钥的值照记 —— 打码不能是「value 一律打掉」
    assert any(VISIBLE in text for text in dumped), '普通参数的值也被打掉了'

    for log, text in zip(logs, dumped, strict=True):
        leaked = [s for s in SECRETS if s in text]
        assert not leaked, f'{log.method} {log.path} 把密钥记进了操作日志：{leaked}'
