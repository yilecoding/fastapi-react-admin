import json
import os

from functools import lru_cache
from typing import Any

import rtoml

from backend.common.dataclasses import PluginEntry
from backend.common.enums import PluginLevelType, StatusType
from backend.common.log import log
from backend.core.conf import settings
from backend.core.path_conf import PLUGIN_DIR
from backend.database.redis import RedisCli
from backend.plugin.errors import PluginConfigError, PluginInjectError
from backend.plugin.status import get_plugin_enable
from backend.plugin.validator import validate_plugin_config
from backend.utils.async_helper import run_await
from backend.utils.dynamic_import import get_model_objects


def check_plugin_installed(plugin_name: str) -> bool:
    """
    检查插件是否已安装

    :param plugin_name: 插件名称
    :return:
    """
    return (PLUGIN_DIR / plugin_name / '__init__.py').exists()


def get_required_plugins() -> tuple[str, ...]:
    """获取必需插件列表"""
    required_plugins = list(settings.PLUGIN_REQUIRED)
    if not settings.RBAC_ROLE_MENU_MODE and 'casbin_rbac' not in required_plugins:
        required_plugins.append('casbin_rbac')
    return tuple(required_plugins)


def check_required_plugins() -> None:
    """检查必需插件"""
    required_plugins = get_required_plugins()
    missing_plugins = [name for name in required_plugins if not check_plugin_installed(name)]
    if missing_plugins:
        raise PluginInjectError(f'当前系统缺少以下插件: {", ".join(missing_plugins)}，请先安装对应插件')


@lru_cache(maxsize=128)
def get_plugins() -> tuple[str, ...]:
    """获取插件列表"""
    plugin_packages = []

    # 遍历插件目录。🔴 要排序（#234 顺带发现）：`os.listdir` 是文件系统自己的顺序，不同机器不同 ——
    # 插件顺序决定路由注册顺序，于是同一份代码在两台机器上路由优先级可能不一样、导出的 OpenAPI 也不一样
    for item in sorted(os.listdir(PLUGIN_DIR)):
        item_path = PLUGIN_DIR / item
        if not os.path.isdir(item_path) and item == '__pycache__':
            continue

        # 检查是否为目录且包含 __init__.py 文件
        if os.path.isdir(item_path) and '__init__.py' in os.listdir(item_path):
            plugin_packages.append(item)

    return tuple(plugin_packages)


def get_enabled_plugins(plugins: tuple[str, ...] | None = None) -> set[str]:
    """
    获取已启用的插件列表

    :param plugins: 插件名称列表
    :return:
    """
    plugin_names = plugins or get_plugins()
    enabled_plugins = set(plugin_names)

    current_redis_client = RedisCli()
    run_await(current_redis_client.init)()

    required = set(get_required_plugins())
    try:
        for plugin in plugin_names:
            plugin_info = run_await(current_redis_client.get)(f'{settings.PLUGIN_REDIS_PREFIX}:{plugin}')
            if get_plugin_enable(plugin_info, StatusType.enable.value) != str(StatusType.enable.value):
                if plugin in required:
                    # 必需插件不许停（#395）：接口那边拦住了，这里兜住拦之前就停掉的。
                    # 原来照样当停用处理 —— 停掉 `dict` 后重启，字典路由全 404、整套表单下拉为空，启动不报一个字
                    log.error(f'必需插件 {plugin} 被标记为停用，已按启用加载；请到插件页把它重新启用')
                    continue
                enabled_plugins.discard(plugin)
    finally:
        run_await(current_redis_client.aclose)()

    return enabled_plugins


def load_plugin_config(plugin: str) -> dict[str, Any]:
    """
    加载插件配置

    :param plugin: 插件名称
    :return:
    """
    toml_path = PLUGIN_DIR / plugin / 'plugin.toml'
    if not os.path.exists(toml_path):
        raise PluginInjectError(f'插件 {plugin} 缺少 plugin.toml 配置文件，请检查插件是否合法')

    with open(toml_path, encoding='utf-8') as f:
        return rtoml.load(f)


