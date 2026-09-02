"""三份方言种子文件的一致性守卫。

🔴 **`backend/sql/{mysql,postgresql,sqlserver}/init_snowflake_test_data.sql`
是三份手写文件，此前没有任何东西校验它们对得上。**

代价是实测出来的：那批「公开演示」数据（3 个部门 + 4 个角色 + 10 个账号，
用来演示三档数据范围）最早只加进了 `sqlserver/`，而 `mysql/` 和 `postgresql/`
两份原地放了半年多还是最初那个 1 部门 + 1 角色 + 2 账号的最小种子 ——
**没人发现**。因为本仓库日常只跑 SQL Server，另两个方言只在别人换库时才走到，
而那时表现是「照文档建了库，登进去看到的东西和 README 完全不一样」。

这条守卫比行数：**每张表在三份里的行数必须相同**，列清单也必须相同。

⚠️ 它**不比 ID**。三个方言的 ID 段是刻意不同的（postgresql 的角色在
`4000000000000000xxx`、另两个在 `3000000000000000xxx`），比 ID 会永远红。
也不比具体的值 —— 那需要一个真正的 SQL 解析器，而行数 + 列清单已经能抓住
「一份加了行/列、另两份没加」这个唯一真正发生过的漂移形态。
"""

import re

from collections import Counter

import pytest

from backend.core.path_conf import BASE_PATH

DIALECTS = ('mysql', 'postgresql', 'sqlserver')
SEED = 'init_snowflake_test_data.sql'

# 一条 INSERT 一直到下一条 INSERT（或文件尾）
_INSERT = re.compile(
    r'INSERT\s+INTO\s+[`"\[]?(\w+)[`"\]]?\s*\(([^)]*)\)(.*?)(?=INSERT\s+INTO|\Z)', re.DOTALL | re.IGNORECASE
)
# VALUES 里每一组的开头：`(` 紧跟一个雪花 ID（至少 6 位数字）
_ROW = re.compile(r'\(\s*\d{6,}')


def _parse(dialect: str) -> dict[str, tuple[int, tuple[str, ...]]]:
    """→ {表名: (行数, 列清单)}"""
    path = BASE_PATH / 'sql' / dialect / SEED
    assert path.exists(), f'{dialect} 的种子文件不存在：{path}'
    text = path.read_text(encoding='utf-8')

    out: dict[str, tuple[int, tuple[str, ...]]] = {}
    for table, cols, body in _INSERT.findall(text):
        columns = tuple(c.strip().strip('`"[]') for c in cols.split(',') if c.strip())
        rows = len(_ROW.findall(body))
        prev_rows, prev_cols = out.get(table, (0, columns))
        assert prev_cols == columns, f'{dialect} 的 {table} 有两条列清单不同的 INSERT'
        out[table] = (prev_rows + rows, columns)
    return out


@pytest.fixture(scope='module')
def seeds() -> dict[str, dict[str, tuple[int, tuple[str, ...]]]]:
    return {d: _parse(d) for d in DIALECTS}


def test_seed_files_exist_for_every_dialect() -> None:
    """三个方言都要有种子文件 —— 少一份的表现是「换库之后初始化直接失败」。"""
    missing = [d for d in DIALECTS if not (BASE_PATH / 'sql' / d / SEED).exists()]
    assert not missing, f'这些方言缺种子文件：{missing}'


def test_every_dialect_seeds_the_same_tables(seeds) -> None:
    """三份里出现的表必须是同一批。"""
    sets = {d: set(s) for d, s in seeds.items()}
    base = sets[DIALECTS[0]]
    problems = [f'{d}: 多了 {sorted(s - base)}、少了 {sorted(base - s)}' for d, s in sets.items() if s != base]
    assert not problems, '三份种子灌的表不一样：\n' + '\n'.join(problems)


def test_every_table_has_the_same_row_count_in_every_dialect(seeds) -> None:
    """🔴 每张表的行数必须相同 —— 这是真正漂移过的那一维。"""
    problems = []
    for table in sorted(seeds[DIALECTS[0]]):
        counts = {d: seeds[d][table][0] for d in DIALECTS}
        if len(set(counts.values())) > 1:
            problems.append(f'  {table}: ' + ' · '.join(f'{d}={n}' for d, n in counts.items()))
    assert not problems, (
        '三份种子的行数对不上（改了一份就要改三份）：\n'
        + '\n'.join(problems)
        + '\n\n⚠️ 只跑 SQL Server 的话另两份漂了不会有任何现象，'
        '要等别人换库时才发现「登进去看到的和 README 不一样」。'
    )


