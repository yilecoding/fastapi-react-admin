"""个人偏好 `GET / PUT /sys/users/me/preferences/{key}`（#202）。

守的是四件「坏了不会报错」的事：

| 测试 | 坏了的样子 |
|---|---|
| 读写往返 | 保存 200、刷新后还是默认布局（写进去的和读出来的不是同一份） |
| 只能动自己的 | A 的工作台布局出现在 B 的首页上 —— 两边都「正常」 |
| 非法 key / 非法 JSON / 超大 | `NaN` 写进去回 200，读回来悄悄变成 `null`（库里那份还不是合法 JSON）；坏 JSON 回 500 |
| 键数上限 | 键名是格式白名单不是清单，没有这道一个登录用户就能往表里无限塞行 |

⚠️ 测试用的键一律在 `pytest.` 命名空间下，前后都**硬删**（这张表不走软删，但别的测试 / E2E 也在用
同一个 `fba_test`，残留行会让「没存过时是 null」那条断言随运行顺序变）。
"""

import asyncio

import pytest

from sqlalchemy import ColumnElement
from starlette.testclient import TestClient

from backend.app.admin.model import UserPreference
from backend.app.admin.schema.user_preference import PREFERENCE_VALUE_MAX_BYTES, USER_PREFERENCE_MAX_KEYS

BASE = '/sys/users/me/preferences'
KEY = 'pytest.layout'
TEMP_PASSWORD = 'Tmp@123456'  # = `temp_user` fixture 建号时的密码


def _purge(condition: ColumnElement[bool]) -> None:
    """直连库硬删（独立引擎，同 `temp_user` 的收尾：共享会话绑在 TestClient 的循环上）

    ⚠️ 走 Core 不写 `text()`：`key` 在 SQL Server / MySQL 都是保留字，裸 SQL 不加引号当场语法错
    （PostgreSQL 上不是保留字，本地跑得过、CI 的 SQL Server 那一跑就红）
    """
    from sqlalchemy import delete

    from backend.database.db import create_database_async_engine, create_database_async_session, get_database_url

    async def _run() -> None:
        engine = create_database_async_engine(get_database_url(unittest=True))
        try:
            async with create_database_async_session(engine).begin() as session:
                await session.execute(delete(UserPreference).where(condition))
        finally:
            await engine.dispose()

    asyncio.run(_run())


@pytest.fixture(autouse=True)
def _purge_pytest_keys():
    _purge(UserPreference.key.like('pytest.%'))
    yield
    _purge(UserPreference.key.like('pytest.%'))


@pytest.fixture
def other_headers(client: TestClient, temp_user: str):
    """第二个人（临时用户）的登录态；他存过的偏好在他被删之前清掉，不留孤儿行"""
    res = client.post('/auth/login/swagger', params={'username': 'pytest_tmp_writes', 'password': TEMP_PASSWORD})
    assert res.status_code == 200, f'临时用户登录失败：{res.text}'
    body = res.json()
    yield {'Authorization': f'{body["token_type"]} {body["access_token"]}'}
    _purge(UserPreference.user_id == int(temp_user))


def _get(client: TestClient, headers: dict, key: str = KEY):
    res = client.get(f'{BASE}/{key}', headers=headers)
    assert res.status_code == 200, res.text
    return res.json()['data']


def _put(client: TestClient, headers: dict, value, key: str = KEY):
    return client.put(f'{BASE}/{key}', headers=headers, json={'value': value})


LAYOUT = {
    'version': 1,
    'cards': [
        {'id': 'notices', 'visible': True, 'width': 'full'},
        {'id': 'todo', 'visible': False, 'width': 'half'},
    ],
    'note': '中文也要原样回来',
}


def test_unsaved_key_reads_as_null_not_404(client: TestClient, token_headers: dict[str, str]) -> None:
    """没存过是常态（每个人第一次打开工作台），200 + null，不是 404 —— 前端要把「读失败」和「没存过」分开"""
    data = _get(client, token_headers)
    assert data == {'key': KEY, 'value': None, 'updated_time': None}


def test_round_trip_and_full_overwrite(client: TestClient, token_headers: dict[str, str]) -> None:
    res = _put(client, token_headers, LAYOUT)
    assert res.status_code == 200 and res.json()['code'] == 200, res.text
    assert res.json()['data']['value'] == LAYOUT, 'PUT 的响应就该带回存下的那一份（前端直接拿它更新缓存）'

    data = _get(client, token_headers)
    assert data['value'] == LAYOUT
    assert data['updated_time'], '存过之后要有保存时间'

    # 整份覆盖，不做合并：少了的字段不能从上一份里「长回来」
    smaller = {'version': 1, 'cards': []}
    assert _put(client, token_headers, smaller).status_code == 200
    assert _get(client, token_headers)['value'] == smaller


