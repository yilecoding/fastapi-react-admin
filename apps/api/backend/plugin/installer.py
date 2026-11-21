import io
import os
import re
import stat
import zipfile

import anyio

from anyio import open_file
from dulwich import porcelain
from fastapi import UploadFile
from starlette.concurrency import run_in_threadpool

from backend.common.exception import errors
from backend.common.i18n import t
from backend.common.log import log
from backend.core.conf import settings
from backend.core.path_conf import ENV_FILE_PATH, PLUGIN_DIR
from backend.database.redis import redis_client
from backend.plugin.core import get_plugins
from backend.plugin.errors import PluginInstallError
from backend.plugin.requirements import install_requirements_async
from backend.utils.locks import acquire_distributed_reload_lock
from backend.utils.pattern_validate import is_git_url

_ENV_KEY = re.compile(r'^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=')


def _env_keys(content: str) -> set[str]:
    return {m.group(1) for line in content.splitlines() if (m := _ENV_KEY.match(line))}


async def _append_env_example(plugin_path: anyio.Path) -> None:
    """
    追加主 .env 文件

    🔴 只追加 `.env` 里**还没有**的键（#395）。原来整份 `.env.example` 无条件接到末尾，重复的键以最后一个为准：
    重装 `ai` 会让 `AI_ENCRYPT_SECRET_KEY=''` 盖掉真密钥（已存的供应商密钥全部解不开），重装 `oauth2` 把
    client secret 盖回示例值 —— 而且不报错，要到用的时候才发现

    :param plugin_path: 插件目录路径
    :return:
    """
    env_example_path = plugin_path / '.env.example'
    if not await env_example_path.exists():
        return

    async with await open_file(env_example_path, mode='r', encoding='utf-8') as f:
        env_example_content = await f.read()

    if not env_example_content.strip():
        return

    env_path = anyio.Path(ENV_FILE_PATH)
    existing_content = ''
    if await env_path.exists():
        async with await open_file(env_path, mode='r', encoding='utf-8') as f:
            existing_content = await f.read()

    existing_keys = _env_keys(existing_content)
    # 跳过已有的键时，连它上面紧挨着的那段注释一起跳过 —— 不然注释留在 .env 末尾，压在一个不相干的新键上面
    lines: list[str] = []
    pending: list[str] = []
    for line in env_example_content.splitlines():
        m = _ENV_KEY.match(line)
        if not m:
            pending.append(line)
            continue
        if m.group(1) not in existing_keys:
            lines.extend(pending)
            lines.append(line)
        pending = []
    if not lines:
        return
    lines.extend(pending)
    addition = '\n'.join(lines) + '\n'

    separator = '\n' if existing_content and not existing_content.endswith('\n') else ''
    new_content = f'{existing_content}{separator}{addition}'

    async with await open_file(env_path, mode='w', encoding='utf-8') as f:
        await f.write(new_content)


async def _snapshot_env() -> str | None:
    env_path = anyio.Path(ENV_FILE_PATH)
    if not await env_path.exists():
        return None
    async with await open_file(env_path, mode='r', encoding='utf-8') as f:
        return await f.read()


async def _restore_env(snapshot: str | None) -> None:
    env_path = anyio.Path(ENV_FILE_PATH)
    if snapshot is None:
        if await env_path.exists():
            await env_path.unlink()
        return
    async with await open_file(env_path, mode='w', encoding='utf-8') as f:
        await f.write(snapshot)


def _check_plugin_name(name: str) -> None:
    """插件名不能和插件系统自己的模块重名（#395）

    `plugin/` 下还放着 `core.py` / `status.py` / `sql.py` / `router.py` … 包目录的优先级高于同名 `.py`，
    叫 `status.zip` 的包解压成 `plugin/status/` 之后，下次启动 `from backend.plugin.status import …` 就是 ImportError
    """
    if name == '__pycache__' or name.startswith('.') or (PLUGIN_DIR / f'{name}.py').exists():
        raise errors.RequestError(msg=t('error.plugin.name_reserved', plugin=name))


