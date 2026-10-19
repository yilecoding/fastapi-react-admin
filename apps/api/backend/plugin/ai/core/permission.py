"""AI 工具的权限判定——**复用现有 RBAC 语义，不发明第二套授权模型**。

`rbac.py: rbac_verify()` 是"拦住一个 HTTP 请求"（不通过就抛异常）；这里要的是
"这个用户能不能调这个工具"（返回布尔，用于过滤工具清单）。两者判据必须一致，
所以这个文件是照着 `rbac_verify` 的分支逐条写的。

🔴 **改 `rbac_verify` 的判据时，这里要跟着改。** 两边分叉的表现是静默越权：
界面上点不到的按钮，换成"让 AI 帮我做"就能做。
"""

from typing import Any

from backend.common.enums import StatusType
from backend.core.conf import settings


def _enabled_roles(user: Any) -> list[Any]:
    return [role for role in (user.roles or []) if role.status == StatusType.enable]


def collect_allowed_perms(user: Any) -> set[str]:
    """把用户所有启用角色下、启用菜单的权限码收集成一个集合

    和 `rbac_verify` 里那段"菜单去重 → allow_perms"完全同构。
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


def user_can(user: Any, perm: str | None) -> bool:
    """这个用户能不能调用要求 `perm` 的工具

    :param user: 当前登录用户（`request.user`）
    :param perm: 工具声明的权限码；`None` = 不要求业务权限
    """
    if user.is_superuser:
        return True

    # casbin 模式下权限码模型不适用（那边按 path+method 鉴权，工具没有 path）。
    # 🔴 fail-closed：宁可整个功能在 casbin 模式下不可用，也不能放行一个没被校验过的调用。
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


def user_can_mutate(user: Any) -> bool:
    """变更类工具的额外门槛：`is_staff`

    🔴 这条不是多余的。`rbac_verify` 里对**非 GET** 请求额外要求 `is_staff`
    （"后台管理操作权限"）。工具调用不经过 HTTP 方法，所以那道闸在这里够不着 ——
    不显式补上的话，一个 `is_staff=False` 的用户在界面上做不了的写操作，
    换成"让 AI 帮我做"就能做，而且完全静默。
    """
    if user.is_superuser:
        return True
    return bool(user.is_staff)
