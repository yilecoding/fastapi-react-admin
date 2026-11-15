"""#305：真实接口、数据库和内部 loader 的密钥边界。"""

import uuid

import pytest

from redis import Redis
from sqlalchemy import create_engine, delete, select

from backend.common.cache.local import local_cache_manager
from backend.common.exception import errors
from backend.core.conf import settings
from backend.plugin.config.model import Config
from backend.plugin.config.secret import decrypt_secret, encrypt_secret
from backend.tests.utils.db import sync_test_db_url


@pytest.fixture
def rows(client, token_headers):
    group = f'PYTEST_SECRET_{uuid.uuid4().hex[:8]}'
    engine = create_engine(sync_test_db_url())
    headers = token_headers

    def create(key, value):
        body = {'name': 'pytest', 'type': group, 'key': key, 'value': value, 'is_frontend': True, 'remark': None}
        response = client.post('/sys/configs', headers=headers, json=body)
        assert response.json()['code'] == 200, response.text
        items = client.get('/sys/configs/all', headers=headers, params={'type': group}).json()['data']
        return next(item for item in items if item['key'] == key), body

    try:
        yield group, engine, create
    finally:
        with engine.begin() as connection:
            connection.execute(delete(Config.__table__).where(Config.type == group))
        engine.dispose()


def stored(engine, pk):
    with engine.connect() as connection:
        return connection.execute(select(Config.__table__).where(Config.id == int(pk))).mappings().one()


def test_all_read_routes_hide_secrets_and_ignore_legacy_caches(client, token_headers, rows):
    group, engine, create = rows
    item, _ = create(f'{group}_password', 'smtp-secret-for-305')
    plain, _ = create(f'{group}_USER_PASSWORD_MIN_LENGTH', '12')
    encrypted = stored(engine, item['id'])['value']
    assert encrypted.startswith('enc:v1:')
    assert decrypt_secret(encrypted) == 'smtp-secret-for-305'
    assert stored(engine, item['id'])['is_frontend'] is False

    redis = Redis(
        host=settings.REDIS_HOST,
        port=settings.REDIS_PORT,
        password=settings.REDIS_PASSWORD or None,
        db=settings.REDIS_DATABASE,
        decode_responses=True,
    )
    cache_keys = [f'{settings.CACHE_CONFIG_REDIS_PREFIX}:{group}', f'{settings.CACHE_CONFIG_REDIS_PREFIX}:{item["id"]}']
    try:
        assert not redis.exists(*cache_keys), '原始配置不应被写进 Redis'
        for key in cache_keys:
            redis.set(key, 'legacy-plaintext-cache')
            local_cache_manager.set(key, {'value': 'legacy-plaintext-cache'})
        for path, params in [
            ('/sys/configs/all', {'type': group}),
            ('/sys/configs', {'type': group}),
            (f'/sys/configs/{item["id"]}', None),
        ]:
            response = client.get(path, headers=token_headers, params=params)
            assert response.status_code == 200, response.text
            assert 'smtp-secret-for-305' not in response.text
            assert encrypted not in response.text
            assert 'legacy-plaintext-cache' not in response.text
            data = response.json()['data']
            items = data if isinstance(data, list) else data.get('items', [data])
            secret = next(row for row in items if row['id'] == item['id'])
            assert secret['value'] == ''  # ruff: ignore[compare-to-empty-string] 契约必须是字符串空值
            assert secret['is_secret'] is True and secret['is_configured'] is True
            if len(items) > 1:
                assert next(row for row in items if row['id'] == plain['id'])['value'] == '12'
        assert stored(engine, item['id'])['value'] == encrypted, '脱敏不能改数据库对象'
    finally:
        redis.delete(*cache_keys)
        redis.close()
        for key in cache_keys:
            local_cache_manager.delete(key)


@pytest.mark.parametrize('bulk', [False, True])
def test_keep_replace_clear_and_immutable_key(client, token_headers, rows, bulk):
    group, engine, create = rows
    item, body = create(f'{group}_API_KEY', 'original-secret')
    pk = item['id']
    original = stored(engine, pk)['value']

    def save(payload):
        return client.put(
            '/sys/configs' if bulk else f'/sys/configs/{pk}',
            headers=token_headers,
            json=[{**payload, 'id': pk}] if bulk else payload,
        )

    for value in ['', None]:
        payload = {**body, 'remark': 'metadata-only'}
        if value is None:
            payload.pop('value')
        else:
            payload['value'] = value
        assert save(payload).json()['code'] == 200
        assert stored(engine, pk)['value'] == original
        assert stored(engine, pk)['remark'] == 'metadata-only'

    assert save({**body, 'key': f'{group}_HOST', 'value': ''}).status_code == 400
    assert stored(engine, pk)['key'] == body['key']
    assert save({**body, 'value': 'replacement'}).json()['code'] == 200
    assert decrypt_secret(stored(engine, pk)['value']) == 'replacement'
    assert save({**body, 'value': 'ambiguous', 'clear_secret': True}).status_code == 422
    assert save({**body, 'value': '', 'clear_secret': True}).json()['code'] == 200
    assert not stored(engine, pk)['value']
    detail = client.get(f'/sys/configs/{pk}', headers=token_headers).json()['data']
    assert detail['is_secret'] and not detail['is_configured']


