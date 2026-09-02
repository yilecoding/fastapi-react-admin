"""数据权限（data scope / data rule）端到端验证。

这份用例是**多账号**的：每个场景一个真实用户 + 真实角色 + 真实数据范围 + 真实规则，
走 `/auth/login/swagger` 拿 token，再打 `GET /sys/depts`（当前**唯一**挂了
`DataPermissionFilter` 的接口），断言它到底看见了哪些部门。

为什么必须打真实接口而不是只单测 `filter_data_permission`：
条件是拼进 SQL 再交给 SQL Server 执行的，「拼得出来」和「跑得通、结果对」是两件事
（`${now}` 那条就是拼得出来、执行时 500）。

⚠️ **JWT 用户解析不走依赖注入**：`jwt.get_jwt_user()` 里直接用了
`backend.database.db.async_db_session`（**开发库**），而接口层被
`conftest.py` 重载成了测试库。现有用例只测 admin，两个库里都有同名同 ID 的 admin，
所以从来没暴露过。本文件的用户只存在于测试库里，必须把那个 session 也换掉，
否则登录成功、第一个请求就 `TokenError`。
"""

import asyncio
import uuid

from collections.abc import Iterator
from typing import Any

import bcrypt
import pytest

from sqlalchemy import delete, insert
from starlette.testclient import TestClient

from backend.app.admin.model import (
    DataRule,
    DataScope,
    Dept,
    Role,
    User,
    data_scope_rule,
    role_data_scope,
    role_menu,
    user_role,
)
from backend.app.admin.utils.password_security import get_hash_password
from backend.common.enums import RoleDataRuleExpressionType as Expr
from backend.common.enums import RoleDataRuleOperatorType as Op
from backend.database.db import create_database_async_engine, get_database_url
from backend.utils.snowflake import snowflake
from backend.utils.timezone import timezone

PASSWORD = 'Dp!123456'

# 种子菜单里的「查询」权限锚点，不是这次建图新加的资源，只是借用来满足
# rbac_verify 的权限码校验——见 add_role()
QUERY_SYS_USER_MENU_ID = 2049629108253622330
# (issue #57) GET /sys/depts 现在也挂了 RBAC（perms='sys:dept:list'），
# 这张图打的就是这条接口，只挂 QUERY_SYS_USER_MENU_ID 不够——那只满足
# "用户至少有一个菜单"这道闸，RBAC_ROLE_MENU_MODE 还会校验*这条路由自己的
# 权限码*是不是在角色的菜单里，两个锚点都要挂
QUERY_SYS_DEPT_MENU_ID = 2049629108253622337

# 每次跑用一个新后缀，避免和上一次残留的行撞唯一约束 / 撞断言
RUN = uuid.uuid4().hex[:6].upper()


def _sid() -> int:
    return snowflake.generate()


class Graph:
    """本次运行建出来的整张图，测试里按名字取"""

    def __init__(self) -> None:
        self.dept: dict[str, int] = {}
        self.role: dict[str, int] = {}
        self.scope: dict[str, int] = {}
        self.rule: dict[str, int] = {}
        self.user: dict[str, int] = {}
        self.rows: dict[Any, list[int]] = {}

    def code(self, key: str) -> str:
        return f'DP{RUN}-{key}'

    def username(self, key: str) -> str:
        return f'dp{RUN}_{key}'.lower()


