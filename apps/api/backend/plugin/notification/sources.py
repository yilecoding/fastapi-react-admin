"""收件箱行的「来源」（`sys_notification.source`，#186）：`<类型>:<ID>`，比如 `notice:123`。

通知插件不认识公告（依赖方向是 notice → notification），所以「这条来源现在有几个附件」由来源方登记一个查询函数，
列表接口按类型分批调。和 `kinds.py` 一样是进程内注册表，来源插件的模块被 import 时登记。
"""

from collections.abc import Awaitable, Callable, Sequence

from sqlalchemy.ext.asyncio import AsyncSession

#: (db, 一批来源 ID) → {来源 ID: 附件个数}；没附件的可以不出现在结果里
AttachmentCounter = Callable[[AsyncSession, Sequence[int]], Awaitable[dict[int, int]]]

_ATTACHMENT_COUNTERS: dict[str, AttachmentCounter] = {}


def make_source(source_type: str, pk: int) -> str:
    return f'{source_type}:{pk}'


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


async def count_source_attachments(db: AsyncSession, sources: Sequence[str | None]) -> dict[str, int]:
    """一批来源 → {来源: 附件个数}。没登记计数的类型不出现在结果里（前端就不显示回形针）"""
    by_type: dict[str, set[int]] = {}
    for source in sources:
        parsed = parse_source(source)
        if parsed and parsed[0] in _ATTACHMENT_COUNTERS:
            by_type.setdefault(parsed[0], set()).add(parsed[1])
    out: dict[str, int] = {}
    for source_type, pks in by_type.items():
        counts = await _ATTACHMENT_COUNTERS[source_type](db, sorted(pks))
        for pk in pks:
            out[make_source(source_type, pk)] = counts.get(pk, 0)
    return out
