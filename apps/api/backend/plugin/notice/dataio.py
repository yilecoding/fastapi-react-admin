"""通知公告的导出定义（#11 · v0.4）。取数调列表接口那条 `notice_dao.get_select`"""

import re

from typing import Any

from pydantic import ConfigDict, Field
from sqlalchemy import Select

from backend.common.dataio.exporting import ExportColumn, ExportSpec, register_export
from backend.common.schema import SchemaBase
from backend.plugin.notice.crud.crud_notice import notice_dao
from backend.plugin.notice.model import Notice
from backend.utils.serializers import select_columns_serialize

_TAGS = re.compile(r'<[^>]+>')
_BLANKS = re.compile(r'\s+')


class NoticeExportFilters(SchemaBase):
    # 🔴 不认识的参数报错，不忽略（理由见 `app/admin/dataio.py: _Filters`）
    model_config = ConfigDict(extra='forbid')

    title: str | None = Field(None, description='标题')
    type: int | None = Field(None, description='类型')
    status: int | None = Field(None, description='状态')


async def _select(f: NoticeExportFilters, _user: Any) -> Select:
    return await notice_dao.get_select(title=f.title, type=f.type, status=f.status)


async def _shape(_db: Any, rows: Any) -> list[dict[str, Any]]:  # ruff: ignore[unused-async]
    return [select_columns_serialize(row[0]) for row in rows]


def _plain_text(row: dict[str, Any]) -> str | None:
    """正文是富文本 HTML，导出成纯文本：表格里看 `<p>` 标签没有意义，图片也带不进单元格"""
    content = row.get('content')
    if not content:
        return None
    return _BLANKS.sub(' ', _TAGS.sub(' ', content)).strip() or None


NOTICE_EXPORT = register_export(
    ExportSpec(
        resource='sys.notice',
        label='export.resource.notice',
        perm='sys:notice:export',
        columns=(
            ExportColumn('title', 'export.column.notice_title', width=30),
            ExportColumn(
                'type',
                'export.column.notice_type',
                kind='enum',
                choices={0: 'export.value.notice', 1: 'export.value.announcement'},
                width=8,
            ),
            ExportColumn(
                'status',
                'export.column.status',
                kind='enum',
                choices={0: 'export.value.hidden', 1: 'export.value.shown'},
                width=8,
            ),
            ExportColumn('content', 'export.column.content_text', get=_plain_text, width=60),
            ExportColumn('created_time', 'export.column.created_time', kind='datetime', width=20),
            ExportColumn('updated_time', 'export.column.updated_time', kind='datetime', width=20),
            ExportColumn('id', 'export.column.notice_id', kind='id', width=22),
        ),
        filters=NoticeExportFilters,
        filter_labels={
            'title': 'export.column.notice_title',
            'type': 'export.column.notice_type',
            'status': 'export.column.status',
        },
        select=_select,
        id_column=Notice.id,
        shape=_shape,
    )
)