async def _build(graph: Graph) -> None:
    """把整张 部门 / 角色 / 数据范围 / 数据规则 / 用户 图灌进测试库"""
    engine = create_database_async_engine(get_database_url(unittest=True))
    now = timezone.now()
    salt = bcrypt.gensalt()
    pwd = get_hash_password(PASSWORD, salt)

    depts: list[dict[str, Any]] = []
    roles: list[dict[str, Any]] = []
    scopes: list[dict[str, Any]] = []
    rules: list[dict[str, Any]] = []
    users: list[dict[str, Any]] = []
    r2s: list[dict[str, Any]] = []
    s2r: list[dict[str, Any]] = []
    u2r: list[dict[str, Any]] = []
    r2m: list[dict[str, Any]] = []

    def add_dept(key: str, parent: str | None = None, status: int = 1) -> None:
        pk = _sid()
        graph.dept[key] = pk
        depts.append({
            'id': pk,
            'code': graph.code(key),
            'name': f'部门{key}',
            'sort': 0,
            'leader': None,
            'phone': None,
            'email': None,
            'status': status,
            'parent_id': graph.dept[parent] if parent else None,
            'deleted': 0,
            'deleted_time': None,
            'created_time': now,
            'updated_time': None,
        })

    def add_rule(key: str, model: str, column: str, op: Op, expr: Expr, value: str) -> None:
        pk = _sid()
        graph.rule[key] = pk
        rules.append({
            'id': pk,
            'name': f'{graph.code(key)}-rule',
            'model': model,
            'column': column,
            'operator': int(op),
            'expression': int(expr),
            'value': value,
            'deleted': 0,
            'deleted_time': None,
            'created_time': now,
            'updated_time': None,
        })

    def add_scope(key: str, rule_keys: list[str], status: int = 1) -> None:
        pk = _sid()
        graph.scope[key] = pk
        scopes.append({
            'id': pk,
            'name': f'{graph.code(key)}-scope',
            'status': status,
            'deleted': 0,
            'deleted_time': None,
            'created_time': now,
            'updated_time': None,
        })
        s2r.extend({'id': _sid(), 'data_scope_id': pk, 'data_rule_id': graph.rule[rk]} for rk in rule_keys)

    def add_role(key: str, scope_keys: list[str], *, is_filter: bool = True, status: int = 1) -> None:
        pk = _sid()
        graph.role[key] = pk
        roles.append({
            'id': pk,
            'code': graph.code(key)[:32],
            'name': f'{graph.code(key)}-role'[:32],
            'status': status,
            'is_filter_scopes': is_filter,
            'remark': None,
            'deleted': 0,
            'deleted_time': None,
            'created_time': now,
            'updated_time': None,
        })
        r2s.extend({'id': _sid(), 'role_id': pk, 'data_scope_id': graph.scope[sk]} for sk in scope_keys)
        # `GET /sys/users` 现在挂了 RBAC（issue #30），没有任何菜单的角色连
        # rbac_verify 的"用户未分配菜单"这道闸都过不去。种子里的 QuerySysUser
        # 菜单（perms='sys:user:list'）就是给这类只测数据权限、不关心 RBAC 的
        # 角色垫底用的——所有这张图里建出来的角色都挂一份，不然每加一个新角色
        # 都要记得单独补，迟早漏。
        # (issue #57) `GET /sys/depts`（这张图实际打的接口）也挂了 RBAC 之后，
        # 同理要补 QUERY_SYS_DEPT_MENU_ID——只有 sys:user:list 满足"有菜单"，
        # 满足不了这条路由自己要校验的 sys:dept:list
        r2m.append({'id': _sid(), 'role_id': pk, 'menu_id': QUERY_SYS_USER_MENU_ID})
        r2m.append({'id': _sid(), 'role_id': pk, 'menu_id': QUERY_SYS_DEPT_MENU_ID})

    def add_user(key: str, role_keys: list[str], *, dept: str | None = 'A1', superuser: bool = False) -> None:
        pk = _sid()
        graph.user[key] = pk
        users.append({
            'id': pk,
            'uuid': str(uuid.uuid4()),
            'username': graph.username(key),
            'nickname': graph.username(key),
            'password': pwd,
            'salt': salt,
            'email': f'{graph.username(key)}@example.com',
            'phone': None,
            'avatar': None,
            'timezone': 'Asia/Shanghai',
            'status': 1,
            'is_superuser': superuser,
            'is_staff': True,
            'is_multi_login': True,
            'join_time': now,
            'last_login_time': now,
            'last_password_changed_time': now,
            'dept_id': graph.dept[dept] if dept else None,
            'deleted': 0,
            'deleted_time': None,
            'created_time': now,
            'updated_time': None,
        })
        u2r.extend({'id': _sid(), 'user_id': pk, 'role_id': graph.role[rk]} for rk in role_keys)

    # ---- 部门树 ----------------------------------------------------------
    #   RA ── A1
    #     └── A2
    #   RB ── B1
    add_dept('RA')
    add_dept('A1', 'RA')
    add_dept('A2', 'RA')
    add_dept('RB')
    add_dept('B1', 'RB')

    # ---- 规则 ------------------------------------------------------------
    add_rule('code_a1', 'Dept', 'code', Op.AND, Expr.eq, graph.code('A1'))
    add_rule('code_b1', 'Dept', 'code', Op.AND, Expr.eq, graph.code('B1'))
    add_rule('code_b1_or', 'Dept', 'code', Op.OR, Expr.eq, graph.code('B1'))
    add_rule('parent_ra', 'Dept', 'parent_id', Op.AND, Expr.eq, str(graph.dept['RA']))
    add_rule('ne_a2', 'Dept', 'code', Op.AND, Expr.ne, graph.code('A2'))
    add_rule('in_a1_b1', 'Dept', 'code', Op.AND, Expr.in_, f'{graph.code("A1")},{graph.code("B1")}')
    add_rule('not_in_a1_b1', 'Dept', 'code', Op.AND, Expr.not_in, f'{graph.code("A1")}, {graph.code("B1")}')
    add_rule('status_on_or', 'Dept', 'status', Op.OR, Expr.eq, '1')
    # 「本部门数据权限」—— 种子数据里就有的那一条：Dept 上根本没有 dept_id 列
    add_rule('dept_id_tpl', 'Dept', '__dept_id__', Op.AND, Expr.eq, '${dept_id}')
    # 规则打在别的模型上
    add_rule('user_only', 'User', 'is_superuser', Op.AND, Expr.ne, '1')
    # __ALL__ + 部门 ID：对 User/File 这类有 dept_id 的模型有意义，对 Dept 无意义
    add_rule('all_dept_id', '__ALL__', '__dept_id__', Op.AND, Expr.eq, '${dept_id}')
    # 真能落到 Dept 上的 __ALL__ 规则
    add_rule('all_status', '__ALL__', 'status', Op.AND, Expr.eq, '1')
    # 值模板变量
    add_rule('parent_tpl', 'Dept', 'parent_id', Op.AND, Expr.eq, '${dept_id}')
    add_rule('now_tpl', 'Dept', 'created_time', Op.AND, Expr.lt, f'${now}')
    # 被排除的列（DATA_PERMISSION_COLUMN_EXCLUDE）
    add_rule('excluded_col', 'Dept', 'id', Op.AND, Expr.eq, str(graph.dept['A1']))
    # 压根不存在的列
    add_rule('ghost_col', 'Dept', 'no_such_column', Op.AND, Expr.eq, 'x')

    # ---- 数据范围 --------------------------------------------------------
    add_scope('s_code_a1', ['code_a1'])
    add_scope('s_parent_ra', ['parent_ra'])
    add_scope('s_and2', ['parent_ra', 'ne_a2'])
    add_scope('s_or2', ['code_a1', 'code_b1_or'])
    add_scope('s_and_or', ['parent_ra', 'status_on_or'])
    add_scope('s_in', ['in_a1_b1'])
    add_scope('s_not_in', ['not_in_a1_b1'])
    add_scope('s_dept_id_tpl', ['dept_id_tpl'])
    add_scope('s_user_only', ['user_only'])
    add_scope('s_all_dept_id', ['all_dept_id'])
    add_scope('s_all_status', ['all_status'])
    add_scope('s_parent_tpl', ['parent_tpl'])
    add_scope('s_now_tpl', ['now_tpl'])
    add_scope('s_excluded_col', ['excluded_col'])
    add_scope('s_ghost_col', ['ghost_col'])
    add_scope('s_empty', [])
    add_scope('s_off', ['code_a1'], status=0)

    # ---- 角色 ------------------------------------------------------------
    add_role('r_code_a1', ['s_code_a1'])
    add_role('r_parent_ra', ['s_parent_ra'])
    add_role('r_and2', ['s_and2'])
    add_role('r_or2', ['s_or2'])
    add_role('r_and_or', ['s_and_or'])
    add_role('r_in', ['s_in'])
    add_role('r_not_in', ['s_not_in'])
    add_role('r_dept_id_tpl', ['s_dept_id_tpl'])
    add_role('r_user_only', ['s_user_only'])
    add_role('r_all_dept_id', ['s_all_dept_id'])
    add_role('r_all_status', ['s_all_status'])
    add_role('r_parent_tpl', ['s_parent_tpl'])
    add_role('r_now_tpl', ['s_now_tpl'])
    add_role('r_excluded', ['s_excluded_col'])
    add_role('r_ghost', ['s_ghost_col'])
    add_role('r_noscope', [])
    add_role('r_scope_off', ['s_off'])
    add_role('r_nofilter', [], is_filter=False)
    add_role('r_code_b1', ['s_code_a1'], status=0)  # 停用角色，带一个会限制的范围

    # ---- 用户 ------------------------------------------------------------
    add_user('super', ['r_code_a1'], superuser=True)
    add_user('code_a1', ['r_code_a1'])
    add_user('parent_ra', ['r_parent_ra'])
    add_user('and2', ['r_and2'])
    add_user('or2', ['r_or2'])
    add_user('and_or', ['r_and_or'])
    add_user('in', ['r_in'])
    add_user('not_in', ['r_not_in'])
    add_user('dept_id_tpl', ['r_dept_id_tpl'])
    add_user('user_only', ['r_user_only'])
    add_user('all_dept_id', ['r_all_dept_id'])
    add_user('all_status', ['r_all_status'])
    add_user('excluded', ['r_excluded'])
    add_user('ghost', ['r_ghost'])
    add_user('noscope', ['r_noscope'])
    add_user('scope_off', ['r_scope_off'])
    add_user('nofilter', ['r_nofilter'])
    add_user('mixed', ['r_code_a1', 'r_nofilter'])  # 一严一松，看谁赢
    add_user('role_off', ['r_code_b1', 'r_parent_ra'])  # 停用角色 + 启用角色
    # dept_id 为 NULL 的用户配 ${dept_id} 模板
    add_user('null_dept', ['r_parent_tpl'], dept=None)
    add_user('parent_tpl', ['r_parent_tpl'], dept='RA')  # dept=RA，规则 parent_id == RA
    add_user('now_tpl', ['r_now_tpl'])

    async with engine.begin() as conn:
        await conn.execute(insert(Dept.__table__), depts)
        await conn.execute(insert(DataRule.__table__), rules)
        await conn.execute(insert(DataScope.__table__), scopes)
        await conn.execute(insert(Role.__table__), roles)
        await conn.execute(insert(User.__table__), users)
        await conn.execute(insert(data_scope_rule), s2r)
        await conn.execute(insert(role_data_scope), r2s)
        await conn.execute(insert(user_role), u2r)
        await conn.execute(insert(role_menu), r2m)

    graph.rows = {
        user_role: [r['id'] for r in u2r],
        role_menu: [r['id'] for r in r2m],
        role_data_scope: [r['id'] for r in r2s],
        data_scope_rule: [r['id'] for r in s2r],
        User.__table__: list(graph.user.values()),
        Role.__table__: list(graph.role.values()),
        DataScope.__table__: list(graph.scope.values()),
        DataRule.__table__: list(graph.rule.values()),
        Dept.__table__: list(graph.dept.values()),
    }
    await engine.dispose()


