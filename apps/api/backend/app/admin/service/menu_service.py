from typing import Any

from fastapi import Request
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.background import BackgroundTasks

from backend.app.admin.crud.crud_menu import menu_dao
from backend.app.admin.model import Menu
from backend.app.admin.schema.menu import CreateMenuParam, UpdateMenuParam
from backend.app.admin.utils.cache import user_cache_manager
from backend.common.enums import StatusType
from backend.common.exception import errors
from backend.common.i18n import t
from backend.utils.build_tree import get_tree_data, get_vben5_tree_data


class MenuService:
    """菜单服务类"""

    @staticmethod
    async def get(*, db: AsyncSession, pk: int) -> Menu:
        """
        获取菜单详情

        :param db: 数据库会话
        :param pk: 菜单 ID
        :return:
        """

        menu = await menu_dao.get(db, menu_id=pk)
        if not menu:
            raise errors.NotFoundError(msg=t('error.menu.not_found'))
        return menu

    @staticmethod
    async def get_tree(*, db: AsyncSession, title: str | None, status: int | None) -> list[dict[str, Any]]:
        """
        获取菜单树形结构

        :param db: 数据库会话
        :param title: 菜单标题
        :param status: 状态
        :return:
        """

        menu_data = await menu_dao.get_all(db, title=title, status=status)
        menu_tree = get_tree_data(menu_data)
        return menu_tree

    @staticmethod
    async def get_sidebar(*, db: AsyncSession, request: Request) -> list[dict[str, Any] | None]:
        """
        获取用户的菜单侧边栏

        :param db: 数据库会话
        :param request: FastAPI 请求对象
        :return:
        """
        menu_data = None
        if request.user.is_superuser:
            menu_data = await menu_dao.get_sidebar(db, None)
        else:
            roles = [role for role in request.user.roles if role.status == StatusType.enable]
            menu_ids = set()
            if roles:
                for role in roles:
                    menu_ids.update(menu.id for menu in role.menus)
                menu_data = await menu_dao.get_sidebar(db, list(menu_ids))

        if menu_data:
            # 停用的连同整棵下级一起不下发（`get_disabled_ids`）。整棵去掉、不会留下孤儿：
            # 只去掉某一项的话，它的下级找不到上级，会被 `traversal_to_tree` 提到顶层
            disabled = await menu_dao.get_disabled_ids(db)
            return get_vben5_tree_data([menu for menu in menu_data if menu.id not in disabled])

        return []

    @staticmethod
    async def check_create(*, db: AsyncSession, obj: CreateMenuParam) -> Menu | None:
        """
        创建前的业务校验（只读）。`create` 和 AI 工具的预演共用这一份

        :param db: 数据库会话
        :param obj: 菜单创建参数
        :return: 上级菜单（顶级为 None）
        """
        if await menu_dao.get_by_title(db, obj.title):
            raise errors.ConflictError(msg=t('error.menu.title_exists'))
        parent_menu = None
        if obj.parent_id:
            parent_menu = await menu_dao.get(db, obj.parent_id)
            if not parent_menu:
                raise errors.NotFoundError(msg=t('error.menu.parent_not_found'))
        return parent_menu

    async def create(self, *, db: AsyncSession, obj: CreateMenuParam) -> None:
        """
        创建菜单

        :param db: 数据库会话
        :param obj: 菜单创建参数
        :return:
        """

        await self.check_create(db=db, obj=obj)
        await menu_dao.create(db, obj)

    @staticmethod
    async def check_update(*, db: AsyncSession, pk: int, obj: UpdateMenuParam) -> Menu:
        """
        更新前的业务校验（只读）。`update` 和 AI 工具的预演共用这一份

        :param db: 数据库会话
        :param pk: 菜单 ID
        :param obj: 菜单更新参数
        :return: 改之前的菜单
        """
        menu = await menu_dao.get(db, pk)
        if not menu:
            raise errors.NotFoundError(msg=t('error.menu.not_found'))
        if menu.title != obj.title and await menu_dao.get_by_title(db, obj.title):
            raise errors.ConflictError(msg=t('error.menu.title_exists'))
        if obj.parent_id:
            parent_menu = await menu_dao.get(db, obj.parent_id)
            if not parent_menu:
                raise errors.NotFoundError(msg=t('error.menu.parent_not_found'))
        if obj.parent_id == menu.id:
            raise errors.ForbiddenError(msg=t('error.menu.cannot_be_own_parent'))
        # 🔴 也不能挂到自己的下级下面（同部门 #135）：成环之后那棵子树找不到根，从菜单树里整个消失，
        # 而库里每一行都还在。前端的上级下拉排除了自己那棵子树，直接打接口 / AI 工具就绕过去了
        if (
            obj.parent_id
            and obj.parent_id != menu.parent_id
            and menu.id in await menu_dao.get_ancestor_ids(db, obj.parent_id)
        ):
            raise errors.ForbiddenError(msg=t('error.menu.cannot_be_own_descendant'))
        return menu

    async def update(
        self, *, db: AsyncSession, background_tasks: BackgroundTasks, pk: int, obj: UpdateMenuParam
    ) -> int:
        """
        更新菜单

        :param db: 数据库会话
        :param background_tasks: FastAPI 后台任务
        :param pk: 菜单 ID
        :param obj: 菜单更新参数
        :return:
        """

        await self.check_update(db=db, pk=pk, obj=obj)
        count = await menu_dao.update(db, pk, obj)
        # 整棵下级都要清：停用 / 挪到停用的目录下，影响的是下级按钮的权限码，
        # 而持有那些按钮的角色未必持有这一项（用户缓存里的菜单状态是按上级算过的，见 `get_jwt_user`）
        await user_cache_manager.clear_by_menu_id(db, background_tasks, await menu_dao.get_subtree_ids(db, pk))
        return count

    @staticmethod
    async def delete(*, db: AsyncSession, background_tasks: BackgroundTasks, pk: int) -> int:
        """
        删除菜单

        :param db: 数据库会话
        :param background_tasks: FastAPI 后台任务
        :param pk: 菜单 ID
        :return:
        """

        children = await menu_dao.get_children(db, pk)
        if children:
            raise errors.ConflictError(msg=t('error.menu.has_children'))
        count = await menu_dao.delete(db, pk)
        if count:
            await user_cache_manager.clear_by_menu_id(db, background_tasks, [pk])
        return count


menu_service: MenuService = MenuService()
