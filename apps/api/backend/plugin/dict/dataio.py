"""字典数据的导出 / 导入定义（#11 · v0.4）。

导出取数调列表接口那条 `dict_data_dao.get_select`，导入写库走 `dict_data_service`
"""

from collections.abc import Mapping
from typing import Any

from pydantic import ConfigDict, Field, ValidationError
from sqlalchemy import Select, select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.admin.service.import_service import pydantic_errors, required_error
from backend.common.cache.decorator import invalidate_cache
from backend.common.dataio.exporting import ExportColumn, ExportSpec, register_export
from backend.common.dataio.importing import (
    ENABLE_STATUS_ALIASES,
    CommitOutcome,
    ImportColumn,
    ImportContext,
    ImportRow,
    ImportSpec,
    register_import,
)
from backend.common.exception import errors
from backend.common.i18n import t
from backend.common.log import log
from backend.common.schema import SchemaBase
from backend.core.conf import settings
from backend.plugin.dict.crud.crud_dict_data import dict_data_dao
from backend.plugin.dict.crud.crud_dict_type import dict_type_dao
from backend.plugin.dict.model import DictData
from backend.plugin.dict.schema.dict_data import CreateDictDataParam, UpdateDictDataParam
from backend.plugin.dict.service.dict_data_service import dict_data_service
from backend.utils.serializers import select_columns_serialize


class DictDataExportFilters(SchemaBase):
    # 🔴 不认识的参数报错，不忽略（理由见 `app/admin/dataio.py: _Filters`）
    model_config = ConfigDict(extra='forbid')

    type_code: str | None = Field(None, description='字典类型编码')
    label: str | None = Field(None, description='字典数据标签')
    value: str | None = Field(None, description='字典数据键值')
    status: int | None = Field(None, description='状态')
    type_id: int | None = Field(None, description='字典类型 ID')


async def _select(f: DictDataExportFilters, _user: Any) -> Select:
    return await dict_data_dao.get_select(
        type_code=f.type_code, label=f.label, value=f.value, status=f.status, type_id=f.type_id
    )


async def _shape(_db: Any, rows: Any) -> list[dict[str, Any]]:  # ruff: ignore[unused-async]
    return [select_columns_serialize(row[0]) for row in rows]


DICT_DATA_EXPORT = register_export(
    ExportSpec(
        resource='dict.data',
        label='export.resource.dict_data',
        perm='dict:data:export',
        # 前四列和字典数据导入模板同义：导出的表改完能原样导回去
        columns=(
            ExportColumn('type_code', 'export.column.dict_type_code', width=22),
            ExportColumn('label', 'export.column.dict_label', width=18),
            ExportColumn('value', 'export.column.dict_value', width=18),
            ExportColumn('sort', 'export.column.sort', kind='int', width=8),
            ExportColumn(
                'status',
                'export.column.status',
                kind='enum',
                choices={0: 'export.value.disabled', 1: 'export.value.enabled'},
                width=8,
            ),
            ExportColumn('color', 'export.column.color', width=10),
            ExportColumn('remark', 'export.column.remark', width=30),
            ExportColumn('created_time', 'export.column.created_time', kind='datetime', width=20),
            ExportColumn('id', 'export.column.dict_data_id', kind='id', width=22),
        ),
        filters=DictDataExportFilters,
        filter_labels={
            'type_code': 'export.column.dict_type_code',
            'label': 'export.column.dict_label',
            'value': 'export.column.dict_value',
            'status': 'export.column.status',
            'type_id': 'export.filter.dict_type',
        },
        select=_select,
        id_column=DictData.id,
        shape=_shape,
    )
)


# ═══════════════════════════════ 导入 ═══════════════════════════════


async def _type_codes(db: AsyncSession) -> list[str]:
    """模板里「字典类型编码」的下拉"""
    return [dict_type.code for dict_type in await dict_type_dao.get_all(db)][:500]


def _key(values: Mapping[str, Any]) -> str | None:
    """业务键：同一个类型下标签唯一（同 `dict_data_service.create` 的冲突判定）"""
    if not values.get('type_code') or not values.get('label'):
        return None
    return f'{values["type_code"]}\x1f{values["label"]}'


def _fields(values: Mapping[str, Any], current: Any) -> dict[str, Any]:
    """更新时空白单元格表示保持原值（同部门导入）"""

    def pick(key: str, default: Any) -> Any:
        value = values.get(key)
        if value is not None:
            return value
        return getattr(current, key) if current is not None else default

    return {
        'label': values.get('label'),
        'value': pick('value', None),
        'color': pick('color', None),
        'sort': pick('sort', 0),
        'status': pick('status', 1),
        'remark': pick('remark', None),
    }


