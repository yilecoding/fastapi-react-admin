"""拼出来的连接串要能被**真正用它的那个库**原样解析回来（上游 e975ae1 的同类问题）

修之前实测：密码 `Ab3/x+Yz@9`，kombu（celery broker）和 redis-py（socket.io）都报
`ValueError: Port could not be cast to integer value as 'Ab3'`；结果后端用 `quote_plus`，
密码 `pass word` 被 SQLAlchemy 解析成 `pass+word`。
"""

import pytest

from kombu import Connection
from redis.asyncio.connection import parse_url
from sqlalchemy.engine import make_url

from backend.app.task.celery import get_broker_url, get_result_backend
from backend.common.enums import DataBaseType
from backend.core.conf import settings
from backend.database.redis import get_redis_url

PASSWORDS = [
    'Ab3/x+Yz@9',  # openssl rand -base64 那种
    'pass word',
    'p%40ss:#?&=',
    '中文密码',
]


@pytest.mark.parametrize('password', PASSWORDS)
def test_redis_url_round_trips_through_redis_py(monkeypatch: pytest.MonkeyPatch, password: str) -> None:
    """socket.io 的 AsyncRedisManager 用 redis-py 的 from_url"""
    monkeypatch.setattr(settings, 'REDIS_PASSWORD', password)
    monkeypatch.setattr(settings, 'REDIS_HOST', '10.0.0.5')
    monkeypatch.setattr(settings, 'REDIS_PORT', 6380)

    parsed = parse_url(get_redis_url(database=3))

    assert parsed['password'] == password
    assert parsed['host'] == '10.0.0.5'
    assert parsed['port'] == 6380
    assert parsed['db'] == 3


@pytest.mark.parametrize('password', PASSWORDS)
def test_redis_broker_url_round_trips_through_kombu(monkeypatch: pytest.MonkeyPatch, password: str) -> None:
    monkeypatch.setattr(settings, 'CELERY_BROKER', 'redis')
    monkeypatch.setattr(settings, 'REDIS_PASSWORD', password)
    monkeypatch.setattr(settings, 'REDIS_HOST', '10.0.0.5')
    monkeypatch.setattr(settings, 'REDIS_PORT', 6380)
    monkeypatch.setattr(settings, 'CELERY_BROKER_REDIS_DATABASE', 2)

    parts = Connection(get_broker_url())  # celery 自己就是这么解析 broker_url 的

    assert parts.password == password
    assert parts.hostname == '10.0.0.5'
    assert parts.port == 6380
    assert parts.virtual_host == '2'


@pytest.mark.parametrize('password', PASSWORDS)
def test_amqp_broker_url_round_trips_through_kombu(monkeypatch: pytest.MonkeyPatch, password: str) -> None:
    monkeypatch.setattr(settings, 'CELERY_BROKER', 'rabbitmq')
    monkeypatch.setattr(settings, 'CELERY_RABBITMQ_USERNAME', 'user@corp')
    monkeypatch.setattr(settings, 'CELERY_RABBITMQ_PASSWORD', password)
    monkeypatch.setattr(settings, 'CELERY_RABBITMQ_HOST', 'mq.local')
    monkeypatch.setattr(settings, 'CELERY_RABBITMQ_PORT', 5673)

    parts = Connection(get_broker_url())  # celery 自己就是这么解析 broker_url 的

    assert parts.userid == 'user@corp'
    assert parts.password == password
    assert parts.hostname == 'mq.local'
    assert parts.port == 5673


def test_empty_redis_password_means_no_auth(monkeypatch: pytest.MonkeyPatch) -> None:
    """本地开发 Redis 不设密码是常态：空密码不能被解析成一个要去认证的空串之外的东西"""
    monkeypatch.setattr(settings, 'REDIS_PASSWORD', '')

    assert not parse_url(get_redis_url(database=0)).get('password')
    assert not Connection(get_redis_url(database=0)).password


@pytest.mark.parametrize('db_type', [DataBaseType.postgresql, DataBaseType.mysql, DataBaseType.sqlserver])
@pytest.mark.parametrize('password', PASSWORDS)
def test_result_backend_round_trips_through_sqlalchemy(
    monkeypatch: pytest.MonkeyPatch, db_type: DataBaseType, password: str
) -> None:
    monkeypatch.setattr(settings, 'DATABASE_TYPE', db_type)
    monkeypatch.setattr(settings, 'DATABASE_USER', 'app@corp')
    monkeypatch.setattr(settings, 'DATABASE_PASSWORD', password)
    monkeypatch.setattr(settings, 'DATABASE_HOST', 'db.local')
    monkeypatch.setattr(settings, 'DATABASE_PORT', 15432)
    monkeypatch.setattr(settings, 'DATABASE_SCHEMA', 'fba')

    backend = get_result_backend()
    assert backend.startswith('db+')
    url = make_url(backend.removeprefix('db+'))

    assert url.username == 'app@corp'
    assert url.password == password
    assert url.host == 'db.local'
    assert url.port == 15432
    assert url.database == 'fba'
    if db_type == DataBaseType.sqlserver:
        assert url.query['driver'] == 'ODBC Driver 18 for SQL Server'
