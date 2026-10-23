"""菜单域工具。"""

import re

from typing import Any, Literal

from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.admin.model import Menu
from backend.app.admin.schema.menu import CreateMenuParam, UpdateMenuParam
from backend.app.admin.service.menu_service import menu_service
from backend.common.enums import MenuType, StatusType
from backend.plugin.ai.core.ports import RunContext
from backend.plugin.ai.core.registry import ai_tool


@ai_tool(
    name='menu_list',
    description=(
        '获取菜单树形结构，返回菜单 ID、标题、类型（目录/菜单/按钮）、权限码、状态。'
        '用户问"有哪些菜单/某个权限码挂在哪"时用它。'
    ),
    domain='menu',
    perm='sys:menu:list',
)
async def menu_list(db: AsyncSession, title: str | None = None, status: int | None = None) -> list[dict[str, Any]]:
    return await menu_service.get_tree(db=db, title=title, status=status)


# ---------------------------------------------------------------------------
# 变更类工具（约定同 `dept_tools.py` 那一段）
#
# 🔴 **刻意没有「改菜单名」**：界面上所有显示菜单名的地方（侧边栏 · 标签条 · 面包屑 · 命令面板 ·
# 菜单管理 · 权限矩阵）都是 `t(menuKey(path), { defaultValue: title })` —— 先按路由地址查语言包，
# 查不到才用库里的标题。内置菜单在两个语言包里都有翻译，改了库里的标题，界面上一个字都不会变；
# 做成工具就是「确认卡片说改好了、界面上没变化」。删除也没开（不可逆，牵连子菜单和角色授权）。
# ---------------------------------------------------------------------------

_MENU_ID_HINT = '菜单 ID 是字符串，先用 menu_list 查到再传，不要自己编'

_TYPES: dict[str, MenuType] = {
    'directory': MenuType.directory,
    'menu': MenuType.menu,
    'button': MenuType.button,
    'link': MenuType.link,
}
_TYPE_NAMES = {MenuType.directory: '目录', MenuType.menu: '菜单', MenuType.button: '按钮', MenuType.link: '外链'}


def _route_name(source: str | None) -> str | None:
    """从路由地址 / 权限码推一个路由名（`/report/sales` → `ReportSales`，`sys:user:export` → `SysUserExport`）。

    菜单表单要求它是英文、字母开头（`MenuWriteParam`），人说话时不会想到给它起名字。推不出来（全是中文）返回 None
    """
    parts = [p for p in re.split(r'[^A-Za-z0-9]+', source or '') if p]
    name = ''.join(p[:1].upper() + p[1:] for p in parts)
    return name if name[:1].isalpha() else None


def _create_param(
    title: str,
    type: str,  # 和表单 / 接口同名，模型看得懂
    parent_id: str | None,
    path: str | None,
    perms: str | None,
    link: str | None,
    icon: str | None,
    sort: int,
    name: str | None,
) -> CreateMenuParam:
    if type not in _TYPES:
        raise ValueError(f'菜单类型只能是 {list(_TYPES)}（内嵌页请在菜单管理里建）')
    menu_type = _TYPES[type]
    name = name or _route_name(perms if menu_type == MenuType.button else path)
    if not name:
        raise ValueError('推不出路由名（name）：请给一个英文、字母开头的 name')
    return CreateMenuParam(
        title=title,
        name=name,
        path=path,
        parent_id=parent_id,
        sort=sort,
        icon=icon,
        type=menu_type,
        perms=perms,
        status=StatusType.enable,
        # 按钮本来就不进侧边栏，种子里的按钮都是 0
        display=StatusType.disable if menu_type == MenuType.button else StatusType.enable,
        link=link,
        remark=None,
    )


async def _preview_create(
    db: AsyncSession,
    title: str,
    type: str,
    parent_id: str | None = None,
    path: str | None = None,
    perms: str | None = None,
    link: str | None = None,
    icon: str | None = None,
    sort: int = 0,
    name: str | None = None,
) -> str:
    obj = _create_param(title, type, parent_id, path, perms, link, icon, sort, name)
    parent = await menu_service.check_create(db=db, obj=obj)
    where = f'「{parent.title}」下' if parent else '顶级'
    kind = _TYPE_NAMES[obj.type]
    if obj.type == MenuType.button:
        return f'将在{where}新建按钮「{obj.title}」，权限标识 {obj.perms}。新按钮不会自动授给任何角色'
    if obj.type == MenuType.link:
        return f'将在{where}新建外链「{obj.title}」，指向 {obj.link}'
    text = f'将在{where}新建{kind}「{obj.title}」（路由地址 {obj.path}）'
    if obj.type == MenuType.menu:
        text += '。路由地址必须是前端已经有的页面，否则侧边栏会跳过它（菜单管理里会标成死链）'
    return text + '。新菜单不会自动授给任何角色'


