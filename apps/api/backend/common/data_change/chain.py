"""数据变更记录的防篡改链（#260）：每一行按顺序编号，签名里带着上一行的签名，校验时从头重算。

```
签名(n) = HMAC(DATA_CHANGE_CHAIN_KEY, 签名(n-1) + 这一行的内容)
```

**发现得了**：改过某一行的内容 · 中间删掉了几行 · 绕过应用往表里塞的行（没有序号）· 最新的几行被删（对不上链头）。
🔴 **每一行都必须有序号**：上线这条链的迁移（`an000000datachangechain`）把已有的记录按时间补签进了链，
所以没有序号的行一律是问题 —— 不设「上线之前的旧行」这一类。按时间分「旧行 / 伪造的行」的话，
伪造的人把时间写早一点就混进了旧行（第一版就是这么判的，测试里一次误报了 977 条）。
**发现不了**：同时改得了库**和**拿得到密钥的人（他能重算整条链）；能同时删掉最老 / 最新的几行**并**改链头那一行的人。
没配 `DATA_CHANGE_CHAIN_KEY` 时签名谁都算得出来，只防「手滑直接改库」—— 校验结果里会说清楚。

🔴 **序号在写入的那个事务里拿，靠一把行锁排队。** 链头存在 `sys_data_change_chain` 的一行里：
先 `UPDATE … SET head_seq = head_seq + n` 占住这一行，再读链头、算签名、写记录、回写链头。

- 不用 `SELECT … FOR UPDATE`：SQL Server 方言**静默丢掉** `FOR UPDATE`（实测编译出来就是一条裸 SELECT），
  两个并发请求会拿到同一个序号。UPDATE 在三个方言上都会拿行锁、持有到提交
- UPDATE 必须真的改值（`+ n`，不是 `SET x = x`）：MySQL 的一致性读只认「这个事务自己改过的行」，
  没改值的话后面那次 SELECT 读到的可能是事务开头的旧快照
- 锁是这个事务**最后**拿的（业务写完、审计行算好之后），拿到之后只写这两张表 —— 不会和业务行锁成环

链头那一行：升级上来的库由迁移建，新库（`fba init` / 测试库）在种子里。还是不存在时（自增主键模式没有种子、被人删了）
在保存点里建：两个请求同时第一次写，后到的撞主键、回滚保存点、再占锁一次。保存点提交也会走 `before_commit`，
拦截层那边 `in_nested_transaction()` 跳过。
⚠️ MySQL 上两个首写可能死锁（评审推断，没实测）—— 种子里放这一行就是为了碰不到它。

保留期删旧记录（`maintenance.prune_logs`）先把**锚点**（`anchor_seq` / `anchor_hash`）推到
「第一条还要留的」前一行，再删；校验从锚点往后算。中途失败的话锚点之前还没删的那几行只是不再校验，不会被报成「中间被删」。
"""

from __future__ import annotations

import hashlib
import hmac
import json

from dataclasses import asdict, dataclass, field
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any

import sqlalchemy as sa

from sqlalchemy.exc import IntegrityError

if TYPE_CHECKING:
    from collections.abc import Iterable, Mapping

    from sqlalchemy.orm import Session

CHAIN_ID = 1
#: 签进去的列。`chain_hash` 自己不在里面（它就是签名）。
#: 🔴 `id` 也不在：自增主键模式（`DATABASE_PK_MODE=autoincrement`）下 INSERT 之前拿不到它，自己填的话 SQL Server
#: 报「不能给 IDENTITY 列显式插值」，所有被审计的提交一起失败（评审抓到的）。记录靠 `chain_seq` 认，不靠 `id`
SIGNED = (
    'chain_seq',
    'trace_id',
    'entity_type',
    'entity_id',
    'entity_label',
    'action',
    'changes',
    'fields',
    'actor_id',
    'actor_name',
    'source',
    'source_ref',
    'ip',
    'created_time',
)
_BATCH = 1000
#: 校验结果里最多列多少条问题（数量另算）
MAX_PROBLEMS = 50
#: 没配密钥时签名里的密钥标识
NO_KEY = '0' * 8


