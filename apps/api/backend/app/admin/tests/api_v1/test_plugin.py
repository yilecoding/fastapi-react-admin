"""Plugin paths must stay inside the plugin root, including after URL decoding."""

import asyncio
import io
import json
import os
import zipfile

from collections.abc import Iterator
from pathlib import Path
from uuid import uuid4

import pytest

from starlette.testclient import TestClient

from backend.app.admin.service import plugin_service as service_module
from backend.common.exception import errors
from backend.core.conf import settings
from backend.database.redis import RedisCli
from backend.plugin import core, requirements


@pytest.fixture
def plugin_tree(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[Path]:
    root = tmp_path / 'plugin'
    demo = root / 'demo'
    demo.mkdir(parents=True)
    (demo / '__init__.py').write_text('', encoding='utf-8')
    (demo / 'a.py').write_text('VALUE = 1', encoding='utf-8')
    (tmp_path / '.env').write_text('TEST_SECRET=private', encoding='utf-8')
    (tmp_path / 'upload').mkdir()
    (tmp_path / 'upload' / 'private.txt').write_text('private upload', encoding='utf-8')
    # requirements reads its own imported PLUGIN_DIR; keep uninstall away from real packages.
    for module in (service_module, core, requirements):
        monkeypatch.setattr(module, 'PLUGIN_DIR', root)
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
                await redis.delete(f'{settings.PLUGIN_REDIS_PREFIX}:demo', f'{settings.PLUGIN_REDIS_PREFIX}:changed')
            finally:
                await redis.aclose()

        asyncio.run(cleanup())


@pytest.mark.parametrize('method,suffix', [('GET', ''), ('DELETE', ''), ('PUT', '/status')])
@pytest.mark.parametrize('name', ['%2e%2e', '%2e', '%2e%2e%5cupload', 'demo%3astream', 'demo.'])
def test_encoded_parent_is_rejected(
    client: TestClient, token_headers: dict[str, str], plugin_tree: Path, method: str, suffix: str, name: str
) -> None:
    response = client.request(method, f'/sys/plugins/{name}{suffix}', headers=token_headers)
    assert response.status_code == 404, response.text[:300]
    assert (plugin_tree.parent / '.env').read_text(encoding='utf-8') == 'TEST_SECRET=private'
    assert (plugin_tree / 'demo' / 'a.py').exists()


@pytest.mark.parametrize('name', ['missing', '__pycache__', 'loose_file'])
def test_only_plugin_packages_can_be_downloaded(
    client: TestClient, token_headers: dict[str, str], plugin_tree: Path, name: str
) -> None:
    (plugin_tree / '__pycache__').mkdir(exist_ok=True)
    (plugin_tree / 'loose_file').write_text('not a plugin', encoding='utf-8')
    response = client.get(f'/sys/plugins/{name}', headers=token_headers)
    assert response.status_code == 404, response.text[:300]


def test_download_contains_only_the_selected_plugin(
    client: TestClient, token_headers: dict[str, str], plugin_tree: Path
) -> None:
    response = client.get('/sys/plugins/demo', headers=token_headers)
    assert response.status_code == 200
    assert response.headers['content-disposition'] == 'attachment; filename=demo.zip'
    with zipfile.ZipFile(io.BytesIO(response.content)) as archive:
        assert set(archive.namelist()) == {'demo/__init__.py', 'demo/a.py'}
        assert archive.read('demo/a.py') == b'VALUE = 1'


def test_uninstall_backs_up_only_the_selected_plugin(
    client: TestClient, token_headers: dict[str, str], plugin_tree: Path
) -> None:
    assert (plugin_tree / 'demo' / 'a.py').exists()
    response = client.delete('/sys/plugins/demo', headers=token_headers)
    assert response.status_code == 200, response.text
    assert response.json()['code'] == 200
    assert not (plugin_tree / 'demo').exists()
    backups = list(plugin_tree.glob('demo.*.backup.zip'))
    assert len(backups) == 1
    with zipfile.ZipFile(backups[0]) as archive:
        assert set(archive.namelist()) == {'demo/__init__.py', 'demo/a.py'}
    assert (plugin_tree.parent / '.env').read_text(encoding='utf-8') == 'TEST_SECRET=private'
    assert (plugin_tree.parent / 'upload' / 'private.txt').exists()


def test_required_plugin_cannot_be_uninstalled(
    client: TestClient, token_headers: dict[str, str], plugin_tree: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(settings, 'PLUGIN_REQUIRED', ['demo'])
    response = client.delete('/sys/plugins/demo', headers=token_headers)
    assert response.status_code == 400, response.text
    assert (plugin_tree / 'demo' / 'a.py').exists()


def test_status_still_toggles_a_valid_plugin(
    client: TestClient, token_headers: dict[str, str], plugin_tree: Path
) -> None:
    key = f'{settings.PLUGIN_REDIS_PREFIX}:demo'

    async def read_or_seed(*, seed: bool = False) -> str | None:
        redis = RedisCli()
        try:
            if seed:
                await redis.set(key, json.dumps({'plugin': {'enable': '1'}}), ex=60)
                return None
            return await redis.get(key)
        finally:
            await redis.aclose()

    asyncio.run(read_or_seed(seed=True))
    response = client.put('/sys/plugins/demo/status', headers=token_headers)
    assert response.status_code == 200, response.text
    assert json.loads(asyncio.run(read_or_seed()))['plugin']['enable'] == '0'


@pytest.mark.parametrize('operation', ['build', 'uninstall', 'update_status'])
@pytest.mark.parametrize(
    'name', ['..', '.', '../upload', '..\\upload', '/upload', 'C:\\upload', 'demo:stream', 'demo.']
)
def test_service_rejects_paths_before_side_effects(plugin_tree: Path, operation: str, name: str) -> None:
    async def attempt() -> None:
        with pytest.raises(errors.NotFoundError):
            await getattr(service_module.plugin_service, operation)(plugin=name)

    asyncio.run(attempt())
    assert (plugin_tree.parent / '.env').read_text(encoding='utf-8') == 'TEST_SECRET=private'
    assert (plugin_tree / 'demo' / 'a.py').exists()
    assert not list(plugin_tree.glob('*.backup.zip'))


@pytest.mark.parametrize('operation', ['build', 'uninstall', 'update_status'])
@pytest.mark.parametrize('external', [True, False])
def test_link_outside_plugin_root_is_rejected(
    plugin_tree: Path, operation: str, monkeypatch: pytest.MonkeyPatch, *, external: bool
) -> None:
    target = plugin_tree.parent / 'outside' if external else plugin_tree / 'demo'
    target.mkdir(exist_ok=True)
    (target / '__init__.py').write_text('', encoding='utf-8')
    (target / 'secret.txt').write_text('outside secret', encoding='utf-8')
    monkeypatch.setattr(settings, 'PLUGIN_REQUIRED', [target.name])
    link = plugin_tree / 'alias'
    try:
        link.symlink_to(target, target_is_directory=True)
    except OSError:
        if os.name != 'nt':
            raise
        import _winapi

        _winapi.CreateJunction(str(target), str(link))
    assert (link / 'secret.txt').exists()

    async def attempt() -> None:
        with pytest.raises(errors.NotFoundError):
            await getattr(service_module.plugin_service, operation)(plugin='alias')

    asyncio.run(attempt())
    assert (target / 'secret.txt').read_text(encoding='utf-8') == 'outside secret'
