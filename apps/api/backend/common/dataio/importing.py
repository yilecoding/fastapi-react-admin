"""导入定义：每个资源写一份，登记到这里（#11 · v0.4）。

流程是用户导入那一套抽出来的（原来写死在 `user_import_service` 里）：

1. **模板**：表头是当前语言的列名（不是英文 key），固定取值和编码类的列带下拉，第二张表是说明
2. **预览**：解析 → 必填 / 取值 / 文件内重复 → 资源自己的校验（`validate`）→ 不落库，结果存 Redis，换一个一次性令牌
3. **提交**：凭令牌取回有效行 → **再校验一遍**（预览之后库里可能变了）→ 资源自己落库（`commit`）

表头三种写法都认：英文 key、中文列名、英文列名 —— 所以**导出的文件改完能原样导回来**
（导出的表头用的是同一套列名）。

三种模式（ContiNew / HubSpot 的叫法，RuoYi 的「是否更新已经存在的数据」是其中两种）：

| 模式 | 业务键在库里已存在 | 不存在 |
|---|---|---|
| `create` 只新增 | 报错 | 新增 |
| `upsert` 新增并更新 | 更新 | 新增 |
| `update` 只更新 | 更新 | 报错 |

资源只实现「怎么校验一行」「怎么写一行」，模式、令牌、报告、表头匹配都在框架里。
"""

import dataclasses
import inspect

from collections.abc import Awaitable, Callable, Mapping
from typing import Any, Literal

from sqlalchemy.ext.asyncio import AsyncSession

from backend.common.log import log

ImportMode = Literal['create', 'upsert', 'update']
IMPORT_MODES: tuple[ImportMode, ...] = ('create', 'upsert', 'update')

#: 「状态」列（1 正常 / 0 停用）手打时常见的别的写法。比较时不分大小写
ENABLE_STATUS_ALIASES: Mapping[int, tuple[str, ...]] = {
    1: ('启用', '开启', '有效', 'enable', 'enabled', 'active', 'on'),
    0: ('禁用', '关闭', '无效', 'disable', 'disabled', 'inactive', 'off'),
}


@dataclasses.dataclass(frozen=True, slots=True)
class ImportColumn:
    """一列"""

    key: str
    #: 列名的翻译键。模板表头就是它，解析时它的各语言译文都算这一列
    label: str
    required: bool = False
    #: 额外认的表头写法（老模板的英文名之类）
    aliases: tuple[str, ...] = ()
    #: 说明页里这一列的说明（翻译键）
    note: str | None = None
    #: 固定取值：值 → 翻译键（「状态」那种）。文件里填文字（任一语言）或者值本身都认，模板里做成下拉
    choices: Mapping[Any, str] | None = None
    #: 取值的别的写法（值 → 写法们）。下拉里是「正常 / 停用」，而人手打的常常是「启用 / 禁用」
    choice_aliases: Mapping[Any, tuple[str, ...]] | None = None
    #: 动态取值（部门编码、字典类型编码……）：只用来在模板里做下拉、在说明页里列出来，校验由资源自己做
    options: Callable[[AsyncSession], Awaitable[list[str]]] | None = None
    #: 有取值时做不做成下拉。一格填多个值的列（「角色编码」填 `A,B`）不做：下拉一次只能选一个，
    #: 手填两个又会被 Excel 弹「不在下拉选项里」—— 那种列只在说明页里列出可选值
    dropdown: bool = True
    #: `int`：读进来按整数解析；编码类的列 `upper=True` 统一转大写（编码约定全大写）
    kind: Literal['text', 'int'] = 'text'
    upper: bool = False
    width: int = 18


@dataclasses.dataclass
class ImportRow:
    """一行。框架填 `values` / `raw` / `errors`，资源的 `validate` 填 `action` / `target_id` / `payload`"""

    #: Excel 里的真实行号（表头是 1）—— 报给用户的必须是这个，他要回 Excel 里定位
    row_no: int
    #: 归一后的值：取值已经换成值、整数已经解析、编码已经大写
    values: dict[str, Any]
    #: 原样的单元格文本：错误报告要原样写回去，用户改完能直接再导
    raw: dict[str, str | None]
    errors: list[str] = dataclasses.field(default_factory=list)
    #: `create` / `update`
    action: str | None = None
    #: 要更新的那一行的 ID（`update` 时）
    target_id: int | None = None
    #: 资源自己要的、落库用的数据（必须能 JSON 序列化：它要过一次 Redis）
    payload: dict[str, Any] | None = None

    @property
    def ok(self) -> bool:
        return not self.errors