def _tables() -> tuple[sa.Table, sa.Table]:
    from backend.common.model import MappedBase

    tables = MappedBase.metadata.tables
    return tables['sys_data_change'], tables['sys_data_change_chain']


def current_key() -> tuple[bytes, str]:
    """(密钥, 它的标识)。标识写进每一行的签名里：换过密钥的话，校验认得出「这几行是别的密钥签的」"""
    from backend.core.conf import settings

    raw = (settings.DATA_CHANGE_CHAIN_KEY or '').encode()
    if not raw:
        return b'', NO_KEY
    return raw, hashlib.sha256(b'fba-data-change-chain:' + raw).hexdigest()[:8]


def _canonical_value(name: str, value: Any) -> Any:
    if value is None:
        return None
    if name == 'created_time':
        # 三个方言读回来的时区各不一样（PostgreSQL 按会话时区、SQL Server 带写入时的偏移、MySQL 由 TimeZone 补）：
        # 一律换成 UTC 再写到微秒
        if value.tzinfo is None:
            from backend.utils.timezone import timezone

            value = value.replace(tzinfo=timezone.tz_info)
        return value.astimezone(UTC).strftime('%Y-%m-%dT%H:%M:%S.%fZ')
    if isinstance(value, int) and not isinstance(value, bool):
        # ID 都是雪花：按字符串签，不经过任何浮点
        return str(value)
    return value


def canonical(row: Mapping[str, Any]) -> str:
    """一行的规范文本。JSON 键排序、不转义中文 —— 写进去时算一次、读回来再算一次，两次必须逐字节相同"""
    return json.dumps(
        {name: _canonical_value(name, row.get(name)) for name in SIGNED},
        sort_keys=True,
        ensure_ascii=False,
        separators=(',', ':'),
    )


def sign(prev: str, row: Mapping[str, Any], key: bytes, kid: str) -> str:
    digest = hmac.new(key, f'{prev}\n{canonical(row)}'.encode(), hashlib.sha256).hexdigest()
    return f'{kid}:{digest}'


# ── 写 ──────────────────────────────────────────────────────────────────────


def _lock_head(session: Session, chain: sa.Table, n: int) -> bool:
    res = session.execute(
        sa.update(chain).where(chain.c.id == CHAIN_ID).values(head_seq=chain.c.head_seq + n),
    )
    return bool(res.rowcount)


def _create_head(session: Session, records: sa.Table, chain: sa.Table) -> None:
    """链头那一行不在：从表里已有的最后一个序号接着往下（链头那一行被删掉的话，校验会在开头报出来）"""
    last = session.execute(
        sa
        .select(records.c.chain_seq, records.c.chain_hash)
        .where(records.c.chain_seq.is_not(None))
        .order_by(records.c.chain_seq.desc())
        .limit(1)
    ).first()
    try:
        with session.begin_nested():
            session.execute(
                sa.insert(chain).values(
                    id=CHAIN_ID,
                    head_seq=last.chain_seq if last else 0,
                    head_hash=last.chain_hash if last else '',
                    anchor_seq=0,
                    anchor_hash='',
                )
            )
    except IntegrityError:
        pass  # 另一个事务刚建好


def link(session: Session, rows: list[dict[str, Any]]) -> None:
    """给这一批要写的记录编号、签名（就地改 `rows`），并把链头推到最后一条。调用方随后 INSERT 这些行。

    `created_time` 在这里定：拿到锁之后才取时间，序号和时间大体同序（多实例时钟有偏差时不严格，见 `advance_anchor`）。
    `id` 不在这里定，INSERT 时由列默认值（雪花）或数据库（自增）给
    """
    if not rows:
        return
    from backend.utils.timezone import timezone

    records, chain = _tables()
    n = len(rows)
    if not _lock_head(session, chain, n):
        _create_head(session, records, chain)
        if not _lock_head(session, chain, n):
            raise RuntimeError('数据变更记录的链头那一行建不出来')
    head = session.execute(sa.select(chain.c.head_seq, chain.c.head_hash).where(chain.c.id == CHAIN_ID)).one()
    seq = head.head_seq - n
    prev = head.head_hash or ''
    key, kid = current_key()
    now = timezone.now()
    for row in rows:
        seq += 1
        row['created_time'] = now
        row['chain_seq'] = seq
        prev = row['chain_hash'] = sign(prev, row, key, kid)
    session.execute(sa.update(chain).where(chain.c.id == CHAIN_ID).values(head_hash=prev))


