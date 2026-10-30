"""收件箱行的「来源」（`sys_notification.source`，#186）：`<类型>:<ID>`，比如 `notice:123`。

通知插件不认识公告（依赖方向是 notice → notification），所以「这条来源现在有几个附件」由来源方登记一个查询函数，
列表接口按类型分批调。和 `kinds.py` 一样是进程内注册表，来源插件的模块被 import 时登记。

受众（#190，`sys_notification_audience`）也按同一个来源字符串挂：来源方在 SQL 里关联它要用 `source_expr`。

「这一行必须读者打开确认」（公告的 `require_ack`）也由来源方登记（`register_explicit_ack`）：
收件箱的「全部已读」要跳过这些行，列表那一行要告诉前端别摆「标为已读」。
"""

from collections.abc import Awaitable, Callable, Sequence
from typing import TYPE_CHECKING

from sqlalchemy import ColumnElement, String, and_, cast, literal, or_
from sqlalchemy.ext.asyncio import AsyncSession

if TYPE_CHECKING:
    from backend.plugin.notification.audience import Viewer

#: (db, 一批来源 ID, 看的人) → {来源 ID: 附件个数}；没附件的、这个人看不见的可以不出现在结果里
AttachmentCounter = Callable[[AsyncSession, Sequence[int], 'Viewer'], Awaitable[dict[int, int]]]

_ATTACHMENT_COUNTERS: dict[str, AttachmentCounter] = {}

#: () → 一个关于 `sys_notification` 那一行的 SQL 条件：为真 = 这一行只能由读者打开之后显式确认
ExplicitAckClause = Callable[[], ColumnElement[bool]]

_EXPLICIT_ACK: dict[str, ExplicitAckClause] = {}


def make_source(source_type: str, pk: int) -> str:
    return f'{source_type}:{pk}'


def source_expr(source_type: str, pk: ColumnElement[int]) -> ColumnElement[str]:
    """SQL 里的 `make_source`：`'notice:' || CAST(id AS VARCHAR(32))`

    拼接运算符三个方言各不相同（PostgreSQL `||`、SQL Server `+`、MySQL `concat()`），交给 SQLAlchemy 按方言渲染。
    放在比较的**外层那一侧**（`audience.source == source_expr(...)`）时，受众表 / 收件箱表上 `source` 的索引照样用得上
    """
    return literal(f'{source_type}:', String) + cast(pk, String(32))


def parse_source(source: str | None) -> tuple[str, int] | None:
    """`notice:123` → `('notice', 123)`；格式不对返回 None（来源是自由字符串，不信任它）"""
    if not source or ':' not in source:
        return None
    source_type, _, raw = source.partition(':')
    if not raw.isdigit():
        return None
    return source_type, int(raw)


def register_source_attachments(source_type: str, counter: AttachmentCounter) -> None:
    """登记一类来源的附件计数。同一类型重复登记以最后一次为准（插件模块被重新 import 时不炸）"""
    _ATTACHMENT_COUNTERS[source_type] = counter


async def count_source_attachments(db: AsyncSession, sources: Sequence[str | None], viewer: 'Viewer') -> dict[str, int]:
    """一批来源 → {来源: 附件个数}。没登记计数的类型不出现在结果里（前端就不显示回形针）"""
    by_type: dict[str, set[int]] = {}
    for source in sources:
        parsed = parse_source(source)
        if parsed and parsed[0] in _ATTACHMENT_COUNTERS:
            by_type.setdefault(parsed[0], set()).add(parsed[1])
    out: dict[str, int] = {}
    for source_type, pks in by_type.items():
        counts = await _ATTACHMENT_COUNTERS[source_type](db, sorted(pks), viewer)
        for pk in pks:
            out[make_source(source_type, pk)] = counts.get(pk, 0)
    return out


def register_explicit_ack(source_type: str, clause_factory: ExplicitAckClause) -> None:
    """登记一类来源的「必须显式确认」条件。同一类型重复登记以最后一次为准

    条件写在 `Notification` 上（来源方自己关联回业务表，比如 `Notification.source IN (必须确认的公告)`），
    用的时候才调工厂：条件里有「现在」的值时（比如过期时间）每次查询都是新的。

    ⚠️ 对 `source` **非空**的行，条件必须算出真 / 假，不能是 NULL（比如 `IN` 的子查询里别选出 NULL）：
    「全部已读」用的是它的**取反**，NULL 取反还是 NULL，那一行就静默地标不上了。
    `source` 为空的行由 `explicit_ack_clause` 兜住
    """
    _EXPLICIT_ACK[source_type] = clause_factory


def explicit_ack_clause() -> ColumnElement[bool] | None:
    """收件箱里「必须读者打开确认」的那些行（各来源登记的条件取或）。没有来源登记过返回 None（= 没有这种行）

    🔴 「全部已读」和列表上的「标为已读」都**不能**替人确认：后端对这种来源只认显式已读
    （`unread_clause(explicit_only=…)`），批量标掉一次，读者就再也不会被要求点「我已阅读」了，阅读统计里他也成了「已读」。
    返回 None 而不是 `false()`：调用方取反之后不想在每个方言上都渲染一条恒真式。

    🔴 **前面那句 `source IS NOT NULL` 不能省**：没有来源的行（点名发的系统消息、每日问候）在 `source IN (…)` 上算出来是
    NULL 不是假，取反还是 NULL —— 只要库里有一条必须确认的公告，「全部已读」就静默地跳过所有系统消息。
    （`test_read_all_does_not_acknowledge_for_the_reader` 里那条点名消息守着；第一版就是这么写的，PostgreSQL 上当场红）
    """
    if not _EXPLICIT_ACK:
        return None
    from backend.plugin.notification.model import Notification

    return and_(Notification.source.is_not(None), or_(*(factory() for factory in _EXPLICIT_ACK.values())))
