"""导出定义：每个资源写一份，登记到这里。

一份定义回答四件事：

- **有哪些列**：表头的翻译键、类型（决定单元格怎么写，见 `cells.py`）、从一行里怎么取值
- **收哪些筛选参数**：和列表接口**同名同义**。前端把查询区那份 `q.params` 原样传过来，
  导出的就是界面上筛出来的那批
- **怎么取数**：返回列表接口用的**同一个** `Select`
- **原始行怎么整理成 dict**：join 进来的部门、分页之后才补的角色……和列表接口给前端的形状一致

🔴 **取数必须复用列表接口的那个 DAO 查询，不要为导出另写一条。** 数据权限挂在
`DataScopedCRUD.select()` 上（`common/security/data_scope.py`），另写一条裸 `select(User)`
就是又开了一条绕过数据权限的路 —— 导出的行比列表里看得到的多，不报错，审计也照样记成功。

定义模块的约定位置：核心资源在 `app/admin/dataio.py`，插件在 `plugin/<名>/dataio.py`。
Celery worker 不走 FastAPI 的路由装载，它靠 `load_dataio_modules()` 按这个约定把定义导进来。
"""

import dataclasses
import datetime as dt
import importlib
import importlib.util

from collections.abc import Awaitable, Callable, Mapping, Sequence
from typing import Any, Literal

from pydantic import BaseModel
from sqlalchemy import Select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.common.dataio.cells import (
    EMPTY,
    Cell,
    date_cell,
    datetime_cell,
    id_cell,
    int_cell,
    number_cell,
    text_cell,
)
from backend.common.i18n import t

ColumnKind = Literal['text', 'id', 'int', 'number', 'datetime', 'date', 'bool', 'enum', 'list']


@dataclasses.dataclass(frozen=True, slots=True)
class RenderContext:
    """一次导出里所有格子共用的东西。语言由调用方用 `i18n.use_language()` 包住，这里不管"""

    #: 导出人的**显示时区**（`sys_user.timezone`），不是服务端时区
    tz: dt.tzinfo
    truncated_mark: str
    list_separator: str
    yes: str
    no: str

    @classmethod
    def current(cls, tz: dt.tzinfo) -> 'RenderContext':
        """按当前语言把几个固定文案翻好（每格都翻一次是几十万次字典查找）"""
        return cls(
            tz=tz,
            truncated_mark=t('export.cell_truncated'),
            list_separator=t('export.list_separator'),
            yes=t('export.bool_yes'),
            no=t('export.bool_no'),
        )


@dataclasses.dataclass(frozen=True, slots=True)
class ExportColumn:
    """一列"""

    key: str
    #: 表头的翻译键
    label: str
    kind: ColumnKind = 'text'
    #: 从一行（dict）里取值；不给就是 `row[key]`
    get: Callable[[Mapping[str, Any]], Any] | None = None
    #: `kind='enum'` 时：值 → 翻译键。表里存的是 0/1，导出要的是「停用 / 正常」
    choices: Mapping[Any, str] | None = None
    width: int = 16

    def render(self, row: Mapping[str, Any], ctx: RenderContext) -> Cell:
        value = self.get(row) if self.get is not None else row.get(self.key)
        if value is None:
            return EMPTY
        match self.kind:
            case 'id':
                return id_cell(value)
            case 'int':
                return int_cell(value)
            case 'number':
                return number_cell(value)
            case 'datetime':
                return datetime_cell(value, ctx.tz)
            case 'date':
                return date_cell(value)
            case 'bool':
                return text_cell(ctx.yes if value else ctx.no)
            case 'enum':
                key = (self.choices or {}).get(value)
                # 没登记的取值原样写出来，不吞成空格 —— 空格会被当成「这一行没有值」
                return text_cell(t(key) if key else value, truncated_mark=ctx.truncated_mark)
            case 'list':
                parts = [str(item) for item in value if item is not None]
                return text_cell(ctx.list_separator.join(parts), truncated_mark=ctx.truncated_mark)
            case _:
                return text_cell(value, truncated_mark=ctx.truncated_mark)


