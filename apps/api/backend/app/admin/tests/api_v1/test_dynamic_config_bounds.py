"""动态配置的**写入侧**范围校验。

⚠️ 此前写入侧完全没有校验 —— 只有前端
`packages/platform/src/pages/config/registry.ts` 里的 `min` / `max`，
而那是 UX 提示、不是闸门：带管理员 token 直接 `PUT /sys/configs` 就能绕过。

实测（四发全部 HTTP 200 code=200）：`USER_PASSWORD_MIN_LENGTH` 能被写成
`1` / `0` / `-5` / `999`。其中 `999` 的后果是**所有人都改不了密码**
（接口回「密码长度不能少于 999 个字符」）—— 一次 API 调用自锁。

`-5` 反而没打开门：1 位密码仍被**别的规则**拦住（「密码必须包含数字」），
所以这不是安全绕过，是自锁 + 配置可以进入无意义状态。

而同类的一次已经发生过：值被清空成 `''`，下一次登录直接
`500 invalid literal for int()`，全站登不进来。那次只修了读取侧的回落
（`utils/dynamic_config.py` 里那段 `try/except`），写入侧的洞留着 ——
这批测试补的是写入侧。
"""

import pytest

from starlette.testclient import TestClient

from backend.utils.dynamic_config import DYNAMIC_INT_BOUNDS, check_dynamic_int_bounds

KEY = 'USER_PASSWORD_MIN_LENGTH'


def _row(client: TestClient, headers: dict[str, str], key: str) -> dict:
    page = client.get('/sys/configs', headers=headers, params={'page': 1, 'size': 200})
    return next(r for r in page.json()['data']['items'] if r['key'] == key)


def _put(client: TestClient, headers: dict[str, str], row: dict, value: str):
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


@pytest.fixture
def row(client: TestClient, token_headers: dict[str, str]):
    """拿到那一行，收尾还原成原值。

    ⚠️ 还原放 fixture 的 teardown，不放测试体末尾 —— 中途红了不还原的话，
    这个值会**跨轮**留在库里，后面所有改密码的测试跟着一起红。
    """
    original = _row(client, token_headers, KEY)
    yield original
    _put(client, token_headers, original, original['value'])


@pytest.mark.parametrize('bad', ['0', '-5', '999', '', 'not-a-number'])
def test_out_of_range_values_are_refused(
    client: TestClient, token_headers: dict[str, str], row: dict, bad: str
) -> None:
    """超范围 / 非数字的值必须被拒，而且**库里的值不能变**。

    第二个断言是必须的：只断言 HTTP 状态码的话，一个「先写库再报错」的实现
    也是绿的 —— 而那种实现的后果和没校验一样。
    """
    resp = _put(client, token_headers, row, bad)
    assert resp.status_code == 422, f'{bad!r} 被接受了：HTTP {resp.status_code} {resp.text[:160]}'

    after = _row(client, token_headers, KEY)
    assert after['value'] == row['value'], f'值被改成了 {after["value"]!r}，说明拒绝发生在写库之后'


def test_in_range_value_still_works(client: TestClient, token_headers: dict[str, str], row: dict) -> None:
    """合格的值照旧能改 —— 只验「坏的被拒」的话，一个全拒的实现也是绿的。"""
    assert _put(client, token_headers, row, '8').json()['code'] == 200
    assert _row(client, token_headers, KEY)['value'] == '8'


def test_keys_outside_the_table_are_not_touched(client: TestClient, token_headers: dict[str, str]) -> None:
    """不在范围表里的键（比如字符串型配置）不受影响，随便填。

    钉住这个边界：校验函数写成「表里没有就拒绝」的话，参数配置页上所有
    非数值配置会一起失效，而那批键连范围的概念都没有。
    """
    assert check_dynamic_int_bounds('SOME_STRING_CONFIG', '随便什么') is None
    assert check_dynamic_int_bounds('LOGIN_CAPTCHA_ENABLED', 'true') is None


def test_bounds_table_matches_the_frontend_registry() -> None:
    """🔴 对账：范围表必须和前端 registry 里的 `min` / `max` 一致。

    两边各有一份是**刻意的**：前端那份是 UX（输入框的上下箭头、即时提示），
    服务端这份是闸门。但两份**不能悄悄分叉** —— 分叉的表现是「界面上能填、
    保存时报 422」，用户会以为是 bug。

    和「权限码三方对账」同一个物种：能被机器核对的一致性就让机器核对。
    """
    import re

    from pathlib import Path

    # ⚠️ 别数 `parents[N]`（第一版数错了一层）—— 向上找 pnpm-workspace.yaml，
    # 这样目录层级变了也不用改这条测试
    here = Path(__file__).resolve()
    root = next((p for p in here.parents if (p / 'pnpm-workspace.yaml').is_file()), None)
    assert root is not None, f'从 {here} 往上找不到仓库根（pnpm-workspace.yaml）'
    registry = root / 'packages/platform/src/pages/config/registry.ts'
    assert registry.is_file(), f'前端 registry 不在预期位置：{registry}'
    src = registry.read_text(encoding='utf-8')

    mismatches = []
    for key, (low, high) in DYNAMIC_INT_BOUNDS.items():
        block = re.search(rf'\b{key}:\s*\{{(.*?)\n  \}}', src, re.DOTALL)
        if not block:
            mismatches.append(f'{key}：前端 registry 里没有这一项')
            continue
        body = block.group(1)
        fe_min = re.search(r'\bmin:\s*(-?\d+)', body)
        fe_max = re.search(r'\bmax:\s*(-?\d+)', body)
        if not fe_min or not fe_max:
            mismatches.append(f'{key}：前端没写 min/max（服务端是 {low}~{high}）')
            continue
        if (int(fe_min.group(1)), int(fe_max.group(1))) != (low, high):
            mismatches.append(f'{key}：前端 {fe_min.group(1)}~{fe_max.group(1)} ≠ 服务端 {low}~{high}')

    assert not mismatches, '前后端的配置范围分叉了：\n  ' + '\n  '.join(mismatches)
