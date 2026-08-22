from typing import Any

from sqlalchemy import ColumnElement
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.admin.crud.crud_dept import dept_dao
from backend.app.admin.model import Dept
from backend.app.admin.schema.dept import CreateDeptParam, UpdateDeptParam
from backend.common.exception import errors
from backend.common.i18n import t
from backend.utils.build_tree import get_tree_data


class DeptService:
    """部门服务类"""

    @staticmethod
    async def get(*, db: AsyncSession, pk: int) -> Dept:
        """
        获取部门详情

        :param db: 数据库会话
        :param pk: 部门 ID
        :return:
        """

        dept = await dept_dao.get(db, pk)
        if not dept:
            raise errors.NotFoundError(msg=t('error.dept.not_found'))
        return dept

    @staticmethod
    async def get_tree(
        *,
        db: AsyncSession,
        data_filter: ColumnElement[bool],
        name: str | None,
        code: str | None,
        leader: str | None,
        phone: str | None,
        status: int | None,
    ) -> list[dict[str, Any]]:
        """
        获取部门树形结构

        :param db: 数据库会话
        :param data_filter: 请求用户
        :param name: 部门名称
        :param code: 部门编码
        :param leader: 部门负责人
        :param phone: 联系电话
        :param status: 状态
        :return:
        """
        dept_select = await dept_dao.get_all(db, data_filter, name, code, leader, phone, status)
        tree_data = get_tree_data(dept_select)
        return tree_data

    @staticmethod
    async def create(*, db: AsyncSession, obj: CreateDeptParam) -> None:
        """
        创建部门

        :param db: 数据库会话
        :param obj: 部门创建参数
        :return:
        """
        if await dept_dao.get_by_code(db, obj.code):
            raise errors.ConflictError(msg=t('error.dept.code_exists'))
        if obj.parent_id is not None:
            parent_dept = await dept_dao.get(db, obj.parent_id)
            if not parent_dept:
                raise errors.NotFoundError(msg=t('error.dept.parent_not_found'))
        # 名称只在同级里唯一 —— 不同上级下的同名部门是合法的
        if await dept_dao.get_sibling_by_name(db, obj.name, obj.parent_id):
            raise errors.ConflictError(msg=t('error.dept.duplicate_name_in_level'))
        await dept_dao.create(db, obj)

    @staticmethod
    async def update(*, db: AsyncSession, pk: int, obj: UpdateDeptParam) -> int:
        """
        更新部门

        :param db: 数据库会话
        :param pk: 部门 ID
        :param obj: 部门更新参数
        :return:
        """
        dept = await dept_dao.get(db, pk)
        if not dept:
            raise errors.NotFoundError(msg=t('error.dept.not_found'))
        if obj.parent_id:
            parent_dept = await dept_dao.get(db, obj.parent_id)
            if not parent_dept:
                raise errors.NotFoundError(msg=t('error.dept.parent_not_found'))
        if obj.parent_id == dept.id:
            raise errors.ForbiddenError(msg=t('error.dept.cannot_be_own_parent'))
        # 同级重名要按**目标**父级判：只挪了上级、名字没动，一样可能撞到新兄弟
        if dept.name != obj.name or dept.parent_id != obj.parent_id:
            sibling = await dept_dao.get_sibling_by_name(db, obj.name, obj.parent_id)
            if sibling and sibling.id != dept.id:
                raise errors.ConflictError(msg=t('error.dept.duplicate_name_in_level'))
        count = await dept_dao.update(db, pk, obj)
        return count

    @staticmethod
    async def delete(*, db: AsyncSession, pk: int) -> int:
        """
        删除部门

        :param db: 数据库会话
        :param pk: 部门 ID
        :return:
        """
        dept = await dept_dao.get_join(db, pk)
        if not dept:
            raise errors.NotFoundError(msg=t('error.dept.not_found'))
        if dept.users:
            raise errors.ConflictError(msg=t('error.dept.has_users'))
        children = await dept_dao.get_children(db, pk)
        if children:
            raise errors.ConflictError(msg=t('error.dept.has_children'))
        count = await dept_dao.delete(db, pk)
        return count


dept_service: DeptService = DeptService()
