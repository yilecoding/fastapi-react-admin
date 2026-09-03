"""`PUT /sys/users/me/password` —— 自助改密码。

零覆盖端点（跑完整套会打印那份清单）。它一次串着七件事：验旧密码 ·
比对确认密码 · 复杂度与历史复用校验 · 写新 hash · 旧密码进历史 ·
更新 `password_changed_time` · **作废所有现存会话**。

🔴 最后那一件是唯一「静默失效等于安全事故」的：改密码的首要理由就是
「我怀疑 token 泄了」。那三行 `delete_by_prefix` 一旦没跑，被盗的 token
在受害者改完密码之后**照旧能用**，而界面上一切正常、日志里什么都没有。

作废是真的生效而不是只删了个 key —— `jwt_authentication` 会拿
`TOKEN_REDIS_PREFIX:{uid}:{session_uuid}` 现取一次，取不到就
`TokenError`，取到但值不等也 `TokenError`（实测读过那段代码）。
所以「旧 token 还能不能用」是可断言的。
"""

import pytest

from starlette.testclient import TestClient

OLD = 'Tmp@123456'
NEW = 'Nw1@abcdef'


def _login(client: TestClient, username: str, password: str):
    """走 swagger 登录 —— 它不过验证码，而这批测试要验的不是登录流程"""
    return client.post('/auth/login/swagger', params={'username': username, 'password': password})


@pytest.fixture
def temp_session(client: TestClient, temp_user: str):
    """临时用户 + 一个真实的会话（token 写进了 Redis）"""
    res = _login(client, 'pytest_tmp_writes', OLD)
    assert res.status_code == 200, f'临时用户登录失败：{res.text}'
    body = res.json()
    headers = {'Authorization': f'{body["token_type"]} {body["access_token"]}'}
    # 前置断言：这个 token 现在真的能用，否则下面「不能用了」证明不了什么
    assert client.get('/sys/users/me', headers=headers).status_code == 200, '新拿到的 token 就用不了？'
    return headers


def test_password_change_invalidates_existing_sessions(client: TestClient, temp_session: dict) -> None:
    """🔴 改完密码，**旧 token 必须立刻失效**。

    这条是这个端点最该测的东西：改密码的首要理由是「怀疑 token 泄了」，
    而作废没生效的表现是**完全没有表现** —— 界面正常、日志干净，
    只有拿着旧 token 的那个人知道自己还在。
    """
    res = client.put(
        '/sys/users/me/password',
        headers=temp_session,
        json={'old_password': OLD, 'new_password': NEW, 'confirm_password': NEW},
    )
    assert res.json()['code'] == 200, res.text

    after = client.get('/sys/users/me', headers=temp_session)
    assert after.status_code != 200, f'旧 token 改完密码还能用 —— 会话没作废：{after.text[:160]}'

    # 新密码能登进来（否则上面那条「失效」可能只是把账号弄坏了）
    again = _login(client, 'pytest_tmp_writes', NEW)
    assert again.status_code == 200, f'新密码登不进来：{again.text[:160]}'


def test_wrong_old_password_is_refused(client: TestClient, temp_session: dict) -> None:
    """旧密码不对要拒，而且**不能顺带把密码改掉**。

    第二个断言是必须的：只断言返回码的话，一个「先改后验」的实现也是绿的。
    """
    res = client.put(
        '/sys/users/me/password',
        headers=temp_session,
        json={'old_password': 'Wrong@99999', 'new_password': NEW, 'confirm_password': NEW},
    )
    assert res.json()['code'] != 200, f'旧密码错了却放过了：{res.text[:160]}'

    # 原密码仍然有效 = 真的没改
    assert _login(client, 'pytest_tmp_writes', OLD).status_code == 200, '旧密码校验失败，密码却被改了'


def test_confirm_mismatch_is_refused(client: TestClient, temp_session: dict) -> None:
    """两次输入不一致要拒 —— 放过的话用户会被改成他自己不知道的那个值"""
    res = client.put(
        '/sys/users/me/password',
        headers=temp_session,
        json={'old_password': OLD, 'new_password': NEW, 'confirm_password': 'Other@12345'},
    )
    assert res.json()['code'] != 200, f'两次不一致却放过了：{res.text[:160]}'
    assert _login(client, 'pytest_tmp_writes', OLD).status_code == 200, '校验失败，密码却被改了'


def test_reusing_the_previous_password_is_refused(client: TestClient, temp_session: dict) -> None:
    """改回上一个密码要拒 —— 历史复用检查（`USER_PASSWORD_HISTORY_CHECK_COUNT`）。

    ⚠️ 这条要先真的改一次，让旧密码进历史表；直接拿初始密码去试是无效的
    （那时候历史表还是空的，什么都拦不住）。
    """
    first = client.put(
        '/sys/users/me/password',
        headers=temp_session,
        json={'old_password': OLD, 'new_password': NEW, 'confirm_password': NEW},
    )
    assert first.json()['code'] == 200, first.text

    # 会话已经作废了，拿新密码重新登
    body = _login(client, 'pytest_tmp_writes', NEW).json()
    fresh = {'Authorization': f'{body["token_type"]} {body["access_token"]}'}

    back = client.put(
        '/sys/users/me/password',
        headers=fresh,
        json={'old_password': NEW, 'new_password': OLD, 'confirm_password': OLD},
    )
    assert back.json()['code'] != 200, f'改回上一个密码却放过了 —— 历史复用检查没生效：{back.text[:200]}'