async def _teardown(graph: Graph) -> None:
    engine = create_database_async_engine(get_database_url(unittest=True))
    async with engine.begin() as conn:
        for table, ids in graph.rows.items():
            if ids:
                await conn.execute(delete(table).where(table.c.id.in_(ids)))
    await engine.dispose()


@pytest.fixture(scope='module')
def dp(client: TestClient) -> Iterator[Graph]:
    """建图 + 把 JWT 用户解析切到测试库"""
    from backend.common.security import jwt as jwt_module
    from backend.tests.utils.db import async_test_db_session

    graph = Graph()
    asyncio.run(_build(graph))

    original = jwt_module.async_db_session
    jwt_module.async_db_session = async_test_db_session
    try:
        yield graph
    finally:
        jwt_module.async_db_session = original
        asyncio.run(_teardown(graph))


def login(client: TestClient, graph: Graph, key: str) -> dict[str, str]:
    """按用户名登录，拿 Bearer 头"""
    resp = client.post('/auth/login/swagger', params={'username': graph.username(key), 'password': PASSWORD})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    return {'Authorization': f'{body["token_type"]} {body["access_token"]}'}


def flatten(nodes: list[dict[str, Any]]) -> list[dict[str, Any]]:
    out = []
    for n in nodes:
        out.append(n)
        out.extend(flatten(n.get('children') or []))
    return out


