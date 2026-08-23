from typing import TYPE_CHECKING, Any

from fastapi import Request
from sqlalchemy import Alias, ColumnElement, Table, and_, false, or_
from sqlalchemy.orm.util import AliasedClass
from sqlalchemy_crud_plus.types import Model

from backend.common.context import ctx
from backend.common.enums import RoleDataRuleExpressionType, RoleDataRuleOperatorType
from backend.common.exception import errors
from backend.core.conf import settings
from backend.utils.dynamic_import import get_all_models
from backend.utils.timezone import timezone

if TYPE_CHECKING:
    from backend.app.admin.model import DataRule


# 模板变量解析失败的哨兵（`None` 本身可能是合法值，不能拿它当哨兵）
#
# 两个哨兵要分开，因为它们代表的是**完全不同性质**的失败：
#   _UNRESOLVED —— 模板变量在这一次请求里没有值（例如用户没有部门，`${dept_id}` 为 None）。
#                  这是合法的运行时状态，规则本身没问题，收紧到「匹配不到行」即可。
#   _UNCASTABLE —— 值转不成列的类型（例如给 bigint 列配了 'abc'）。这是**配置错误**，
#                  说明这条规则从来就没能表达管理员想要的意思 —— 整个过滤器必须
#                  fail-closed，不能只当这一条不存在
_UNRESOLVED = object()
_UNCASTABLE = object()


class RequestPermission:
    """
    请求权限验证器，用于角色菜单 RBAC 权限控制

    注意：
        使用此请求权限时，需要将 `Depends(RequestPermission('xxx'))` 在 `DependsRBAC` 之前设置，
        因为 FastAPI 当前版本的接口依赖注入按正序执行，意味着 RBAC 标识会在验证前被设置
    """

    def __init__(self, value: str) -> None:
        """
        初始化请求权限验证器

        :param value: 权限标识
        :return:
        """
        self.value = value

    async def __call__(self, request: Request) -> None:
        """
        验证请求权限

        :param request: FastAPI 请求对象
        :return:
        """
        if settings.RBAC_ROLE_MENU_MODE:
            if not isinstance(self.value, str):
                raise errors.ServerError

            # 设置权限标识到上下文
            ctx.permission = self.value


def get_data_permission_models() -> dict[str, object]:
    """获取所有可用于数据权限的模型"""
    return {getattr(model, '__name__', str(model)): model for model in get_all_models()}


class _UserOnly:
    """只为了让下面那段沿用 `request.user` 的写法 —— 避免大面积改动引入笔误"""

    __slots__ = ('user',)

    def __init__(self, user: Any) -> None:
        self.user = user


def filter_data_permission(
    request: Request, *models: type[Model] | AliasedClass | Alias | Table
) -> ColumnElement[bool]:
    """
    过滤数据权限，控制用户可见数据范围（按请求取用户）

    保留这个签名是为了 `DataPermissionFilter` 那条显式接线方式还能用。
    真正的实现在 `filter_data_permission_for_user` —— DAO 层
    （`common/security/data_scope.py: DataScopedCRUD`）拿不到 `Request`，
    只能拿到从 ContextVar 里取出来的用户对象。

    :param request: FastAPI 请求对象
    :param models: 需要应用数据权限的模型类
    :return:
    """
    return filter_data_permission_for_user(request.user, *models)


