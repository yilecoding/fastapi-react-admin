"""#395：插件装 / 停的几条「当时没事、下次重启起不来」。

- 装依赖失败不回滚：目录和 .env 的追加都留着，重装报「已安装」，重启时再装一遍、照样失败，进程起不来
- requirements 里 `-r` / `--index-url` / 行尾注释这类写法，「装没装」判断直接抛错 —— 启动时每个插件都跑这一步
- 必需插件能停用；被依赖的插件能停用（下次重启 `resolve_plugin_order` 抛错）
- 插件名能遮蔽插件系统自己的模块（`status.zip` → `plugin/status/`）
- 重装插件把 `.env.example` 的空值接到 `.env` 末尾，盖掉真值
"""

import asyncio
import io
import json
import zipfile

from collections.abc import Iterator
from pathlib import Path
from uuid import uuid4

import pytest

from pydantic_settings import BaseSettings, SettingsConfigDict
from starlette.testclient import TestClient

from backend.app.admin.service import plugin_service as service_module
from backend.common.dataclasses import PluginEntry
from backend.common.exception import errors
from backend.core.conf import settings
from backend.database.redis import RedisCli
from backend.plugin import core, installer, requirements
from backend.plugin.errors import PluginInstallError

ENV = 'REAL_SECRET=keep-me\n'


