from collections.abc import Sequence
from typing import Any

from sqlalchemy import Table
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.admin.crud.crud_data_rule import data_rule_dao
from backend.app.admin.model import DataRule
from backend.app.admin.schema.data_rule import (
    CreateDataRuleParam,
    DeleteDataRuleParam,
    GetDataRuleColumnDetail,
    GetDataRuleTemplateVariableDetail,
    UpdateDataRuleParam,
)
from backend.app.admin.utils.cache import user_cache_manager
from backend.common.enums import RoleDataRuleExpressionType
from backend.common.exception import errors
from backend.common.i18n import t
from backend.common.pagination import paging_data
from backend.common.security.permission import get_data_permission_models
from backend.core.conf import settings


class DataRuleService:
    """数据规则服务类"""

    @staticmethod
    async def get(*, db: AsyncSession, pk: int) -> DataRule:
        """
        获取数据规则详情

        :param db: 数据库会话
        :param pk: 规则 ID
        :return:
        """

        data_rule = await data_rule_dao.get(db, pk)
        if not data_rule:
            raise errors.NotFoundError(msg=t('error.data_rule.not_found'))
        return data_rule

    @staticmethod
    async def get_models() -> list[str]:
        """获取所有数据规则可用模型"""
        model_template_variables = [var['key'] for var in settings.DATA_PERMISSION_MODEL_TEMPLATE_VARIABLES]
        models = [
            m for m in list(get_data_permission_models().keys()) if m not in settings.DATA_PERMISSION_MODEL_EXCLUDE
        ]
        return model_template_variables + models

    @staticmethod
    async def get_value_template_variables() -> list[GetDataRuleTemplateVariableDetail]:
        """获取所有数据规则值可用模板变量"""
        return [GetDataRuleTemplateVariableDetail(**var) for var in settings.DATA_PERMISSION_TEMPLATE_VARIABLES]

    @staticmethod
    async def get_columns(model: str) -> list[GetDataRuleColumnDetail]:
        """
        获取数据规则可用模型的字段列表

        :param model: 模型名称
        :return:
        """
        column_template_variables = [
            GetDataRuleColumnDetail(key=var['key'], comment=var['comment'])
            for var in settings.DATA_PERMISSION_COLUMN_TEMPLATE_VARIABLES
        ]

        model_template_variable_keys = {var['key'] for var in settings.DATA_PERMISSION_MODEL_TEMPLATE_VARIABLES}
        if model in model_template_variable_keys:
            return column_template_variables

        available_models = get_data_permission_models()
        if model not in available_models:
            raise errors.NotFoundError(msg=t('error.data_rule.model_not_found'))
        model_ins = available_models[model]

        table = model_ins if isinstance(model_ins, Table) else model_ins.__table__
        model_columns = [
            GetDataRuleColumnDetail(key=column.key, comment=column.comment)
            for column in table.columns
            if column.key not in settings.DATA_PERMISSION_COLUMN_EXCLUDE
        ]
        return model_columns + column_template_variables

    @staticmethod
    async def get_list(*, db: AsyncSession, name: str | None) -> dict[str, Any]:
        """
        获取数据规则列表

        :param db: 数据库会话
        :param name: 规则名称
        :return:
        """
        data_rule_select = await data_rule_dao.get_select(name=name)
        return await paging_data(db, data_rule_select)

    @staticmethod
    async def get_all(*, db: AsyncSession) -> Sequence[DataRule]:
        """
        获取所有数据规则

        :param db: 数据库会话
        :return:
        """

        data_rules = await data_rule_dao.get_all(db)
        return data_rules

    @staticmethod
    def _validate_values(python_type: type, raw_values: list[str], value_templates: set[str]) -> None:
        """逐个值确认能转成列的类型；`${user_id}` 这类模板变量在运行时才解析，跳过

        :param python_type: 列的 Python 类型
        :param raw_values: 规则里配的原始值（in / not_in 已按逗号拆开）
        :param value_templates: 允许的值模板变量
        :return:
        """
        if python_type is str:
            return
        for raw in raw_values:
            if raw in value_templates:
                continue
            try:
                python_type(raw)
            except (ValueError, TypeError):
                raise errors.RequestError(msg=t('error.data_rule.value_type_mismatch')) from None

    @classmethod
    def _validate_rule(cls, obj: CreateDataRuleParam | UpdateDataRuleParam) -> None:
        """保存前校验模型 / 字段 / 值类型

        🔴 **这是主防线。** 运行时那一层（`filter_data_permission` 的 fail-closed）
        只能把配错的规则收紧成「看不到数据」—— 用户会来报，但报的是「我怎么什么都
        看不见」，没人会想到是某条规则的字段名拼错了。在这里 400，管理员当场就知道
        哪里不对。

        字段白名单直接来自**模型反射**（`get_data_permission_models()`），
        和 `get_columns()` 给前端下拉的是同一份真相 —— 不维护第二份清单。

        :param obj: 规则创建 / 更新参数
        :return:
        """
        models = get_data_permission_models()
        column_templates = {var['key'] for var in settings.DATA_PERMISSION_COLUMN_TEMPLATE_VARIABLES}
        value_templates = {var['key'] for var in settings.DATA_PERMISSION_TEMPLATE_VARIABLES}
        model_templates = {var['key'] for var in settings.DATA_PERMISSION_MODEL_TEMPLATE_VARIABLES}

        if obj.model in model_templates:
            # `__ALL__` 只允许配字段模板变量。配裸字段名等于「碰巧有这一列的表才过滤，
            # 其余表全部放行」—— 那正是本次要消灭的失败形态
            if obj.column not in column_templates:
                raise errors.RequestError(msg=t('error.data_rule.template_column_required'))
            targets = list(models.values())
            strict = False
        else:
            if obj.model not in models:
                raise errors.NotFoundError(msg=t('error.data_rule.model_not_found'))
            targets = [models[obj.model]]
            strict = True

        column = obj.column.strip('_') if obj.column in column_templates else obj.column
        if column in settings.DATA_PERMISSION_COLUMN_EXCLUDE:
            raise errors.RequestError(msg=t('error.data_rule.column_not_allowed'))

        multi_value = obj.expression in (RoleDataRuleExpressionType.in_, RoleDataRuleExpressionType.not_in)
        raw_values = [v.strip() for v in obj.value.split(',')] if multi_value else [obj.value]

        matched = False
        for target in targets:
            table = target if isinstance(target, Table) else target.__table__
            if column not in table.columns:
                if strict:
                    raise errors.RequestError(msg=t('error.data_rule.column_not_found'))
                continue
            matched = True
            cls._validate_values(table.columns[column].type.python_type, raw_values, value_templates)

        if not matched:
            # `__ALL__` + 一个谁都没有的模板列 —— 这条规则永远不产生任何条件，
            # 等于没配。让它在保存时就说清楚，而不是留着让人以为已经限制住了
            raise errors.RequestError(msg=t('error.data_rule.column_matches_no_model'))

    @classmethod
    async def create(cls, *, db: AsyncSession, obj: CreateDataRuleParam) -> DataRule:
        """
        创建数据规则

        :param db: 数据库会话
        :param obj: 规则创建参数
        :return: 新建的规则
        """
        cls._validate_rule(obj)
        data_rule = await data_rule_dao.get_by_name(db, obj.name)
        if data_rule:
            raise errors.ConflictError(msg=t('error.data_rule.already_exists'))
        return await data_rule_dao.create(db, obj)

    @classmethod
    async def update(cls, *, db: AsyncSession, pk: int, obj: UpdateDataRuleParam) -> int:
        """
        更新数据规则

        :param db: 数据库会话
        :param pk: 规则 ID
        :param obj: 规则更新参数
        :return:
        """
        cls._validate_rule(obj)
        data_rule = await data_rule_dao.get(db, pk)
        if not data_rule:
            raise errors.NotFoundError(msg=t('error.data_rule.not_found'))
        if data_rule.name != obj.name and await data_rule_dao.get_by_name(db, obj.name):
            raise errors.ConflictError(msg=t('error.data_rule.already_exists'))
        count = await data_rule_dao.update(db, pk, obj)
        await user_cache_manager.clear_by_data_rule_id(db, [pk])
        return count

    @staticmethod
    async def delete(*, db: AsyncSession, obj: DeleteDataRuleParam) -> int:
        """
        批量删除数据规则

        :param db: 数据库会话
        :param obj: 规则 ID 列表
        :return:
        """
        count = await data_rule_dao.delete(db, obj.pks)
        await user_cache_manager.clear_by_data_rule_id(db, obj.pks)
        return count


data_rule_service: DataRuleService = DataRuleService()