@dataclasses.dataclass(frozen=True)
class ExportSpec:
    """一个资源的导出定义"""

    #: 登记用的键，也落在导出记录上（`sys.user`）。改名 = 老记录的「重新导出」找不到定义
    resource: str
    #: 资源名的翻译键（「用户列表」）：文件名、工作表名、站内消息标题都用它
    label: str
    #: 导出要的权限码。路由上用它挂 `RequestPermission`，后台任务执行前**再按它核一次**
    perm: str
    columns: tuple[ExportColumn, ...]
    #: 筛选参数。字段名和列表接口的查询参数一致
    filters: type[BaseModel]
    #: 筛选参数 → 翻译键。写进「导出信息」那张表，不登记的参数按原名写
    filter_labels: Mapping[str, str]
    #: `(筛选参数, 导出人) -> 列表接口那个 Select`。🔴 必须在导出人的数据范围里调（见 `export_service`）。
    #: 导出人一般用不上 —— 范围条件由 DAO 从上下文里取；部门那种「范围是显式入参」的才要它
    select: Callable[[BaseModel, Any], Awaitable[Select]]
    #: 主键列，按它做 keyset 分批和「只导选中的行」
    id_column: Any
    #: 一批原始结果 → dict 列表
    shape: Callable[[AsyncSession, Sequence[Any]], Awaitable[list[dict[str, Any]]]]
    #: 单次导出上限；不给用全局的 `EXPORT_MAX_ROWS`
    max_rows: int | None = None
    #: 要「全部取完再排一次」的资源给这个（部门要按树序：上级在前）。给了它就不再边取边写，
    #: 所以只给行数天然有限的资源用，并配一个小的 `max_rows`
    reorder: Callable[[list[dict[str, Any]]], list[dict[str, Any]]] | None = None

    def column_keys(self) -> list[str]:
        return [column.key for column in self.columns]

    def pick_columns(self, keys: Sequence[str] | None) -> list[ExportColumn]:
        """按前端给的列 key 挑列，顺序跟着**前端给的顺序**（界面上拖过列序，导出就该是那个顺序）。

        不认识的 key 直接忽略而不是报错：前端的列比导出的多（操作列、勾选列），
        让前端先过滤一遍等于把同一张清单维护两份。一列都没挑中就导全部 ——
        「导出了一个只有表头的文件」比「多导了几列」糟糕得多
        """
        if not keys:
            return list(self.columns)
        by_key = {column.key: column for column in self.columns}
        picked = [by_key[key] for key in dict.fromkeys(keys) if key in by_key]
        return picked or list(self.columns)


_EXPORTS: dict[str, ExportSpec] = {}


def register_export(spec: ExportSpec) -> ExportSpec:
    """登记一份导出定义。同一个键登记两次直接报错 —— 后登记的静默覆盖前一个是最难查的那种错"""
    existing = _EXPORTS.get(spec.resource)
    if existing is not None and existing is not spec:
        raise RuntimeError(f'导出定义 {spec.resource} 重复登记')
    _EXPORTS[spec.resource] = spec
    return spec


def get_export(resource: str) -> ExportSpec | None:
    return _EXPORTS.get(resource)


def export_specs() -> dict[str, ExportSpec]:
    return dict(_EXPORTS)


def load_dataio_modules() -> None:
    """把各模块的定义导进来（worker 用；web 进程里路由模块 import 时就登记了）。

    插件按**文件系统上装了哪些**来扫，不按「启用了哪些」：后者要连 Redis，
    而禁用插件的定义登记进来也无害 —— 它的导出接口没挂出去，不会有新任务
    """
    from backend.plugin.core import get_plugins

    importlib.import_module('backend.app.admin.dataio')
    for plugin in get_plugins():
        name = f'backend.plugin.{plugin}.dataio'
        # 先问「有没有这个模块」再导，不用 try/except ModuleNotFoundError：
        # 后者会把「模块存在、但它自己 import 别的东西失败」也吞掉，那个插件的导出就静默消失
        if importlib.util.find_spec(name) is not None:
            importlib.import_module(name)