def backfill(conn: sa.Connection, records: sa.Table, chain: sa.Table) -> int:
    """迁移用：把已有的记录按 (created_time, id) 补签进链，并建链头那一行。返回补签了几行。

    签名按**从库里读回来的值**算（和校验时同一条路），`records` 要带真实的列类型（JSON / TimeZone）
    """
    key, kid = current_key()
    ids = [
        row.id
        for row in conn.execute(
            sa.select(records.c.id).where(records.c.chain_seq.is_(None)).order_by(records.c.created_time, records.c.id)
        )
    ]
    seq, prev = 0, ''
    stmt = (
        sa
        .update(records)
        .where(records.c.id == sa.bindparam('_id'))
        .values(chain_seq=sa.bindparam('_seq'), chain_hash=sa.bindparam('_hash'))
    )
    for i in range(0, len(ids), _BATCH):
        chunk = ids[i : i + _BATCH]
        found = {row['id']: row for row in conn.execute(sa.select(records).where(records.c.id.in_(chunk))).mappings()}
        params = []
        for pk in chunk:
            seq += 1
            prev = sign(prev, {**found[pk], 'chain_seq': seq}, key, kid)
            params.append({'_id': pk, '_seq': seq, '_hash': prev})
        conn.execute(stmt, params)
    conn.execute(sa.delete(chain))
    conn.execute(sa.insert(chain).values(id=CHAIN_ID, head_seq=seq, head_hash=prev, anchor_seq=0, anchor_hash=''))
    return seq


def advance_anchor(session: Session, cutoff: datetime) -> int | None:
    """保留期：把锚点推到「第一条还在保留期里的记录」的前一条，返回它（调用方删掉序号不超过它的行）。

    没有要删的返回 None。

    - 🔴 **不按「早于 cutoff 的最大序号」推**：多实例时钟有偏差时序号和时间不严格同序，那样会把还在保留期里、
      只是序号小一点的行一起删掉。按「第一条还要留的」往前推，宁可多留几行，不少留（评审抓到的）
    - 🔴 **链头那一行不在就不推、也不删**：推不了锚点还照删的话，链头重建之后锚点是 0，这段被删的就成了
      永远报着的「缺口」，正常的清理被当成有人删记录（评审抓到的）
    """
    records, chain = _tables()
    head = session.execute(sa.select(chain.c.anchor_seq).where(chain.c.id == CHAIN_ID)).first()
    if head is None:
        return None
    anchor = head.anchor_seq
    seq = records.c.chain_seq
    first_kept = session.execute(
        sa.select(sa.func.min(seq)).where(seq > anchor, records.c.created_time >= cutoff)
    ).scalar()
    upto = session.execute(
        sa.select(sa.func.max(seq)).where(seq > anchor, *([seq < first_kept] if first_kept is not None else []))
    ).scalar()
    if upto is None:
        # 没有新的可删；上一次清理推了锚点、没删完的那几行（中途失败）照样删
        return anchor or None
    anchor_hash = session.execute(sa.select(records.c.chain_hash).where(seq == upto)).scalar_one()
    session.execute(
        sa
        .update(chain)
        .where(chain.c.id == CHAIN_ID, chain.c.anchor_seq < upto)
        .values(anchor_seq=upto, anchor_hash=anchor_hash)
    )
    return upto


