"""公告对**所有登录用户**可见 —— 包括受限用户；管理列表只给管理端。

🔴 `CRUDNotice` 原来默默继承了 `DataScopedCRUD` 的默认值（过滤），
而四个种子演示角色都是「开了 `is_filter_scopes` 但没配范围」，
那种组合是 fail-closed（`if not data_rules: return or_(1 != 1)`）。

实测（改之前）：超管看到 **3** 条公告，STAFF 角色的用户看到 **0** 条 ——
HTTP 200、`code=200`、空列表，**没有任何提示**。仪表盘那张统计卡也跟着显示 0。

而且这张表**没有可过滤的维度**（没有 `dept_id` / `created_by`），所以过滤在这里
只有 fail-closed 一种效果 —— 规则想表达「某部门才看得到某公告」压根表达不了。

#186 之后读者走 `GET /sys/notices/feed`（只要登录），`GET /sys/notices` 是管理列表、
挂了 `sys:notice:add`：原来两者共用一个口，任何登录用户都拿得到**隐藏的**公告和正文。
"""

from starlette.testclient import TestClient


def _feed_ids(client: TestClient, headers: dict[str, str]) -> set[str]:
    resp = client.get('/sys/notices/feed', headers=headers, params={'page': 1, 'size': 50})
    assert resp.status_code == 200, resp.text
    return {str(n['id']) for n in (resp.json().get('data') or {}).get('items') or []}


def _login_temp_user(client: TestClient) -> dict[str, str]:
    res = client.post('/auth/login/swagger', params={'username': 'pytest_tmp_writes', 'password': 'Tmp@123456'})
    assert res.status_code == 200, f'临时用户登录失败：{res.text}'
    body = res.json()
    return {'Authorization': f'{body["token_type"]} {body["access_token"]}'}


def test_restricted_user_sees_the_same_notices_as_admin(
    client: TestClient, token_headers: dict[str, str], temp_user: str
) -> None:
    """受限用户看到的公告集合必须和超管一致。

    🔴 **先断言超管看得到**：库里一条公告都没有的话，
    「受限用户也看到 0 条」会以「两边都是空」的方式假绿。
    """
    admin_ids = _feed_ids(client, token_headers)
    assert admin_ids, '超管都看不到公告 —— 种子数据变了？这条证明不了什么'

    user_ids = _feed_ids(client, _login_temp_user(client))
    assert user_ids == admin_ids, (
        f'受限用户看到 {len(user_ids)} 条公告、超管看到 {len(admin_ids)} 条 —— '
        'CRUDNotice 的数据权限豁免可能被撤了，公告会对所有受限用户消失'
    )


def test_restricted_user_cannot_read_the_admin_list(
    client: TestClient, token_headers: dict[str, str], temp_user: str
) -> None:
    """管理列表 / 管理详情会带出隐藏的公告，没有 `sys:notice:add` 的人拿不到"""
    pk = next(iter(_feed_ids(client, token_headers)))
    headers = _login_temp_user(client)
    assert client.get('/sys/notices', headers=headers, params={'page': 1, 'size': 50}).status_code == 403
    assert client.get(f'/sys/notices/{pk}', headers=headers).status_code == 403
    # 对照：同一条从读者的口拿得到
    assert client.get(f'/sys/notices/feed/{pk}', headers=headers).status_code == 200