def visible_codes(client: TestClient, graph: Graph, key: str) -> set[str]:
    """某个账号在 `GET /sys/depts` 上看见的**全部**部门编码（含非本次创建的）"""
    resp = client.get('/sys/depts', headers=login(client, graph, key))
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body['code'] == 200, body
    return {n['code'] for n in flatten(body['data'])}


def dp_codes(client: TestClient, graph: Graph, key: str) -> set[str]:
    """只看本次创建的那 5 个部门，滤掉种子数据和别的用例留下的行"""
    mine = {graph.code(k) for k in ('RA', 'A1', 'A2', 'RB', 'B1')}
    return visible_codes(client, graph, key) & mine


ALL_DP = {'RA', 'A1', 'A2', 'RB', 'B1'}


# --------------------------------------------------------------------------
# 1. 基线：谁不过滤
# --------------------------------------------------------------------------


def test_superuser_sees_everything(client: TestClient, dp: Graph) -> None:
    """超级管理员直接短路，连规则都不读"""
    assert dp_codes(client, dp, 'super') == {dp.code(k) for k in ALL_DP}


def test_role_with_filter_off_sees_everything(client: TestClient, dp: Graph) -> None:
    """`is_filter_scopes=False` 的角色 = 不过滤"""
    assert dp_codes(client, dp, 'nofilter') == {dp.code(k) for k in ALL_DP}