def test_only_your_own_preferences(client: TestClient, token_headers: dict[str, str], other_headers: dict) -> None:
    """路径里没有用户 ID —— 两个人写同一个键，各读各的"""
    mine = {'owner': 'admin'}
    theirs = {'owner': 'temp'}

    assert _put(client, token_headers, mine).status_code == 200
    # 先断言「有」：admin 自己读得到。否则下面「对方读不到」在写入静默失败时也成立
    assert _get(client, token_headers)['value'] == mine
    assert _get(client, other_headers)['value'] is None, '另一个人读到了 admin 的偏好'

    assert _put(client, other_headers, theirs).status_code == 200
    assert _get(client, other_headers)['value'] == theirs
    assert _get(client, token_headers)['value'] == mine, '另一个人的写入覆盖了 admin 的偏好'


def test_requires_login(client: TestClient) -> None:
    assert client.get(f'{BASE}/{KEY}').status_code == 401
    assert client.put(f'{BASE}/{KEY}', json={'value': 1}).status_code == 401


@pytest.mark.parametrize(
    'bad_key',
    [
        'pytest',  # 没有命名空间
        'Pytest.layout',  # 大写
        'pytest.Layout',
        'pytest..layout',  # 空段
        'pytest.layout.',  # 结尾的点
        '1pytest.layout',  # 数字开头
        'pytest.lay-out',  # 字符集外
        'a.b.c.d.e',  # 超过四段
        'pytest.' + 'x' * 60,  # 超过 64
    ],
)
def test_bad_key_is_rejected(client: TestClient, token_headers: dict[str, str], bad_key: str) -> None:
    assert client.get(f'{BASE}/{bad_key}', headers=token_headers).status_code == 422
    assert _put(client, token_headers, {'ok': True}, key=bad_key).status_code == 422


@pytest.mark.parametrize(
    ('label', 'body'),
    [
        # 🔴 Python 的 json.loads 接受 NaN / Infinity：放进去的话回 200，读回来是 null（见 `dump_preference_value`）
        ('NaN', '{"value": NaN}'),
        ('Infinity', '{"value": {"w": Infinity}}'),
        # 🔴 截断的 JSON 原来是 500：操作日志中间件在路由之前 `request.json()` 炸了（见 middleware 分册）
        ('截断', '{"value": {"cards": ['),
        ('null', '{"value": null}'),
        ('没有 value', '{}'),
    ],
)
def test_bad_json_is_rejected_and_keeps_the_old_value(
    client: TestClient, token_headers: dict[str, str], label: str, body: str
) -> None:
    assert _put(client, token_headers, LAYOUT).status_code == 200
    res = client.put(
        f'{BASE}/{KEY}', headers={**token_headers, 'Content-Type': 'application/json'}, content=body.encode()
    )
    assert res.status_code == 422, f'{label}：{res.status_code} {res.text[:200]}'
    # 拒掉的那一次不能把原来那份覆盖掉（先存了一份，所以「还是原来那份」不是空转）
    assert _get(client, token_headers)['value'] == LAYOUT


def test_value_size_limit_counts_utf8_bytes(client: TestClient, token_headers: dict[str, str]) -> None:
    # 序列化之后是 `"xxx…"`，两个引号占 2 字节：恰好到上限的放行、多一个字节的拒
    at_limit = 'x' * (PREFERENCE_VALUE_MAX_BYTES - 2)
    assert _put(client, token_headers, at_limit).status_code == 200
    assert _get(client, token_headers)['value'] == at_limit
    assert _put(client, token_headers, at_limit + 'x').status_code == 422

    # 按**字节**算，不是按字符：6000 个汉字 = 18000 字节，字符数却远在上限之下
    assert _put(client, token_headers, '中' * 6000).status_code == 422
    assert _get(client, token_headers)['value'] == at_limit


def test_per_user_key_cap(client: TestClient, other_headers: dict) -> None:
    keys = [f'pytest.k{i}' for i in range(USER_PREFERENCE_MAX_KEYS)]
    for k in keys:
        assert _put(client, other_headers, 1, key=k).status_code == 200, k

    res = _put(client, other_headers, 1, key='pytest.one_too_many')
    assert res.status_code == 400, res.text
    assert _get(client, other_headers, key='pytest.one_too_many')['value'] is None

    # 上限只挡「新键」：已经有的照样能改
    assert _put(client, other_headers, 2, key=keys[0]).status_code == 200
    assert _get(client, other_headers, key=keys[0])['value'] == 2
