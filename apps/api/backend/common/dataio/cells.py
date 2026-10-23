"""单元格安全层：把一个 Python 值变成「写进 Excel / CSV 不会出事」的值。

导出的每一格都过这里。各资源的导出定义只声明列的**类型**（`ExportColumn.kind`），
不自己处理下面这些坑 —— 每一条都在 openpyxl 3.1.5 上实测过（脚本和结论见 `AGENTS.md`）：

- 🔴 openpyxl 把 `=` 开头的字符串**写成公式**（普通模式、write_only 模式都是）——
  登录日志里，没登录的人在登录框填的「用户名」会在管理员的 Excel 里执行（公式注入，OWASP）
- 🔴 19 位雪花 ID 当数字写，文件里存的就是 `2.049629108245234e+18`：
  精度在**写文件那一刻**就丢了，不只是显示问题（同硬纪律 6）
- 🔴 XML 1.0 不允许的控制字符：openpyxl 抛 `IllegalCharacterError`，
  write_only 模式下那一行写了一半，**整个文件打不开**
- 🔴 带时区的 datetime：openpyxl 直接 `TypeError`（Excel 没有时区），之后这张表再 append 全是 `StopIteration`
- 一格超过 32,767 个字符：Excel 的硬上限，操作日志的响应体轻松超过

🔴 **write_only 模式下任何一次 append 抛异常，整张表就废了**：后面的 append 全是
`StopIteration`，已经写出去的是半截 XML。所以这一层的目标是「交给 writer 的值
**永远不会**让 openpyxl 抛异常」，不是「抛了再接住」。
"""

import dataclasses
import datetime as dt
import math

from decimal import Decimal
from typing import Any
from zoneinfo import ZoneInfo

from openpyxl.cell.cell import ILLEGAL_CHARACTERS_RE

from backend.common.enums import StrEnum

#: Excel 一格最多放这么多字符（Microsoft「Excel 规范与限制」）
CELL_TEXT_MAX = 32_767

#: IEEE double 能精确表示的最大整数。Excel 所有数值都是 double，超过就只能当文本写（同硬纪律 6）
NUMBER_SAFE_MAX = 2**53 - 1

#: 以这些字符开头的单元格会被表格软件当成公式求值。OWASP「CSV Injection」现行版列的是 8 类：
#: `= + - @`、Tab、CR、LF，以及全角的 `＝ ＋ － ＠`（ASVS 5.0 第 1.2.10 条另列了 `\0`）
FORMULA_TRIGGERS = frozenset('=+-@\t\r\n\0＝＋－＠')

#: 判断之前先跳过的前导字符。🔴 只看第一个字节是能绕过的：EspoCRM CVE-2026-55154 就是
#: 在 `=` 前面垫空白 / 控制字符，CSV 和 XLSX 一起中招
_LEADING_SKIP = frozenset(' \u00a0\u3000\x0b\x0c')


#: 写 xlsx 时间格时用的显示格式，和前端 `formatDateTime` 同一个固定格式（不跟 locale 走）
DATETIME_NUMBER_FORMAT = 'yyyy-mm-dd hh:mm:ss'
DATE_NUMBER_FORMAT = 'yyyy-mm-dd'
DATETIME_TEXT_FORMAT = '%Y-%m-%d %H:%M:%S'
DATE_TEXT_FORMAT = '%Y-%m-%d'


class CellKind(StrEnum):
    """单元格写成什么类型。xlsx 按它决定单元格类型，csv 按它决定怎么转字符串"""

    TEXT = 'text'
    NUMBER = 'number'
    DATETIME = 'datetime'
    DATE = 'date'


@dataclasses.dataclass(frozen=True, slots=True)
class Cell:
    """一格。`value` 已经过归一：文本是干净的 str、时间是**无时区**的本地时间"""

    kind: CellKind
    value: str | int | float | Decimal | dt.datetime | dt.date | None


EMPTY = Cell(CellKind.TEXT, None)


def looks_like_formula(text: str | None) -> bool:
    """这段文本放进单元格会不会被当成公式（跳过前导空白和控制字符之后看第一个字符）"""
    if not text:
        return False
    for char in text:
        if char in FORMULA_TRIGGERS:
            return True
        if char in _LEADING_SKIP or ord(char) < 0x20:
            continue
        return False
    return False