def filter_data_permission_for_user(  # ruff:ignore[complex-structure]
    current_user: Any, *models: type[Model] | AliasedClass | Alias | Table
) -> ColumnElement[bool]:
    """
    过滤数据权限，控制用户可见数据范围

    使用场景：
        - 控制用户能看到哪些数据

    :param current_user: 当前用户（含 roles → scopes → rules）
    :param models: 需要应用数据权限的模型类
    :return:
    """
    request = _UserOnly(current_user)

    # 超级管理员不过滤
    if request.user.is_superuser:
        return or_(1 == 1)

    # 角色未启用数据权限过滤
    for role in request.user.roles:
        if role.status and not role.is_filter_scopes:
            return or_(1 == 1)

    # 获取数据规则
    data_rules: set[DataRule] = set()
    for role in request.user.roles:
        if not role.status:
            continue
        for scope in role.scopes:
            if scope.status:
                data_rules.update(rule for rule in scope.rules if rule is not None)

    # 启用数据权限过滤，但没有已启用的数据权限
    if not data_rules:
        return or_(1 != 1)

    # 目标模型
    target_model_map = (
        {getattr(model, '__name__', str(model)): model for model in models} if models else get_data_permission_models()
    )

    # 字段模板变量映射
    column_template_resolvers = {
        var['key']: var['key'].strip('_') for var in settings.DATA_PERMISSION_COLUMN_TEMPLATE_VARIABLES
    }

    # 模板变量解析映射
    template_variable_keys = {var['key'] for var in settings.DATA_PERMISSION_TEMPLATE_VARIABLES}
    template_resolvers = {
        '${user_id}': request.user.id,
        '${dept_id}': request.user.dept_id,
        # 🔴 必须是**调用结果**。原来这里放的是 `timezone.now` 这个函数对象，
        # `datetime(<function now>)` 抛 TypeError 被下面的 except 吞掉，
        # 于是 `'${now}'` 这个字面量被原样拼进 SQL —— 规则不是不生效，是让接口 500
        '${now}': timezone.now(),
    }

    where_and_list = []
    where_or_list = []

    # 🔴 只要有**一条规则无法解释**，整个过滤器就收紧成「看不到任何行」。
    #
    # 为什么是整体收紧而不是「跳过这一条」：一条读不懂的规则意味着这份策略
    # 没有被完整执行，我们无法保证剩下的条件还表达着管理员的本意。
    # 而且收紧之后失败是**可见的**（用户看不到数据会来报），
    # 跳过则是静默放行 —— 一条「仅本部门」配错字段，实际效果是「全部可见」，
    # 界面上没有任何提示。
    has_broken_rule = False

    # 全量模型表，用来区分「模型名拼错了」和「这条规则不适用于本次查询的模型」
    all_model_names = set(get_data_permission_models())

    for data_rule in data_rules:
        if data_rule.model == '__ALL__':
            target_models = list(target_model_map.values())
            # `__ALL__` 天然只命中「有这一列」的表，缺列是正常的，不算配错
            strict_column = False
        else:
            if data_rule.model not in all_model_names:
                # 模型名在全量模型里都找不到 = 拼错了。区别于下面那种
                # 「模型存在但本次查询不涉及它」—— 后者跳过是对的
                has_broken_rule = True
                continue
            target_model = target_model_map.get(data_rule.model)
            target_models = [target_model] if target_model is not None else []
            strict_column = True

        for target_model in target_models:
            table = target_model if isinstance(target_model, Table) else target_model.__table__
            rule_column = column_template_resolvers.get(data_rule.column, data_rule.column)
            if rule_column not in table.columns.keys():
                if strict_column:
                    # 显式指定了模型，却配了一个该模型没有的字段 —— 规则配错了
                    has_broken_rule = True
                continue
            if rule_column in settings.DATA_PERMISSION_COLUMN_EXCLUDE:
                # 引用了被明令排除的字段，同样是配置错误
                has_broken_rule = True
                continue

            # 构建过滤条件
            column_obj = (
                getattr(target_model, rule_column)
                if not isinstance(target_model, Table)
                else table.columns[rule_column]
            )
            column_type = table.columns[rule_column].type.python_type

            def cast_value(value: Any, _column_type: type = column_type) -> Any:
                """类型转换；模板变量解析不出值时返回 `_UNRESOLVED`"""
                if value in template_variable_keys:
                    resolved = template_resolvers[value]
                    # 解析不出来（例如用户没有部门，`${dept_id}` 是 None）。
                    # 绝不能把 `'${dept_id}'` 这个字面量继续往下传 ——
                    # 它会被拼进 SQL，SQL Server 直接
                    # `Error converting data type varchar to bigint` → 500
                    if resolved is None:
                        return _UNRESOLVED
                    value = resolved
                if isinstance(value, _column_type):
                    return value
                try:
                    return _column_type(value) if _column_type is not str else value
                except (ValueError, TypeError):
                    # 🔴 原来这里 `return value`，把转不动的原始字符串继续拼进 SQL，
                    # SQL Server 端 `Error converting data type varchar to bigint` → 500。
                    # 既不是放行也不是拦截，是让接口挂掉。现在判定为配置错误
                    return _UNCASTABLE

            # 先把值解析出来，解析不了的规则一律**收紧**成「匹配不到任何行」。
            # 不能退化成「不加条件」—— 那是 fail-open，一条配错的规则会把整张表放出去
            if data_rule.expression in (RoleDataRuleExpressionType.in_, RoleDataRuleExpressionType.not_in):
                cast_values = [cast_value(v.strip()) for v in data_rule.value.split(',')]
                if any(v is _UNCASTABLE for v in cast_values):
                    has_broken_rule = True
                values = [v for v in cast_values if v is not _UNRESOLVED and v is not _UNCASTABLE]
                single_value: Any = _UNRESOLVED if not values else None
            else:
                values = []
                single_value = cast_value(data_rule.value)
                if single_value is _UNCASTABLE:
                    has_broken_rule = True

            condition = None
            if single_value is _UNRESOLVED or single_value is _UNCASTABLE:
                condition = false()
            else:
                match data_rule.expression:
                    case RoleDataRuleExpressionType.eq:
                        condition = column_obj == single_value
                    case RoleDataRuleExpressionType.ne:
                        condition = column_obj != single_value
                    case RoleDataRuleExpressionType.gt:
                        condition = column_obj > single_value
                    case RoleDataRuleExpressionType.ge:
                        condition = column_obj >= single_value
                    case RoleDataRuleExpressionType.lt:
                        condition = column_obj < single_value
                    case RoleDataRuleExpressionType.le:
                        condition = column_obj <= single_value
                    case RoleDataRuleExpressionType.in_:
                        condition = column_obj.in_(values)
                    case RoleDataRuleExpressionType.not_in:
                        condition = column_obj.not_in(values)

            # 根据运算符添加到对应列表
            if condition is not None:
                match data_rule.operator:
                    case RoleDataRuleOperatorType.AND:
                        where_and_list.append(condition)
                    case RoleDataRuleOperatorType.OR:
                        where_or_list.append(condition)

    # 🔴 有读不懂的规则 → 一行都不给。见上面 has_broken_rule 的说明
    if has_broken_rule:
        return false()

    # 组合所有条件
    where_list = []
    if where_and_list:
        where_list.append(and_(*where_and_list))
    if where_or_list:
        where_list.append(or_(*where_or_list))

    # 到这里 where_list 为空，只剩一种情况：规则都是好的，但没有一条适用于
    # 本次查询的模型（例如规则配在 Dept 上，这次查的是 User）。
    # 那属于「本模型不受限」，放行是对的 —— 上面几个分支已经把「配错」摘出去了
    return or_(*where_list) if where_list else or_(1 == 1)


# 此函数是为了简化调用方式，但目前无法正常工作: https://github.com/fastapi/fastapi/discussions/14438
# def DataPermissionFilter(*models: type[Model] | AliasedClass | Alias | Table) -> type[ColumnElement[bool]]:
#     """
#     指定模型的数据权限过滤器
#
#     :param models: 模型类（可选，支持多个）
#     :return:
#     """
#     return Annotated[ColumnElement[bool], Depends(partial(filter_data_permission, *models))]


class DataPermissionFilter:
    """指定模型的数据权限过滤器"""

    def __init__(self, *models: type[Model] | AliasedClass | Alias | Table) -> None:
        self.models = models

    async def __call__(self, request: Request) -> ColumnElement[bool]:
        return filter_data_permission(request, *self.models)