def test_one_unfiltered_role_defeats_all_restrictive_roles(client: TestClient, dp: Graph) -> None:
    """🔴 多角色取**最宽**：只要有一个角色 `is_filter_scopes=False`，其它角色的限制全部作废。

    这是 `filter_data_permission` 里那个提前 return —— 遍历角色时撞上第一个
    不过滤的就 `return or_(1 == 1)`，后面的限制规则一条都不看。
    """
    assert dp_codes(client, dp, 'mixed') == {dp.code(k) for k in ALL_DP}


# --------------------------------------------------------------------------
# 2. 基线：谁看不见
# --------------------------------------------------------------------------


def test_filter_on_but_no_scope_sees_nothing(client: TestClient, dp: Graph) -> None:
    """开了过滤又没配数据范围 = 一条都看不到（`1 != 1`），不是「看全部」"""
    assert visible_codes(client, dp, 'noscope') == set()


def test_disabled_scope_is_ignored(client: TestClient, dp: Graph) -> None:
    """`status=0` 的数据范围不参与，退化成「没有范围」= 看不见"""
    assert visible_codes(client, dp, 'scope_off') == set()


def test_disabled_role_scope_is_ignored(client: TestClient, dp: Graph) -> None:
    """停用角色带的范围不算数，只有启用角色的 parent_id==RA 生效"""
    assert dp_codes(client, dp, 'role_off') == {dp.code('A1'), dp.code('A2')}


# --------------------------------------------------------------------------
# 3. 表达式矩阵
# --------------------------------------------------------------------------


def test_eq(client: TestClient, dp: Graph) -> None:
    assert dp_codes(client, dp, 'code_a1') == {dp.code('A1')}


def test_eq_on_parent_id(client: TestClient, dp: Graph) -> None:
    assert dp_codes(client, dp, 'parent_ra') == {dp.code('A1'), dp.code('A2')}


def test_in(client: TestClient, dp: Graph) -> None:
    assert dp_codes(client, dp, 'in') == {dp.code('A1'), dp.code('B1')}


def test_not_in_trims_whitespace(client: TestClient, dp: Graph) -> None:
    """`in`/`not_in` 按逗号切并 `.strip()`，值里带空格不该改变结果"""
    got = dp_codes(client, dp, 'not_in')
    assert got == {dp.code('RA'), dp.code('A2'), dp.code('RB')}