def csv_text(text: str) -> str:
    """CSV 里的文本格：看起来像公式的，整格前面补一个单引号（OWASP / ASVS 1.2.10 的做法）。

    ⚠️ 只对 CSV 改值。xlsx 不改值，靠单元格类型 + `quotePrefix` 挡（见 `writers.py`）——
    CSV 没有「这一格是文本」的声明手段，只能改值；改了之后原样导回来会多一个引号，这是 CSV 的代价
    """
    return f"'{text}" if looks_like_formula(text) else text


def clean_text(value: str, *, truncated_mark: str = '…') -> str:
    """去掉 XML 不允许的控制字符、截到单元格上限。

    控制字符换成 `\\ufffd` 而不是删掉：这类字符多半出现在日志的请求体里，
    悄悄删掉会让导出的内容和库里对不上，换成一个看得见的替换符至少能看出「这里原来有东西」。
    制表符、换行、回车是合法的，留着（`ILLEGAL_CHARACTERS_RE` 不含它们）。

    :param value: 原文
    :param truncated_mark: 超长时接在末尾的说明（调用方给翻译好的）
    :return:
    """
    text = ILLEGAL_CHARACTERS_RE.sub('�', value)
    if len(text) > CELL_TEXT_MAX:
        keep = max(CELL_TEXT_MAX - len(truncated_mark), 0)
        text = text[:keep] + truncated_mark
    return text


def text_cell(value: Any, *, truncated_mark: str = '…') -> Cell:
    if value is None:
        return EMPTY
    if isinstance(value, bytes):
        value = value.decode('utf-8', errors='replace')
    return Cell(CellKind.TEXT, clean_text(str(value), truncated_mark=truncated_mark))


def id_cell(value: Any) -> Cell:
    """雪花 ID：一律文本。int 和 str 都收（接口层下发的已经是 str）"""
    if value is None or (isinstance(value, str) and not value):
        return EMPTY
    return Cell(CellKind.TEXT, str(int(value)))


def int_cell(value: Any) -> Cell:
    if value is None:
        return EMPTY
    number = int(value)
    if abs(number) > NUMBER_SAFE_MAX:
        return Cell(CellKind.TEXT, str(number))
    return Cell(CellKind.NUMBER, number)


def number_cell(value: Any) -> Cell:
    if value is None:
        return EMPTY
    if isinstance(value, bool):
        return Cell(CellKind.NUMBER, int(value))
    if isinstance(value, float) and not math.isfinite(value):
        # NaN / inf 写进 xlsx 是非法值，Excel 打开时报文件损坏
        return Cell(CellKind.TEXT, str(value))
    if isinstance(value, int) and abs(value) > NUMBER_SAFE_MAX:
        return Cell(CellKind.TEXT, str(value))
    if isinstance(value, (int, float, Decimal)):
        return Cell(CellKind.NUMBER, value)
    return Cell(CellKind.NUMBER, float(value))


def datetime_cell(value: Any, tz: ZoneInfo | dt.tzinfo) -> Cell:
    """换算到**看表的人**的时区，再去掉时区信息（Excel 只认无时区的时间）。

    🔴 先换算再去时区，顺序不能反：直接 `replace(tzinfo=None)` 得到的是服务端时区的钟面时间，
    显示时区不同的人看到的整体偏几个小时，不报错。
    库里读出来的时间都带时区（`TimeZone` 类型保证）；万一拿到无时区的，按服务端时区解释。
    """
    if value is None:
        return EMPTY
    if isinstance(value, str):
        value = dt.datetime.fromisoformat(value)
    if value.tzinfo is None:
        from backend.utils.timezone import timezone

        value = value.replace(tzinfo=timezone.tz_info)
    # 秒以下截掉：界面上显示到秒，导出的值和界面对不上会被当成数据有问题
    local = value.astimezone(tz).replace(tzinfo=None, microsecond=0)
    return Cell(CellKind.DATETIME, local)


def date_cell(value: Any) -> Cell:
    if value is None:
        return EMPTY
    if isinstance(value, dt.datetime):
        value = value.date()
    if isinstance(value, str):
        value = dt.date.fromisoformat(value)
    return Cell(CellKind.DATE, value)


def as_csv(cell: Cell) -> str:
    """一格在 CSV 里的样子"""
    if cell.value is None:
        return ''
    match cell.kind:
        case CellKind.TEXT:
            return csv_text(str(cell.value))
        case CellKind.DATETIME:
            return cell.value.strftime(DATETIME_TEXT_FORMAT)  # type: ignore[union-attr]
        case CellKind.DATE:
            return cell.value.strftime(DATE_TEXT_FORMAT)  # type: ignore[union-attr]
        case _:
            return str(cell.value)