def test_ordinary_config_can_still_be_cleared(client, token_headers, rows):
    group, engine, create = rows
    item, body = create(f'{group}_HOST', 'smtp.example.test')
    assert (
        client.put(f'/sys/configs/{item["id"]}', headers=token_headers, json={**body, 'value': ''}).json()['code']
        == 200
    )
    assert not stored(engine, item['id'])['value']


def test_bulk_validation_failure_keeps_existing_secret(client, token_headers, rows):
    group, engine, create = rows
    item, body = create(f'{group}_TOKEN', 'original')
    original = stored(engine, item['id'])['value']
    response = client.put(
        '/sys/configs',
        headers=token_headers,
        json=[
            {**body, 'id': item['id'], 'value': 'must-not-commit'},
            {**body, 'id': '9223372036854775806', 'value': 'missing-config'},
        ],
    )
    assert response.status_code == 404, response.text
    assert stored(engine, item['id'])['value'] == original


@pytest.mark.parametrize('key', ['', 'not-hex', 'aa'])
def test_missing_or_invalid_key_rejects_writes(client, token_headers, rows, monkeypatch, key):
    group, engine, create = rows
    item, body = create(f'{group}_TOKEN', 'before')
    original = stored(engine, item['id'])['value']
    monkeypatch.setattr(settings, 'CONFIG_ENCRYPT_SECRET_KEY', key)
    response = client.put(f'/sys/configs/{item["id"]}', headers=token_headers, json={**body, 'value': 'after'})
    assert response.status_code == 500
    assert 'CONFIG_ENCRYPT_SECRET_KEY' in response.json()['msg']
    assert stored(engine, item['id'])['value'] == original
    created = client.post(
        '/sys/configs',
        headers=token_headers,
        json={**body, 'key': f'{group}_NEW_PASSWORD', 'value': 'must-not-persist'},
    )
    assert created.status_code == 500
    with engine.connect() as connection:
        assert not connection.scalar(select(Config.id).where(Config.key == f'{group}_NEW_PASSWORD'))
    # 无须解密旧值即可改备注，避免密钥丢失时连配置页都无法维护。
    assert (
        client.put(
            f'/sys/configs/{item["id"]}', headers=token_headers, json={**body, 'value': '', 'remark': 'still editable'}
        ).json()['code']
        == 200
    )


def test_internal_email_loader_decrypts_without_exposing_or_caching(client, token_headers, monkeypatch):
    from backend.plugin.email.utils.dynamic_config import load_email_config
    from backend.tests.utils.db import async_test_db_session

    engine = create_engine(sync_test_db_url())
    with engine.connect() as connection:
        original = (
            connection
            .execute(select(Config.__table__).where(Config.key == 'EMAIL_PASSWORD', Config.deleted == 0))
            .mappings()
            .one()
        )
    monkeypatch.setattr(settings, 'EMAIL_PASSWORD', 'env-before-load')
    try:
        with engine.begin() as connection:
            connection.execute(
                Config.__table__
                .update()
                .where(Config.id == original['id'])
                .values(value=encrypt_secret('runtime-smtp-secret'))
            )

        async def load():
            async with async_test_db_session() as db:
                await load_email_config(db)

        client.portal.call(load)
        assert settings.EMAIL_PASSWORD == 'runtime-smtp-secret'
        assert stored(engine, original['id'])['value'] != settings.EMAIL_PASSWORD
        assert not client.get(f'/sys/configs/{original["id"]}', headers=token_headers).json()['data']['value']
    finally:
        with engine.begin() as connection:
            connection.execute(
                Config.__table__.update().where(Config.id == original['id']).values(value=original['value'])
            )
        engine.dispose()


def test_corrupt_ciphertext_is_not_treated_as_plaintext():
    for value in ['legacy-plaintext', 'enc:v1:broken', 'enc:v1:00']:
        with pytest.raises(errors.ServerError):
            decrypt_secret(value)


def test_startup_removes_old_config_caches_only(client):
    from backend.plugin.config.hooks import lifespan

    prefix = settings.CACHE_CONFIG_REDIS_PREFIX
    redis = Redis(
        host=settings.REDIS_HOST,
        port=settings.REDIS_PORT,
        password=settings.REDIS_PASSWORD or None,
        db=settings.REDIS_DATABASE,
    )
    old_key, sibling_key = f'{prefix}:legacy-test', f'{prefix}-unrelated:legacy-test'
    try:
        for key in [old_key, sibling_key]:
            redis.set(key, 'old-value')
            local_cache_manager.set(key, 'old-value')

        async def restart_hook():
            async with lifespan(client.app):
                pass

        client.portal.call(restart_hook)
        assert not redis.exists(old_key)
        assert local_cache_manager.get(old_key) is None
        assert redis.exists(sibling_key)
        assert local_cache_manager.get(sibling_key) == 'old-value'
    finally:
        redis.delete(old_key, sibling_key)
        redis.close()
        local_cache_manager.delete(old_key)
        local_cache_manager.delete(sibling_key)