def test_every_table_has_the_same_columns_in_every_dialect(seeds) -> None:
    """列清单也要相同 —— 一份加了列、另两份没加，那两个方言初始化直接失败。

    ⚠️ **按多数判定异类，不要拿固定的某一份当基准。** 三份里两份相同、一份不同时，
    不同的那一份才是要改的。拿 `DIALECTS[0]` 当基准的话，被改坏的恰好是它时，
    提示会反过来指着另外两份「你们少了一列」—— 一条把人带向错误文件的守卫
    比没有守卫更费时间。
    """
    problems = []
    for table in sorted(seeds[DIALECTS[0]]):
        cols = {d: seeds[d][table][1] for d in DIALECTS}
        if len(set(cols.values())) == 1:
            continue
        counts = Counter(cols.values())
        majority, n = counts.most_common(1)[0]
        if n == 1:  # 三份互不相同，没有多数可依
            problems.append(
                f'  {table}: 三份的列清单互不相同 —— ' + ' · '.join(f'{d}={len(c)} 列' for d, c in cols.items())
            )
            continue
        for d, c in cols.items():
            if c != majority:
                extra = sorted(set(c) - set(majority))
                lack = sorted(set(majority) - set(c))
                problems.append(f'  {table} 在 {d} 和另两份不同: 多了 {extra}、少了 {lack}')
    assert not problems, '三份种子的列清单对不上：\n' + '\n'.join(problems)


#: 关联表（m2m 中间表）→ 它们的外键必须在同一份种子里找得到主
#:
#: ⚠️ 这些表**自己也有 `id` 列**，行长这样：`(id, role_id, menu_id)`。
#: 所以取引用时要跳过每行的第一个数字 —— 第一版没跳，把它们自己的主键
#: 当成了引用，三个方言一起报「悬空」，而对称的失败正是「解析器坏了」的信号
#: （行数一致性那条测试是过的，所以数据不可能三份一起坏成同一个样子）。
_LINK_TABLES = ('sys_role_menu', 'sys_user_role', 'sys_role_data_scope', 'sys_data_scope_rule')

# 行首那个雪花 ID = 主键
_PK = re.compile(r'\(\s*(\d{15,})')
# 正文里所有雪花 ID
_ANY_ID = re.compile(r'\b(\d{15,})\b')
# 一组值：`(...)`。种子里有 `CONVERT(varchar(36), NEWID())` 这种嵌套括号，
# 所以只用来切行、不用来切列
_ROW_GROUP = re.compile(r'\(([^)]*)\)')


def _ids(dialect: str) -> tuple[set[str], dict[str, set[str]]]:
    """→ (这份种子里所有主键, {关联表: 它引用的 ID})"""
    text = (BASE_PATH / 'sql' / dialect / SEED).read_text(encoding='utf-8')

    pks: set[str] = set()
    refs: dict[str, set[str]] = {}
    for table, _cols, body in _INSERT.findall(text):
        pks.update(_PK.findall(body))
        if table not in _LINK_TABLES:
            continue
        for row in _ROW_GROUP.finditer(body):
            row_ids = _ANY_ID.findall(row.group(1))
            if len(row_ids) > 1:
                # 跳过第一个 —— 那是这一行自己的主键
                refs.setdefault(table, set()).update(row_ids[1:])
    return pks, refs


@pytest.mark.parametrize('dialect', DIALECTS)
def test_link_tables_reference_ids_that_exist(dialect: str) -> None:
    """🔴 关联表里的每个外键都要在同一份种子里找得到主。

    行数和列清单一致**不代表引用对得上**：行还在、只是指向了一个不存在的 ID。
    表现是那个方言初始化之后「演示角色一个菜单都没有」/「数据范围没绑上」——
    界面上是空的，日志里什么都没有，而另外两个方言完全正常。

    这一维特别容易漂，因为三份种子的 ID **本来就不一样**（实测：postgresql 的
    角色在 `4000000000000000xxx`、另两个在 `3000000000000000xxx`）。
    改一份里的角色 ID 而忘了改同一份里的 `sys_role_menu`，就是这个 bug。
    """
    pks, refs = _ids(dialect)

    # 🔴 先断言「有」：解析器一坏就什么都扫不到，而「没有悬空引用」会照旧通过
    assert len(pks) >= 100, f'{dialect} 只解析出 {len(pks)} 个主键，解析器可能坏了'
    assert len(refs) == len(_LINK_TABLES), f'{dialect} 只找到 {sorted(refs)} 这几张关联表'
    checked = sum(len(v) for v in refs.values())
    assert checked >= 20, f'{dialect} 只核对了 {checked} 个引用，太少，这条证明不了什么'

    dangling = {table: sorted(ids - pks) for table, ids in refs.items() if ids - pks}
    assert not dangling, f'{dialect} 的种子里有悬空引用（指向不存在的 ID）：{dangling}'
