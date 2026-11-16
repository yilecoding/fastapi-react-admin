"""独立 SQLite 表验证数据迁移的幂等性和失败原子性，不依赖开发库内容。"""

import pytest
import sqlalchemy as sa

from backend.common.exception import errors
from backend.core.conf import settings
from backend.plugin.config.secret import decrypt_secret, encrypt_legacy_configs


def test_migration_includes_deleted_rows_and_is_idempotent():
    engine = sa.create_engine('sqlite://')
    metadata = sa.MetaData()
    configs = sa.Table(
        'sys_config',
        metadata,
        sa.Column('id', sa.Integer, primary_key=True),
        sa.Column('key', sa.Text),
        sa.Column('value', sa.Text),
        sa.Column('deleted', sa.Integer),
    )
    metadata.create_all(engine)
    try:
        with engine.begin() as connection:
            connection.execute(
                configs.insert(),
                [
                    {'id': 1, 'key': 'EMAIL_PASSWORD', 'value': 'smtp-code', 'deleted': 0},
                    {'id': 2, 'key': 'old_api_key', 'value': 'old-code', 'deleted': 2},
                    {'id': 3, 'key': 'USER_PASSWORD_MIN_LENGTH', 'value': '12', 'deleted': 0},
                    {'id': 4, 'key': 'EMPTY_TOKEN', 'value': '', 'deleted': 0},
                ],
            )
            assert encrypt_legacy_configs(connection) == 2
            once = list(connection.execute(sa.select(configs).order_by(configs.c.id)).mappings())
            assert decrypt_secret(once[0]['value']) == 'smtp-code'
            assert decrypt_secret(once[1]['value']) == 'old-code'
            assert once[2]['value'] == '12' and not once[3]['value']
            assert encrypt_legacy_configs(connection) == 0
            assert list(connection.execute(sa.select(configs).order_by(configs.c.id)).mappings()) == once
    finally:
        engine.dispose()


def test_migration_validates_before_writing(monkeypatch):
    engine = sa.create_engine('sqlite://')
    try:
        with engine.begin() as connection:
            connection.execute(sa.text('CREATE TABLE sys_config (id INTEGER, key TEXT, value TEXT)'))
            connection.execute(
                sa.text("INSERT INTO sys_config VALUES (1, 'EMAIL_PASSWORD', 'plain'), (2, 'API_KEY', 'enc:v1:broken')")
            )
            with pytest.raises(errors.ServerError):
                encrypt_legacy_configs(connection)
            assert connection.scalar(sa.text('SELECT value FROM sys_config WHERE id = 1')) == 'plain'
            connection.execute(sa.text('DELETE FROM sys_config WHERE id = 2'))
            monkeypatch.setattr(settings, 'CONFIG_ENCRYPT_SECRET_KEY', '')
            with pytest.raises(errors.ServerError):
                encrypt_legacy_configs(connection)
            assert connection.scalar(sa.text('SELECT value FROM sys_config')) == 'plain'
    finally:
        engine.dispose()
