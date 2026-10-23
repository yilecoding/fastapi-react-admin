"""流式写 xlsx / csv：一行一行写进临时文件，内存不随行数涨。

xlsx 用 openpyxl 的 write_only 模式 —— 项目解析导入用的也是它，不为「写」再引一个库。
实测（10 列、7 个文本格）：5 万行 3.6 秒，XlsxWriter 的 constant_memory 模式 1.4 秒；
单次上限是 `EXPORT_MAX_ROWS`（默认 20 万行），差的是十几秒，而且大批量本来就在后台任务里跑，
不构成多一个依赖的理由。内存两者都恒定（10 万行 Python 侧峰值 0.4 MiB）。

🔴 **交给 `append()` 的必须是 `cells.py` 归一过的 `Cell`。** write_only 模式下任何一次
append 抛异常，整张表就废了（见 `cells.py` 的说明），这里不做第二道兜底。
"""

import csv
import dataclasses
import datetime as dt
import re

from collections.abc import Sequence
from pathlib import Path
from typing import Literal, Protocol

from openpyxl import Workbook
from openpyxl.cell import WriteOnlyCell
from openpyxl.styles import Alignment, Font
from openpyxl.utils import get_column_letter

from backend.common.dataio.cells import (
    DATETIME_NUMBER_FORMAT,
    DATE_NUMBER_FORMAT,
    Cell,
    CellKind,
    as_csv,
    clean_text,
    csv_text,
)

ExportFormat = Literal['xlsx', 'csv']

MEDIA_TYPES: dict[str, str] = {
    'xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'csv': 'text/csv; charset=utf-8',
}

#: Excel 工作表名的规则：最长 31 个字符，不能含 `\ / ? * [ ] :`
_SHEET_TITLE_MAX = 31
_SHEET_TITLE_ILLEGAL = re.compile(r'[\\/?*\[\]:]')


def safe_sheet_title(title: str) -> str:
    """工作表名收口（Microsoft「重命名工作表」的规则）：≤31 字符、不含 `\\ / ? * : [ ]`、
    不以单引号开头结尾、不能为空、不能叫 `History`（Excel 保留名）。

    openpyxl 对非法名直接抛 ValueError，而工作表名来自翻译文案和资源名，在这里一次挡掉
    """
    cleaned = _SHEET_TITLE_ILLEGAL.sub('_', clean_text(title)).strip("' ")[:_SHEET_TITLE_MAX].strip("' ")
    if not cleaned or cleaned.casefold() == 'history':
        cleaned = f'{cleaned}_' if cleaned else 'Sheet'
    return cleaned


@dataclasses.dataclass(frozen=True, slots=True)
class SheetColumn:
    """表头一列"""

    title: str
    #: Excel 的列宽单位（约等于一个半角字符宽）
    width: int = 16


class SheetWriter(Protocol):
    def append(self, cells: Sequence[Cell]) -> None: ...

    def close(self) -> None: ...


