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
from backend.plugin.requirements import install_requirements_async
from backend.utils.locks import acquire_distributed_reload_lock
from backend.utils.pattern_validate import is_git_url


async def _append_env_example(plugin_path: anyio.Path) -> None:
    """
    追加主 .env 文件

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

    separator = '\n' if existing_content and not existing_content.endswith('\n') else ''
    new_content = f'{existing_content}{separator}{env_example_content}'

    async with await open_file(env_path, mode='w', encoding='utf-8') as f:
        await f.write(new_content)


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
            await run_in_threadpool(zf.extractall, full_plugin_path, members)

        await _append_env_example(full_plugin_path)
        await install_requirements_async(plugin_name)
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
    path = anyio.Path(PLUGIN_DIR / repo_name)
    if await path.exists():
        raise errors.ConflictError(msg=t('error.plugin.repo_already_installed', repo_name=repo_name))

    async with acquire_distributed_reload_lock():
        try:
            await run_in_threadpool(porcelain.clone, repo_url, PLUGIN_DIR / repo_name, checkout=True)
        except Exception as e:
            log.error(f'插件安装失败: {e}')
            raise errors.ServerError(msg=t('error.plugin.install_failed')) from e

        await _append_env_example(path)
        await install_requirements_async(repo_name)
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