def head_summary(session: Session) -> str:
    """链头的一句话（写进清理任务的日志，做库外的旁证）"""
    _, chain = _tables()
    head = session.execute(sa.select(chain).where(chain.c.id == CHAIN_ID)).mappings().first()
    if head is None:
        return '防篡改链还没有记录'
    return f'防篡改链：链头 #{head["head_seq"]} {head["head_hash"]}，锚点 #{head["anchor_seq"]}'


# ── 校验 ────────────────────────────────────────────────────────────────────


@dataclass(slots=True)
class ChainProblem:
    #: modified 内容被改过 · missing 中间少了几行 · tail 最新的几行没了（或链头被改过）·
    #: key 密钥对不上 · stale 最新的记录不是用现在的密钥签的 · unchained 不在链上的行（绕过应用写进来的）·
    #: head 链头那一行不见了
    kind: str
    seq: int | None = None
    record_id: str | None = None
    created_time: str | None = None
    #: missing：少了哪一段（含两端）
    seq_to: int | None = None


@dataclass(slots=True)
class ChainReport:
    ok: bool
    keyed: bool
    checked: int
    head_seq: int
    anchor_seq: int
    #: 换密钥之前签的、当前密钥校验不了的行数
    other_key: int
    problem_count: int
    problems: list[ChainProblem] = field(default_factory=list)

    def as_dict(self) -> dict[str, Any]:
        return asdict(self)


class _Collector:
    def __init__(self) -> None:
        self.items: list[ChainProblem] = []
        #: 没列出来、只计数的（没有序号的行只列前 10 条）
        self.unlisted = 0

    def add(self, problem: ChainProblem) -> None:
        self.items.append(problem)

    @property
    def count(self) -> int:
        return len(self.items) + self.unlisted


def _problem(kind: str, row: Mapping[str, Any] | None = None, **extra: Any) -> ChainProblem:
    if row is None:
        return ChainProblem(kind=kind, **extra)
    created = row.get('created_time')
    return ChainProblem(
        kind=kind,
        seq=row.get('chain_seq'),
        record_id=str(row['id']),
        created_time=created.isoformat() if isinstance(created, datetime) else None,
        **extra,
    )


def _chained_rows(session: Session, records: sa.Table, after: int, upto: int | None) -> Iterable[Mapping[str, Any]]:
    last = after
    seq = records.c.chain_seq
    while True:
        stmt = sa.select(records).where(seq > last).order_by(seq).limit(_BATCH)
        if upto is not None:
            stmt = stmt.where(seq <= upto)
        batch = list(session.execute(stmt).mappings().all())
        yield from batch
        if len(batch) < _BATCH:
            return
        last = batch[-1]['chain_seq']


@dataclass(slots=True)
class _Walk:
    checked: int = 0
    other_key: int = 0
    last_seq: int = 0
    last_hash: str = ''
    last_kid: str | None = None


def _walk(session: Session, records: sa.Table, head: Mapping[str, Any] | None, found: _Collector) -> _Walk:
    """沿着链从锚点往后走（只走到读链头那一刻的链头：校验期间新提交的行留给下一次）：序号连不连得上、签名重算对不对得上"""
    key, kid = current_key()
    # 没配密钥时签的行（配密钥之前的历史）用空密钥核对得了；换掉的旧密钥没有，那几行只能核对序号
    keys = {kid: key, NO_KEY: b''}
    anchor_seq = head['anchor_seq'] if head else 0
    walk = _Walk(last_seq=anchor_seq, last_hash=(head['anchor_hash'] if head else '') or '')
    seen_current_key = False
    for row in _chained_rows(session, records, anchor_seq, head['head_seq'] if head else None):
        walk.checked += 1
        stored = row['chain_hash'] or ''
        row_kid = stored.split(':', 1)[0]
        gap = row['chain_seq'] != walk.last_seq + 1
        if gap:
            found.add(_problem('missing', seq=walk.last_seq + 1, seq_to=row['chain_seq'] - 1))
        if seen_current_key and row_kid != kid:
            # 当前密钥签过的行**之后**又出现别的标识（包括「没配密钥」）：有人改了内容、顺手换了个能自己算的签法
            found.add(_problem('key', row))
        elif row_kid not in keys:
            walk.other_key += 1
        else:
            seen_current_key = seen_current_key or row_kid == kid
            # 前面少了几行时，这一行签名里的「上一行」已经不在了，重算不了；缺口已经报过
            expected = sign(walk.last_hash, row, keys[row_kid], row_kid)
            if not gap and not hmac.compare_digest(expected, stored):
                found.add(_problem('modified', row))
        walk.last_seq, walk.last_hash, walk.last_kid = row['chain_seq'], stored, row_kid
    return walk