async def _finish_install(plugin_path: anyio.Path, plugin_name: str) -> None:
    """解压 / 克隆之后的两步（追加 .env、装依赖）；任一步失败把这次安装整个撤掉（#395）

    原来失败了目录和 .env 的追加都留着：重装报「已安装」，重启时 `_prepare_plugins()` 再装一遍依赖、照样失败，
    进程起不来。撤干净之后，失败就只是这一次安装失败
    """
    env_snapshot = await _snapshot_env()
    try:
        await _append_env_example(plugin_path)
        await install_requirements_async(plugin_name)
    except BaseException as e:
        log.error(f'插件 {plugin_name} 安装失败，回滚：{e!r}')
        with anyio.CancelScope(shield=True):
            await _restore_env(env_snapshot)
            if await plugin_path.exists():
                await run_in_threadpool(remove_plugin, plugin_path)
            get_plugins.cache_clear()
        if isinstance(e, PluginInstallError):
            raise errors.ServerError(
                msg=t('error.plugin.requirements_install_failed', plugin=plugin_name, reason=str(e))
            ) from e
        raise


async def install_zip_plugin(file: UploadFile | str) -> str:  # ruff:ignore[complex-structure]
    """
    安装 ZIP 插件

    :param file: FastAPI 上传文件对象或文件完整路径
    :return:
    """
    if isinstance(file, str):
        async with await open_file(file, mode='rb') as fb:
            contents = await fb.read()
    else:
        contents = await file.read()
    file_bytes = io.BytesIO(contents)
    if not zipfile.is_zipfile(file_bytes):
        raise errors.RequestError(msg=t('error.plugin.archive_invalid_format'))

    async with acquire_distributed_reload_lock():
        with zipfile.ZipFile(file_bytes) as zf:
            # 校验压缩包
            plugin_namelist = zf.namelist()
            if not plugin_namelist:
                raise errors.RequestError(msg=t('error.plugin.archive_invalid_content'))
            plugin_dir_name = plugin_namelist[0].split('/', 1)[0].strip()
            if not plugin_dir_name:
                raise errors.RequestError(msg=t('error.plugin.archive_invalid_content'))
            if (
                len(plugin_namelist) <= 3
                or f'{plugin_dir_name}/plugin.toml' not in plugin_namelist
                or f'{plugin_dir_name}/README.md' not in plugin_namelist
            ):
                raise errors.RequestError(msg=t('error.plugin.archive_missing_files'))

            # 插件是否可安装
            plugin_name_match = re.match(
                r'^([a-zA-Z0-9_]+)',
                file.split(os.sep)[-1].split('.')[0].strip()
                if isinstance(file, str)
                else file.filename.split('.')[0].strip(),
            )
            if not plugin_name_match:
                raise errors.RequestError(msg=t('error.plugin.archive_invalid_filename'))
            plugin_name = plugin_name_match.group()
            _check_plugin_name(plugin_name)
            full_plugin_path = anyio.Path(PLUGIN_DIR / plugin_name)
            if await full_plugin_path.exists():
                raise errors.ConflictError(msg=t('error.plugin.already_installed'))

            # 解压（安装）
            members = []
            prefix = f'{plugin_dir_name}/'
            for member in zf.infolist():
                if member.filename in {plugin_dir_name, prefix}:
                    continue
                if not member.filename.startswith(prefix):
                    continue

                relative_filename = member.filename.removeprefix(prefix)
                if not relative_filename:
                    if member.is_dir():
                        continue
                    raise errors.RequestError(msg=t('error.plugin.archive_invalid_content'))

                member.filename = relative_filename
                members.append(member)

            if not members:
                raise errors.RequestError(msg=t('error.plugin.archive_invalid_content'))

            await full_plugin_path.mkdir(parents=True, exist_ok=True)
            try:
                await run_in_threadpool(zf.extractall, full_plugin_path, members)
            except BaseException:
                with anyio.CancelScope(shield=True):
                    await run_in_threadpool(remove_plugin, full_plugin_path)
                raise

        await _finish_install(full_plugin_path, plugin_name)
        await redis_client.set(f'{settings.PLUGIN_REDIS_PREFIX}:changed', 'true')

    return plugin_name