def parse_plugin_config() -> tuple[list[PluginEntry], list[PluginEntry]]:
    """解析插件配置"""
    plugins = get_plugins()
    extend_plugins: list[PluginEntry] = []
    app_plugins: list[PluginEntry] = []

    # 使用独立连接
    current_redis_client = RedisCli()
    run_await(current_redis_client.init)()

    try:
        # 清理未知插件信息
        exclude_keys = [f'{settings.PLUGIN_REDIS_PREFIX}:{key}' for key in plugins]
        run_await(current_redis_client.delete_by_prefix)(
            settings.PLUGIN_REDIS_PREFIX,
            exclude_keys=exclude_keys,
        )

        for plugin in plugins:
            plugin_config = load_plugin_config(plugin)
            plugin_type = validate_plugin_config(plugin, plugin_config)

            # 补充插件信息
            plugin_config['plugin']['name'] = plugin
            plugin_cache_key = f'{settings.PLUGIN_REDIS_PREFIX}:{plugin}'
            plugin_cache_info = run_await(current_redis_client.get)(plugin_cache_key)
            plugin_config['plugin']['enable'] = get_plugin_enable(plugin_cache_info, StatusType.enable.value)

            if plugin_type == PluginLevelType.extend:
                extend_plugins.append(
                    PluginEntry(
                        name=plugin,
                        depends_on=plugin_config['plugin'].get('depends_on'),
                        extend=plugin_config['app']['extend'],
                        api=plugin_config['api'],
                    )
                )
            elif plugin_type == PluginLevelType.app:
                app_plugins.append(
                    PluginEntry(
                        name=plugin,
                        depends_on=plugin_config['plugin'].get('depends_on'),
                        routers=plugin_config['app']['router'],
                    )
                )

            # 缓存最新插件信息
            run_await(current_redis_client.set)(plugin_cache_key, json.dumps(plugin_config, ensure_ascii=False))

        # 重置插件变更状态
        run_await(current_redis_client.delete)(f'{settings.PLUGIN_REDIS_PREFIX}:changed')
    finally:
        run_await(current_redis_client.aclose)()

    return extend_plugins, app_plugins


def resolve_plugin_order(plugins: list[PluginEntry]) -> list[PluginEntry]:
    """
    根据 depends_on 对插件排序

    :param plugins: 插件配置列表
    :return:
    """
    plugin_map = {plugin.name: plugin for plugin in plugins}
    ordered_plugins: list[PluginEntry] = []
    visited: set[str] = set()
    visiting: list[str] = []

    def visit(plugin: PluginEntry) -> None:
        if plugin.name in visited:
            return
        if plugin.name in visiting:
            cycle_start = visiting.index(plugin.name)
            cycle_path = [*visiting[cycle_start:], plugin.name]
            raise PluginConfigError(f'插件存在循环依赖: {" -> ".join(cycle_path)}')

        if plugin.depends_on is not None:
            visiting.append(plugin.name)
            for dep_name in plugin.depends_on:
                dep_plugin = plugin_map.get(dep_name)
                if dep_plugin is None:
                    raise PluginConfigError(f'插件 {plugin.name} 依赖插件 {dep_name}，但插件 {dep_name} 不存在')
                visit(dep_plugin)
            visiting.pop()

        visited.add(plugin.name)
        ordered_plugins.append(plugin)

    for plugin in plugins:
        visit(plugin)

    return ordered_plugins


def drop_disabled_dependents(plugins: list[PluginEntry], installed: set[str]) -> list[PluginEntry]:
    """去掉依赖了「已安装但停用」插件的那些（连带传递），记错误日志（#395）

    停用一个被依赖的插件（比如 `notification`，`notice` 和 `workflow` 都依赖它），原来当时一切正常，
    下次重启 `resolve_plugin_order` 抛 `PluginConfigError: … 但插件 notification 不存在`，API 起不来，
    而且没有界面能恢复（只能手改 Redis）。接口那边现在拦住了这种停用，这里兜住拦之前就停掉的：
    少加载几个插件，进程照样起来，管理员能在插件页把依赖重新启用。依赖**没装**的照旧报错（那是装错了）

    :param plugins: 已启用的插件
    :param installed: 所有已安装插件名
    :return:
    """
    kept = list(plugins)
    while True:
        names = {p.name for p in kept}
        dropped = [p for p in kept if any(dep in installed and dep not in names for dep in (p.depends_on or []))]
        if not dropped:
            return kept
        for p in dropped:
            missing = [dep for dep in p.depends_on or [] if dep in installed and dep not in names]
            log.error(f'插件 {p.name} 依赖的插件 {", ".join(missing)} 已停用，本次不加载 {p.name}')
        kept = [p for p in kept if p not in dropped]


def get_ordered_enabled_plugins() -> list[PluginEntry]:
    """获取按依赖排序后的已启用插件"""
    enabled_plugins = get_enabled_plugins()
    extend_plugins, app_plugins = parse_plugin_config()
    plugins: list[PluginEntry] = [plugin for plugin in extend_plugins + app_plugins if plugin.name in enabled_plugins]
    plugins = drop_disabled_dependents(plugins, {plugin.name for plugin in extend_plugins + app_plugins})

    try:
        return resolve_plugin_order(plugins)
    except PluginConfigError as e:
        log.error(f'插件依赖解析失败: {e}')
        raise


def get_plugin_models() -> list[object]:
    """获取插件所有模型类"""
    objs = []

    for plugin in get_plugins():
        module_path = f'backend.plugin.{plugin}.model'
        model_objs = get_model_objects(module_path)
        if model_objs:
            objs.extend(model_objs)

    return objs
