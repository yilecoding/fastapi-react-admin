from collections.abc import Sequence
from typing import Any

from sqlalchemy import ColumnElement, and_
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy_crud_plus import JoinConfig

from backend.app.admin.model import Dept, User
from backend.app.admin.schema.dept import CreateDeptParam, UpdateDeptParam
from backend.common.security.data_scope import DataScopedCRUD, bypass_data_scope
from backend.utils.serializers import select_join_serialize
from backend.utils.timezone import timezone


class CRUDDept(DataScopedCRUD[Dept]):
    """部门数据库操作类"""

    async def get(self, db: AsyncSession, dept_id: int) -> Dept | None:
        """
        获取部门详情

        :param db: 数据库会话
        :param dept_id: 部门 ID
        :return:
        """
        return await self.select_model_by_column(db, id=dept_id, deleted=0)

    async def get_by_code(self, db: AsyncSession, code: str) -> Dept | None:
        """
        通过编码获取部门

        :param db: 数据库会话
        :param code: 部门编码
        :return:
        """
        # 🔴 **唯一性 / 业务规则检查不是「展示读」，必须豁免数据权限。**
        # 这个 DAO 是 `DataScopedCRUD`，而「开了范围过滤但没配范围」的角色是
        # fail-closed —— 冲突行落在范围外时这里查不到，检查静默通过，
        # 然后撞到数据库的唯一约束上：**IntegrityError → 500**，
        # 而正确的表现是干净的 409。
        #
        # 实测见 `tests/security/test_conflict_checks.py`：改之前受限视角下
        # `get_by_code('HQ')` 找不到，超管视角找得到。
        #
        # ⚠️ 在**方法内部**豁免而不是在调用点：已逐个核实过这些方法的调用方
        # 全是「冲突检查 / 认证链路 / CLI」，没有一个把结果展示给用户。
        # 逐个调用点包的话，下一个新调用点会漏。
        with bypass_data_scope():
            return await self.select_model_by_column(db, code=code, deleted=0)

    async def get_sibling_by_name(self, db: AsyncSession, name: str, parent_id: int | None) -> Dept | None:
        """
        在**同一父级下**按名称找部门

        名称的唯一性只在兄弟之间成立（「技术中心/测试组」和「质量中心/测试组」都合法），
        全局唯一性由 `code` 承担。库上没有对应约束，理由见模型里的注释。

        :param db: 数据库会话
        :param name: 部门名称
        :param parent_id: 父部门 ID（None 表示顶级）
        :return:
        """
        # 🔴 **唯一性 / 业务规则检查不是「展示读」，必须豁免数据权限。**
        # 这个 DAO 是 `DataScopedCRUD`，而「开了范围过滤但没配范围」的角色是
        # fail-closed —— 冲突行落在范围外时这里查不到，检查静默通过，
        # 然后撞到数据库的唯一约束上：**IntegrityError → 500**，
        # 而正确的表现是干净的 409。
        #
        # 实测见 `tests/security/test_conflict_checks.py`：改之前受限视角下
        # `get_by_code('HQ')` 找不到，超管视角找得到。
        #
        # ⚠️ 在**方法内部**豁免而不是在调用点：已逐个核实过这些方法的调用方
        # 全是「冲突检查 / 认证链路 / CLI」，没有一个把结果展示给用户。
        # 逐个调用点包的话，下一个新调用点会漏。
        with bypass_data_scope():
            return await self.select_model_by_column(db, name=name, parent_id=parent_id, deleted=0)

    async def get_all(
        self,
        db: AsyncSession,
        data_filter: ColumnElement[bool],
        name: str | None,
        code: str | None,
        leader: str | None,
        phone: str | None,
        status: int | None,
    ) -> Sequence[Dept]:
        """
        获取所有部门

        :param db: 数据库会话
        :param data_filter: 请求用户
        :param name: 部门名称
        :param code: 部门编码
        :param leader: 负责人
        :param phone: 联系电话
        :param status: 部门状态
        :return:
        """
        filters = {'deleted': 0}

        if name is not None:
            filters['name__like'] = f'%{name}%'
        if code is not None:
            filters['code__like'] = f'%{code.upper()}%'
        if leader is not None:
            filters['leader__like'] = f'%{leader}%'
        if phone is not None:
            filters['phone__startswith'] = phone
        if status is not None:
            filters['status'] = status

        return await self.select_models_order(db, 'sort', 'asc', data_filter, **filters)

    async def create(self, db: AsyncSession, obj: CreateDeptParam) -> None:
        """
        创建部门

        :param db: 数据库会话
        :param obj: 创建部门参数
        :return:
        """
        await self.create_model(db, obj)

    async def update(self, db: AsyncSession, dept_id: int, obj: UpdateDeptParam) -> int:
        """
        更新部门

        :param db: 数据库会话
        :param dept_id: 部门 ID
        :param obj: 更新部门参数
        :return:
        """
        return await self.update_model_by_column(db, obj, id=dept_id, deleted=0)

    async def delete(self, db: AsyncSession, dept_id: int) -> int:
        """
        删除部门

        :param db: 数据库会话
        :param dept_id: 部门 ID
        :return:
        """
        return await self.delete_model_by_column(
            db,
            logical_deletion=True,
            deleted_flag_column='deleted',
            deleted_flag_value=self.model.id,
            deleted_at_column='deleted_time',
            deleted_at_factory=timezone.now(),
            id=dept_id,
            deleted=0,
        )

    async def get_join(self, db: AsyncSession, dept_id: int) -> Any | None:
        """
        获取部门及关联数据

        :param db: 数据库会话
        :param dept_id: 部门 ID
        :return:
        """
        result = await self.select_model(
            db,
            dept_id,
            deleted=0,
            join_conditions=[
                JoinConfig(
                    model=User,
                    join_on=and_(User.dept_id == self.model.id, User.deleted == 0),
                    fill_result=True,
                )
            ],
        )
        return select_join_serialize(result, relationships=['Dept-o2m-User'])

    async def get_children(self, db: AsyncSession, dept_id: int) -> Sequence[Dept | None]:
        """
        获取子部门列表

        :param db: 数据库会话
        :param dept_id: 部门 ID
        :return:
        """
        # 🔴 **唯一性 / 业务规则检查不是「展示读」，必须豁免数据权限。**
        # 这个 DAO 是 `DataScopedCRUD`，而「开了范围过滤但没配范围」的角色是
        # fail-closed —— 冲突行落在范围外时这里查不到，检查静默通过，
        # 然后撞到数据库的唯一约束上：**IntegrityError → 500**，
        # 而正确的表现是干净的 409。
        #
        # 实测见 `tests/security/test_conflict_checks.py`：改之前受限视角下
        # `get_by_code('HQ')` 找不到，超管视角找得到。
        #
        # ⚠️ 在**方法内部**豁免而不是在调用点：已逐个核实过这些方法的调用方
        # 全是「冲突检查 / 认证链路 / CLI」，没有一个把结果展示给用户。
        # 逐个调用点包的话，下一个新调用点会漏。
        with bypass_data_scope():
            return await self.select_models(db, parent_id=dept_id, deleted=0)


dept_dao: CRUDDept = CRUDDept(Dept)
