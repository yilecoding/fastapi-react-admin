"""数据权限的 fail-closed 语义。

`filter_data_permission()` 原来有一处兜底是 `return or_(1 == 1)` —— 所有规则
都没能产生条件时，把**整张表**放出去。配合三种「规则读不懂」的情形
（模型名拼错、字段不存在、值转不成列类型），一条名叫「仅本部门」的规则
配错之后的实际效果是「全部可见」，而界面上没有任何提示。

这里在**单元层**钉住新语义，端到端那一层由
`backend/app/admin/tests/api_v1/test_data_permission.py` 负责（26 条，打真实接口）。
分两层是因为有些情形端到端造不出来：`User.join_time` 这种「没被排除的时间列」
在部门接口上根本不参与查询。

一条重要的边界：**「规则读不懂」和「规则不适用于本次查询的模型」必须区别对待。**
前者收紧到 `false()`，后者放行 —— 否则用户只要有任何一条数据规则，
在所有没被规则覆盖的模型上都会一行都看不到，系统直接不可用。
"""

from types import SimpleNamespace

from sqlalchemy import ColumnElement, select

from backend.app.admin.model import Dept, User
from backend.common.enums import RoleDataRuleExpressionType as Expr
from backend.common.enums import RoleDataRuleOperatorType as Op
from backend.common.enums import StatusType
from backend.common.security.permission import filter_data_permission


class _Rule:
    """假的 DataRule。

    ⚠️ 不能用 `SimpleNamespace` —— `filter_data_permission` 把规则收进 `set`，
    而 SimpleNamespace 定义了 `__eq__` 所以不可哈希，会 TypeError。
    普通类用默认的 id 哈希，正合适。
    """

    def __init__(
        self, model: str, column: str, value: str, *, expression: int = Expr.eq, operator: int = Op.AND
    ) -> None:
        self.model = model
        self.column = column
        self.value = value
        self.expression = expression
        self.operator = operator


def _rule(model: str, column: str, value: str, *, expression: int = Expr.eq, operator: int = Op.AND) -> _Rule:
    return _Rule(model, column, value, expression=expression, operator=operator)


def _request(*rules: _Rule, user_id: int = 1, dept_id: int | None = 7) -> SimpleNamespace:
    scope = SimpleNamespace(status=StatusType.enable, rules=list(rules))
    role = SimpleNamespace(status=StatusType.enable, is_filter_scopes=True, scopes=[scope], menus=[])
    user = SimpleNamespace(is_superuser=False, id=user_id, dept_id=dept_id, roles=[role])
    return SimpleNamespace(user=user)


def _is_always_false(condition: ColumnElement[bool]) -> bool:
    """把条件编译成 SQL 文本判断它是不是恒假

    直接比对象没用（SQLAlchemy 的 `false()` 每次都是新实例），编译成字符串最直白，
    而且顺带证明这个条件**真的能编译进 SQL**，不会在执行期才炸。
    """
    compiled = str(select(Dept.id).where(condition).compile(compile_kwargs={'literal_binds': True}))
    return '1 != 1' in compiled or 'false' in compiled.lower()


def test_unknown_model_name_sees_nothing() -> None:
    """模型名拼错（Users 多了个 s）→ 一行都看不到

    原来：`target_model_map.get('Users')` 拿不到 → `target_models = []` → 整条规则
    静默跳过 → 没有任何条件 → `or_(1 == 1)` → 全部可见。
    """
    condition = filter_data_permission(_request(_rule('Users', 'dept_id', '7')), Dept)
    assert _is_always_false(condition)


def test_unknown_column_on_explicit_model_sees_nothing() -> None:
    """显式指定了模型，字段却不存在 → 收紧"""
    condition = filter_data_permission(_request(_rule('Dept', 'no_such_column', 'x')), Dept)
    assert _is_always_false(condition)


def test_uncastable_value_sees_nothing_instead_of_500() -> None:
    """给 bigint 列配 'abc' → 收紧，而不是把原始字符串拼进 SQL

    原来 `cast_value` 的 `except (ValueError, TypeError): return value` 会把
    'abc' 原样传下去，SQL Server 端 `Error converting data type varchar to bigint`
    → 500。既不是放行也不是拦截，是让接口挂掉。
    """
    condition = filter_data_permission(_request(_rule('Dept', 'parent_id', 'abc')), Dept)
    assert _is_always_false(condition)


def test_one_broken_rule_poisons_the_whole_filter() -> None:
    """一条好规则 + 一条坏规则 = 收紧

    不能只把坏的那条丢掉：读不懂一条规则意味着这份策略没有被完整执行，
    剩下的条件不一定还表达着管理员的本意。而且收紧是**可见**的失败
    （用户看不到数据会来报），跳过则是静默放行。
    """
    condition = filter_data_permission(
        _request(_rule('Dept', 'status', '1'), _rule('Dept', 'no_such_column', 'x')),
        Dept,
    )
    assert _is_always_false(condition)


def test_rule_for_another_model_still_passes_through() -> None:
    """🔴 反向守卫：规则打在 User 上、这次查 Dept —— 这不是「读不懂」，要放行

    把这种情形也收紧的话，用户只要有任何一条数据规则，在所有没被覆盖的模型上
    都会一行都看不到，整个系统直接不可用。这条守住那个边界不被顺手改掉。
    """
    condition = filter_data_permission(_request(_rule('User', 'dept_id', '7')), Dept)
    assert not _is_always_false(condition)


def test_now_template_resolves_on_a_non_excluded_datetime_column() -> None:
    """`${now}` 必须解析成**调用结果**

    修之前 `template_resolvers` 里放的是 `timezone.now` 这个函数对象，
    `datetime(<function now>)` 抛 TypeError 被 except 吞掉，
    `'${now}'` 字面量被原样拼进 SQL → 500。

    ⚠️ 必须用**没被排除**的时间列。`test_data_permission.py` 里那条同名测试
    用的是 `Dept.created_time`，而它在 `DATA_PERMISSION_COLUMN_EXCLUDE` 里 ——
    规则被跳过、fail-open、断言「全可见」通过，但和 `${now}` 没有关系。
    `User.join_time` 不在排除清单里，这里才真的走到了模板解析。
    """
    condition = filter_data_permission(
        _request(_rule('User', 'join_time', '${now}', expression=Expr.lt)),
        User,
    )
    compiled = str(select(User.id).where(condition).compile(compile_kwargs={'literal_binds': True}))
    assert '${now}' not in compiled, '模板变量没被解析，字面量进了 SQL'
    assert 'join_time' in compiled
    assert not _is_always_false(condition)


def test_unresolvable_template_variable_is_not_a_broken_rule() -> None:
    """用户没有部门时 `${dept_id}` 解析不出值 —— 这是**运行时状态**，不是配错

    结果同样是看不到行（收紧），但它走的是「值解析不出」那条路而不是
    「规则读不懂」，两者要分开：前者换个用户就正常了，后者要改配置。
    """
    condition = filter_data_permission(
        _request(_rule('User', 'dept_id', '${dept_id}'), dept_id=None),
        User,
    )
    assert _is_always_false(condition)


def test_superuser_is_unaffected() -> None:
    """超管短路不能被 fail-closed 改造波及"""
    request = _request(_rule('Users', 'dept_id', '7'))
    request.user.is_superuser = True
    assert not _is_always_false(filter_data_permission(request, Dept))