def _find_unchained(session: Session, records: sa.Table, found: _Collector) -> None:
    """没有序号的行：绕过应用写进来的（应用写的每一行都在链上，迁移也补签了已有的）"""
    no_seq = records.c.chain_seq.is_(None)
    rows = session.execute(sa.select(records).where(no_seq).order_by(records.c.created_time).limit(10)).mappings()
    listed = 0
    for row in rows:
        found.add(_problem('unchained', row))
        listed += 1
    total = session.execute(sa.select(sa.func.count()).select_from(records).where(no_seq)).scalar_one()
    found.unlisted += max(total - listed, 0)


def verify(session: Session) -> ChainReport:
    """从锚点往后逐行重算签名。只读，不拿锁"""
    records, chain = _tables()
    key, kid = current_key()
    found = _Collector()
    head = session.execute(sa.select(chain).where(chain.c.id == CHAIN_ID)).mappings().first()
    walk = _walk(session, records, head, found)
    if head is None:
        if walk.checked:
            found.add(_problem('head'))
    elif walk.last_seq != head['head_seq'] or walk.last_hash != (head['head_hash'] or ''):
        # 最新的几行被删了，或者链头那一行被改过
        found.add(_problem('tail', seq=walk.last_seq + 1, seq_to=head['head_seq']))
    if key and walk.last_kid is not None and walk.last_kid != kid:
        # 🔴 配了密钥，最新那一行却不是用它签的：把整条链的标识换成假的 / 换成「没配密钥」再自己重算，
        # 每一行都会落进「校验不了 / 用空密钥核对得上」，只有这一条拦得住（评审抓到的）。
        # 刚配上密钥、之后还没有新的修改时也会报 —— 有一次修改之后就消失
        found.add(_problem('stale', seq=walk.last_seq))
    if head is not None:
        # ⚠️ 先读最大序号、再读链头：反过来的话两次读之间别的事务一提交，「比链头还新」就成了误报
        newest = session.execute(sa.select(sa.func.max(records.c.chain_seq))).scalar()
        now = session.execute(sa.select(chain.c.anchor_seq, chain.c.head_seq).where(chain.c.id == CHAIN_ID)).first()
        # 校验期间清理任务推了锚点、删了行：被删的那一段不是缺口
        if now is not None and now.anchor_seq > head['anchor_seq']:
            found.items = [p for p in found.items if not (p.kind == 'missing' and (p.seq_to or 0) <= now.anchor_seq)]
        # 🔴 只走到「读链头那一刻的链头」是为了不把校验期间新提交的行报成问题；但不能因此给
        # 「把链头往回改、藏起最新几行」留口子 —— 写记录和推链头在同一个事务里，任何提交过的状态下
        # 最大序号都等于链头。比链头还新的行就是链头被改过
        current_head = now.head_seq if now is not None else head['head_seq']
        if newest is not None and newest > current_head:
            found.add(_problem('tail', seq=current_head + 1, seq_to=newest))
    _find_unchained(session, records, found)
    return ChainReport(
        ok=found.count == 0,
        keyed=bool(key),
        checked=walk.checked,
        head_seq=head['head_seq'] if head else 0,
        anchor_seq=head['anchor_seq'] if head else 0,
        other_key=walk.other_key,
        problem_count=found.count,
        problems=found.items[:MAX_PROBLEMS],
    )
