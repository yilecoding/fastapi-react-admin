from __future__ import annotations

import asyncio

from typing import TYPE_CHECKING

import cappa
import pytest

from backend import cli
from backend.cli import _format_database_connection_error

if TYPE_CHECKING:
    from typing_extensions import Self


def test_database_authentication_error_is_actionable_without_echoing_details() -> None:
    error = Exception("[28000] Login failed for user 'sa'; password=super-secret")

    message = _format_database_connection_error(error)

    assert '数据库登录失败' in message
    assert 'DATABASE_PASSWORD' in message
    assert '持久化卷' in message
    assert 'super-secret' not in message


def test_database_connection_error_lists_environment_checks() -> None:
    message = _format_database_connection_error(Exception('connection refused'))

    assert '数据库连接失败' in message
    assert 'ODBC Driver 18' in message
    assert 'connection refused' not in message


class _BrokenConnection:
    async def __aenter__(self) -> Self:
        raise RuntimeError("[28000] Login failed for user 'sa'; password=super-secret")

    async def __aexit__(self, *_args: object) -> None:
        return None


class _BrokenEngine:
    def connect(self):
        return _BrokenConnection()


def test_auto_init_turns_connection_failure_into_cli_exit(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(cli, 'setup_env_file', lambda: True)
    monkeypatch.setattr(cli.Prompt, 'ask', lambda *_args, **_kwargs: 'y')
    monkeypatch.setattr(cli, 'create_database_async_engine', lambda _url: _BrokenEngine())

    with pytest.raises(cappa.Exit) as caught:
        asyncio.run(cli.auto_init())

    message = caught.value.message
    assert isinstance(message, str)
    assert '数据库登录失败' in message
    assert 'super-secret' not in message