def test_two_and_rules_intersect(client: TestClient, dp: Graph) -> None:
    """两条 AND 规则求交：parent_id==RA 且 code!=A2"""
    assert dp_codes(client, dp, 'and2') == {dp.code('A1')}


def test_two_or_rules_union(client: TestClient, dp: Graph) -> None:
    """两条 OR 规则求并"""
    assert dp_codes(client, dp, 'or2') == {dp.code('A1'), dp.code('B1')}


# --------------------------------------------------------------------------
# 4. 组合语义：AND 组和 OR 组之间是 OR
# --------------------------------------------------------------------------


def test_or_rule_defeats_and_rule(client: TestClient, dp: Graph) -> None:
    """🔴 AND 组与 OR 组在**顶层是 OR**：`or_(and_(...), or_(...))`。

    配了「parent_id==RA」（AND，想收紧）+「status==1」（OR，很宽），
    结果不是交集而是并集 —— 那条 OR 规则把限制整个抬掉了。
    界面上这两个字段都叫「运算符」，看不出会有这个后果。
    """
    got = dp_codes(client, dp, 'and_or')
    assert got == {dp.code(k) for k in ALL_DP}


# --------------------------------------------------------------------------
# 5. 🔴 失效规则 = 完全不过滤（fail-open）
# --------------------------------------------------------------------------


def test_rule_on_missing_column_sees_nothing(client: TestClient, dp: Graph) -> None:
    """🔴 规则显式指定了模型，却配了该模型没有的字段 → **一行都看不到**。

    这条以前叫 `..._fails_open`，断言的是「看见全部」—— 那才是当时的真实行为：
    字段不存在就 `continue`，所有规则跳完之后没有任何条件，最后
    `return or_(1 == 1)` 把整张表放出去。一条名字叫「仅本部门」的规则，
    配错字段之后的实际效果是「全部可见」，而界面上没有任何提示。

    这不是假想：种子数据里的「本部门数据权限」原本就是 `Dept.__dept_id__`，
    而 `__dept_id__` 解析成 `dept_id`，`sys_dept` 上**没有这一列**。
    那条种子规则已经改成 `__ALL__`（见 `backend/sql/*/init_snowflake_test_data.sql`），
    这里保留一条**故意配错**的规则来守住 fail-closed 本身。
    """
    assert dp_codes(client, dp, 'dept_id_tpl') == set()


def test_rule_on_nonexistent_column_sees_nothing(client: TestClient, dp: Graph) -> None:
    """字段名拼错同理 —— 收紧而不是放行"""
    assert dp_codes(client, dp, 'ghost') == set()


def test_rule_on_excluded_column_sees_nothing(client: TestClient, dp: Graph) -> None:
    """引用 `DATA_PERMISSION_COLUMN_EXCLUDE` 里的列（id/created_time/…）也算配置错误

    那份排除清单是刻意的（按主键、时间戳过滤是脚枪，而且它们在每张表上都有，
    `__ALL__` 规则打上去后果严重）。规则引用了被排除的列 = 它表达不出管理员的本意，
    和字段拼错是同一类问题，一样收紧。
    """
    assert dp_codes(client, dp, 'excluded') == set()


def test_rule_on_other_model_fails_open(client: TestClient, dp: Graph) -> None:
    """规则只打在 User 上，部门接口拿不到匹配模型 → 不过滤 → 部门全可见"""
    assert dp_codes(client, dp, 'user_only') == {dp.code(k) for k in ALL_DP}


def test_all_model_rule_on_column_missing_from_dept_fails_open(client: TestClient, dp: Graph) -> None:
    """`__ALL__` + `__dept_id__`：Dept 没有 dept_id，于是对部门接口不过滤"""
    assert dp_codes(client, dp, 'all_dept_id') == {dp.code(k) for k in ALL_DP}


def test_all_model_rule_applies_when_column_exists(client: TestClient, dp: Graph) -> None:
    """`__ALL__` + status（Dept 上真有这一列）才真正生效"""
    assert dp_codes(client, dp, 'all_status') == {dp.code(k) for k in ALL_DP}


# --------------------------------------------------------------------------
# 6. 值模板变量
# --------------------------------------------------------------------------