@pytest.fixture
def tree(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[Path]:
    root = tmp_path / 'plugin'
    root.mkdir()
    (root / 'status.py').write_text('', encoding='utf-8')  # 插件系统自己的模块
    env = tmp_path / '.env'
    env.write_text(ENV, encoding='utf-8')
    for module in (service_module, core, requirements, installer):
        monkeypatch.setattr(module, 'PLUGIN_DIR', root)
    monkeypatch.setattr(installer, 'ENV_FILE_PATH', env)
    monkeypatch.setattr(settings, 'ENVIRONMENT', 'dev')
    monkeypatch.setattr(settings, 'PLUGIN_REQUIRED', [])
    monkeypatch.setattr(settings, 'RBAC_ROLE_MENU_MODE', True)
    monkeypatch.setattr(settings, 'PLUGIN_REDIS_PREFIX', f'pytest:plugin:{uuid4().hex}')
    core.get_plugins.cache_clear()
    try:
        yield root
    finally:
        core.get_plugins.cache_clear()

        async def cleanup() -> None:
            redis = RedisCli()
            try:
                await redis.delete_by_prefix(settings.PLUGIN_REDIS_PREFIX)
            finally:
                await redis.aclose()

        asyncio.run(cleanup())


def _plugin(root: Path, name: str, *, depends_on: list[str] | None = None) -> None:
    (root / name).mkdir()
    (root / name / '__init__.py').write_text('', encoding='utf-8')
    deps = f'depends_on = {json.dumps(depends_on)}\n' if depends_on else ''
    (root / name / 'plugin.toml').write_text(f'[plugin]\nsummary = "x"\n{deps}', encoding='utf-8')


def _status(name: str, enable: str | None = None) -> str:
    async def go() -> str:
        redis = RedisCli()
        try:
            key = f'{settings.PLUGIN_REDIS_PREFIX}:{name}'
            if enable is not None:
                await redis.set(key, json.dumps({'plugin': {'name': name, 'enable': enable}}))
            return json.loads(await redis.get(key))['plugin']['enable']
        finally:
            await redis.aclose()

    return asyncio.run(go())


def _zip(tmp: Path, name: str, *, env_example: str = 'NEW_KEY=1\n') -> str:
    path = tmp / f'{name}.zip'
    with zipfile.ZipFile(path, 'w') as zf:
        zf.writestr(f'{name}/__init__.py', '')
        zf.writestr(f'{name}/plugin.toml', '[plugin]\nsummary = "x"\n')
        zf.writestr(f'{name}/README.md', 'x')
        zf.writestr(f'{name}/requirements.txt', 'surely-not-a-package==0.0.1\n')
        zf.writestr(f'{name}/.env.example', env_example)
    return str(path)


# ---------- ① 装依赖失败要回滚 ----------


def test_failed_requirements_roll_back_the_install(
    client: TestClient, tree: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    async def boom(_plugin: str | None = None) -> None:  # ruff: ignore[unused-async]
        raise PluginInstallError('pip 退出码 1')

    monkeypatch.setattr(installer, 'install_requirements_async', boom)

    async def attempt() -> None:
        with pytest.raises(errors.ServerError) as info:
            await installer.install_zip_plugin(_zip(tree.parent, 'demo'))
        assert 'pip 退出码 1' in info.value.msg, '原因要带给调用方，不是一句「请稍后重试」'

    # 安装走的是全局 redis_client（绑在 TestClient 的事件循环上），不能另起 asyncio.run
    client.portal.call(attempt)
    assert not (tree / 'demo').exists(), '目录留着：重装报「已安装」，重启时再装一遍照样失败'
    assert (tree.parent / '.env').read_text(encoding='utf-8') == ENV, '.env 的追加也要撤掉'


def test_failed_git_requirements_roll_back_too(client: TestClient, tree: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    def fake_clone(_url: str, target: Path, **_kw: object) -> None:
        target.mkdir()
        (target / '__init__.py').write_text('', encoding='utf-8')
        (target / '.env.example').write_text('NEW_KEY=1\n', encoding='utf-8')

    async def boom(_plugin: str | None = None) -> None:  # ruff: ignore[unused-async]
        raise PluginInstallError('pip 退出码 1')

    monkeypatch.setattr(installer.porcelain, 'clone', fake_clone)
    monkeypatch.setattr(installer, 'install_requirements_async', boom)

    async def attempt() -> None:
        with pytest.raises(errors.ServerError):
            await installer.install_git_plugin('https://example.com/acme/gitdemo.git')

    # 安装走的是全局 redis_client（绑在 TestClient 的事件循环上），不能另起 asyncio.run
    client.portal.call(attempt)
    assert not (tree / 'gitdemo').exists()
    assert (tree.parent / '.env').read_text(encoding='utf-8') == ENV


@pytest.mark.parametrize(
    'line',
    [
        '-r base.txt',
        '--index-url https://mirrors.example.com/simple',
        '-e .',
        'git+https://example.com/acme/pkg.git',
        'pytest>=7  # 注释',
        'pytest>=7 --hash=sha256:abc',
    ],
)
def test_unrecognised_requirement_lines_do_not_raise(tmp_path: Path, line: str) -> None:
    """这些都是 pip 认的写法；判断不了就交给 pip（返回 False），不能抛错拖垮启动"""
    req = tmp_path / 'requirements.txt'
    req.write_text(f'{line}\n', encoding='utf-8')
    assert requirements._requirements_installed(req) in {True, False}


def test_options_and_comments_do_not_hide_an_installed_requirement(tmp_path: Path) -> None:
    req = tmp_path / 'requirements.txt'
    req.write_text('--index-url https://mirrors.example.com/simple\npytest>=7  # 测试\n', encoding='utf-8')
    assert requirements._requirements_installed(req) is True, '选项行和行尾注释去掉之后，pytest 是装着的'


def test_startup_survives_a_plugin_whose_requirements_fail(monkeypatch: pytest.MonkeyPatch) -> None:
    def boom(_plugin: str | None) -> None:
        raise PluginInstallError('网络不通')

    monkeypatch.setattr(requirements, 'install_requirements', boom)
    assert requirements.install_requirements_on_startup('demo') is False


# ---------- ② 必需插件 / 被依赖的插件不能停 ----------


def test_required_plugin_cannot_be_disabled(
    client: TestClient, token_headers: dict[str, str], tree: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _plugin(tree, 'demo')
    monkeypatch.setattr(settings, 'PLUGIN_REQUIRED', ['demo'])
    _status('demo', '1')
    response = client.put('/sys/plugins/demo/status', headers=token_headers)
    assert response.status_code == 400, response.text
    assert _status('demo') == '1'


def test_plugin_with_enabled_dependents_cannot_be_disabled(
    client: TestClient, token_headers: dict[str, str], tree: Path
) -> None:
    _plugin(tree, 'base')
    _plugin(tree, 'child', depends_on=['base'])
    _status('base', '1')
    _status('child', '1')
    response = client.put('/sys/plugins/base/status', headers=token_headers)
    assert response.status_code == 400, response.text
    assert 'child' in response.json()['msg']
    assert _status('base') == '1'

    # 先停依赖方，再停被依赖的，照常
    assert client.put('/sys/plugins/child/status', headers=token_headers).status_code == 200
    assert client.put('/sys/plugins/base/status', headers=token_headers).status_code == 200
    assert _status('base') == '0'

    # 反过来：依赖还停着时不能先启用依赖方
    response = client.put('/sys/plugins/child/status', headers=token_headers)
    assert response.status_code == 400, response.text
    assert _status('child') == '0'


def test_required_plugin_marked_disabled_still_loads(tree: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """接口拦住之前就停掉的必需插件：启动时照样加载（原来字典路由全 404、启动不报一个字）"""
    _plugin(tree, 'demo')
    monkeypatch.setattr(settings, 'PLUGIN_REQUIRED', ['demo'])
    _status('demo', '0')
    assert core.get_enabled_plugins(('demo',)) == {'demo'}


def test_dependents_of_a_disabled_plugin_are_skipped_not_fatal() -> None:
    """接口拦住之前就停掉的被依赖插件：原来下次启动 `resolve_plugin_order` 抛错、进程起不来"""
    child = PluginEntry(name='child', depends_on=['base'])
    grandchild = PluginEntry(name='grandchild', depends_on=['child'])
    other = PluginEntry(name='other')
    kept = core.drop_disabled_dependents([child, grandchild, other], {'base', 'child', 'grandchild', 'other'})
    assert [p.name for p in core.resolve_plugin_order(kept)] == ['other']


# ---------- 插件名不能遮蔽插件系统自己的模块 ----------


def test_plugin_name_cannot_shadow_a_plugin_system_module(client: TestClient, tree: Path) -> None:
    async def attempt() -> None:
        with pytest.raises(errors.RequestError):
            await installer.install_zip_plugin(_zip(tree.parent, 'status'))
        with pytest.raises(errors.RequestError):
            await installer.install_git_plugin('https://example.com/acme/status.git')

    # 安装走的是全局 redis_client（绑在 TestClient 的事件循环上），不能另起 asyncio.run
    client.portal.call(attempt)
    assert not (tree / 'status').exists()


# ---------- 重装不能用空值盖掉 .env 里的真值 ----------


def test_reinstall_does_not_override_existing_env_values(
    client: TestClient, tree: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    async def ok(_plugin: str | None = None) -> None:  # ruff: ignore[unused-async]
        return None

    monkeypatch.setattr(installer, 'install_requirements_async', ok)

    async def install() -> None:
        await installer.install_zip_plugin(_zip(tree.parent, 'demo', env_example="REAL_SECRET=''\nNEW_KEY=1\n"))

    client.portal.call(install)
    env = tree.parent / '.env'

    class Probe(BaseSettings):
        model_config = SettingsConfigDict(env_file=env, extra='ignore')
        REAL_SECRET: str = ''
        NEW_KEY: str = ''

    probe = Probe()
    assert probe.REAL_SECRET == 'keep-me', f'.env 被盖成了：{env.read_text(encoding="utf-8")!r}'
    assert probe.NEW_KEY == '1', '没有的键照常追加'
    assert io.StringIO(env.read_text(encoding='utf-8')).read().count('REAL_SECRET') == 1
