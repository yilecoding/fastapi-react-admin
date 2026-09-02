"""三条高危写接口的测试 —— 它们在这之前**一条测试都没有**。

接口覆盖量测的结论：137 条接口里 62 条零测试引用，写入型 70 条里 26 条零覆盖。
这三条是里面风险最高的：

- `PUT /sys/roles/{pk}/scopes` —— **数据范围的分配**。仓库用 19 个真账号测过
  数据范围的*效果*，但「把范围绑到角色上」这一步从没测过
- `PUT /sys/users/{pk}/permissions` —— 切超管 / 管理员 / 状态 / 多端登录。
  里面有一条**修上游 bug 的代码**，而仓库会 cherry-pick 上游补丁 ——
  没有回归测试就可能被重新引入
- `PUT /sys/users/{pk}/password` —— 超管重置他人密码

⚠️ 用「建临时用户 → 测 → 删掉」，不碰种子里的演示账号 —— 那 10 个账号是
数据权限演示的一部分，改了它们会让别的测试和界面演示都对不上。
"""

import pytest

from starlette.testclient import TestClient


def _user(client: TestClient, headers: dict[str, str], pk: str) -> dict:
    return client.get(f'/sys/users/{pk}', headers=headers).json()['data']


# ── PUT /sys/users/{pk}/permissions ──────────────────────────────────────────


def test_toggling_multi_login_changes_the_target_user_not_the_caller(
    client: TestClient, token_headers: dict[str, str], temp_user: str
) -> None:
    """🔴 **回归测试：切他人的多端登录，必须改的是那个人。**

    上游原本的判据是 `pk != user.id` —— 而 `user` 就是按 `pk` 查出来的，
    所以那个条件**恒为 False**，于是永远拿**操作者自己**的 `is_multi_login`
    去取反。后果：改他人时接口返回 200 但值**纹丝不动**
    （admin 是 True，去切一个 False 的用户，算出 `not True = False`，写回去等于没改）。

    本仓库把判据改成了 `pk == request.user.id`。这条测试锁住那个修法 ——
    仓库会 cherry-pick 上游补丁，没有它这个 bug 可能被重新引入而且**不报错**。
    """
    before = _user(client, token_headers, temp_user)['is_multi_login']
    res = client.put(f'/sys/users/{temp_user}/permissions', headers=token_headers, params={'type': 'multi_login'})
    assert (res.status_code, res.json()['code']) == (200, 200)
    after = _user(client, token_headers, temp_user)['is_multi_login']
    assert after is not before, (
        '切他人的 multi_login 之后值没变 —— 说明取反用的是操作者自己的值，上游那个 `pk != user.id` 的判据回来了'
    )


@pytest.mark.parametrize('kind', ['superuser', 'staff', 'status'])
def test_cannot_change_own_permission(client: TestClient, token_headers: dict[str, str], kind: str) -> None:
    """不许改自己的超管 / 管理员 / 启用状态。

    漏了这个守卫的后果不对称但都很糟：把自己降权是**不可逆**的（降完就没权限
    改回来），把自己停用是当场把自己锁在门外。
    """
    me = client.get('/sys/users/me', headers=token_headers).json()['data']
    res = client.put(f'/sys/users/{me["id"]}/permissions', headers=token_headers, params={'type': kind})
    assert res.status_code == 403, f'改自己的 {kind} 必须 403，实际 {res.status_code}'


def test_multi_login_is_the_one_permission_you_may_change_on_yourself(
    client: TestClient, token_headers: dict[str, str]
) -> None:
    """⚠️ `multi_login` 是唯一允许改自己的 —— 它有自己的 token 失效逻辑。

    钉住这个**不对称**：不写下来的话，下一个人看到上面三条 403 会以为
    「所有权限都不许改自己」，然后顺手给它也加个守卫。
    """
    me = client.get('/sys/users/me', headers=token_headers).json()['data']
    res = client.put(f'/sys/users/{me["id"]}/permissions', headers=token_headers, params={'type': 'multi_login'})
    assert res.status_code == 200, '改自己的 multi_login 应当允许（它会把其他 token 失效）'
    # 还原，别影响后面的测试
    client.put(f'/sys/users/{me["id"]}/permissions', headers=token_headers, params={'type': 'multi_login'})


# ── PUT /sys/users/{pk}/password ─────────────────────────────────────────────


