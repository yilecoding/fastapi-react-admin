"""#402 第 2 条：菜单 `perms` 的切分，每条判定路径必须得出同一个结论

`perms` 是逗号分隔的字符串（`"sys:a,sys:b"`）。原来有人切完 strip、有人不 strip：
存成 `"sys:a, sys:b"`（带空格）时，HTTP 鉴权（`rbac_verify`）和前端 `can()`（`get_codes`）认不出 `sys:b`
—— 403、按钮隐藏；AI 工具和后台导出复核（`collect_allowed_perms`）却认得出。同一个人在两条路上结论不同，
界面上看不出原因。

这里把**每一个**切 `perms` 的地方都拉进同一组参数化断言：谁漏了 strip 谁红。
"""

import asyncio

from types import SimpleNamespace

import pytest

from backend.common.enums import MenuType, StatusType
from backend.common.exception import errors

# 带空格、带空段 —— 都是手填 / 老数据 / 绕过前端直接打接口能写进去的形状
MESSY = 'sys:a, sys:b ,,sys:c '
EXPECTED = {'sys:a', 'sys:b', 'sys:c'}


def _user(*, is_superuser: bool = False) -> SimpleNamespace:
    menu = SimpleNamespace(id=1, perms=MESSY, status=StatusType.enable)
    role = SimpleNamespace(status=StatusType.enable, menus=[menu])
    return SimpleNamespace(id=1, nickname='n', dept_id=None, is_superuser=is_superuser, is_staff=True, roles=[role])


def test_split_perms_strips_and_drops_empty_segments() -> None:
    from backend.common.security.perms import split_perms

    assert split_perms(MESSY) == ['sys:a', 'sys:b', 'sys:c']
    assert split_perms(None) == []
    assert split_perms(' , ') == []


def test_rbac_verify_accepts_every_code_in_a_messy_perms(monkeypatch: pytest.MonkeyPatch) -> None:
    """HTTP 这一路：`"sys:a, sys:b"` 里的 `sys:b` 原来是 403"""
    from backend.common.security import rbac

    for code in EXPECTED:
        monkeypatch.setattr(rbac, 'ctx', SimpleNamespace(permission=code))
        request = SimpleNamespace(
            url=SimpleNamespace(path='/api/v1/sys/depts'),
            method='GET',
            auth=SimpleNamespace(scopes=['authenticated']),
            user=_user(),
        )
        asyncio.run(rbac.rbac_verify(request))  # 不抛 = 放行


def test_rbac_verify_still_rejects_a_code_that_is_not_there(monkeypatch: pytest.MonkeyPatch) -> None:
    """对照组：strip 不能变成「什么都放行」"""
    from backend.common.security import rbac

    monkeypatch.setattr(rbac, 'ctx', SimpleNamespace(permission='sys:d'))
    request = SimpleNamespace(
        url=SimpleNamespace(path='/api/v1/sys/depts'),
        method='GET',
        auth=SimpleNamespace(scopes=['authenticated']),
        user=_user(),
    )
    with pytest.raises(errors.AuthorizationError):
        asyncio.run(rbac.rbac_verify(request))


def test_collect_allowed_perms() -> None:
    from backend.common.security.rbac import collect_allowed_perms

    assert collect_allowed_perms(_user()) == EXPECTED


def test_get_codes_for_a_normal_user() -> None:
    """前端 `can()` 这一路：码表里原来是 `' sys:b '`，按钮按 `'sys:b'` 找不到 → 隐藏"""
    from backend.app.admin.service.auth_service import auth_service

    codes = asyncio.run(auth_service.get_codes(db=None, request=SimpleNamespace(user=_user())))  # type: ignore[arg-type]
    assert set(codes) == EXPECTED


def test_get_codes_for_a_superuser(monkeypatch: pytest.MonkeyPatch) -> None:
    """超管那一支读的是菜单表的进程内缓存（行是 dict），切法要和非超管那一支一样"""
    from backend.app.admin.service import auth_service as mod

    async def fake_get(_db: object) -> SimpleNamespace:  # ruff:ignore[unused-async]
        return SimpleNamespace(rows=[{'id': 1, 'perms': MESSY}], disabled=set())

    monkeypatch.setattr(mod.menu_dataset, 'get', fake_get)
    request = SimpleNamespace(user=_user(is_superuser=True))
    codes = asyncio.run(mod.auth_service.get_codes(db=None, request=request))  # type: ignore[arg-type]
    assert set(codes) == EXPECTED


def test_file_relation_guard() -> None:
    from backend.app.admin.service.file_service import _has_perm

    assert all(_has_perm(_user(), code) for code in EXPECTED)


def test_workflow_actor() -> None:
    from backend.plugin.workflow.service.runtime_service import Actor

    assert Actor.from_user(_user()).perms == EXPECTED


# ── 写入时规范化：存进库的就是干净的 ─────────────────────────────────────


def _menu_param(**over: object) -> dict:
    base = {
        'title': '按钮',
        'name': 'Btn',
        'type': MenuType.button,
        'perms': MESSY,
        'status': StatusType.enable,
        'display': StatusType.enable,
    }
    base.update(over)
    return base


def test_menu_schema_normalizes_perms_on_write() -> None:
    from backend.app.admin.schema.menu import CreateMenuParam, UpdateMenuParam

    assert CreateMenuParam(**_menu_param()).perms == 'sys:a,sys:b,sys:c'
    assert UpdateMenuParam(**_menu_param()).perms == 'sys:a,sys:b,sys:c'


def test_menu_schema_turns_blank_perms_into_none_for_non_buttons() -> None:
    """只剩逗号和空格的 perms 对目录 / 页面来说就是「没有」，别存成 `' , '`"""
    from backend.app.admin.schema.menu import CreateMenuParam

    param = CreateMenuParam(**_menu_param(type=MenuType.menu, name='Page', path='/x', perms=' , '))
    assert param.perms is None


def test_button_with_only_commas_is_still_rejected() -> None:
    """按钮必须有权限码：`' , '` 规范化之后是空的，要和空串一样拒"""
    from pydantic import ValidationError

    from backend.app.admin.schema.menu import CreateMenuParam

    with pytest.raises(ValidationError):
        CreateMenuParam(**_menu_param(perms=' , '))