def test_dept_id_template_resolves(client: TestClient, dp: Graph) -> None:
    """`${dept_id}` 取当前用户部门：用户在 RA，规则 parent_id == ${dept_id} → 看到 RA 的子部门"""
    assert dp_codes(client, dp, 'parent_tpl') == {dp.code('A1'), dp.code('A2')}


def test_dept_id_template_with_null_dept_is_fail_closed(client: TestClient, dp: Graph) -> None:
    """用户没有部门时 `${dept_id}` 解析不出值 —— 必须收紧成「看不到」，不能 500、也不能放行。

    修之前：`int(None)` 抛 TypeError 被吞，`'${dept_id}'` 这个**字面量**被拼进 SQL，
    SQL Server 报 `Error converting data type varchar to bigint` → 接口 500（实测）。
    """
    assert visible_codes(client, dp, 'null_dept') == set()


def test_now_template_on_excluded_column_sees_nothing(client: TestClient, dp: Graph) -> None:
    """`created_time` 在排除清单里，所以这条规则同样是配置错误 → 看不到任何行。

    ⚠️ 这条**以前叫 `test_now_template_resolves`，而它从来没有验证过 `${now}`**：
    `created_time` 被排除 → 规则被跳过 → fail-open → 全可见，
    断言「全可见」于是通过了，但通过的原因和 `${now}` 无关。
    `${now}` 真正的回归测试挪到了
    `backend/app/admin/tests/security/test_data_permission_failclosed.py`
    （那里用 `User.join_time` —— 一个**没被排除**的时间列）。
    """
    assert dp_codes(client, dp, 'now_tpl') == set()


# --------------------------------------------------------------------------
# 7. 覆盖面：过滤接在 DAO 层，列表和详情都算数
# --------------------------------------------------------------------------


def test_dept_detail_endpoint_is_filtered(client: TestClient, dp: Graph) -> None:
    """按主键取详情也要过滤 —— 「列表页看不到」不等于「拿不到」

    这条以前叫 `..._has_no_data_filter`，断言的是「直接按 ID 就能读到 B1」——
    那是当时的真实行为：过滤器只挂在 `GET /sys/depts`（部门树）上，
    同一个文件里的 `GET /sys/depts/{pk}` 什么都没有。

    🔴 修法不是给这个接口补一个 `Depends` —— 那样**下一个新接口还会漏**。
    过滤接在 `CRUDPlus` 的读方法上（`common/security/data_scope.py`），
    其中 `select_model`（按主键）必须单独覆盖：它**不走** `select()`。
    """
    headers = login(client, dp, 'code_a1')
    resp = client.get(f'/sys/depts/{dp.dept["B1"]}', headers=headers)
    assert resp.status_code == 404, f'按 ID 还能读到不可见的部门：{resp.text}'


def test_dept_detail_of_visible_row_still_works(client: TestClient, dp: Graph) -> None:
    """反向对照：可见的那条必须照常读得到，否则就是把详情接口整个滤死了"""
    headers = login(client, dp, 'code_a1')
    resp = client.get(f'/sys/depts/{dp.dept["A1"]}', headers=headers)
    assert resp.status_code == 200, resp.text
    assert resp.json()['data']['code'] == dp.code('A1')


def test_user_list_endpoint_is_filtered(client: TestClient, dp: Graph) -> None:
    """`__ALL__ + __dept_id__`（「只看本部门的一切」）现在真的作用到用户列表上

    以前这个过滤器**根本没接到这个接口**，配了这条规则的账号照样翻得到全公司。
    """
    headers = login(client, dp, 'all_dept_id')
    resp = client.get('/sys/users', headers=headers, params={'page': 1, 'size': 50})
    assert resp.status_code == 200, resp.text
    items = resp.json()['data']['items']
    dept_ids = {str(i.get('dept_id')) for i in items}
    assert len(dept_ids) <= 1, f'用户列表跨了多个部门，说明按部门过滤没生效：{dept_ids}'


