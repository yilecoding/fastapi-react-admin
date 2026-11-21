import io
import json
import re

from typing import Any

import anyio

from fastapi import UploadFile
from starlette.concurrency import run_in_threadpool

from backend.common.enums import PluginType, StatusType
from backend.common.exception import errors
from backend.common.i18n import t
from backend.core.conf import settings
from backend.core.path_conf import PLUGIN_DIR
from backend.database.redis import redis_client
from backend.plugin.core import get_plugins, get_required_plugins, load_plugin_config
from backend.plugin.installer import install_git_plugin, install_zip_plugin, remove_plugin, zip_plugin
from backend.plugin.requirements import uninstall_requirements_async
from backend.plugin.status import get_plugin_enable
from backend.utils.timezone import timezone


async def _get_plugin_dir(plugin: str) -> anyio.Path:
    """Resolve only a named plugin package directly inside the plugin root."""
    if not re.fullmatch(r'[A-Za-z0-9_-]+', plugin):
        raise errors.NotFoundError(msg=t('error.plugin.not_found'))

    root = await anyio.Path(PLUGIN_DIR).resolve()
    plugin_dir = await (root / plugin).resolve()
    # Also reject aliases to other packages and links/junctions outside the root.
    if (
        plugin_dir.parent != root
        or plugin_dir.name != plugin
        or not await plugin_dir.is_dir()
        or not await (plugin_dir / '__init__.py').is_file()
    ):
        raise errors.NotFoundError(msg=t('error.plugin.not_found'))
    return plugin_dir


def _depends_on(plugin: str) -> list[str]:
    try:
        return list(load_plugin_config(plugin).get('plugin', {}).get('depends_on') or [])
    except Exception:
        # plugin.toml 读不出来的插件不参与依赖判断（启动时它自己会报）
        return []


async def _check_status_change(plugin: str, *, enable: bool) -> None:
    """启停前的两道检查（#395）

    - 停用：必需插件不许停（`uninstall` 早就拦了，这里原来没有 —— 停掉 `dict` 当场字典接口全挂）；
      被**已启用**的插件依赖的不许停 —— 原来当时一切正常，下次重启 `resolve_plugin_order` 抛错、API 起不来
    - 启用：依赖的插件得先是启用的，同一个道理反过来
    """
    if not enable:
        if plugin in get_required_plugins():
            raise errors.RequestError(msg=t('error.plugin.required_cannot_disable', plugin=plugin))
        others = [name for name in get_plugins() if name != plugin and plugin in _depends_on(name)]
        if others:
            infos = await redis_client.mget(*[f'{settings.PLUGIN_REDIS_PREFIX}:{name}' for name in others])
            dependents = [
                name
                for name, info in zip(others, infos, strict=True)
                if get_plugin_enable(info, StatusType.enable.value) == str(StatusType.enable.value)
            ]
            if dependents:
                raise errors.RequestError(
                    msg=t('error.plugin.depended_cannot_disable', plugin=plugin, dependents=', '.join(dependents))
                )
        return
    deps = [name for name in _depends_on(plugin) if name in get_plugins()]
    if deps:
        infos = await redis_client.mget(*[f'{settings.PLUGIN_REDIS_PREFIX}:{name}' for name in deps])
        off = [
            name
            for name, info in zip(deps, infos, strict=True)
            if get_plugin_enable(info, StatusType.enable.value) != str(StatusType.enable.value)
        ]
        if off:
            raise errors.RequestError(
                msg=t('error.plugin.dependency_not_enabled', plugin=plugin, dependencies=', '.join(off))
            )


class PluginService:
    """插件服务类"""

    @staticmethod
    async def get_all() -> list[dict[str, Any]]:
        """获取所有插件"""

        changed_key = f'{settings.PLUGIN_REDIS_PREFIX}:changed'
        keys = [key for key in await redis_client.get_by_prefix(settings.PLUGIN_REDIS_PREFIX) if key != changed_key]
        if not keys:
            return []

        result = []
        plugin_infos = await redis_client.mget(*keys)
        for info in plugin_infos:
            if info is None:
                continue

            plugin_info = json.loads(info)
            if isinstance(plugin_info, dict):
                result.append(plugin_info)

        return result

    @staticmethod
    async def changed() -> str | None:
        """检查插件是否发生变更"""
        return await redis_client.get(f'{settings.PLUGIN_REDIS_PREFIX}:changed')

    @staticmethod
    async def install(*, type: PluginType, file: UploadFile | None = None, repo_url: str | None = None) -> str:
        """
        安装插件

        :param type: 插件类型
        :param file: 插件 zip 压缩包
        :param repo_url: git 仓库地址
        :return:
        """
        if settings.ENVIRONMENT != 'dev':
            raise errors.RequestError(msg=t('error.plugin.dev_only_install'))
        if type == PluginType.zip:
            if not file:
                raise errors.RequestError(msg=t('error.plugin.zip_required'))
            return await install_zip_plugin(file)
        if not repo_url:
            raise errors.RequestError(msg=t('error.plugin.git_repo_required'))
        return await install_git_plugin(repo_url)

    @staticmethod
    async def uninstall(*, plugin: str) -> None:
        """
        卸载插件

        :param plugin: 插件名称
        :return:
        """
        if settings.ENVIRONMENT != 'dev':
            raise errors.RequestError(msg=t('error.plugin.dev_only_uninstall'))
        plugin_dir = await _get_plugin_dir(plugin)
        if plugin in get_required_plugins():
            raise errors.RequestError(msg=t('error.plugin.required_cannot_uninstall', plugin=plugin))
        await uninstall_requirements_async(plugin)
        backup_file = PLUGIN_DIR / f'{plugin}.{timezone.now().strftime("%Y%m%d%H%M%S")}.backup.zip'
        await run_in_threadpool(zip_plugin, plugin_dir, backup_file)
        await run_in_threadpool(remove_plugin, plugin_dir)
        await redis_client.delete(f'{settings.PLUGIN_REDIS_PREFIX}:{plugin}')
        await redis_client.set(f'{settings.PLUGIN_REDIS_PREFIX}:changed', 'true')

    @staticmethod
    async def update_status(*, plugin: str) -> None:
        """
        更新插件状态

        :param plugin: 插件名称
        :return:
        """
        await _get_plugin_dir(plugin)
        plugin_key = f'{settings.PLUGIN_REDIS_PREFIX}:{plugin}'
        plugin_info = await redis_client.get(plugin_key)
        if not plugin_info:
            raise errors.NotFoundError(msg=t('error.plugin.not_found'))
        plugin_info = json.loads(plugin_info)

        # 更新持久缓存状态
        new_status = (
            str(StatusType.enable.value)
            if plugin_info['plugin']['enable'] == str(StatusType.disable.value)
            else str(StatusType.disable.value)
        )
        await _check_status_change(plugin, enable=new_status == str(StatusType.enable.value))
        plugin_info['plugin']['enable'] = new_status
        await redis_client.set(plugin_key, json.dumps(plugin_info, ensure_ascii=False))
        await redis_client.set(f'{settings.PLUGIN_REDIS_PREFIX}:changed', 'true')

    @staticmethod
    async def build(*, plugin: str) -> io.BytesIO:
        """
        打包插件为 zip 压缩包

        :param plugin: 插件名称
        :return:
        """
        plugin_dir = await _get_plugin_dir(plugin)

        bio = io.BytesIO()
        await run_in_threadpool(zip_plugin, plugin_dir, bio)
        bio.seek(0)
        return bio


plugin_service: PluginService = PluginService()
