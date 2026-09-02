"""动态配置的容灾 —— **一条脏数据不能拖垮登录和改密码路径**。

`utils/dynamic_config.py` 把 `sys_config` 表里的值 `setattr` 回 `settings`，
而 `load_user_security_config` 挂在**密码校验**路径上（`password_security.py`），
`load_login_config` 挂在**登录和验证码**路径上。那些 converter 大多是裸 `int`。

🔴 **这是一次真实发生过的故障**：原来那段不捕获异常，于是 `sys_config` 里只要有
一个非数字值（参数配置页把某个数字框清空存下去就产生 `''`），下一次登录就是
`500 invalid literal for int() with base 10: ''` —— **全站登不进来，包括改坏它
的那个管理员自己**（源码注释里记着「实测确认过」）。

修法是退化成「这一个键回落到 .env 默认值 + 一条 error 日志」。

⚠️ 那个修法此前**没有任何测试**。`test_auth.py` 反而把 `load_login_config`
monkeypatch 成了 no-op（为了不依赖 `fba_test` 里的表值），所以整套测试从来没有
走过这条 `try/except` —— 删掉那个 `except` 不会有任何测试变红。

⚠️ 写入侧也拦不住：`UpdateConfigParam.value` 是裸 `str`，`''` 收得下 ——
校验只在前端（`pages/config/registry.ts`）。**读取侧不能依赖写入侧的自觉。**

## 为什么全走 HTTP，不直接调 loader

第一版是 `asyncio.run(load_user_security_config(session))`。它能跑，但
**`asyncio.run()` 会关掉共享 `redis_client` 绑定的那个事件循环** ——
之后同一 session 里的请求全部 `JWT 授权异常：Event loop is closed`。
一个测试把后面的测试弄坏了，而全套还是绿的（靠运行顺序侥幸）。

所以改成经真实请求触发：重置密码会走 `password_security` → 那个 loader。
这也更贴近真实故障（用户看到的就是「登录/改密码 500」）。
"""

import pytest

from starlette.testclient import TestClient

from backend.core.conf import settings

# 挑 `int` 转换器管的键。⚠️ `load_login_config` 那批不行 ——
# 它只有 `LOGIN_CAPTCHA_ENABLED`，converter 是 `value == 'true'`，永不抛。
DIRTY_KEY = 'USER_LOCK_THRESHOLD'
# 同一个 mapping 里的另一个键 —— 用来证明回落是**按键**的，不是整批放弃
SIBLING_KEY = 'USER_LOCK_SECONDS'

# 基线值**写死在这儿，不从库里读**，理由见 fixture
BASELINE = {DIRTY_KEY: '5', SIBLING_KEY: '300'}


def _find(client: TestClient, headers: dict[str, str], key: str) -> dict:
    page = client.get('/sys/configs', headers=headers, params={'page': 1, 'size': 200})
    return next(r for r in page.json()['data']['items'] if r['key'] == key)


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


@pytest.fixture
def configs(client: TestClient, token_headers: dict[str, str]):
    """还原被改动的配置值 + 被 setattr 改掉的 settings。

    🔴 **还原用写死的基线，不用「测试开始时库里的值」。** 后者会被上一次运行
    污染然后一直传下去 —— 这个坑在写这个文件时真的踩到了：

    突变验证（把 `dynamic_config.py` 的 `try/except` 拿掉）那一轮，库里已经是
    `'not-a-number'`，于是**任何加载安全配置的请求都 500，包括 teardown 里那个
    还原请求本身**。而当时没断言它的返回，还原就静默失败了；之后每次运行读到
    的「基线」都是被污染的值，再原样写回去 —— 脏值永久留在了 `fba_test` 里。

    **这正是被测的那个故障：「改坏它的管理员自己也修不回来」。**

    ⚠️ 所以两条都要做：**基线写死** + **断言还原成功**。
    """
    rows = {k: _find(client, token_headers, k) for k in BASELINE}
    saved = {k: getattr(settings, k) for k in BASELINE}
    yield rows
    problems = []
    for key, row in rows.items():
        res = _put(client, token_headers, row, BASELINE[key])
        if res.status_code != 200 or res.json().get('code') != 200:
            problems.append(f'{key} 还原失败：{res.status_code} {res.text[:120]}')
    for key, value in saved.items():
        setattr(settings, key, value)
    assert not problems, '配置没还原干净，下一次运行会读到脏基线：\n' + '\n'.join(problems)


def test_a_non_numeric_config_value_does_not_break_the_password_path(
    client: TestClient, token_headers: dict[str, str], configs: dict, temp_user: str
) -> None:
    """🔴 把一个数字型配置存成空串，改密码路径**不能 500**。

    这条如果红了，说明 `dynamic_config.py` 里那个 `try/except` 被去掉了 ——
    而后果不是「这个测试失败」，是**线上全站登不进来**。

    突变验证过：拿掉那个 `try/except`，这条会以历史故障的原样报错变红
    （`ValueError: invalid literal for int() with base 10`）。
    """
    assert _put(client, token_headers, configs[DIRTY_KEY], '').json()['code'] == 200, '写入侧应当收得下空串'

    res = client.put(f'/sys/users/{temp_user}/password', headers=token_headers, json={'password': 'Dirty@123456'})
    assert res.status_code != 500, f'脏配置把改密码路径打挂了：{res.text[:200]}'
    assert (res.status_code, res.json()['code']) == (200, 200)


def test_the_dirty_key_falls_back_and_the_siblings_still_load(
    client: TestClient, token_headers: dict[str, str], configs: dict, temp_user: str
) -> None:
    """回落是**按键**的：脏的那个用默认值，同 mapping 里其他键照常生效。

    钉住这个粒度：改成「一条脏数据就整批放弃」的话，参数配置页上所有安全设置
    会一起静默失效 —— 而界面上还显示着用户设的值。
    """
    assert _put(client, token_headers, configs[SIBLING_KEY], '321').json()['code'] == 200
    assert _put(client, token_headers, configs[DIRTY_KEY], 'not-a-number').json()['code'] == 200

    # 经真实请求触发 loader
    client.put(f'/sys/users/{temp_user}/password', headers=token_headers, json={'password': 'Dirty@123456'})

    assert getattr(settings, SIBLING_KEY) == 321, '同一批里的干净键必须照常生效'
    assert isinstance(getattr(settings, DIRTY_KEY), int), '脏键必须回落成合法 int，而不是留下字符串'


def test_updating_a_config_is_visible_on_the_next_read(
    client: TestClient, token_headers: dict[str, str], configs: dict
) -> None:
    """改了参数配置，下一次读必须是新值 —— 也就是缓存真的失效了。

    ⚠️ 读取侧是 `@cached(namespace=CACHE_CONFIG_REDIS_PREFIX, key='pk')`，
    写入侧是 `@cache_invalidate(namespace=...)`。两个 namespace 对不上时
    **什么都不会清、也不会报错**，表现为「改完保存成功，页面上还是旧值」。
    先读一次把缓存灌满，再改，再读 —— 这条路径才走得到。
    """
    row = configs[SIBLING_KEY]
    pk = row['id']
    first = client.get(f'/sys/configs/{pk}', headers=token_headers).json()['data']['value']
    assert _put(client, token_headers, row, '777').json()['code'] == 200
    again = client.get(f'/sys/configs/{pk}', headers=token_headers).json()['data']['value']
    assert again == '777', f'改完再读还是旧值（{first!r} → {again!r}）—— 缓存没失效'