def test_paginated_total_is_filtered_too(client: TestClient, dp: Graph) -> None:
    """🔴 受限账号看到的 `total` 必须和它实际列得出的条数一致。

    这条最早是冲着「`count()` 没跟着过滤」写的，结果**跑出来的红是另一个 bug**：
    `total=22` 但只列得出 20 条，而这个账号的范围一页 50 条装得下。
    真因是用户列表 join 了 `sys_user_role`（m2m）导致的**分页扇出**，
    和数据权限无关 —— 完整的三个症状和修法在
    [`test_pagination_fanout.py`](test_pagination_fanout.py) 里。

    留着这一条，是因为它盯的角度不一样：那边用超管测「总数 = 用户数」，
    这边测**过滤之后**总数仍然对得上。分页的 count 是 fastapi-pagination
    拿 Select 自己拼的，过滤条件在 Select 里 —— 哪天有人给列表加个
    「先取全量再在 Python 里过滤」的实现，这条会红。

    ⚠️ 断言用 `total == len(items)`：这个账号只看得到本部门，一页 50 条装得下，
    所以两者必须相等。
    """
    headers = login(client, dp, 'all_dept_id')
    resp = client.get('/sys/users', headers=headers, params={'page': 1, 'size': 50})
    assert resp.status_code == 200, resp.text
    data = resp.json()['data']
    assert data['total'] == len(data['items']), (
        f'分页总数 {data["total"]} 和实际能列出的 {len(data["items"])} 条不一致 —— '
        '说明 count() 没跟着过滤，分页器会翻不到底'
    )


def test_every_crud_class_declares_its_data_scope_stance() -> None:
    """🔴 守卫：每个 CRUD 类都要对数据权限**表态**。

    这条替换了原来的 `test_data_permission_filter_is_wired_to_exactly_one_endpoint`
    ——那条断言「全仓只有一个接口挂了 DataPermissionFilter」，是一条主动记录缺口的
    守卫，覆盖面补上之后它必然红。

    换成现在这条之后守的东西更强：新写一个 DAO 时，要么继承 `DataScopedCRUD`
    （默认过滤），要么显式写 `data_scope_enabled = False` 并说明理由。
    **忘了想这件事**会红 —— 而忘了想正是原来那个洞的成因。
    """
    import pathlib
    import re

    api_root = pathlib.Path(__file__).resolve().parents[4]
    offenders = []
    for path in api_root.rglob('crud_*.py'):
        if '/tests/' in path.as_posix():
            continue
        body = path.read_text(encoding='utf-8')
        rel = path.relative_to(api_root).as_posix()
        offenders.extend(f'{rel}::{cls}' for cls in re.findall(r'^class (\w+)\(CRUDPlus\[', body, flags=re.MULTILINE))

    assert not offenders, (
        '这些 CRUD 类还在直接继承 CRUDPlus，没有对数据权限表态：\n'
        + '\n'.join(f'  - {o}' for o in offenders)
        + '\n改成继承 DataScopedCRUD；确实不该过滤的，显式写 data_scope_enabled = False 并注明理由。'
    )


# --------------------------------------------------------------------------
# 8. 缓存失效
# --------------------------------------------------------------------------


def test_scope_change_takes_effect_without_relogin(
    client: TestClient, dp: Graph, token_headers: dict[str, str]
) -> None:
    """改数据范围后，已登录用户下一个请求就该看到新结果（`fba:user:<id>` 被清掉）。

    走真实接口改（`PUT /sys/data-scopes/{pk}/rules`），因为清缓存是写在 service 里的。
    """
    headers = login(client, dp, 'code_a1')
    assert dp_codes(client, dp, 'code_a1') == {dp.code('A1')}

    # admin 把这个范围的规则换成 parent_id == RA
    resp = client.put(
        f'/sys/data-scopes/{dp.scope["s_code_a1"]}/rules',
        headers=token_headers,
        json={'rules': [dp.rule['parent_ra']]},
    )
    assert resp.status_code == 200, resp.text

    resp = client.get('/sys/depts', headers=headers)
    assert resp.status_code == 200, resp.text
    codes = {n['code'] for n in flatten(resp.json()['data'])} & {dp.code(k) for k in ALL_DP}
    assert codes == {dp.code('A1'), dp.code('A2')}

    # 还原，免得影响同模块里后跑的用例
    client.put(
        f'/sys/data-scopes/{dp.scope["s_code_a1"]}/rules',
        headers=token_headers,
        json={'rules': [dp.rule['code_a1']]},
    )