async def _existing(db: AsyncSession, rows: list[ImportRow]) -> dict[tuple[str, str], DictData]:
    """文件里出现的（类型, 标签）在库里已有的那些。一次批量查，不逐行往返"""
    pairs = {(row.values['type_code'], row.values['label']) for row in rows if _key(row.values)}
    labels = sorted({label for _, label in pairs})
    found: dict[tuple[str, str], DictData] = {}
    for start in range(0, len(labels), 1000):  # SQL Server 一句最多 2100 个参数
        stmt = select(DictData).where(
            DictData.label.in_(labels[start : start + 1000]),
            DictData.type_code.in_({type_code for type_code, _ in pairs}),
            DictData.deleted == 0,
        )
        for item in (await db.execute(stmt)).scalars():
            if (item.type_code, item.label) in pairs:
                found[item.type_code, item.label] = item
    return found


async def _validate(db: AsyncSession, rows: list[ImportRow], mode: str, _ctx: ImportContext) -> None:
    types = {
        code: await dict_type_dao.get_by_code(db, code)
        for code in {row.values['type_code'] for row in rows if row.values.get('type_code')}
    }
    existing = await _existing(db, rows)
    for row in rows:
        values = row.values
        type_code, label = values.get('type_code'), values.get('label')
        if not type_code or not label:
            continue
        dict_type = types[type_code]
        if dict_type is None:
            row.errors.append(t('error.import.dict_type_not_found', code=type_code))
            continue
        current = existing.get((type_code, label))
        if current is not None and mode == 'create':
            row.errors.append(t('error.import.key_exists', key=f'{type_code} / {label}'))
            continue
        if current is None and mode == 'update':
            row.errors.append(t('error.import.key_not_found', key=f'{type_code} / {label}'))
            continue
        if current is None and values.get('value') is None:
            row.errors.append(required_error(DICT_DATA_IMPORT, 'value'))
            continue
        fields = {**_fields(values, current), 'type_id': dict_type.id}
        try:
            param = (CreateDictDataParam if current is None else UpdateDictDataParam)(**fields)
        except ValidationError as e:
            row.errors.extend(pydantic_errors(DICT_DATA_IMPORT, e))
            continue
        row.action = 'create' if current is None else 'update'
        row.target_id = current.id if current is not None else None
        row.payload = param.model_dump(mode='json')


async def _commit(db: AsyncSession, rows: list[ImportRow], ctx: ImportContext) -> CommitOutcome:
    """一行一个保存点（理由同部门导入）。校验走 service 那一份（`check_create` / `check_update`），

    写库直接调 DAO、**不调 `dict_data_service.create`**：那个方法挂着 `@cache_invalidate`，函数一返回就清缓存 ——
    一千行就是一千次按前缀扫 Redis，而且事务还没提交，清完之后别人的读会把旧值重新缓存回去。
    这里整批写完、**提交之后**清一次（`background_tasks` 在响应发出之后才跑，那时 `import_service.commit` 已经提交了）
    """
    created: list[str] = []
    updated: list[str] = []
    failed: dict[int, str] = {}
    for row in rows:
        key = f'{row.values["type_code"]} / {row.values["label"]}'
        try:
            async with db.begin_nested():
                if row.action == 'create':
                    obj = CreateDictDataParam(**row.payload)
                    dict_type = await dict_data_service.check_create(db=db, obj=obj)
                    await dict_data_dao.create(db, obj, dict_type.code)
                    created.append(key)
                else:
                    obj = UpdateDictDataParam(**row.payload)
                    dict_type = await dict_data_service.check_update(db=db, pk=row.target_id, obj=obj)
                    await dict_data_dao.update(db, row.target_id, obj, dict_type.code)
                    updated.append(key)
        except errors.BaseExceptionError as e:
            failed[row.row_no] = e.msg
        except (SQLAlchemyError, ValidationError):
            log.exception(f'导入字典数据 {key} 失败')
            failed[row.row_no] = t('error.import.row_unexpected')
    if created or updated:
        ctx.after_commit(invalidate_cache, settings.CACHE_DICT_REDIS_PREFIX, prefix=True)
    return CommitOutcome(created=created, updated=updated, failed=failed)


DICT_DATA_IMPORT = register_import(
    ImportSpec(
        resource='dict.data',
        label='export.resource.dict_data',
        # 列名和导出同一套：导出的字典数据改完能原样导回来
        columns=(
            ImportColumn(
                'type_code',
                'export.column.dict_type_code',
                required=True,
                note='import.note.dict_type_code',
                options=_type_codes,
                width=22,
            ),
            ImportColumn('label', 'export.column.dict_label', required=True, note='import.note.dict_label'),
            # 不是整列必填：更新时空白表示不改，新建时才必填（`_validate` 查）
            ImportColumn('value', 'export.column.dict_value', note='import.note.dict_value'),
            ImportColumn('sort', 'export.column.sort', kind='int', width=8),
            ImportColumn(
                'status',
                'export.column.status',
                choices={0: 'export.value.disabled', 1: 'export.value.enabled'},
                choice_aliases=ENABLE_STATUS_ALIASES,
                width=8,
            ),
            ImportColumn('color', 'export.column.color', width=10),
            ImportColumn('remark', 'export.column.remark', width=30),
        ),
        key_of=_key,
        validate=_validate,
        commit=_commit,
        modes=('create', 'upsert', 'update'),
        notes=('import.note.update_keeps_blank',),
    )
)
