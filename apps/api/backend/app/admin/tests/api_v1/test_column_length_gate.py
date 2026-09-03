"""写入侧的字符串长度闸门。

⚠️ **此前一个字都没限。** 前端限了长度（`dept/form.tsx` 的 `leader` 是
`max(20)`），后端 schema 没限，列是 `UniversalStr(32)` —— 三个数字互不相同，
而超出列长度的表现是**裸 SQL 错误冒到 500**：

    pyodbc.ProgrammingError: ('42000', "... String or binary data would be
    truncated in table 'fba_test.dbo.sys_dept', column 'leader' ...")

（实测，33 个字符就触发。）

🔴 **这个洞盖不住的原因值得记**：`get_db_transaction` 是在 `begin()` 里
`yield` 的，commit 发生在**依赖收尾**，那时已经出了异常处理器的覆盖范围 ——
加了 `dbapi_exception_handler` 之后再打一次，冒出来的变成
`ContextDoesNotExistError`（连 starlette-context 都拆了）。
所以 INSERT/UPDATE 这条路的闸门只能在 schema 那层。

修法是 `common/schema.py` 的 `ColumnLengthChecked` mixin：从绑定模型的
`__table__` **现读列长度**，不逐个字段写 `max_length`。理由是数量 ——
全仓 88 个带长度的列、Create/Update 里缺 `max_length` 的可写字符串字段
**327 处**（约 50 个不同字段），逐个写就是 327 个会和列定义分叉的数字。
"""

import pytest

from starlette.testclient import TestClient

#: 这批测试会用到的部门编码，收尾一律硬删
CODES = ('PYTESTLEN', 'PYTESTEDGE')


@pytest.fixture(autouse=True)
def _purge_probe_depts():
    """每条测试前后都把探针部门**硬删**掉。

    🔴 **不能把清理写在测试体末尾** —— 这是我自己刚在分册里写下、又当场违反了
    一次的那条：`test_over_long_value_is_422_not_500` 预期请求被拒，所以它
    没有清理逻辑；而在「把校验关掉」的突变实验里那条请求**真的写进去了**，
    于是下一轮 `PYTESTEDGE`/`PYTESTLEN` 已经存在，测试红在
    `409 部门编码已存在` 上 —— 一个和被测行为毫无关系的症状。

    ⚠️ 硬删，不走接口：`DELETE /sys/depts` 是逻辑删除，而部门编码的唯一约束
    带着 `deleted`，所以逻辑删除之后同名还能建 —— 但行会一直堆着。
    和 `tests/conftest.py` 的 `temp_user` 同一个套路。
    """

    def purge() -> None:
        import asyncio

        from sqlalchemy import text

        from backend.database.db import (
            create_database_async_engine,
            create_database_async_session,
            get_database_url,
        )

        async def _run() -> None:
            engine = create_database_async_engine(get_database_url(unittest=True))
            session_maker = create_database_async_session(engine)
            try:
                async with session_maker.begin() as session:
                    await session.execute(
                        text('DELETE FROM sys_dept WHERE code IN (:a, :b)'), {'a': CODES[0], 'b': CODES[1]}
                    )
            finally:
                await engine.dispose()

        asyncio.run(_run())

    purge()
    yield
    purge()


def test_over_long_value_is_422_not_500(client: TestClient, token_headers: dict[str, str]) -> None:
    """超出列长度 → 422 并**点出字段名和上限**，不是 500。

    两个断言都必要：只看状态码的话，一个「把所有请求都拒掉」的实现也是绿的；
    只看有没有报错的话，分不出 422 和 500 —— 而 500 意味着请求已经打到了
    数据库、并且日志里是一条裸 SQL 错误。
    """
    resp = client.post(
        '/sys/depts',
        headers=token_headers,
        json={'name': 'pytest-长度闸门', 'code': 'PYTESTLEN', 'leader': '字' * 40, 'sort': 0, 'status': 1},
    )
    assert resp.status_code == 422, f'期望 422，实际 {resp.status_code}：{resp.text[:200]}'
    msg = resp.json()['msg']
    assert 'leader' in msg, f'报错没点出是哪个字段：{msg}'
    assert '32' in msg, f'报错没给出上限（列长度 32）：{msg}'


def test_value_within_the_column_length_still_works(client: TestClient, token_headers: dict[str, str]) -> None:
    """列长度以内照旧能写 —— 只验「超长被拒」的话，全拒的实现也是绿的。

    ⚠️ 用**正好 32 个**字符（列的上限），把边界钉在「等于上限要放过」这一侧：
    判据写成 `>=` 会把恰好填满的值拒掉，而那种误杀在界面上表现为
    「明明没超还是存不下」。
    """
    resp = client.post(
        '/sys/depts',
        headers=token_headers,
        json={'name': 'pytest-长度边界', 'code': 'PYTESTEDGE', 'leader': '字' * 32, 'sort': 0, 'status': 1},
    )
    assert resp.json()['code'] == 200, resp.text

    tree = client.get('/sys/depts', headers=token_headers).json()['data']

    def find(nodes: list) -> dict | None:
        for node in nodes:
            if node['code'] == 'PYTESTEDGE':
                return node
            got = find(node.get('children') or [])
            if got:
                return got
        return None

    row = find(tree)
    assert row is not None, '写进去了却查不到'
    assert len(row['leader']) == 32
    # 清理交给 `_purge_probe_depts` —— 断言红了它照样跑


