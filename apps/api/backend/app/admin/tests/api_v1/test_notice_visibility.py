"""公告对**所有登录用户**可见 —— 包括受限用户。

🔴 `CRUDNotice` 原来默默继承了 `DataScopedCRUD` 的默认值（过滤），
而四个种子演示角色都是「开了 `is_filter_scopes` 但没配范围」，
那种组合是 fail-closed（`if not data_rules: return or_(1 != 1)`）。

实测（改之前）：超管看到 **3** 条公告，STAFF 角色的用户看到 **0** 条 ——
HTTP 200、`code=200`、空列表，**没有任何提示**。仪表盘那张统计卡
（`countOf('/api/v1/sys/notices')`）也跟着显示 0。

而且这张表**没有可过滤的维度**（只有 `id / title / type / status / content`，
没有 `dept_id` / `created_by`），所以过滤在这里只有 fail-closed 一种效果 ——
规则想表达「某部门才看得到某公告」压根表达不了。

⚠️ `GET /sys/notices` 只挂 `DependsJwtAuth`、没有权限门禁：它是给所有登录用户
看公告的接口，不是管理端列表。和菜单/字典同一类 —— 滤掉了界面就空，
而用户不知道为什么。
"""

from starlette.testclient import TestClient


def _items(client: TestClient, headers: dict[str, str]) -> list:
    resp = client.get('/sys/notices', headers=headers, params={'page': 1, 'size': 50})
    assert resp.status_code == 200, resp.text
    return (resp.json().get('data') or {}).get('items') or []


def test_restricted_user_sees_the_same_notices_as_admin(
    client: TestClient, token_headers: dict[str, str], temp_user: str
) -> None:
    """受限用户看到的公告集合必须和超管一致。

    🔴 **先断言超管看得到**：库里一条公告都没有的话，
    「受限用户也看到 0 条」会以「两边都是空」的方式假绿。
    """
    admin_ids = {str(n['id']) for n in _items(client, token_headers)}
    assert admin_ids, '超管都看不到公告 —— 种子数据变了？这条证明不了什么'

    res = client.post('/auth/login/swagger', params={'username': 'pytest_tmp_writes', 'password': 'Tmp@123456'})
    assert res.status_code == 200, f'临时用户登录失败：{res.text}'
    body = res.json()
    headers = {'Authorization': f'{body["token_type"]} {body["access_token"]}'}

    user_ids = {str(n['id']) for n in _items(client, headers)}
    assert user_ids == admin_ids, (
        f'受限用户看到 {len(user_ids)} 条公告、超管看到 {len(admin_ids)} 条 —— '
        'CRUDNotice 的数据权限豁免可能被撤了，公告会对所有受限用户消失'
    )