@dataclasses.dataclass(frozen=True, slots=True)
class ImportContext:
    """一次导入里资源要用到的上下文"""

    #: 导入人（`request.user`）。校验「这个上级部门他看不看得见」之类要用
    user: Any
    #: FastAPI 的后台任务（响应发出之后才跑）。service 方法要它的就传给它（`dept_service.update` 清用户缓存）
    background_tasks: Any | None = None
    _after_commit: list[tuple[Callable[..., Any], tuple[Any, ...], dict[str, Any]]] = dataclasses.field(
        default_factory=list
    )

    def after_commit(self, func: Callable[..., Any], /, *args: Any, **kwargs: Any) -> None:
        """登记一件**事务提交之后**才做的事（清缓存那种）。全有或全无模式回滚了就不做"""
        self._after_commit.append((func, args, kwargs))

    async def run_after_commit(self) -> None:
        """框架在提交之后调"""
        for func, args, kwargs in self._after_commit:
            await _run_quietly(func, args, kwargs)


async def _run_quietly(func: Callable[..., Any], args: tuple[Any, ...], kwargs: dict[str, Any]) -> None:
    """数据已经落库了，这里失败只记日志 —— 报错给用户会让他以为没导进去、再导一遍"""
    try:
        result = func(*args, **kwargs)
        if inspect.isawaitable(result):
            await result
    except Exception:
        log.exception(f'导入提交之后的 {getattr(func, "__name__", func)} 失败')


@dataclasses.dataclass(frozen=True, slots=True)
class CommitOutcome:
    """落库的结果。`failed` 是 行号 → 原因"""

    created: list[str] = dataclasses.field(default_factory=list)
    updated: list[str] = dataclasses.field(default_factory=list)
    failed: dict[int, str] = dataclasses.field(default_factory=dict)
    #: 要提醒用户的话（已翻译），比如「这批账号用的是默认密码」
    notes: list[str] = dataclasses.field(default_factory=list)


@dataclasses.dataclass(frozen=True)
class ImportSpec:
    """一个资源的导入定义"""

    resource: str
    #: 资源名的翻译键（「部门」）：模板文件名、错误报告文件名用它
    label: str
    columns: tuple[ImportColumn, ...]
    #: 业务键：文件内查重、「已存在」判断都按它。拿不到（必填列为空）返回 None
    key_of: Callable[[Mapping[str, Any]], str | None]
    #: 整批校验（预览和提交各调一次）：给每行填 errors / action / target_id / payload。
    #: 进来的行已经过了必填、取值、文件内重复；`mode` 决定「已存在」算错还是算更新
    validate: Callable[[AsyncSession, list[ImportRow], ImportMode, ImportContext], Awaitable[None]]
    #: 落库。只会拿到校验通过的行，在调用方的事务里；一行写不进去要用保存点兜住，
    #: 记进 `CommitOutcome.failed`，别让它毁掉整个事务（PostgreSQL 上一句失败整个事务就作废）
    commit: Callable[[AsyncSession, list[ImportRow], ImportContext], Awaitable[CommitOutcome]]
    modes: tuple[ImportMode, ...] = ('create',)
    #: 说明页里额外的几句话（翻译键）
    notes: tuple[str, ...] = ()
    #: 单次行数上限；不给用 `TABLE_IMPORT_MAX_ROWS`
    max_rows: int | None = None

    def column(self, key: str) -> ImportColumn:
        return next(column for column in self.columns if column.key == key)


_IMPORTS: dict[str, ImportSpec] = {}


def register_import(spec: ImportSpec) -> ImportSpec:
    """登记一份导入定义（重复登记直接报错，理由同 `register_export`）"""
    existing = _IMPORTS.get(spec.resource)
    if existing is not None and existing is not spec:
        raise RuntimeError(f'导入定义 {spec.resource} 重复登记')
    unknown = set(spec.modes) - set(IMPORT_MODES)
    if unknown:
        raise RuntimeError(f'导入定义 {spec.resource} 声明了不认识的模式：{sorted(unknown)}')
    _IMPORTS[spec.resource] = spec
    return spec


def get_import(resource: str) -> ImportSpec | None:
    return _IMPORTS.get(resource)


def import_specs() -> dict[str, ImportSpec]:
    return dict(_IMPORTS)
