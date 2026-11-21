import site
import subprocess
import sys

from importlib import invalidate_caches
from importlib.metadata import PackageNotFoundError, distribution
from pathlib import Path

from packaging.markers import default_environment
from packaging.requirements import Requirement
from packaging.utils import canonicalize_name
from starlette.concurrency import run_in_threadpool

from backend.common.log import log
from backend.core.conf import settings
from backend.core.path_conf import PLUGIN_DIR
from backend.plugin.core import get_plugins
from backend.plugin.errors import PluginInstallError


def _is_in_virtualenv() -> bool:
    """检测当前是否在虚拟环境中运行"""
    return hasattr(sys, 'real_prefix') or (hasattr(sys, 'base_prefix') and sys.base_prefix != sys.prefix)


#: requirements 文件里只影响「去哪装」的选项行：和「装没装」无关，跳过
_INDEX_OPTIONS = (
    '-i',
    '--index-url',
    '--extra-index-url',
    '--no-index',
    '-f',
    '--find-links',
    '--trusted-host',
    '--pre',
    '--prefer-binary',
    '--only-binary',
    '--no-binary',
)

#: pip 单次安装的超时（秒）。原来 `check_call` 不带超时，`TimeoutExpired` 分支是死代码：
#: pip 卡在网络上时一直占着插件安装锁，启动时则卡在「安装插件依赖」那一步不动
PIP_TIMEOUT_SECONDS = 600


def _requirements_installed(requirements_file: Path) -> bool:  # ruff:ignore[complex-structure]
    """检查 requirements 及其 extras 子依赖是否已安装

    🔴 认不出的行**交给 pip**（返回「没装齐」），不抛错（#395）。原来 `-r base.txt` / `--index-url …` /
    `-e .` / `git+https://…` / 行尾注释 / `--hash=…` 全部 `InvalidRequirement` → `PluginInstallError`，
    而启动时 `_prepare_plugins()` 对每个插件都跑这一步 —— 一个这样写的插件让整个后端起不来
    """
    requirements = []
    for raw in requirements_file.read_text(encoding='utf-8').splitlines():
        # 行尾注释（pip 的规则：`#` 前面要有空白）和逐行的 `--hash=…` 选项
        line = raw.split(' #', 1)[0].split(' --', 1)[0].strip()
        if not line or line.startswith('#'):
            continue
        if line.split('=', 1)[0].split(' ', 1)[0] in _INDEX_OPTIONS:
            continue
        try:
            requirements.append(Requirement(line))
        except Exception:
            # `-r` / `-c` / `-e` / 裸 URL：这里判断不了装没装，让 pip 去判断
            return False

    environment = default_environment()
    visited = set()

    def requirement_satisfied(requirement: Requirement, active_extras: frozenset[str] = frozenset({''})) -> bool:
        if requirement.marker and not any(
            requirement.marker.evaluate(environment={**environment, 'extra': extra}) for extra in active_extras
        ):
            return True

        try:
            dist = distribution(requirement.name)
        except PackageNotFoundError:
            return False

        if requirement.specifier and not requirement.specifier.contains(dist.version, prereleases=True):
            return False

        requested_extras = tuple(sorted(requirement.extras))
        state = (canonicalize_name(requirement.name), requested_extras)
        if state in visited:
            return True
        visited.add(state)

        child_active_extras = frozenset(requirement.extras) or frozenset({''})
        for dependency_line in dist.requires or []:
            try:
                dependency = Requirement(dependency_line)
            except Exception as e:
                raise PluginInstallError(f'依赖元数据 {dependency_line} 格式错误: {e!s}') from e
            if not requirement_satisfied(dependency, child_active_extras):
                return False

        return True

    return all(requirement_satisfied(requirement) for requirement in requirements)


def install_requirements(plugin: str | None) -> None:  # ruff:ignore[complex-structure]
    """
    安装插件依赖

    :param plugin: 指定插件名，否则检查所有插件
    :return:
    """
    plugins = [plugin] if plugin else get_plugins()

    for plugin in plugins:
        requirements_file = PLUGIN_DIR / plugin / 'requirements.txt'
        if not requirements_file.exists() or _requirements_installed(requirements_file):
            continue

        pip_install = ['uv', 'pip', 'install', '-r', str(requirements_file), '--prerelease=allow']
        if not _is_in_virtualenv():
            pip_install.append('--system')
        if settings.PLUGIN_PIP_CHINA:
            # 将国内源作为优先索引，同时保留 PyPI 作为回退来源
            pip_install.extend([
                '--index',
                settings.PLUGIN_PIP_INDEX_URL,
                '--index-strategy',
                'unsafe-best-match',
            ])

        max_retries = settings.PLUGIN_PIP_MAX_RETRY
        for attempt in range(max_retries):
            try:
                subprocess.check_call(pip_install, timeout=PIP_TIMEOUT_SECONDS)
                invalidate_caches()
                for site_dir in site.getsitepackages():
                    if site_dir.endswith('site-packages'):
                        site.addsitedir(site_dir)
                break
            except subprocess.TimeoutExpired:
                if attempt == max_retries - 1:
                    raise PluginInstallError(f'插件 {plugin} 依赖安装超时')
                continue
            except subprocess.CalledProcessError as e:
                if attempt == max_retries - 1:
                    raise PluginInstallError(f'插件 {plugin} 依赖安装失败：{e}') from e
                continue


def install_requirements_on_startup(plugin: str) -> bool:
    """启动时给一个插件装依赖：失败只记错误日志、不中断启动（#395）

    装依赖失败多半是网络 / 镜像的问题，依赖可能早就装好了（只是判断不出来）。原来这里一抛，整个进程起不来，
    连「去插件页把它停掉 / 卸掉」的机会都没有。真缺依赖的话，导入那个插件时会报 `ModuleNotFoundError`，指向具体的包

    :param plugin: 插件名称
    :return: 是否成功
    """
    try:
        install_requirements(plugin)
    except PluginInstallError as e:
        log.error(f'插件 {plugin} 依赖安装失败，跳过、继续启动：{e}')
        return False
    return True


def uninstall_requirements(plugin: str) -> None:
    """
    卸载插件依赖

    :param plugin: 插件名称
    :return:
    """
    requirements_file = PLUGIN_DIR / plugin / 'requirements.txt'
    if not requirements_file.exists():
        return

    try:
        pip_uninstall = ['uv', 'pip', 'uninstall', '-r', str(requirements_file)]
        if not _is_in_virtualenv():
            pip_uninstall.append('--system')
        subprocess.check_call(pip_uninstall, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except subprocess.CalledProcessError as e:
        raise PluginInstallError(f'插件 {plugin} 依赖卸载失败：{e}') from e


async def install_requirements_async(plugin: str | None = None) -> None:
    """
    异步安装插件依赖

    由于 Windows 平台限制，无法实现完美的全异步方案，详情：
    https://stackoverflow.com/questions/44633458/why-am-i-getting-notimplementederror-with-async-and-await-on-windows
    """
    await run_in_threadpool(install_requirements, plugin)


async def uninstall_requirements_async(plugin: str) -> None:
    """
    异步卸载插件依赖

    :param plugin: 插件名称
    :return:
    """
    await run_in_threadpool(uninstall_requirements, plugin)