def test_mixin_ignores_fields_that_are_not_columns() -> None:
    """绑了模型的 schema 里，**不是列**的字段不受影响。

    钉住这个边界：mixin 写成「字段名找不到列就报错」的话，所有带额外入参的
    schema（`roles` 列表、确认密码那种）会一起 422，而那些字段本来就不该有
    列长度的概念。
    """
    from backend.app.admin.model import Dept
    from backend.app.admin.schema.dept import CreateDeptParam

    assert CreateDeptParam.__sa_model__ is Dept
    # `parent_id` 是 BIGINT、`sort` 是 INT，都没有 length；不该被误伤
    param = CreateDeptParam(name='x' * 10, code='OKCODE', leader=None, sort=0, status=1)
    assert param.name == 'x' * 10


#: 用户能在界面上编辑的那批 param schema —— 这些必须绑了模型。
#:
#: ⚠️ 没列进来的（`UpdateOperaLogParam` / `UpdateLoginLogParam` 那些）是
#: 中间件自己写的，不经用户输入，暂时没绑。要绑就是加一行 `__sa_model__`。
USER_WRITABLE = (
    ('backend.app.admin.schema.dept', ('CreateDeptParam', 'UpdateDeptParam')),
    ('backend.app.admin.schema.role', ('CreateRoleParam', 'UpdateRoleParam')),
    ('backend.app.admin.schema.menu', ('CreateMenuParam', 'UpdateMenuParam')),
    ('backend.app.admin.schema.user', ('UpdateUserParam',)),
    ('backend.plugin.dict.schema.dict_data', ('CreateDictDataParam', 'UpdateDictDataParam')),
    ('backend.plugin.dict.schema.dict_type', ('CreateDictTypeParam', 'UpdateDictTypeParam')),
    ('backend.plugin.notice.schema.notice', ('CreateNoticeParam', 'UpdateNoticeParam')),
    ('backend.plugin.config.schema.config', ('CreateConfigParam', 'UpdateConfigParam')),
)


def test_user_writable_schemas_are_all_bound() -> None:
    """🔴 守卫：用户能编辑的 param schema 都要绑上模型。

    删掉一行 `__sa_model__` 的后果是**那个接口悄悄回到 500 的老路上** ——
    超长值又变成裸 SQL 错误。而删掉之后所有现存测试照旧绿（只有 dept 那两条
    在盯着），所以要有这条按清单核对。
    """
    import importlib

    unbound = []
    for module_name, class_names in USER_WRITABLE:
        module = importlib.import_module(module_name)
        for class_name in class_names:
            cls = getattr(module, class_name, None)
            if cls is None:
                unbound.append(f'{module_name}.{class_name} 不存在了')
                continue
            if getattr(cls, '__sa_model__', None) is None:
                unbound.append(f'{module_name}.{class_name} 没绑 __sa_model__')

    assert not unbound, '这些 schema 的长度闸门没接上：\n  ' + '\n  '.join(unbound)


def test_bound_model_matches_the_schema_name() -> None:
    """绑的模型要**对得上** —— 按命名约定核对：`CreateDeptParam` → `Dept`。

    钉住「绑错模型」这种手滑：`UpdateRoleMenuParam` 曾经被误绑成 `Role`
    （它的字段全是 ID，一列都对不上），那种绑法无害但误导 —— 看起来有闸门，
    实际一个字段都没在管。第一版误绑了 5 个。

    ⚠️ **判据不能写成「至少有一个字段对得上」。** 第一版就是那么写的，
    而突变实验（把 menu 的 schema 绑到 `Role`）**照旧全绿** ——
    因为 `Role` 和 `Menu` 都有 `name` / `remark` 这种同名带长度的列。
    我自己刚写的测试当场就是假绿，靠突变抓出来的。按模型名核对才区分得开。
    """
    import importlib

    wrong = []
    for module_name, class_names in USER_WRITABLE:
        module = importlib.import_module(module_name)
        for class_name in class_names:
            cls = getattr(module, class_name)
            expected = class_name.removeprefix('Create').removeprefix('Update').removesuffix('Param')
            actual = cls.__sa_model__.__name__
            if actual != expected:
                wrong.append(f'{module_name}.{class_name} 绑的是 {actual}，按命名约定应该是 {expected}')

    assert not wrong, '绑错了模型：\n  ' + '\n  '.join(wrong)
