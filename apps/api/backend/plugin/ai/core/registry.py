"""工具注册表：`@ai_tool` 装饰器 + 从函数签名自动推断 JSON Schema。

工具作者写的是**一个普通 async 函数 + 一行装饰器**，不关心：
当前用的是哪个引擎、schema 长什么样、权限怎么校验、怎么落审计。
"""

import importlib
import importlib.util
import inspect
import pkgutil

from collections.abc import Awaitable, Callable
from typing import Any

from pydantic import create_model

from backend.common.log import log
from backend.plugin.ai.core.ports import ToolSpec

# 注册表：工具名 -> ToolSpec。进程内全局，随 import 建立（同 celery 的任务注册）。
_REGISTRY: dict[str, ToolSpec] = {}

# handler 里由 dispatcher 注入、**不暴露给模型**的参数名
_INJECTED_PARAMS = frozenset({'db', 'ctx'})


def _schema_from_signature(fn: Callable[..., Any], name: str) -> dict[str, Any]:
    """从函数签名生成 JSON Schema（object）。

    ⚠️ 只支持能被 pydantic 表达的简单标注（`str | None`、`int`、`bool`…）。
    工具入参故意保持简单——嵌套结构生成出来带 `$defs`/`$ref`，各家模型对 ref 的
    支持程度不一样，而"模型看不懂 schema"的表现是它**乱填参数**，不是报错。
    """
    sig = inspect.signature(fn)
    fields: dict[str, Any] = {}
    for param_name, param in sig.parameters.items():
        if param_name in _INJECTED_PARAMS:
            continue
        annotation = Any if param.annotation is inspect.Parameter.empty else param.annotation
        default = ... if param.default is inspect.Parameter.empty else param.default
        fields[param_name] = (annotation, default)

    if not fields:
        return {'type': 'object', 'properties': {}}

    model = create_model(f'{name}_Params', **fields)  # type: ignore[call-overload]
    schema = model.model_json_schema()
    # pydantic 会带上 title，对模型没用，去掉减少噪音
    schema.pop('title', None)
    for prop in schema.get('properties', {}).values():
        prop.pop('title', None)
    return schema


def _owner_plugin(module: str) -> str | None:
    """`backend.plugin.workflow.ai_tools` → `workflow`。AI 插件自己的工具不算（它停用时对话入口本身就被拦了），
    不在插件目录下的也没有归属"""
    parts = module.split('.')
    owner = parts[2] if len(parts) > 3 and parts[:2] == ['backend', 'plugin'] else None
    return None if owner == 'ai' else owner


def ai_tool(
    *,
    name: str,
    description: str,
    domain: str,
    perm: str | None = None,
    mutating: bool = False,
    preview: Callable[..., Awaitable[str]] | None = None,
    self_authorized: bool = False,
) -> Callable[[Callable[..., Any]], Callable[..., Any]]:
    """把一个 async 函数注册成 AI 可调用的工具。

    :param name: 工具名，模型看到的就是它（英文小写下划线，和 OpenAI 惯例一致）
    :param description: 给**模型**看的说明——写清楚"什么时候该用它"，不是写给人看的文档
    :param domain: 工具域，对应 `AI_TOOL_DOMAINS`，整域可开关
    :param perm: 权限码。复用现有 RBAC 权限码，**不要发明新的授权模型**
    :param mutating: 会不会改变系统状态。`True` 触发二次确认 + `is_staff` 校验
    :param preview: 变更类工具**必填**的预演函数（只读），返回「会变成什么」给人确认
    :param self_authorized: 写操作的授权由业务自己判定、不要求 `is_staff`（见 `ToolSpec.self_authorized`）
    """

    def decorator(fn: Callable[..., Any]) -> Callable[..., Any]:
        if not inspect.iscoroutinefunction(fn):
            raise TypeError(f'AI 工具 {name} 必须是 async 函数')
        if name in _REGISTRY:
            raise ValueError(f'AI 工具重名：{name}')
        # 🔴 变更类工具必须带预演。没有它，确认卡片上只有「工具名 + 参数」——
        # `dept_id: "2048601263515500544"` 对人来说什么都没说，「点头」就退化成了走过场
        if mutating and preview is None:
            raise TypeError(f'变更类 AI 工具 {name} 必须提供 preview（预演）')
        if self_authorized and not mutating:
            raise TypeError(f'AI 工具 {name}：self_authorized 只对写操作工具有意义')
        if preview is not None and not inspect.iscoroutinefunction(preview):
            raise TypeError(f'AI 工具 {name} 的 preview 必须是 async 函数')

        spec = ToolSpec(
            name=name,
            description=description,
            parameters=_schema_from_signature(fn, name),
            handler=fn,
            domain=domain,
            perm=perm,
            mutating=mutating,
            preview=preview,
            self_authorized=self_authorized,
            plugin=_owner_plugin(fn.__module__),
            wants_db='db' in inspect.signature(fn).parameters,
            wants_ctx='ctx' in inspect.signature(fn).parameters,
        )
        _REGISTRY[name] = spec
        return fn

    return decorator


def get_tool(name: str) -> ToolSpec | None:
    """按名字取工具（模型给的名字不可信，取不到要当成一次失败的调用，不是崩溃）"""
    return _REGISTRY.get(name)


def all_tools() -> list[ToolSpec]:
    """注册表里的全部工具（不过滤域、不过滤权限）"""
    return list(_REGISTRY.values())


def tools_in_domains(domains: list[str]) -> list[ToolSpec]:
    """按域筛选。不在 `AI_TOOL_DOMAINS` 里的域**整域不出现**在工具清单里。"""
    allowed = set(domains)
    return [spec for spec in _REGISTRY.values() if spec.domain in allowed]


def load_builtin_tools() -> None:
    """自动发现并 import `tools/` 下的全部模块，触发装饰器注册。

    🔴 **刻意不维护一份手写的 import 清单。** 和 celery 的任务发现同一个物种：
    没被 import 的工具等于不存在，而"不存在"的表现是模型答"我没有这个能力"——
    不报错、不告警。手写清单意味着每加一个工具文件都要"记得"改这里，
    而漏掉的代价恰恰是最难查的那一种。
    """
    package = importlib.import_module('backend.plugin.ai.tools')
    for module in pkgutil.iter_modules(package.__path__):
        if not module.name.startswith('_'):
            importlib.import_module(f'{package.__name__}.{module.name}')

    # 别的插件自己带的工具：`backend/plugin/<插件>/ai_tools.py`。放在插件自己那里，依赖方向是「插件 → ai」——
    # 两个都能卸载，反过来放进 `tools/` 就成了 AI 插件依赖一个可能不存在的插件（审批的工具就是这么放的）
    plugins = importlib.import_module('backend.plugin')
    for module in pkgutil.iter_modules(plugins.__path__):
        if module.ispkg and module.name != 'ai' and importlib.util.find_spec(f'backend.plugin.{module.name}.ai_tools'):
            importlib.import_module(f'backend.plugin.{module.name}.ai_tools')

    log.debug(f'AI 工具注册完成，共 {len(_REGISTRY)} 个：{sorted(_REGISTRY)}')