class XlsxSheetWriter:
    """数据表 + 一张「导出信息」表（谁、什么时候、按什么条件导的）。

    「导出信息」放第二张表而不是数据表顶上几行：数据表只有「表头 + 数据」，
    拿去再导入、做透视都不用先删几行（同 `excel_ops.build_template` 把说明放第二张表的理由）。
    """

    def __init__(
        self,
        path: Path,
        *,
        sheet_title: str,
        columns: Sequence[SheetColumn],
        expected_rows: int,
        info_title: str,
        info: Sequence[tuple[str, str]] = (),
        creator: str | None = None,
        doc_title: str | None = None,
    ) -> None:
        self._path = path
        self._info_title = info_title
        self._info = info
        self._wb = Workbook(write_only=True)
        self._ws = self._wb.create_sheet(safe_sheet_title(sheet_title))

        # 列宽 / 冻结首行 / 自动筛选都得在第一次 append 之前设好 —— write_only 模式写出去就改不了
        for index, column in enumerate(columns, start=1):
            self._ws.column_dimensions[get_column_letter(index)].width = column.width
        self._ws.freeze_panes = 'A2'
        if columns:
            last = get_column_letter(len(columns))
            self._ws.auto_filter.ref = f'A1:{last}{max(expected_rows, 1) + 1}'

        bold = Font(bold=True)
        header = []
        for column in columns:
            cell = self._text(column.title, quote=False)
            cell.font = bold
            header.append(cell)
        self._ws.append(header)

        props = self._wb.properties
        if creator:
            props.creator = clean_text(creator)
            props.lastModifiedBy = clean_text(creator)
        if doc_title:
            props.title = clean_text(doc_title)
        # 文档属性里的时间是 UTC（OOXML 的 W3CDTF），openpyxl 收无时区的 datetime
        props.created = dt.datetime.now(dt.UTC).replace(tzinfo=None, microsecond=0)
        props.modified = props.created

    def _text(self, value: str, *, quote: bool = True) -> WriteOnlyCell:
        """文本格：显式标成字符串，再挂 `quotePrefix`。

        🔴 不能靠 openpyxl 自己判类型 —— `=` 开头的字符串它会写成公式（实测普通 / write_only 都是）。
        `data_type = 's'` 让它写成 inlineStr，文件里就没有 `<f>` 元素，打开时不会求值。

        `quotePrefix` 是 ASVS 1.2.10「单引号转义」在 xlsx 里的原生写法（ECMA-376：文本前带一个单引号，
        引号本身不存进值）。**所有**数据文本格都挂，而不是只挂「看起来像公式的」：那样就要维护一张
        触发字符表，而那张表本身就是绕过的来源（见 `cells.FORMULA_TRIGGERS`）。
        ⚠️「挂了之后在 Excel 里改这一格也不会变成公式」没在真 Excel 上验过（本仓库的环境里没有 Excel）
        """
        cell = WriteOnlyCell(self._ws, value=value)
        cell.data_type = 's'
        if quote:
            cell.quotePrefix = True
        return cell

    def _to_xlsx(self, cell: Cell) -> object:
        if cell.value is None:
            return None
        match cell.kind:
            case CellKind.TEXT:
                return self._text(str(cell.value))
            case CellKind.DATETIME:
                out = WriteOnlyCell(self._ws, value=cell.value)
                out.number_format = DATETIME_NUMBER_FORMAT
                return out
            case CellKind.DATE:
                out = WriteOnlyCell(self._ws, value=cell.value)
                out.number_format = DATE_NUMBER_FORMAT
                return out
            case _:
                return cell.value

    def append(self, cells: Sequence[Cell]) -> None:
        self._ws.append([self._to_xlsx(cell) for cell in cells])

    def close(self) -> None:
        if self._info:
            info = self._wb.create_sheet(safe_sheet_title(self._info_title))
            info.column_dimensions['A'].width = 18
            info.column_dimensions['B'].width = 80
            wrap = Alignment(wrap_text=True, vertical='top')
            for label, value in self._info:
                key_cell = self._text_in(info, label)
                key_cell.font = Font(bold=True)
                value_cell = self._text_in(info, value)
                value_cell.alignment = wrap
                info.append([key_cell, value_cell])
        self._wb.save(self._path)

    @staticmethod
    def _text_in(ws: object, value: str) -> WriteOnlyCell:
        # 信息页里的筛选值是用户填的，同样要挡（同 `_text`）
        cell = WriteOnlyCell(ws, value=clean_text(value))
        cell.data_type = 's'
        cell.quotePrefix = True
        return cell


class CsvSheetWriter:
    """RFC 4180：逗号分隔、CRLF 换行、需要时加双引号。

    带 UTF-8 BOM：没有它，Excel 双击打开 CSV 会按系统代码页（中文 Windows 是 GBK）解码，中文全是乱码。
    CSV 没有「第二张表」，导出信息只在 xlsx 里有。
    """

    def __init__(self, path: Path, *, columns: Sequence[SheetColumn]) -> None:
        self._file = path.open('w', encoding='utf-8-sig', newline='')
        self._writer = csv.writer(self._file, lineterminator='\r\n')
        self._writer.writerow([csv_text(clean_text(column.title)) for column in columns])

    def append(self, cells: Sequence[Cell]) -> None:
        self._writer.writerow([as_csv(cell) for cell in cells])

    def close(self) -> None:
        self._file.close()