def test_reset_password_lets_the_user_log_in_with_the_new_one(
    client: TestClient, token_headers: dict[str, str], temp_user: str
) -> None:
    """超管重置他人密码，那个人要能用新密码登进来。

    只断言接口返回 200 是不够的 —— 真正要证的是「密码真的换了」，
    而唯一能证明它的是**用新密码走一次登录**。
    """
    new_password = 'Reset@654321'
    res = client.put(f'/sys/users/{temp_user}/password', headers=token_headers, json={'password': new_password})
    assert (res.status_code, res.json()['code']) == (200, 200)

    login = client.post('/auth/login/swagger', params={'username': 'pytest_tmp_writes', 'password': new_password})
    assert login.status_code == 200, f'重置后用新密码登不进去：{login.text}'


def test_reset_password_of_a_nonexistent_user_returns_404_not_a_fail_envelope(
    client: TestClient, token_headers: dict[str, str]
) -> None:
    """不存在的用户 → **404**，不是「HTTP 200 + code 400」。

    🔴 这条是用来纠正一个我们自己搞错过的印象的。handler 长这样：

        count = await user_service.reset_password(...)
        if count > 0: return response_base.success()
        return response_base.fail()          # ← 看起来是「0 行 → 假成功」的经典形状

    但 `reset_password` 在拿不到用户时**先抛了** `NotFoundError`，所以那个
    `fail()` 分支**走不到**。实测就是这条：返回 404 而不是 200。

    ⚠️ 结论不是「信封判定没必要」—— `fail()` 在别处是真会发生的，而且客户端
    只看 `!res.ok` 依然是错的。结论是：**`count > 0 ? success() : fail()` 这个
    形状到处都有，但它的 else 分支能不能走到取决于 service 有没有先做检查**，
    不能一看到这个形状就断言「这里会静默失败」。
    """
    res = client.put('/sys/users/999999999999999999/password', headers=token_headers, json={'password': 'X@123456'})
    assert res.status_code == 404, f'不存在的用户应当 404（service 先抛 NotFoundError），实际 {res.status_code}'


# ── PUT /sys/roles/{pk}/scopes ───────────────────────────────────────────────


@pytest.fixture
def role_with_restored_scopes(client: TestClient, token_headers: dict[str, str]):
    """挑一个角色，测完把它的数据范围还原。

    ⚠️ 不挑 admin 那个角色 —— 它是超管用的，改它的数据范围会影响别的测试。
    """
    roles = client.get('/sys/roles/all', headers=token_headers).json()['data']
    role = next(r for r in roles if r['code'] != 'ADMIN')
    pk = role['id']
    original = client.get(f'/sys/roles/{pk}/scopes', headers=token_headers).json()['data'] or []
    yield pk
    client.put(f'/sys/roles/{pk}/scopes', headers=token_headers, json={'scopes': original})


def test_assigning_scopes_to_a_role_actually_binds_them(
    client: TestClient, token_headers: dict[str, str], role_with_restored_scopes: str
) -> None:
    """把数据范围绑到角色上，再读回来必须是同一批。

    仓库用 19 个真账号验过数据范围的**效果**，但那批测试是直接在库里建图的 ——
    「分配」这一步（也就是界面上真正会点的那个按钮）此前零覆盖。
    """
    pk = role_with_restored_scopes
    scopes = client.get('/sys/data-scopes', headers=token_headers, params={'page': 1, 'size': 100}).json()
    ids = [s['id'] for s in scopes['data']['items'][:2]]
    assert ids, '种子里应该有数据范围可绑'

    res = client.put(f'/sys/roles/{pk}/scopes', headers=token_headers, json={'scopes': ids})
    assert (res.status_code, res.json()['code']) == (200, 200)

    got = client.get(f'/sys/roles/{pk}/scopes', headers=token_headers).json()['data']
    assert sorted(str(x) for x in got) == sorted(str(x) for x in ids), f'绑上去的和读回来的不一致：{got} vs {ids}'


def test_assigning_an_empty_scope_list_is_not_a_failure(
    client: TestClient, token_headers: dict[str, str], role_with_restored_scopes: str
) -> None:
    """`scopes: []` 是「不绑任何数据范围」，**不是失败**。

    handler 里为此专门写了一句注释。钉住它：一旦有人照别处的
    `count > 0 ? success() : fail()` 改这条，清空数据范围就会变成
    「界面报错、但其实已经清掉了」。
    """
    pk = role_with_restored_scopes
    res = client.put(f'/sys/roles/{pk}/scopes', headers=token_headers, json={'scopes': []})
    assert (res.status_code, res.json()['code']) == (200, 200), '清空数据范围不是失败'
    assert (client.get(f'/sys/roles/{pk}/scopes', headers=token_headers).json()['data'] or []) == []