async def install_git_plugin(repo_url: str) -> str:
    """
    安装 Git 插件

    :param repo_url:
    :return:
    """
    match = is_git_url(repo_url)
    if not match:
        raise errors.RequestError(msg=t('error.plugin.git_repo_invalid'))
    repo_name = match.group('repo')
    _check_plugin_name(repo_name)
    path = anyio.Path(PLUGIN_DIR / repo_name)

    async with acquire_distributed_reload_lock():
        # 🔴 「已安装」要在锁**里面**查：下面克隆失败会删目录，查在锁外的话，排队等锁期间另一个请求装好的同名插件
        # 会被这次「克隆失败」当成自己的半个目录删掉（#395 评审）
        if await path.exists():
            raise errors.ConflictError(msg=t('error.plugin.repo_already_installed', repo_name=repo_name))
        try:
            await run_in_threadpool(porcelain.clone, repo_url, PLUGIN_DIR / repo_name, checkout=True)
        except Exception as e:
            log.error(f'插件安装失败: {e}')
            # 克隆到一半失败也会留下半个目录，不删的话重装报「已安装」
            if await path.exists():
                await run_in_threadpool(remove_plugin, path)
            raise errors.ServerError(msg=t('error.plugin.install_failed')) from e

        await _finish_install(path, repo_name)
        await redis_client.set(f'{settings.PLUGIN_REDIS_PREFIX}:changed', 'true')

    return repo_name


async def install_git_frontend_plugin(repo_url: str, frontend_project_root: str) -> str:
    """
    安装前端 Git 插件

    :param repo_url: Git 仓库地址
    :param frontend_project_root: 前端项目根路径
    :return:
    """
    match = is_git_url(repo_url)
    if not match:
        raise errors.RequestError(msg=t('error.plugin.git_repo_invalid'))

    if not frontend_project_root.strip():
        raise errors.RequestError(msg=t('error.plugin.frontend_root_required'))

    frontend_root = await (await anyio.Path(frontend_project_root).expanduser()).resolve()
    if not await frontend_root.exists():
        raise errors.RequestError(msg=t('error.plugin.frontend_root_not_found'))
    if not await frontend_root.is_dir():
        raise errors.RequestError(msg=t('error.plugin.frontend_root_invalid'))

    plugins_dir = frontend_root.joinpath('apps', 'web-antdv-next', 'src', 'plugins')
    if not await plugins_dir.exists() or not await plugins_dir.is_dir():
        raise errors.RequestError(msg=t('error.plugin.frontend_dir_not_found'))

    repo_name = match.group('repo')
    plugin_name = repo_name.removesuffix('_ui')
    if not plugin_name:
        raise errors.RequestError(msg=t('error.plugin.frontend_repo_name_invalid'))

    target_path = anyio.Path(plugins_dir / plugin_name)
    if await target_path.exists():
        raise errors.ConflictError(msg=t('error.plugin.frontend_repo_already_installed', plugin_name=plugin_name))

    try:
        await run_in_threadpool(porcelain.clone, repo_url, plugins_dir / plugin_name, checkout=True)
    except Exception as e:
        log.error(f'前端插件安装失败: {e}')
        raise errors.ServerError(msg=t('error.plugin.frontend_install_failed')) from e

    return plugin_name


def remove_plugin(plugin_dir: os.PathLike) -> None:
    """
    删除插件

    :param plugin_dir: 插件目录
    :return:
    """
    import shutil

    def _on_error(func, path, _exc_info) -> None:  # ruff:ignore[missing-type-function-argument]
        os.chmod(path, stat.S_IWRITE)
        func(path)

    shutil.rmtree(plugin_dir, onerror=_on_error)


def zip_plugin(plugin_dir: os.PathLike, target: os.PathLike | io.BytesIO) -> None:
    """
    zip 压缩插件

    :param plugin_dir: 插件目录
    :param target: 压缩目标
    :return:
    """
    with zipfile.ZipFile(target, 'w') as zf:
        plugin_dir_parent = os.path.dirname(plugin_dir)
        for root, dirs, files in os.walk(plugin_dir):
            dirs[:] = [d for d in dirs if d != '__pycache__']
            for file in files:
                file_path = os.path.join(root, file)
                arcname = os.path.relpath(file_path, start=plugin_dir_parent)
                zf.write(file_path, arcname)
