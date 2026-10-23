"""上传策略可在参数配置里改（#139）：分片阈值 / 每片大小读 sys_config 的 FILE 组，`.env` 是默认值。

要守的都是「改了、界面上也显示改了，但没生效 / 生效成了别的值」那一类：

- 界面上改了，`upload-policy` 和分片 init 都要用新值，而且**单位要换算**（库里 MiB，下发字节）
- 🔴 组总开关关掉之后真的回落 `.env`。原来的 `load_config` 关组时直接 `return`，
  进程里留着上一次加载的库值 —— 界面上的横幅写着「回落 .env」，实际要重启才回落
- 🔴 库里的脏值不能把 init 打成 500：`'0'` 过得了 `int()`，然后是 `ceil(size / 0)`
- 写入侧：超范围的值 422，且库里的值不变（阈值的上界跟着 nginx 的 `client_max_body_size 100m`）

⚠️ 全走真实请求，不直接调 loader —— `asyncio.run()` 会关掉共享 redis_client 的事件循环
（见 `test_dynamic_config.py` 开头那段）。
"""

from collections.abc import Iterator

import pytest

from starlette.testclient import TestClient

from backend.core.conf import Settings, settings

MIB = 1024 * 1024
POLICY = '/sys/files/upload-policy'
MP = '/sys/files/multipart'
STATUS, THRESHOLD, SIZE = 'FILE_CONFIG_STATUS', 'FILE_CHUNK_THRESHOLD', 'FILE_CHUNK_SIZE'

#: 还原用写死的基线（= 种子里的值），不用「测试开始时库里的值」—— 理由见 test_dynamic_config.py 的 `configs` fixture
BASELINE = {STATUS: '1', THRESHOLD: '16', SIZE: '8'}


def _find(client: TestClient, headers: dict[str, str], key: str) -> dict:
    page = client.get('/sys/configs', headers=headers, params={'page': 1, 'size': 200})
    rows = [r for r in page.json()['data']['items'] if r['key'] == key]
    # 先断言「有」：测试库是旧种子建的话这一行不存在，后面每条都会以莫名其妙的样子红
    assert rows, f'测试库里没有 {key}，先 `pnpm --filter api test:db` 按新种子重建'
    return rows[0]


def _put(client: TestClient, headers: dict[str, str], row: dict, value: str):
    """按原样回写，只改 value —— 这条接口要求整份 body"""
    return client.put(
        f'/sys/configs/{row["id"]}',
        headers=headers,
        json={
            'name': row['name'],
            'type': row['type'],
            'key': row['key'],
            'value': value,
            'is_frontend': row['is_frontend'],
            'remark': row['remark'],
        },
    )


def _put_raw(client: TestClient, headers: dict[str, str], row: dict, value: str) -> None:
    """绕过写入侧闸门直接写库（脏数据现在只可能从这条路来）。先用接口写一发合法值把 `get_all` 的缓存清掉，顺序不能反"""
    import asyncio

    from sqlalchemy import text

    from backend.database.db import create_database_async_engine, create_database_async_session, get_database_url

    assert _put(client, headers, row, BASELINE[row['key']]).json()['code'] == 200

    async def _write() -> None:
        engine = create_database_async_engine(get_database_url(unittest=True))
        try:
            async with create_database_async_session(engine).begin() as session:
                await session.execute(
                    text('UPDATE sys_config SET value = :v WHERE id = :pk'), {'v': value, 'pk': int(row['id'])}
                )
        finally:
            await engine.dispose()

    asyncio.run(_write())


def _policy(client: TestClient, headers: dict[str, str]) -> dict:
    resp = client.get(POLICY, headers=headers)
    assert resp.json()['code'] == 200, resp.text
    return resp.json()['data']


def _env() -> Settings:
    """`.env` 给的值：重新构造一份 Settings，不受进程里 setattr 的影响 —— 拿它当回落的真值，不拿被测代码自己的快照"""
    return Settings()


@pytest.fixture
def rows(client: TestClient, token_headers: dict[str, str], monkeypatch: pytest.MonkeyPatch) -> Iterator[dict]:
    """三行配置；收尾按基线还原库值（并断言还原成功），settings 交给 monkeypatch 还原"""
    found = {k: _find(client, token_headers, k) for k in BASELINE}
    # loader 会往进程级 settings 上 setattr；登记一下，测完还原成测试开始前的值
    for attr in (THRESHOLD, SIZE):
        monkeypatch.setattr(settings, attr, getattr(settings, attr))
    yield found
    problems = []
    for key, row in found.items():
        res = _put(client, token_headers, row, BASELINE[key])
        if res.status_code != 200 or res.json().get('code') != 200:
            problems.append(f'{key} 还原失败：{res.status_code} {res.text[:120]}')
    assert not problems, '配置没还原干净，下一次运行会读到脏基线：\n' + '\n'.join(problems)


