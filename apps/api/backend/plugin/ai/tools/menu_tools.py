"""菜单域工具。"""

import re

from typing import Any, Literal

from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.admin.crud.crud_menu import menu_dao
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
# 🔴 **刻意没有「改菜单名」**：中文界面显示的是库里的标题，但其它语言下内置菜单显示的是语言包里
# 按路由地址预置的译名（`@admin/i18n: menuTitle`，#143）—— 改了库里的标题，英文界面一个字都不会变；
# 做成工具就是「确认卡片说改好了、一半界面没变化」。删除也没开（不可逆，牵连子菜单和角色授权）。
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
    """🔴 上级停用着的不改：停用一个目录 / 页面是连同整棵下级一起关掉（`menu_dao.get_disabled_ids`，#143），
    这时单独启停它自己，侧边栏和权限都看不出任何变化。与其执行一个看起来成功的空操作，不如当场说清楚
    """
    menu = await menu_service.get(db=db, pk=int(menu_id))
    ancestor_ids = (await menu_dao.get_ancestor_ids(db, menu.id))[1:]
    off = next((m for m in await menu_dao.get_all_by_ids(db, ancestor_ids) if m.status != StatusType.enable), None)
    if off:
        raise ValueError(
            f'「{menu.title}」的上级「{off.title}」停用着，它和整棵下级现在都不生效，单独启停它看不出任何变化。'
            f'要恢复的话先启用「{off.title}」'
        )
    return menu, _update_param(menu, status=StatusType.enable if enabled else StatusType.disable)


async def _affected(db: AsyncSession, menu: Menu) -> list[Menu]:
    """启停这一项时跟着变的：它自己 + 下级里一路启用着的（中间某一级自己停用着的话，那一枝本来就不生效，不受影响）"""
    children: dict[int | None, list[Menu]] = {}
    for m in await menu_dao.get_all_by_ids(db, await menu_dao.get_subtree_ids(db, menu.id)):
        children.setdefault(m.parent_id, []).append(m)
    affected = [menu]
    for m in affected:
        affected.extend(c for c in children.get(m.id, []) if c.status == StatusType.enable and c not in affected)
    return affected


async def _preview_set_status(db: AsyncSession, menu_id: str, *, enabled: bool) -> str:
    menu, obj = await _status_param(db, menu_id, enabled=enabled)
    if menu.status == obj.status:
        raise ValueError(f'「{menu.title}」已经是{"启用" if enabled else "停用"}状态，不需要改')
    await menu_service.check_update(db=db, pk=menu.id, obj=obj)
    affected = await _affected(db, menu)
    scope = f'「{menu.title}」' + (f'和它下面的 {len(affected) - 1} 项' if len(affected) > 1 else '')
    perms = sorted({p.strip() for m in affected for p in (m.perms or '').split(',') if p.strip()})
    shown = any(m.type != MenuType.button and m.display == StatusType.enable for m in affected)
    if enabled:
        effects = ['回到已授权角色的侧边栏里'] if shown else []
        effects += [f'已经授给它们的角色重新获得权限 {", ".join(perms)}'] if perms else []
        return f'将启用{scope}' + (f'：{"，".join(effects)}' if effects else '')
    effects = ['从侧边栏消失（超级管理员也看不到）'] if shown else []
    effects += [f'权限 {", ".join(perms)} 对所有角色失效'] if perms else []
    return f'将停用{scope}' + (f'：{"，".join(effects)}' if effects else '') + '，直到重新启用'


@ai_tool(
    name='menu_set_status',
    description=(
        '启用或停用一个菜单项。停用按钮：它的权限码对所有角色失效；停用目录 / 页面：连同全部下级一起关掉 —— '
        '侧边栏不再显示，下级按钮的权限码一并失效。上级停用着的菜单不能单独启停，工具会说明原因。'
        f'enabled=true 启用，false 停用。会先请用户确认再执行。{_MENU_ID_HINT}。'
    ),
    domain='menu',
    perm='sys:menu:edit',
    mutating=True,
    preview=_preview_set_status,
)
async def menu_set_status(db: AsyncSession, ctx: RunContext, menu_id: str, *, enabled: bool) -> dict[str, Any]:
    menu, obj = await _status_param(db, menu_id, enabled=enabled)
    # 改菜单会清掉拥有它（和它的下级）的角色下所有人的用户缓存 —— service 里挂在 background_tasks 上
    await menu_service.update(db=db, background_tasks=ctx.background_tasks, pk=menu.id, obj=obj)
    status = 'enabled' if enabled else 'disabled'
    return {'menu_id': menu_id, 'title': menu.title, 'perms': menu.perms, 'status': status}
