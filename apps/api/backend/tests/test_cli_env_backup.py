"""`fba init` 覆盖 `.env` 之前先留一份备份（#399）。

`auto_init()` 先写 `.env`、后问「确认继续吗」：两步都答「否」时库没动，
`.env` 却已经换成了模板 + 新 `TOKEN_SECRET_KEY`，自配的加密密钥全丢。
覆盖本身是设计（init 就是重置环境），但旧文件必须找得回来。
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from backend import cli
from backend.core.conf import settings

if TYPE_CHECKING:
    from pathlib import Path

    import pytest

# setup_env_file() 会把用户输入直接 setattr 到全局 settings 上，测完要还原
_TOUCHED_SETTINGS = (
    'DATABASE_TYPE',
    'DATABASE_HOST',
    'DATABASE_PORT',
    'DATABASE_USER',
    'DATABASE_PASSWORD',
    'REDIS_HOST',
    'REDIS_PORT',
    'REDIS_PASSWORD',
    'REDIS_DATABASE',
    'TOKEN_SECRET_KEY',
)


def _run_setup(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> Path:
    example = tmp_path / '.env.example'
    example.write_text("DATABASE_TYPE='postgresql'\nTOKEN_SECRET_KEY='placeholder'\n", encoding='utf-8')
    env = tmp_path / '.env'
    monkeypatch.setattr(cli, 'ENV_EXAMPLE_FILE_PATH', example)
    monkeypatch.setattr(cli, 'ENV_FILE_PATH', env)
    for name in _TOUCHED_SETTINGS:
        monkeypatch.setattr(settings, name, getattr(settings, name))
    monkeypatch.setattr(cli.Prompt, 'ask', lambda *_a, default='', **_kw: default)
    return env


def test_existing_env_is_backed_up_before_overwrite(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    env = _run_setup(monkeypatch, tmp_path)
    original = "MFA_SECRET_KEY='my-own-key'\n"
    env.write_text(original, encoding='utf-8')

    assert cli.setup_env_file() is True

    backups = list(tmp_path.glob('.env.bak.*'))
    assert len(backups) == 1
    assert backups[0].read_text(encoding='utf-8') == original
    assert 'my-own-key' not in env.read_text(encoding='utf-8')


def test_backups_in_the_same_second_do_not_overwrite_each_other(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    env = _run_setup(monkeypatch, tmp_path)
    env.write_text("MFA_SECRET_KEY='my-own-key'\n", encoding='utf-8')

    assert cli.setup_env_file() is True
    assert cli.setup_env_file() is True

    contents = sorted(p.read_text(encoding='utf-8') for p in tmp_path.glob('.env.bak.*'))
    assert len(contents) == 2
    assert any('my-own-key' in c for c in contents)


def test_no_backup_when_env_does_not_exist(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    env = _run_setup(monkeypatch, tmp_path)

    assert cli.setup_env_file() is True

    assert env.exists()
    assert list(tmp_path.glob('.env.bak.*')) == []
