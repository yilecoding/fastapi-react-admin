"""`/sys/users/me/*` 那几条写接口的**信封契约**。

🔴 **这几条在「写了 0 行」时返回 HTTP 200 + `code: 400`**（`response_base.fail()`），
不是 4xx。客户端只看 `!res.ok` 会把失败读成成功 —— `packages/api` 的
`resolveEnvelope` 就是为这条存在的（两端共用一份），而这里锁住它依赖的那个契约。

⚠️ 这些测试**同时断言 HTTP 状态是 200**。只断言 `code` 的话，读测试的人看不出
「HTTP 层是成功的」这个陷阱，而那正是客户端会写错的地方。
"""

import pytest

from starlette.testclient import TestClient

from backend.core.conf import settings


def _envelope(res) -> tuple[int, int]:
    """→ (HTTP 状态, 信封 code)"""
    return res.status_code, res.json()['code']


@pytest.fixture
def restore_nickname(client: TestClient, token_headers: dict[str, str]):
    """改完还原 —— 这几条接口动的是 admin 自己，别污染后面的测试"""
    original = client.get('/sys/users/me', headers=token_headers).json()['data']['nickname']
    yield original
    client.put('/sys/users/me/nickname', headers=token_headers, json={'nickname': original})


def test_update_nickname_success_returns_code_200(
    client: TestClient, token_headers: dict[str, str], restore_nickname: str
) -> None:
    res = client.put('/sys/users/me/nickname', headers=token_headers, json={'nickname': '契约测试用昵称'})
    assert _envelope(res) == (200, 200)
    assert client.get('/sys/users/me', headers=token_headers).json()['data']['nickname'] == '契约测试用昵称'


def test_update_nickname_with_the_same_value_is_dialect_dependent(
    client: TestClient, token_headers: dict[str, str], restore_nickname: str
) -> None:
    """🔴 把昵称设成**当前一样的值** —— 结果**取决于数据库方言**。

    handler 是 `count > 0 ? success() : fail()`，而 `count` 一路下来就是
    `CursorResult.rowcount`（`sqlalchemy_crud_plus` 的 `update_model_by_column`
    直接 `return result.rowcount`）—— 也就是 DBAPI 报什么就是什么：

    | 方言 | 设同值时的 rowcount | 接口返回 |
    |---|---|---|
    | SQL Server（aioodbc） | **匹配**行 = 1 | `code: 200` |
    | PostgreSQL（asyncpg） | 匹配行 = 1 | `code: 200` |
    | MySQL（asyncmy，本仓库**没有**设 `CLIENT_FOUND_ROWS`） | **变更**行 = 0 | `code: 400` |

    ⚠️ **同一个接口在三个方言上行为不同**，而本仓库宣称支持三种数据库。
    `platform/src/pages/profile/api.ts` 里原来那句「提交一模一样的值 rowcount = 0，
    接口会返回失败」是**只在 MySQL 上成立**的，已按这条测试的结果改成有条件的说法。

    所以页面侧「值没变就禁用提交」那个做法**要保留**：在 MySQL 上它是正确性
    要求，在另两个方言上是省一次无意义的请求。
    """
    same = restore_nickname
    res = client.put('/sys/users/me/nickname', headers=token_headers, json={'nickname': same})
    http, code = _envelope(res)
    assert http == 200, '无论哪个方言，HTTP 层都是 200 —— 这正是客户端会读错的地方'
    if settings.DATABASE_TYPE == 'mysql':
        assert code == 400, 'MySQL 的 affected_rows 数变更行，设同值应当是 0 行 -> fail()'
    else:
        assert code == 200, f'{settings.DATABASE_TYPE} 的 rowcount 数匹配行，设同值应当仍成功'


def test_update_timezone_rejects_a_bogus_iana_name(client: TestClient, token_headers: dict[str, str]) -> None:
    """时区是 `IanaTimeZone`，拼错的名字必须在**写入侧**被挡住。

    为什么必须挡：这个值会被前端直接交给 `Intl.DateTimeFormat(..., { timeZone })`，
    而那个 API 对不认识的时区**抛异常** —— 存进去一个拼错的名字，受害者是那个
    用户自己（每次打开任何带时间的页面都白屏，而且改不回来，因为偏好设置页
    自己也要渲染时间）。
    """
    res = client.put('/sys/users/me/timezone', headers=token_headers, json={'timezone': 'Asia/Shangaï'})
    assert res.status_code == 422, '拼错的 IANA 时区必须 422，不能存进去'


def test_update_avatar_rejects_empty_string(client: TestClient, token_headers: dict[str, str]) -> None:
    """🔴 空串必须被拒，`null` 才是「清空」。

    读取侧 `avatar` 是 `HttpUrl | None`，存进空串之后 `/users/me` 和登录会
    **全部 422**（`url_parsing: input is empty`）—— 连改坏它的人自己都登不回来。
    """
    res = client.put('/sys/users/me/avatar', headers=token_headers, json={'avatar': ''})
    assert res.status_code == 422, '空串必须 422 —— 存进去之后本人都登不回来'


def test_update_avatar_accepts_null_as_clear(client: TestClient, token_headers: dict[str, str]) -> None:
    res = client.put('/sys/users/me/avatar', headers=token_headers, json={'avatar': None})
    assert _envelope(res) == (200, 200)
