from typing import Any

from sqlalchemy import ColumnElement, select
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.background import BackgroundTasks

from backend.app.admin.crud.crud_dept import dept_dao
from backend.app.admin.model import Dept, User
from backend.app.admin.schema.dept import CreateDeptParam, UpdateDeptParam
from backend.app.admin.utils.cache import user_cache_manager
from backend.common.exception import errors
from backend.common.i18n import t
from backend.utils.build_tree import get_tree_data


async def leader_names(db: AsyncSession, ids: set[int]) -> dict[str, str]:
    """负责人 ID → 昵称。键是**字符串**：树已经过了 `stringify_big_ids`，雪花 ID 在那边是字符串"""
    if not ids:
        return {}
    rows = await db.execute(select(User.id, User.nickname).where(User.id.in_(ids), User.deleted == 0))
    return {str(pk): nickname for pk, nickname in rows.all()}


def _fill_leader_name(nodes: list[dict[str, Any]], names: dict[str, str]) -> None:
    for node in nodes:
        leader_id = node.get('leader_id')
        # 负责人被删除之后查不到 —— 回填 None，前端显示「—」，不把一个悬空 ID 当名字摊出去
        node['leader_name'] = names.get(str(leader_id)) if leader_id is not None else None
        _fill_leader_name(node.get('children') or [], names)


async def _check_leader(db: AsyncSession, leader_id: int | None) -> None:
    """负责人必须是一个存在的用户。

    不校验的话随手填一个 ID 也能存进去，而审批流按「部门负责人」取人时会拿到一个
    不存在的人 —— 那条审批就卡在一个谁都办不了的待办上。
    """
    if leader_id is None:
        return
    # 停用的账号也不行：审批按负责人取人时会把它当「没配」往上找，设了等于没设
    found = await db.scalar(select(User.id).where(User.id == leader_id, User.deleted == 0, User.status == 1))
    if not found:
        raise errors.NotFoundError(msg=t('error.dept.leader_not_found'))


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
        phone: str | None,
        status: int | None,
    ) -> list[dict[str, Any]]:
        """
        获取部门树形结构

        :param db: 数据库会话
        :param data_filter: 请求用户
        :param name: 部门名称
        :param code: 部门编码
        :param phone: 联系电话
        :param status: 状态
        :return:
        """
        dept_select = await dept_dao.get_all(db, data_filter, name, code, phone, status)
        tree_data = get_tree_data(dept_select)
        names = await leader_names(db, {d.leader_id for d in dept_select if d.leader_id})
        _fill_leader_name(tree_data, names)
        return tree_data

    @staticmethod
    async def check_create(*, db: AsyncSession, obj: CreateDeptParam) -> Dept | None:
        """
        创建前的业务校验（只读）。`create` 和 AI 工具的预演共用这一份，
        不要在别处另写一套 —— 两份校验迟早有一份漏掉新加的规则

        :param db: 数据库会话
        :param obj: 部门创建参数
        :return: 上级部门（顶级部门为 None）
        """
        await _check_leader(db, obj.leader_id)
        if await dept_dao.get_by_code(db, obj.code):
            raise errors.ConflictError(msg=t('error.dept.code_exists'))
        parent_dept = None
        if obj.parent_id is not None:
            parent_dept = await dept_dao.get(db, obj.parent_id)
            if not parent_dept:
                raise errors.NotFoundError(msg=t('error.dept.parent_not_found'))
        # 名称只在同级里唯一 —— 不同上级下的同名部门是合法的
        if await dept_dao.get_sibling_by_name(db, obj.name, obj.parent_id):
            raise errors.ConflictError(msg=t('error.dept.duplicate_name_in_level'))
        return parent_dept

    async def create(self, *, db: AsyncSession, obj: CreateDeptParam) -> None:
        """
        创建部门

        :param db: 数据库会话
        :param obj: 部门创建参数
        :return:
        """
        await self.check_create(db=db, obj=obj)
        await dept_dao.create(db, obj)

    @staticmethod
    async def check_update(*, db: AsyncSession, pk: int, obj: UpdateDeptParam, check_ancestry: bool = True) -> Dept:
        """
        更新前的业务校验（只读）。`update`、AI 工具的预演和部门导入共用这一份

        :param db: 数据库会话
        :param pk: 部门 ID
        :param obj: 部门更新参数
        :param check_ancestry: 查不查「新上级是不是自己的下级」。只有导入预览传 False：它按
            「整份文件导完之后的树」查环（`dataio._check_tree`），比按库里现在的树查准 ——
            同一份文件里先把那个下级挪走了的话，按现在的树查会误报
        :return: 更新前的部门
        """
        dept = await dept_dao.get(db, pk)
        if not dept:
            raise errors.NotFoundError(msg=t('error.dept.not_found'))
        if obj.parent_id:
            parent_dept = await dept_dao.get(db, obj.parent_id)
            if not parent_dept:
                raise errors.NotFoundError(msg=t('error.dept.parent_not_found'))
        # 只在**换了**负责人时校验：负责人离职、账号停用之后，表单会把原来那个 ID 原样带回来 ——
        # 无条件校验的话这个部门就再也改不了（改个名字也报「负责人不存在」）。审批那边把停用的负责人
        # 当「没配」往上找，留着不影响流程
        if obj.leader_id != dept.leader_id:
            await _check_leader(db, obj.leader_id)
        if obj.parent_id == dept.id:
            raise errors.ForbiddenError(msg=t('error.dept.cannot_be_own_parent'))
        # 🔴 也不能挂到自己的下级下面：成环之后整棵子树从部门树里消失（找不到根），而每一行都还在。
        # 原来只有前端拦（上级下拉里排除了自己那棵子树）；导入的「更新」模式能一次改很多行的上级
        if (
            check_ancestry
            and obj.parent_id
            and obj.parent_id != dept.parent_id
            and dept.id in await dept_dao.get_ancestor_ids(db, obj.parent_id)
        ):
            raise errors.ForbiddenError(msg=t('error.dept.cannot_be_own_descendant'))
        # 同级重名要按**目标**父级判：只挪了上级、名字没动，一样可能撞到新兄弟
        if dept.name != obj.name or dept.parent_id != obj.parent_id:
            sibling = await dept_dao.get_sibling_by_name(db, obj.name, obj.parent_id)
            if sibling and sibling.id != dept.id:
                raise errors.ConflictError(msg=t('error.dept.duplicate_name_in_level'))
        return dept

    async def update(
        self, *, db: AsyncSession, background_tasks: BackgroundTasks, pk: int, obj: UpdateDeptParam
    ) -> int:
        """
        更新部门

        :param db: 数据库会话
        :param background_tasks: FastAPI 后台任务
        :param pk: 部门 ID
        :param obj: 部门更新参数
        :return:
        """
        await self.check_update(db=db, pk=pk, obj=obj)
        count = await dept_dao.update(db, pk, obj)
        # (issue #58) 缓存的用户快照里嵌着整个 dept（含 status）——不清的话被禁用
        # 部门下的用户继续被当成"部门正常"放行，最长锁死一个 TOKEN_EXPIRE_SECONDS
        await user_cache_manager.clear_by_dept_id(db, background_tasks, [pk])
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
