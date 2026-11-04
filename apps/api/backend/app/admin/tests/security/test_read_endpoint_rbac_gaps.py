"""issue #57：role / data-scope / dept / dict 的读接口曾经完全裸奔。

`rbac_verify` 对没有声明权限标识的路由直接放行——这不是漏配一个字符串，
是这条路由整体退出了鉴权。#30 修过一批（`/sys/users`、`/sys/configs`、
`/sys/data-rules`、`GET /sys/menus`、`/monitors/redis`、`/logs/login`、
`/logs/opera`），但那次修复自己的 commit message 就写了"dept/role 的读接口
还是裸奔，不在这次范围内"——这批用例钉住的就是那个遗留缺口。

用种子里现成的两个非超管账号做对照：
- `test`（STAFF 角色，只看仪表盘）—— 这几个模块的权限码它一个都没有，
  应该全部 403
- `zhangwei`（MANAGER 角色）—— 种子专门给它补了 `sys:dept:list`
  （因为它是唯一已经在用"组织架构"页面的演示角色，见 issue #57 的种子改动），
  应该能正常拿到 200
"""

from starlette.testclient import TestClient


def _login(client: TestClient, username: str, password: str = '123456') -> dict[str, str]:
    resp = client.post('/auth/login/swagger', params={'username': username, 'password': password})
    resp.raise_for_status()
    body = resp.json()
    return {'Authorization': f'{body["token_type"]} {body["access_token"]}'}


def test_staff_account_is_rejected_by_previously_unguarded_read_endpoints(client: TestClient) -> None:
    """STAFF 角色没有 role/data-scope/dept/dict 的任何权限码，全部应该 403"""
    headers = _login(client, 'test')

    endpoints = [
        '/sys/roles',
        '/sys/roles/all',
        '/sys/data-scopes',
        '/sys/data-scopes/all',
        '/sys/depts',
        '/sys/dict-datas',
        '/sys/dict-types',
    ]
    for path in endpoints:
        resp = client.get(path, headers=headers)
        assert resp.status_code == 403, f'{path} 应该 403（STAFF 没有对应权限码），实际是 {resp.status_code}'


def test_manager_account_keeps_working_dept_page_after_the_fix(client: TestClient) -> None:
    """回归对照组：MANAGER 已经在用的"组织架构"页面不能被这次加固误伤

    种子专门给 MANAGER 补了 sys:dept:list（issue #57），这是唯一一个在这批
    修复之前就真的在用相关页面的演示角色——光加校验不加种子授权，会把它
    现有能用的页面锁死（#30 自己就踩过这个坑）。
    """
    headers = _login(client, 'zhangwei')

    resp = client.get('/sys/depts', headers=headers)
    assert resp.status_code == 200, f'MANAGER 应该仍能访问部门树，实际是 {resp.status_code}: {resp.text}'

    # 但 MANAGER 没有被授予角色/数据范围/字典管理，这几个模块对它仍然应该 403 ——
    # 证明这次修复是"精确补权限码"而不是"顺手把它设成超管"
    for path in ('/sys/roles', '/sys/data-scopes', '/sys/dict-datas'):
        resp = client.get(path, headers=headers)
        assert resp.status_code == 403, f'MANAGER 不该有 {path} 的权限，实际是 {resp.status_code}'


def test_task_read_endpoints_require_their_list_codes(client: TestClient, token_headers: dict[str, str]) -> None:
    """issue #228：任务调度 / 执行记录的读接口原来只要登录 —— 任务的 args/kwargs、执行结果和 traceback 谁都读得到

    STAFF 没有 `task:scheduler:list` / `task:result:list`，全部 403；超管（对照组）照常 200，
    证明不是把接口整个打坏了。
    """
    paths = ['/tasks/schedulers', '/tasks/schedulers/all', '/tasks/schedulers/meta', '/tasks/results']
    staff = _login(client, 'test')
    for path in paths:
        resp = client.get(path, headers=staff)
        assert resp.status_code == 403, f'{path} 应该 403（STAFF 没有任务模块的权限码），实际是 {resp.status_code}'
    for path in paths:
        resp = client.get(path, headers=token_headers)
        assert resp.status_code == 200, f'超管读 {path} 应该 200，实际是 {resp.status_code}: {resp.text}'


def test_user_roles_endpoint_only_reads_your_own_without_a_user_code(
    client: TestClient, token_headers: dict[str, str]
) -> None:
    """issue #228：`GET /sys/users/{pk}/roles` 原来任何登录用户都能按 ID 读别人的角色

    自己的照常能读（没有任何权限码的 STAFF 也行）；别人的要 `sys:user:list` 或 `sys:role:edit`。
    """
    staff = _login(client, 'test')
    me = client.get('/sys/users/me', headers=staff).json()['data']['id']
    admin_id = client.get('/sys/users/me', headers=token_headers).json()['data']['id']
    assert me != admin_id

    own = client.get(f'/sys/users/{me}/roles', headers=staff)
    assert own.status_code == 200, own.text
    assert own.json()['data'], '先断言「有」：STAFF 自己至少挂着一个角色，否则下面的 403 证明不了什么'

    other = client.get(f'/sys/users/{admin_id}/roles', headers=staff)
    assert other.status_code == 403, f'读别人的角色应该 403，实际是 {other.status_code}'

    # 超管读别人的照常 200
    assert client.get(f'/sys/users/{me}/roles', headers=token_headers).status_code == 200
