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

⚠️ **但「天然不过滤」只对「不代表任何人」的任务成立。** 一旦有任务是**代替
某个人**读写业务数据（编排流程、浏览器自动化、以后的 AI 工具调用都是这种），
同一个 `None` 默认值就从「合理的不过滤」变成**静默 fail-open** —— 那个人
只该看到本部门的行，任务却查回了全库，而且不报错。这类路径必须用下面的
`run_as(user)` 显式声明执行身份。判据是一句话：**这段代码的读，结果要给
某个具体的人看或按他的权限写吗？** 要，就得 `run_as`。
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


@contextmanager
def run_as(user: Any) -> Iterator[None]:
    """在非请求上下文里显式声明「以谁的身份执行」

    ## 为什么必须有这个

    `_current_user` 默认 `None`，而 `_data_scope_condition()` 在拿到 `None` 时
    **返回 `None`（不加任何过滤）**。对定时清日志那类任务这是对的 —— 它们不代表
    任何人。但只要有一条任务是「代替某个人去查业务数据」，同一个默认值就变成
    **静默 fail-open**：没有报错、没有 403，只是查出来的行比那个人有权看的多。

    RBAC（权限码）拦不住这个：那一层在 API 依赖里判，而行级过滤在 DAO 层靠这个
    ContextVar 生效 —— 两层的失效方式完全不同，走 Celery 的路径根本不经过 API 依赖。

    ## 用法

    Celery 任务 / CLI / 编排引擎里，凡是要代表某个人读写业务数据的，把那段包起来::

        async with async_db_session() as db:
            user = await user_dao.get(db, workflow.run_as_id)
        with run_as(user):
            ...  # 这里面的 DAO 读会按 user 的数据范围过滤

    🔴 **不接受 `None`。** 「不知道以谁的身份跑」不是一个可以继续执行的状态 ——
    允许它就等于把 fail-open 重新开了个后门。任务确实不代表任何人时，
    根本不要调这个函数（默认的不过滤是刻意的）；要跳过过滤就用
    `bypass_data_scope()`，那是**显式**的、看得见的。

    :param user: 执行身份，必须是已加载 roles → scopes → rules 的用户对象
    """
    if user is None:
        raise ValueError('run_as() 不接受 None —— 执行身份必须确定；要跳过过滤请用 bypass_data_scope()')
    token = _current_user.set(user)
    try:
        yield
    finally:
        _current_user.reset(token)


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
        """⚠️ **目前零调用方 —— 分页的总数不走这里。**

        原来这条注释写的是「分页总数也要跟着过滤，否则『共 100 条』但只列得出
        10 条」。那句话是错的，而且**误导过一次真实的分析**：分页走
        `paging_data` → fastapi-pagination 的 `apaginate`，它是拿传进去的那个
        `Select` **自己拼 count**，而那个 Select 来自 `select_order` → `select()`，
        过滤条件早就在里面了。所以把这个 `count` 改成不过滤，全套测试**一条都不红**
        —— 不是因为没测试，是因为它压根不在任何路径上（实测）。

        那为什么还留着：这是**安全原语的兜底**，和「零调用方的便利代码」不是
        一回事。哪天真有人写 `xxx_dao.count(db, ...)` 去统计，少了这层覆盖就是
        静默 fail-open（数字把被过滤掉的行也算进去）。三行的保险，留着。
        """
        return await super().count(session, *self._scoped(whereclause), **kwargs)
