"""唯一性 / 业务规则检查必须看得见数据范围之外的行。

🔴 **背景**：这些 DAO 是 `DataScopedCRUD`，而「开了范围过滤但没配范围」的角色是
fail-closed（`filter_data_permission_for_user` 里 `if not data_rules:
return or_(1 != 1)`）。冲突行落在范围外时，冲突检查**查不到 → 静默通过** →
然后撞到数据库的唯一约束上：`IntegrityError` → **500**，
而正确的表现是干净的 409。

实测（改之前，`set_current_user` 造一个受限用户）：

| 查询 | 超管视角 | 受限视角 |
|---|---|---|
| `dept_dao.get_by_code('HQ')` | 找到 | **找不到** |
| `role_dao.get_by_code('STAFF')` | 找到 | **找不到** |
| `user_dao.get_by_username('admin')` | 找到 | **找不到** |

⚠️ **种子配置下走不到这个 bug**：四个非超管演示角色（STAFF / MANAGER /
FINANCE_STAFF / VIEWER）一个写权限都没有（实测 `:add`/`:edit`/`:del` 全为 0），
而要触发冲突检查得先有写权限。但这是个**底座** —— 数据范围功能的用途就是
做「区域管理员」这种角色（写权限 + 部门范围），第一个这么配的人就会踩到。
所以这里**自己造出那个配置**来测，不依赖种子里恰好有没有。

⚠️ 豁免写在 DAO 方法**内部**，不在调用点：已逐个核实过这 7 个方法的调用方
全是「冲突检查 / 认证链路 / CLI」，没有一个把结果展示给用户
（`get_by_username` 还兼着登录和 OAuth2 查号，那也是非展示读）。
逐个调用点包的话，下一个新调用点会漏。
"""

import asyncio

from types import SimpleNamespace

import pytest

from backend.common.security.data_scope import set_current_user

#: (DAO 属性路径, 方法名, 参数) —— 这些查询在任何视角下都必须找到种子里的那一行
CHECKS = (
    ('backend.app.admin.crud.crud_dept', 'dept_dao', 'get_by_code', ('HQ',)),
    ('backend.app.admin.crud.crud_role', 'role_dao', 'get_by_code', ('STAFF',)),
    ('backend.app.admin.crud.crud_role', 'role_dao', 'get_by_name', ('普通员工',)),
    ('backend.app.admin.crud.crud_user', 'user_dao', 'get_by_username', ('admin',)),
    ('backend.app.admin.crud.crud_user', 'check_email_dao', 'check_email', ('admin@example.com',)),
)


def _restricted() -> SimpleNamespace:
    """开了范围过滤、一个规则都没有 —— fail-closed，看不见任何行"""
    scope = SimpleNamespace(status=1, rules=[])
    return SimpleNamespace(
        is_superuser=False,
        id=1,
        dept_id=1,
        roles=[SimpleNamespace(status=1, is_filter_scopes=True, scopes=[scope])],
    )


def _lookup(module_name: str, dao_name: str, method: str, args: tuple, *, as_user) -> bool:
    """在指定视角下跑一次查询，返回「找到了没有」"""
    import importlib

    from backend.database.db import create_database_async_engine, create_database_async_session, get_database_url

    module = importlib.import_module(module_name)
    dao = getattr(module, dao_name if hasattr(module, dao_name) else dao_name.replace('check_email_dao', 'user_dao'))

    async def go() -> bool:
        engine = create_database_async_engine(get_database_url(unittest=True))
        session_maker = create_database_async_session(engine)
        try:
            async with session_maker() as db:
                set_current_user(as_user)
                try:
                    return bool(await getattr(dao, method)(db, *args))
                finally:
                    set_current_user(None)
        finally:
            await engine.dispose()

    return asyncio.run(go())


@pytest.mark.parametrize(('module_name', 'dao_name', 'method', 'args'), CHECKS)
def test_conflict_check_sees_rows_outside_the_scope(module_name: str, dao_name: str, method: str, args: tuple) -> None:
    """受限视角下也必须找到 —— 否则冲突检查静默通过、撞唯一约束、500。

    🔴 **先断言超管视角找得到**：那一行要是压根不在种子里（改了种子、换了库），
    下面「受限视角也找得到」会以「两边都找不到」的方式假绿。
    """
    assert _lookup(module_name, dao_name, method, args, as_user=None), (
        f'{dao_name}.{method}{args} 在超管视角都找不到 —— 种子数据变了？这条证明不了什么'
    )
    assert _lookup(module_name, dao_name, method, args, as_user=_restricted()), (
        f'{dao_name}.{method}{args} 在受限视角找不到 —— 冲突检查会静默通过，'
        '然后撞唯一约束变成 500。这个方法需要 bypass_data_scope()'
    )
