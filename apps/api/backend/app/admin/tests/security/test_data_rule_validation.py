"""数据规则的**保存时**校验。

运行时的 fail-closed（`filter_data_permission`）只能把配错的规则收紧成
「看不到数据」。那是对的兜底，但对管理员来说信息量很低 —— 他看到的是
「某个用户说什么都看不见」，不会想到是三天前建的某条规则字段名拼错了。

所以主防线在这里：保存的时候就 400，当场说清楚哪里不对。

字段白名单来自模型反射，和 `get_columns()` 喂给前端下拉的是同一份真相，
不维护第二份清单。
"""

import pytest

from backend.app.admin.schema.data_rule import CreateDataRuleParam
from backend.app.admin.service.data_rule_service import data_rule_service
from backend.common.enums import RoleDataRuleExpressionType as Expr
from backend.common.enums import RoleDataRuleOperatorType as Op
from backend.common.exception import errors


def _param(model: str, column: str, value: str, *, expression: int = Expr.eq) -> CreateDataRuleParam:
    return CreateDataRuleParam(
        name='校验用例',
        model=model,
        column=column,
        operator=Op.AND,
        expression=expression,
        value=value,
    )


def test_unknown_model_is_rejected() -> None:
    with pytest.raises(errors.NotFoundError):
        data_rule_service._validate_rule(_param('Users', 'dept_id', '7'))


def test_unknown_column_is_rejected() -> None:
    with pytest.raises(errors.RequestError):
        data_rule_service._validate_rule(_param('Dept', 'no_such_column', 'x'))


def test_excluded_column_is_rejected() -> None:
    """id / created_time 这类列在 DATA_PERMISSION_COLUMN_EXCLUDE 里"""
    with pytest.raises(errors.RequestError):
        data_rule_service._validate_rule(_param('Dept', 'created_time', '2026-01-01'))


def test_value_type_mismatch_is_rejected() -> None:
    """给 bigint 列配 'abc' —— 运行时会 500，这里直接 400"""
    with pytest.raises(errors.RequestError):
        data_rule_service._validate_rule(_param('Dept', 'parent_id', 'abc'))


def test_all_model_requires_template_column() -> None:
    """🔴 `__ALL__` + 裸字段名 = 「碰巧有这一列的表才过滤，其余全放行」

    这正是要消灭的失败形态：规则看起来限制了所有模型，实际上大部分模型不受影响。
    """
    with pytest.raises(errors.RequestError):
        data_rule_service._validate_rule(_param('__ALL__', 'dept_id', '7'))


def test_valid_rules_are_accepted() -> None:
    """校验器不能误杀正常配置"""
    data_rule_service._validate_rule(_param('Dept', 'status', '1'))
    data_rule_service._validate_rule(_param('Dept', 'code', 'TEST'))
    data_rule_service._validate_rule(_param('__ALL__', '__dept_id__', '${dept_id}'))
    data_rule_service._validate_rule(_param('__ALL__', '__created_by__', '${user_id}'))


def test_template_values_are_not_type_checked() -> None:
    """`${user_id}` 在运行时才解析，保存时不能拿它去转 bigint"""
    data_rule_service._validate_rule(_param('User', 'dept_id', '${dept_id}'))


def test_in_expression_checks_every_value() -> None:
    """in / not_in 的每一个值都要过类型校验，不能只看第一个"""
    data_rule_service._validate_rule(_param('Dept', 'parent_id', '1,2,3', expression=Expr.in_))
    with pytest.raises(errors.RequestError):
        data_rule_service._validate_rule(_param('Dept', 'parent_id', '1,abc,3', expression=Expr.in_))


def test_every_seeded_rule_passes_validation() -> None:
    """🔴 种子 SQL 里的每一条数据规则都必须能通过保存校验。

    这条守的是「发一份自己都过不了校验的默认配置」。它不是假想 ——
    原来种子里的「部门 ID 等于当前用户部门」配的是 `Dept.__dept_id__`，
    而 `__dept_id__` 解析成 `dept_id`，`sys_dept` 上根本没有这一列。
    那条规则从来没生效过，而它所在的数据范围就叫「本部门数据权限」：
    一个名字写着「本部门」、实际效果是「全部部门」的授权配置，
    在 fail-open 时代没有任何现象。（已改成 `__ALL__`。）

    直接解析种子 SQL 而不是查库：这样它在任何环境下都能跑，
    也不依赖测试库是不是刚灌过种子。
    """
    import re

    from backend.core.path_conf import BASE_PATH

    sql_files = [
        *(BASE_PATH / 'sql').rglob('init_*.sql'),
        *(BASE_PATH / 'plugin').rglob('sql/**/init_*.sql'),
    ]

    # INSERT INTO sys_data_rule (...) VALUES (id, N'名称', 'Model', 'column', op, expr, 'value', ...)
    row_re = re.compile(
        r"\(\s*\d+\s*,\s*N?'(?P<name>[^']*)'\s*,\s*'(?P<model>[^']*)'\s*,\s*'(?P<column>[^']*)'\s*,"
        r"\s*(?P<operator>\d+)\s*,\s*(?P<expression>\d+)\s*,\s*'(?P<value>[^']*)'"
    )

    checked = 0
    for path in sql_files:
        body = path.read_text(encoding='utf-8', errors='ignore')
        block = re.search(r'INSERT INTO sys_data_rule\b.*?;', body, re.DOTALL | re.IGNORECASE)
        if not block:
            continue
        for m in row_re.finditer(block.group(0)):
            checked += 1
            param = CreateDataRuleParam(
                name=m['name'],
                model=m['model'],
                column=m['column'],
                operator=int(m['operator']),
                expression=int(m['expression']),
                value=m['value'],
            )
            try:
                data_rule_service._validate_rule(param)
            except errors.BaseExceptionError as e:
                pytest.fail(f'{path.name} 里的种子规则「{m["name"]}」过不了保存校验：{e.msg}')

    assert checked >= 15, f'只解析到 {checked} 条种子规则，正则大概率没匹配上（三个方言各 6 条）'