def _init(client: TestClient, headers: dict[str, str], size: int) -> dict:
    resp = client.post(MP, headers=headers, json={'name': 'policy.zip', 'size': size})
    assert resp.status_code != 500, f'init 500 了：{resp.text[:200]}'
    assert resp.json()['code'] == 200, resp.text
    session = resp.json()['data']
    # 会话只在 Redis 里（init 不写存储），删掉免得留到 24 小时后才过期
    client.delete(f'{MP}/{session["upload_id"]}', headers=headers)
    return session


# ─── 改了就生效 ──────────────────────────────────────────────────────────────


def test_policy_and_init_follow_the_config_page(client: TestClient, token_headers: dict[str, str], rows: dict) -> None:
    """界面上改成 32 / 4，下发的是 32 MiB / 4 MiB（字节），init 也按 4 MiB 切"""
    assert _put(client, token_headers, rows[THRESHOLD], '32').json()['code'] == 200
    assert _put(client, token_headers, rows[SIZE], '4').json()['code'] == 200

    assert _policy(client, token_headers) == {'chunk_threshold': 32 * MIB, 'chunk_size': 4 * MIB}

    session = _init(client, token_headers, 10 * MIB)
    assert (session['chunk_size'], session['total_parts']) == (4 * MIB, 3)


def test_turning_the_group_off_falls_back_to_env(client: TestClient, token_headers: dict[str, str], rows: dict) -> None:
    """🔴 关掉组总开关 → 回落 `.env`，不是留着上一次加载的库值。

    先让 loader 把库值（4 MiB）加载进进程，再关组 —— 只关组不先加载的话，进程里本来就是 .env 值，
    「留着旧值」那个 bug 测不出来。反向验证过：把 load_config 改回「关组直接 return」，这条以 4 MiB ≠ 8 MiB 变红
    """
    assert _put(client, token_headers, rows[SIZE], '4').json()['code'] == 200
    assert _policy(client, token_headers)['chunk_size'] == 4 * MIB

    assert _put(client, token_headers, rows[STATUS], '0').json()['code'] == 200
    env = _env()
    assert env.FILE_CHUNK_SIZE != 4 * MIB, '前提不成立：.env 恰好也是 4 MiB，这条测不出回落'
    assert _policy(client, token_headers) == {
        'chunk_threshold': env.FILE_CHUNK_THRESHOLD,
        'chunk_size': env.FILE_CHUNK_SIZE,
    }
    assert _init(client, token_headers, 10 * MIB)['chunk_size'] == env.FILE_CHUNK_SIZE


# ─── 读取侧：脏数据 ──────────────────────────────────────────────────────────


@pytest.mark.parametrize('dirty', ['0', '-1', '', 'abc', '65'])
def test_a_dirty_chunk_size_in_the_db_does_not_break_init(
    client: TestClient, token_headers: dict[str, str], rows: dict, dirty: str
) -> None:
    """🔴 库里的分片大小是脏的（直接写库造），init 不能 500，按 `.env` 的值切。

    `'0'` 是最要命的那个：它过得了 `int()`，原来的 loader 照单全收，然后 `ceil(size / 0)` ——
    每一次分片上传都是 500。所以读取侧也要过范围表，只 catch 转换异常不够
    """
    _put_raw(client, token_headers, rows[SIZE], dirty)

    assert _init(client, token_headers, 10 * MIB)['chunk_size'] == _env().FILE_CHUNK_SIZE
    assert _policy(client, token_headers)['chunk_size'] == _env().FILE_CHUNK_SIZE


# ─── 写入侧：范围 ────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    ('key', 'bad'),
    [
        # 100 MiB 以上的阈值意味着「100 MB 上下的文件一个请求传」—— nginx 的 client_max_body_size 100m 直接 413
        (THRESHOLD, '100'),
        (THRESHOLD, '0'),
        (SIZE, '65'),
        (SIZE, '0'),
        (SIZE, ''),
    ],
)
def test_out_of_range_values_are_refused(
    client: TestClient, token_headers: dict[str, str], rows: dict, key: str, bad: str
) -> None:
    resp = _put(client, token_headers, rows[key], bad)
    assert resp.status_code == 422, f'{key}={bad!r} 被接受了：HTTP {resp.status_code} {resp.text[:160]}'
    assert _find(client, token_headers, key)['value'] == rows[key]['value'], '拒绝发生在写库之后'


@pytest.mark.parametrize(('key', 'edge'), [(THRESHOLD, '99'), (THRESHOLD, '1'), (SIZE, '64'), (SIZE, '1')])
def test_the_edges_are_accepted(
    client: TestClient, token_headers: dict[str, str], rows: dict, key: str, edge: str
) -> None:
    """边界本身合法 —— 只验「坏的被拒」的话，一个全拒的实现也是绿的"""
    assert _put(client, token_headers, rows[key], edge).json()['code'] == 200
    assert _find(client, token_headers, key)['value'] == edge
