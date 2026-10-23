from typing import Any

from fastapi import Depends, Request

from backend.common.context import ctx
from backend.common.enums import MethodType, StatusType
from backend.common.exception import errors
from backend.common.i18n import t
from backend.common.security.jwt import DependsJwtAuth
from backend.core.conf import settings


async def rbac_verify(request: Request, _token: str = DependsJwtAuth) -> None:  # ruff:ignore[complex-structure]
    """
    RBAC 权限校验（鉴权顺序很重要，谨慎修改）

    :param request: FastAPI 请求对象
    :param _token: JWT 令牌
    :return:
    """
    path = request.url.path

    # API 鉴权白名单
    if path in settings.TOKEN_REQUEST_PATH_EXCLUDE:
        return
    for pattern in settings.TOKEN_REQUEST_PATH_EXCLUDE_PATTERN:
        if pattern.match(path):
            return

    # JWT 授权状态强制校验
    if not request.auth.scopes:
        raise errors.TokenError

    # 超级管理员免校验
    if request.user.is_superuser:
        return

    # 检测用户角色
    user_roles = request.user.roles
    enabled_roles = [role for role in user_roles if role.status == StatusType.enable]
    if not enabled_roles:
        raise errors.AuthorizationError(msg=t('error.auth.role_locked'))

    # 检测用户所属角色菜单
    if not any(len(role.menus) > 0 for role in enabled_roles):
        raise errors.AuthorizationError(msg=t('error.auth.menu_not_assigned'))

    # 检测后台管理操作权限
    method = request.method
    if method not in {MethodType.GET, MethodType.OPTIONS} and not request.user.is_staff:
        raise errors.AuthorizationError(msg=t('error.auth.admin_forbidden'))

    # RBAC 鉴权
    if settings.RBAC_ROLE_MENU_MODE:
        path_auth_perm = ctx.permission

        # 没有菜单操作权限标识不校验
        if not path_auth_perm:
            return

        # 菜单鉴权白名单
        if path_auth_perm in settings.RBAC_ROLE_MENU_EXCLUDE:
            return

        # 菜单去重
        unique_menus = {}
        for role in enabled_roles:
            for menu in role.menus:
                unique_menus[menu.id] = menu

        # 已分配菜单权限校验
        allow_perms = []
        for menu in list(unique_menus.values()):
            if menu.perms and menu.status == StatusType.enable:
                allow_perms.extend(menu.perms.split(','))
        if path_auth_perm not in allow_perms:
            raise errors.AuthorizationError
    else:
        # casbin 模式
        try:
            from backend.plugin.casbin_rbac.rbac import casbin_verify
        except ImportError:
            raise errors.ServerError(msg=t('error.rbac.casbin_import_failed'))

        await casbin_verify(request)


# RBAC 授权依赖注入
DependsRBAC = Depends(rbac_verify)


# ── 不经过 HTTP 请求的同一套判定 ──────────────────────────────────────────────
#
# `rbac_verify` 是「拦住一个请求」（不通过就抛异常）；下面这组是「这个人能不能做这件事」
# （返回布尔）。给拿不到请求的地方用：AI 工具清单 / 工具调用、后台任务执行前的复核
# （导出任务排队期间权限被收回，worker 不该照跑）。
#
# 🔴 **改 `rbac_verify` 的判据时，这里要跟着改** —— 两边分叉的表现是静默越权：
# 界面上点不到的按钮，换成「让 AI 帮我做」/「先发起、等排队」就能做。
# 这组原来写在 `plugin/ai/core/permission.py`，导出也要用，挪到 `rbac_verify` 旁边，两份判据挨着改。


def _enabled_roles(user: Any) -> list[Any]:
    return [role for role in (user.roles or []) if role.status == StatusType.enable]


def collect_allowed_perms(user: Any) -> set[str]:
    """把用户所有启用角色下、启用菜单的权限码收集成一个集合

    和 `rbac_verify` 里那段「菜单去重 → allow_perms」完全同构。
    """
    unique_menus: dict[Any, Any] = {}
    for role in _enabled_roles(user):
        for menu in role.menus:
            unique_menus[menu.id] = menu

    perms: set[str] = set()
    for menu in unique_menus.values():
        if menu.perms and menu.status == StatusType.enable:
            perms.update(p.strip() for p in menu.perms.split(',') if p.strip())
    return perms


def user_has_perm(user: Any, perm: str | None) -> bool:
    """这个用户有没有 `perm` 这个权限码（判据同 `rbac_verify`）

    :param user: 用户快照（`request.user` 或 `get_jwt_user()` 拿到的那份）
    :param perm: 权限码；`None` = 不要求业务权限，只要过了「有启用角色、有菜单」两道闸
    """
    if user.is_superuser:
        return True

    # casbin 模式下权限码模型不适用（那边按 path+method 鉴权，这里没有 path）。
    # 🔴 fail-closed：宁可这类功能在 casbin 模式下整个不可用，也不能放行一个没被校验过的调用
    if not settings.RBAC_ROLE_MENU_MODE:
        return False

    # 没有启用角色 / 一个菜单都没分配 —— 同 rbac_verify 的前两道闸
    enabled_roles = _enabled_roles(user)
    if not enabled_roles:
        return False
    if not any(len(role.menus) > 0 for role in enabled_roles):
        return False

    if perm is None:
        return True
    if perm in settings.RBAC_ROLE_MENU_EXCLUDE:
        return True

    return perm in collect_allowed_perms(user)


def user_can_write(user: Any) -> bool:
    """`rbac_verify` 对**非 GET** 请求额外要求的那道闸：`is_staff`（后台管理操作权限）

    🔴 不经过 HTTP 方法的调用够不着那道闸，要显式补上 —— 不补的话，一个 `is_staff=False`
    的用户在界面上做不了的写操作，换个入口就能做，而且完全静默
    """
    if user.is_superuser:
        return True
    return bool(user.is_staff)
