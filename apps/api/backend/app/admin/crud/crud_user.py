from collections.abc import Sequence
from typing import Any

import bcrypt

from sqlalchemy import Select, and_, delete, insert, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy_crud_plus import JoinConfig

from backend.app.admin.model import (
    DataRule,
    DataScope,
    Dept,
    Menu,
    Role,
    User,
    data_scope_rule,
    role_data_scope,
    role_menu,
    user_role,
)
from backend.app.admin.schema.user import (
    AddOAuth2UserParam,
    AddUserParam,
    AddUserRoleParam,
    UpdateUserParam,
)
from backend.app.admin.utils.password_security import get_hash_password
from backend.common.enums import StatusType
from backend.common.exception import errors
from backend.common.i18n import t
from backend.common.security.data_scope import DataScopedCRUD, bypass_data_scope
from backend.plugin.core import check_plugin_installed
from backend.utils.serializers import select_join_serialize
from backend.utils.timezone import timezone


class CRUDUser(DataScopedCRUD[User]):
    """用户数据库操作类"""

    async def get(self, db: AsyncSession, user_id: int) -> User | None:
        """
        获取用户详情

        :param db: 数据库会话
        :param user_id: 用户 ID
        :return:
        """
        return await self.select_model(db, user_id, deleted=0)

    async def get_by_username(self, db: AsyncSession, username: str) -> User | None:
        """
        通过用户名获取用户

        :param db: 数据库会话
        :param username: 用户名
        :return:
        """
        # 🔴 **唯一性 / 业务规则检查不是「展示读」，必须豁免数据权限。**
        # 这个 DAO 是 `DataScopedCRUD`，而「开了范围过滤但没配范围」的角色是
        # fail-closed —— 冲突行落在范围外时这里查不到，检查静默通过，
        # 然后撞到数据库的唯一约束上：**IntegrityError → 500**，
        # 而正确的表现是干净的 409。
        #
        # 实测（`set_current_user` 造一个受限用户）：超管视角三个查询全 True，
        # 受限视角全 False（`test_conflict_checks.py` 就是那份实测）。
        #
        # ⚠️ 在**方法内部**豁免而不是在调用点：已逐个核实过这些方法的调用方
        # 全是「冲突检查 / 认证链路 / CLI」，没有一个是把结果展示给用户的。
        # 逐个调用点包的话，下一个新调用点会漏。
        with bypass_data_scope():
            return await self.select_model_by_column(db, username=username, deleted=0)

    async def get_all_by_usernames(self, db: AsyncSession, usernames: list[str]) -> Sequence[User]:
        """
        通过用户名列表批量获取用户

        :param db: 数据库会话
        :param usernames: 用户名列表
        :return:
        """
        return await self.select_models(db, username__in=usernames, deleted=0)

    async def get_by_nickname(self, db: AsyncSession, nickname: str) -> User | None:
        """
        通过昵称获取用户

        :param db: 数据库会话
        :param nickname: 用户昵称
        :return:
        """
        return await self.select_model_by_column(db, nickname=nickname, deleted=0)

    async def check_email(self, db: AsyncSession, email: str) -> User | None:
        """
        检查邮箱是否已被绑定

        :param db: 数据库会话
        :param email: 电子邮箱
        :return:
        """
        # 🔴 **唯一性 / 业务规则检查不是「展示读」，必须豁免数据权限。**
        # 这个 DAO 是 `DataScopedCRUD`，而「开了范围过滤但没配范围」的角色是
        # fail-closed —— 冲突行落在范围外时这里查不到，检查静默通过，
        # 然后撞到数据库的唯一约束上：**IntegrityError → 500**，
        # 而正确的表现是干净的 409。
        #
        # 实测（`set_current_user` 造一个受限用户）：超管视角三个查询全 True，
        # 受限视角全 False（`test_conflict_checks.py` 就是那份实测）。
        #
        # ⚠️ 在**方法内部**豁免而不是在调用点：已逐个核实过这些方法的调用方
        # 全是「冲突检查 / 认证链路 / CLI」，没有一个是把结果展示给用户的。
        # 逐个调用点包的话，下一个新调用点会漏。
        with bypass_data_scope():
            return await self.select_model_by_column(db, email=email, deleted=0)

    async def get_select(
        self,
        dept: int | None,
        username: str | None,
        phone: str | None,
        status: int | None,
        role: int | None = None,
    ) -> Select:
        """
        获取用户列表查询表达式

        :param dept: 部门 ID
        :param username: 用户名
        :param phone: 电话号码
        :param status: 用户状态
        :param role: 角色 ID
        :return:
        """
        filters = {'deleted': 0}

        if dept:
            filters['dept_id'] = dept
        if username:
            filters['username__like'] = f'%{username}%'
        if phone:
            filters['phone__like'] = f'%{phone}%'
        if status is not None:
            filters['status'] = status

        # 🔴 **这里只 join Dept，不 join `sys_user_role` / `sys_role`。**
        #
        # 部门是 m2o（一个用户一个部门），join 不会增加行数；角色是 m2m，
        # join 会让一个挂 N 个角色的用户变成 **N 行**。而这个 Select 是交给
        # `paging_data` 分页的，`total` 和 `LIMIT` 都作用在 join 后的行上，
        # 去重（`select_join_serialize`）却发生在**分页之后** —— 三个症状：
        #
        # | 症状 | 实测 |
        # |---|---|
        # | `total` 数的是 join 行数 | 11 个用户报 `total=12` |
        # | 每页被重复行偷名额 | `size=20` 的第一页只回 18 条 |
        # | 同一个用户出现在两页上 | 逐页翻完 12 条里只有 11 个不同的 |
        #
        # 三个都**不报错**，每条数据本身还都是对的，所以只表现为「数量对不上」。
        # 种子数据里每个用户恰好挂一个角色，扇出永远不显形 ——
        # 守卫测试在 `tests/api_v1/test_pagination_fanout.py`，它显式造一个多角色用户。
        #
        # 角色由 `user_service.get_pagination` 在分页**之后**按本页的 ID 批量补，
        # 一条查询，不影响行数。
        stmt = await self.select_order(
            'id',
            'desc',
            join_conditions=[
                JoinConfig(
                    model=Dept,
                    join_on=and_(Dept.id == self.model.dept_id, Dept.deleted == 0),
                    fill_result=True,
                ),
            ],
            **filters,
        )

        # 角色是 m2m，filters 那套 `列名=值` 表达不了。用子查询而不是 join +
        # `where user_role.c.role_id == role`：后者会把 join 出来的角色行一起筛掉，
        # 结果每条的 `roles` 里只剩被筛的那一个角色（不是该用户的全部角色）。
        if role:
            stmt = stmt.where(self.model.id.in_(select(user_role.c.user_id).where(user_role.c.role_id == role)))

        return stmt

    async def add(self, db: AsyncSession, obj: AddUserParam) -> None:
        """
        添加用户

        :param db: 数据库会话
        :param obj: 添加用户参数
        :return:
        """
        salt = bcrypt.gensalt()
        obj.password = get_hash_password(obj.password, salt)

        dict_obj = obj.model_dump(exclude={'roles'})
        dict_obj.update({'salt': salt})
        new_user = self.model(**dict_obj)
        db.add(new_user)
        await db.flush()

        if obj.roles:
            role_stmt = select(Role).where(Role.id.in_(obj.roles), Role.deleted == 0)
            result = await db.execute(role_stmt)
            roles = result.scalars().all()

            user_role_data = [AddUserRoleParam(user_id=new_user.id, role_id=role.id).model_dump() for role in roles]
            user_role_stmt = insert(user_role)
            await db.execute(user_role_stmt, user_role_data)

    async def add_by_oauth2(self, db: AsyncSession, obj: AddOAuth2UserParam) -> None:
        """
        通过 OAuth2 添加用户

        :param db: 数据库会话
        :param obj: 注册用户参数
        :return:
        """
        dict_obj = obj.model_dump()
        dict_obj.update({'is_staff': True, 'salt': None})
        new_user = self.model(**dict_obj)
        db.add(new_user)
        await db.flush()

        role_stmt = select(Role).where(Role.status == StatusType.enable, Role.deleted == 0)
        result = await db.execute(role_stmt)
        role = result.scalars().first()  # 默认绑定第一个角色
        if role is None:
            raise errors.NotFoundError(msg=t('error.role.none_available'))

        user_role_stmt = insert(user_role).values(AddUserRoleParam(user_id=new_user.id, role_id=role.id).model_dump())
        await db.execute(user_role_stmt)

    async def update(self, db: AsyncSession, user_id: int, obj: UpdateUserParam) -> int:
        """
        更新用户信息

        :param db: 数据库会话
        :param user_id: 用户 ID
        :param obj: 更新用户参数
        :return:
        """
        role_ids = obj.roles
        del obj.roles

        count = await self.update_model_by_column(db, obj, id=user_id, deleted=0)

        user_role_stmt = delete(user_role).where(user_role.c.user_id == user_id)
        await db.execute(user_role_stmt)

        if role_ids:
            role_stmt = select(Role).where(Role.id.in_(role_ids), Role.deleted == 0)
            result = await db.execute(role_stmt)
            roles = result.scalars().all()

            user_role_data = [AddUserRoleParam(user_id=user_id, role_id=role.id).model_dump() for role in roles]
            user_role_stmt = insert(user_role)
            await db.execute(user_role_stmt, user_role_data)

        return count

    async def update_login_time(self, db: AsyncSession, username: str) -> int:
        """
        更新用户上次登录时间

        :param db: 数据库会话
        :param username: 用户名
        :return:
        """
        return await self.update_model_by_column(db, {'last_login_time': timezone.now()}, username=username, deleted=0)

    async def update_password_changed_time(self, db: AsyncSession, user_id: int) -> int:
        """
        更新用户上次密码变更时间

        :param db: 数据库会话
        :param user_id: 用户 ID
        :return:
        """
        return await self.update_model_by_column(
            db, {'last_password_changed_time': timezone.now()}, id=user_id, deleted=0
        )

    async def update_nickname(self, db: AsyncSession, user_id: int, nickname: str) -> int:
        """
        更新用户昵称

        :param db: 数据库会话
        :param user_id: 用户 ID
        :param nickname: 用户昵称
        :return:
        """
        return await self.update_model_by_column(db, {'nickname': nickname}, id=user_id, deleted=0)

    async def update_avatar(self, db: AsyncSession, user_id: int, avatar: str | None) -> int:
        """
        更新用户头像

        :param db: 数据库会话
        :param user_id: 用户 ID
        :param avatar: 头像地址
        :return:
        """
        return await self.update_model_by_column(db, {'avatar': avatar}, id=user_id, deleted=0)

    async def update_timezone(self, db: AsyncSession, user_id: int, tz: str) -> int:
        """
        更新用户显示时区

        :param db: 数据库会话
        :param user_id: 用户 ID
        :param tz: IANA 时区标识
        :return:
        """
        return await self.update_model_by_column(db, {'timezone': tz}, id=user_id, deleted=0)

    async def update_email(self, db: AsyncSession, user_id: int, email: str) -> int:
        """
        更新用户邮箱

        :param db: 数据库会话
        :param user_id: 用户 ID
        :param email: 邮箱
        :return:
        """
        return await self.update_model_by_column(db, {'email': email}, id=user_id, deleted=0)

    async def reset_password(self, db: AsyncSession, pk: int, password: str) -> int:
        """
        重置用户密码

        :param db: 数据库会话
        :param pk: 用户 ID
        :param password: 新密码
        :return:
        """
        salt = bcrypt.gensalt()
        new_pwd = get_hash_password(password, salt)
        return await self.update_model_by_column(db, {'password': new_pwd, 'salt': salt}, flush=True, id=pk, deleted=0)

    async def set_super(self, db: AsyncSession, user_id: int, *, is_super: bool) -> int:
        """
        设置用户超级管理员状态

        :param db: 数据库会话
        :param user_id: 用户 ID
        :param is_super: 是否超级管理员
        :return:
        """
        return await self.update_model_by_column(db, {'is_superuser': is_super}, id=user_id, deleted=0)

    async def set_staff(self, db: AsyncSession, user_id: int, *, is_staff: bool) -> int:
        """
        设置用户后台登录状态

        :param db: 数据库会话
        :param user_id: 用户 ID
        :param is_staff: 是否可登录后台
        :return:
        """
        return await self.update_model_by_column(db, {'is_staff': is_staff}, id=user_id, deleted=0)

    async def set_status(self, db: AsyncSession, user_id: int, status: int) -> int:
        """
        设置用户状态

        :param db: 数据库会话
        :param user_id: 用户 ID
        :param status: 状态
        :return:
        """
        return await self.update_model_by_column(db, {'status': status}, id=user_id, deleted=0)

    async def set_multi_login(self, db: AsyncSession, user_id: int, *, multi_login: bool) -> int:
        """
        设置用户多端登录状态

        :param db: 数据库会话
        :param user_id: 用户 ID
        :param multi_login: 是否允许多端登录
        :return:
        """
        return await self.update_model_by_column(db, {'is_multi_login': multi_login}, id=user_id, deleted=0)

    async def delete(self, db: AsyncSession, user_id: int) -> int:
        """
        删除用户

        :param db: 数据库会话
        :param user_id: 用户 ID
        :return:
        """
        if check_plugin_installed('oauth2'):
            try:
                from backend.plugin.oauth2.crud.crud_user_social import user_social_dao

                await user_social_dao.delete_by_user_id(db, user_id)
            except ImportError:
                raise errors.ServerError(msg=t('error.plugin.oauth2_import_failed'))

        user_role_stmt = delete(user_role).where(user_role.c.user_id == user_id)
        await db.execute(user_role_stmt)

        return await self.delete_model_by_column(
            db,
            logical_deletion=True,
            deleted_flag_column='deleted',
            deleted_flag_value=self.model.id,
            deleted_at_column='deleted_time',
            deleted_at_factory=timezone.now(),
            id=user_id,
            deleted=0,
        )

    async def get_join(
        self,
        db: AsyncSession,
        *,
        user_id: int | None = None,
        username: str | None = None,
    ) -> Any | None:
        """
        获取用户关联信息

        :param db: 数据库会话
        :param user_id: 用户 ID
        :param username: 用户名
        :return:
        """
        filters = {'deleted': 0}

        if user_id:
            filters['id'] = user_id
        if username:
            filters['username'] = username

        result = await self.select_models(
            db,
            join_conditions=[
                JoinConfig(
                    model=Dept,
                    join_on=and_(Dept.id == self.model.dept_id, Dept.deleted == 0),
                    fill_result=True,
                ),
                JoinConfig(model=user_role, join_on=user_role.c.user_id == self.model.id),
                JoinConfig(
                    model=Role,
                    join_on=and_(Role.id == user_role.c.role_id, Role.deleted == 0),
                    fill_result=True,
                ),
                JoinConfig(model=role_menu, join_on=role_menu.c.role_id == Role.id),
                JoinConfig(
                    model=Menu,
                    join_on=and_(Menu.id == role_menu.c.menu_id, Menu.deleted == 0),
                    fill_result=True,
                ),
                JoinConfig(model=role_data_scope, join_on=role_data_scope.c.role_id == Role.id),
                JoinConfig(
                    model=DataScope,
                    join_on=and_(DataScope.id == role_data_scope.c.data_scope_id, DataScope.deleted == 0),
                    fill_result=True,
                ),
                JoinConfig(model=data_scope_rule, join_on=data_scope_rule.c.data_scope_id == DataScope.id),
                JoinConfig(
                    model=DataRule,
                    join_on=and_(DataRule.id == data_scope_rule.c.data_rule_id, DataRule.deleted == 0),
                    fill_result=True,
                ),
            ],
            **filters,
        )

        return select_join_serialize(
            result,
            relationships=[
                'User-m2o-Dept',
                'User-m2m-Role',
                'Role-m2m-Menu',
                'Role-m2m-DataScope:scopes',
                'DataScope-m2m-DataRule:rules',
            ],
        )


user_dao: CRUDUser = CRUDUser(User)
