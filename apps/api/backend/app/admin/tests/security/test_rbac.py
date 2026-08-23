"""`rbac_verify` 的四道闸。

**这个函数原来一条测试都没有**，而它自己的 docstring 写着「鉴权顺序很重要，
谨慎修改」—— 顺序确实重要，但没有任何东西守着它。

和数据权限的区别值得写下来：数据权限错了是「多看见几行」，RBAC 错了是
「没有这个权限的人能删」。前者有 26 条测试，后者零条。

这里直接调 `rbac_verify(request)` 而不是打真实接口：四道闸都只看
`request.auth.scopes` / `request.user` / `request.method` / `ctx.permission`，
造一个轻量假 Request 就能把每一条分支单独钉住，比建一套角色-菜单-用户的库数据
省两个数量级的成本，而且**每条闸各自失败得清清楚楚**。
真实接口那一层由 `test_data_permission.py` 和 e2e 负责。
"""

import asyncio

from types import SimpleNamespace

import pytest

from backend.common.enums import StatusType
from backend.common.exception import errors
from backend.common.security.rbac import rbac_verify
from backend.core.conf import settings


def _menu(perms: str | None, *, status: int = StatusType.enable, menu_id: int = 1) -> SimpleNamespace:
    return SimpleNamespace(id=menu_id, perms=perms, status=status)


def _role(menus: list, *, status: int = StatusType.enable) -> SimpleNamespace:
    return SimpleNamespace(status=status, menus=menus)


def _request(
    *,
    path: str = '/api/v1/sys/depts',
    method: str = 'GET',
    scopes: list[str] | None = None,
    is_superuser: bool = False,
    is_staff: bool = True,
    roles: list | None = None,
) -> SimpleNamespace:
    return SimpleNamespace(
        url=SimpleNamespace(path=path),
        method=method,
        auth=SimpleNamespace(scopes=['authenticated'] if scopes is None else scopes),
        user=SimpleNamespace(is_superuser=is_superuser, is_staff=is_staff, roles=roles or []),
    )


@pytest.fixture(autouse=True)
def _permission(monkeypatch: pytest.MonkeyPatch) -> None:
    """`ctx.permission` 走 starlette_context，测试里没有请求上下文，直接打桩"""
    holder = {'value': 'sys:dept:query'}

    class FakeCtx:
        @property
        def permission(self) -> str | None:
            return holder['value']

    monkeypatch.setattr('backend.common.security.rbac.ctx', FakeCtx())
    return holder


@pytest.fixture
def permission(_permission: dict) -> dict:
    return _permission


def test_superuser_bypasses_everything() -> None:
    """超管短路，连角色都不看"""
    asyncio.run(rbac_verify(_request(is_superuser=True, roles=[])))


def test_no_scopes_is_token_error() -> None:
    """JWT 授权状态必须硬校验 —— 这是第一道闸，绕过它后面全废"""
    with pytest.raises(errors.TokenError):
        asyncio.run(rbac_verify(_request(scopes=[])))


def test_excluded_path_bypasses(monkeypatch: pytest.MonkeyPatch) -> None:
    """白名单路径在**取 scopes 之前**就返回，顺序不能调"""
    monkeypatch.setattr(settings, 'TOKEN_REQUEST_PATH_EXCLUDE', ['/api/v1/auth/login'])
    asyncio.run(rbac_verify(_request(path='/api/v1/auth/login', scopes=[])))


def test_no_enabled_role_is_rejected() -> None:
    """一个启用角色都没有 → role_locked"""
    disabled = _role([_menu('sys:dept:query')], status=StatusType.disable)
    with pytest.raises(errors.AuthorizationError) as e:
        asyncio.run(rbac_verify(_request(roles=[disabled])))
    assert '角色' in str(e.value.msg)


def test_role_without_menu_is_rejected() -> None:
    """有角色但一个菜单都没分配 → menu_not_assigned"""
    with pytest.raises(errors.AuthorizationError) as e:
        asyncio.run(rbac_verify(_request(roles=[_role([])])))
    assert '菜单' in str(e.value.msg)


def test_non_staff_can_read_but_not_write() -> None:
    """非 staff 只读

    ⚠️ 这一条排在权限码校验**之前**，所以即使权限码齐全，非 staff 的写操作
    也应该被挡。测试同时验证两个方向，防止有人把它挪到后面去。
    """
    role = _role([_menu('sys:dept:query,sys:dept:add')])

    asyncio.run(rbac_verify(_request(method='GET', is_staff=False, roles=[role])))

    with pytest.raises(errors.AuthorizationError) as e:
        asyncio.run(rbac_verify(_request(method='POST', is_staff=False, roles=[role])))
    assert '管理' in str(e.value.msg) or '权限' in str(e.value.msg)


def test_missing_perm_code_is_rejected(permission: dict) -> None:
    """有菜单，但菜单的 perms 里没有目标权限码"""
    permission['value'] = 'sys:dept:delete'
    with pytest.raises(errors.AuthorizationError):
        asyncio.run(rbac_verify(_request(roles=[_role([_menu('sys:dept:query,sys:dept:add')])])))


def test_matching_perm_code_passes(permission: dict) -> None:
    permission['value'] = 'sys:dept:add'
    asyncio.run(rbac_verify(_request(method='POST', roles=[_role([_menu('sys:dept:query,sys:dept:add')])])))


def test_disabled_menu_perms_do_not_count(permission: dict) -> None:
    """🔴 停用的菜单，它的权限码不进 allow_perms

    停用一个菜单是管理员收回权限的常用手段。如果停用后权限码仍然生效，
    界面上那一项消失了、接口却还能打 —— 是最典型的「以为收回了其实没有」。
    """
    permission['value'] = 'sys:dept:add'
    disabled_menu = _role([_menu('sys:dept:add', status=StatusType.disable)])
    with pytest.raises(errors.AuthorizationError):
        asyncio.run(rbac_verify(_request(method='POST', roles=[disabled_menu])))


def test_empty_perm_code_skips_check(permission: dict) -> None:
    """接口没声明权限码时不校验（有意为之，不是漏洞）"""
    permission['value'] = None
    asyncio.run(rbac_verify(_request(roles=[_role([_menu(None)])])))


def test_excluded_perm_code_skips_check(
    permission: dict, monkeypatch: pytest.MonkeyPatch
) -> None:
    permission['value'] = 'sys:dept:add'
    monkeypatch.setattr(settings, 'RBAC_ROLE_MENU_EXCLUDE', ['sys:dept:add'])
    asyncio.run(rbac_verify(_request(method='POST', roles=[_role([_menu(None)])])))


def test_perms_are_unioned_across_roles(permission: dict) -> None:
    """多角色的权限码取并集，且菜单按 id 去重"""
    permission['value'] = 'sys:role:add'
    roles = [
        _role([_menu('sys:dept:query', menu_id=1)]),
        _role([_menu('sys:dept:query', menu_id=1), _menu('sys:role:add', menu_id=2)]),
    ]
    asyncio.run(rbac_verify(_request(method='POST', roles=roles)))