@ai_tool(
    name='menu_create',
    description=(
        '新建一个菜单项。会先请用户确认再执行。'
        'type：directory 目录（侧边栏里的分组）/ menu 菜单（指向前端已有页面的路由地址）/ '
        'button 按钮（只提供权限标识 perms，如 sys:user:export）/ link 外链（link 填完整网址）。'
        '目录、菜单、外链要填 path（路由地址，以 / 开头）；按钮要填 perms。'
        f'parent_id 不传表示顶级。{_MENU_ID_HINT}。建好后要授给角色才有人看得到（role_update_menus）。'
    ),
    domain='menu',
    perm='sys:menu:add',
    mutating=True,
    preview=_preview_create,
)
async def menu_create(
    db: AsyncSession,
    title: str,
    type: Literal['directory', 'menu', 'button', 'link'],
    parent_id: str | None = None,
    path: str | None = None,
    perms: str | None = None,
    link: str | None = None,
    icon: str | None = None,
    sort: int = 0,
    name: str | None = None,
) -> dict[str, Any]:
    obj = _create_param(title, type, parent_id, path, perms, link, icon, sort, name)
    await menu_service.create(db=db, obj=obj)
    return {'title': obj.title, 'type': type, 'name': obj.name, 'path': obj.path, 'perms': obj.perms}


def _update_param(menu: Menu, **changes: Any) -> UpdateMenuParam:
    """照原值带全。不是怕清空（DAO 的更新是 `exclude_unset`，没传的字段不会被写），是 `UpdateMenuParam`
    的必填项和「按类型必填」的规则要求标题、名称、类型、路由地址 / 权限标识 / 外链都在"""
    values = {
        'title': menu.title, 'name': menu.name, 'path': menu.path, 'parent_id': menu.parent_id,
        'sort': menu.sort, 'icon': menu.icon, 'type': menu.type, 'perms': menu.perms,
        'status': menu.status, 'display': menu.display, 'link': menu.link, 'remark': menu.remark,
    }  # fmt: skip
    return UpdateMenuParam(**{**values, **changes})


async def _status_param(db: AsyncSession, menu_id: str, *, enabled: bool) -> tuple[Menu, UpdateMenuParam]:
    """🔴 只有带权限码的菜单项，停用才有效果：

    权限码按菜单逐个算，停用的那一个不算（`rbac.collect_allowed_perms`），所以停用一个按钮 = 这个权限码对所有角色失效。
    而侧边栏只跳过「不显示」的、不看停用（`use-sidebar.ts`），目录 / 页面又大多不带权限码 —— 停用它们**什么都不会变**。
    与其执行一个看起来成功的空操作，不如当场说清楚该用什么
    """
    menu = await menu_service.get(db=db, pk=int(menu_id))
    if not (menu.perms or '').strip():
        raise ValueError(
            f'「{menu.title}」没有权限标识，停用它不会有任何效果（侧边栏照样显示，下面的按钮权限也不受影响）。'
            '要从侧边栏隐藏，请在菜单管理里关掉「是否显示」；要收回某个角色的访问，用 role_update_menus'
        )
    return menu, _update_param(menu, status=StatusType.enable if enabled else StatusType.disable)


async def _preview_set_status(db: AsyncSession, menu_id: str, *, enabled: bool) -> str:
    menu, obj = await _status_param(db, menu_id, enabled=enabled)
    if menu.status == obj.status:
        raise ValueError(f'「{menu.title}」已经是{"启用" if enabled else "停用"}状态，不需要改')
    await menu_service.check_update(db=db, pk=menu.id, obj=obj)
    if enabled:
        return f'将启用「{menu.title}」：已经授给它的角色重新获得权限 {menu.perms}'
    return f'将停用「{menu.title}」：权限 {menu.perms} 对所有角色失效，授过它的角色也一样，直到重新启用'


@ai_tool(
    name='menu_set_status',
    description=(
        '启用或停用一个带权限标识的菜单项（通常是按钮）：停用后这个权限码对所有角色失效。'
        '没有权限标识的目录 / 页面停用没有效果，工具会说明原因。'
        f'enabled=true 启用，false 停用。会先请用户确认再执行。{_MENU_ID_HINT}。'
    ),
    domain='menu',
    perm='sys:menu:edit',
    mutating=True,
    preview=_preview_set_status,
)
async def menu_set_status(db: AsyncSession, ctx: RunContext, menu_id: str, *, enabled: bool) -> dict[str, Any]:
    menu, obj = await _status_param(db, menu_id, enabled=enabled)
    # 改菜单会清掉拥有它的角色下所有人的用户缓存 —— service 里挂在 background_tasks 上
    await menu_service.update(db=db, background_tasks=ctx.background_tasks, pk=menu.id, obj=obj)
    status = 'enabled' if enabled else 'disabled'
    return {'menu_id': menu_id, 'title': menu.title, 'perms': menu.perms, 'status': status}
