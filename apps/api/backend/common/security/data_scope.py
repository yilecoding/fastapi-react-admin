"""数据权限的**自动**接入点。

## 为什么不是逐个接口加 `Depends`

数据权限原来只挂在 `GET /sys/depts` 一个接口上（`api/v1/sys/dept.py` 的
`DataPermissionFilter`）。同文件的 `GET /sys/depts/{pk}` 都没挂 —— 配了「仅本部门」
的用户翻列表看不到别的部门，但直接按 ID 请求就能拿到。

逐个接口补 `Depends` 解决不了这件事：**下一个新接口一定会漏**，而漏了没有任何现象。
所以接在 DAO 这一层 —— 新写的 DAO 默认就带上，要豁免必须显式写出来。

## 钩子在哪（这一段是实测出来的，别照直觉改）

`sqlalchemy_crud_plus.CRUDPlus` 的读路径**不是**全都汇流到 `select()`：

| 方法 | 怎么建语句 |
|---|---|
| `select_model_by_column` / `select_models` | → `self.select()` |
| `select_models_order` | → `self.select_order()` → `self.select()` |
| `select_model`（**按主键取详情**） | **自己 `select(self.model)`**，不过 `select()` |
| `count` | **自己建**，`select(func.count(...))` |
| `exists` | **自己建** |

所以只覆盖 `select()` 会漏掉「详情接口」—— 而那正是这次要补的洞。
这里覆盖 `select` / `select_model` / `count` 三个，做法是把条件塞进 `whereclause`
再委托给 `super()`，不重抄上游的语句构造逻辑（重抄一定会跟丢上游的改动）。

⚠️ **`exists` 刻意不覆盖。** 它被用来做唯一性校验（「这个部门编码是不是已经存在」）。
按数据权限过滤之后，用户会因为「看不见」而被判定为「不存在」，于是建出一条重复记录 ——
要么撞数据库唯一约束报 500，要么真的重复。信息泄漏（知道某条记录存在）
比这个后果轻得多。

## 非请求上下文天然不过滤

`_current_user` 默认是 `None` —— Celery 任务、缓存预热、CLI、启动期的代码
拿不到用户，条件为 `None`，不加任何过滤。所以那些路径不需要显式豁免。
需要 `bypass_data_scope()` 的只有一种：**请求上下文里的系统内部读**
（典型的是认证链路自己去查用户）。
"""

from collections.abc import Iterator
from contextlib import contextmanager
from contextvars import ContextVar
from typing import Any

from sqlalchemy import ColumnElement, Select
from sqlalchemy_crud_plus import CRUDPlus
from sqlalchemy_crud_plus.types import Model

_current_user: ContextVar[Any | None] = ContextVar('data_scope_user', default=None)
_bypass: ContextVar[bool] = ContextVar('data_scope_bypass', default=False)


def set_current_user(user: Any | None) -> None:
    """把当前请求的用户放进上下文

    由 `middleware/jwt_auth_middleware.py` 在认证通过后调用。
    ⚠️ 必须在**用户已经解析出来之后**才调 —— 解析过程本身要查用户表，
    那时候设了就会自己过滤自己。
    """
    _current_user.set(user)


@contextmanager
def bypass_data_scope() -> Iterator[None]:
    """在这段代码里关掉数据权限过滤

    只给「请求上下文里的系统内部读」用：认证链路查用户、缓存重建等等。
    这些读的目的不是「把数据展示给用户」，按用户的可见范围过滤没有意义，
    而且会自锁（查不到自己 → 认证失败）。
    """
    token = _bypass.set(True)
    try:
        yield
    finally:
        _bypass.reset(token)


class DataScopedCRUD(CRUDPlus[Model]):
    """自动应用数据权限的 CRUD 基类

    子类把 `data_scope_enabled` 设成 False 表示**显式豁免**。
    豁免要写出来而不是靠不继承 —— `test_data_scope_coverage.py` 会检查
    每个 CRUD 类都表过态，新增 DAO 忘了想这件事会红。
    """

    #: 是否对读操作应用数据权限。豁免的理由写在子类的注释里
    data_scope_enabled: bool = True

    def _data_scope_condition(self) -> ColumnElement[bool] | None:
        """算出本次查询要追加的条件，不适用时返回 None"""
        if not self.data_scope_enabled or _bypass.get():
            return None
        user = _current_user.get()
        if user is None:
            # 非请求上下文（Celery / CLI / 启动期），没有「谁在看」这个概念
            return None

        from backend.common.security.permission import filter_data_permission_for_user

        return filter_data_permission_for_user(user, self.model)

    def _scoped(self, whereclause: tuple[Any, ...]) -> tuple[Any, ...]:
        condition = self._data_scope_condition()
        return whereclause if condition is None else (*whereclause, condition)

    async def select(self, *whereclause: Any, **kwargs: Any) -> Select:
        """列表 / 按列查询的公共入口（`select_models`、`select_model_by_column`、
        以及经由 `select_order` 的 `select_models_order` 都走这里）"""
        return await super().select(*self._scoped(whereclause), **kwargs)

    async def select_model(self, session: Any, pk: Any, *whereclause: Any, **kwargs: Any) -> Any:
        """🔴 按主键取详情。它**不走** `select()`，必须单独覆盖 ——
        漏了的话「列表里看不到、按 ID 直接拿得到」"""
        return await super().select_model(session, pk, *self._scoped(whereclause), **kwargs)

    async def count(self, session: Any, *whereclause: Any, **kwargs: Any) -> int:
        """分页总数也要跟着过滤，否则「共 100 条」但只列得出 10 条"""
        return await super().count(session, *self._scoped(whereclause), **kwargs)
