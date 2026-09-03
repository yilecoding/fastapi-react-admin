from collections.abc import Sequence
from typing import Any

from fastapi import Request
from pydantic import HttpUrl
from sqlalchemy import and_, select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.admin.crud.crud_dept import dept_dao
from backend.app.admin.crud.crud_role import role_dao
from backend.app.admin.crud.crud_user import user_dao
from backend.app.admin.model import Role, User
from backend.app.admin.model.m2m import user_role
from backend.app.admin.schema.role import GetRoleDetail
from backend.app.admin.schema.user import (
    AddUserParam,
    ResetPasswordParam,
    UpdateUserParam,
)
from backend.app.admin.schema.user_password_history import CreateUserPasswordHistoryParam
from backend.app.admin.service.user_password_history_service import password_security_service
from backend.app.admin.utils.password_security import (
    password_verify,
    validate_new_password,
    validate_password_strength,
)
from backend.common.context import ctx
from backend.common.enums import UserPermissionType
from backend.common.exception import errors
from backend.common.i18n import t
from backend.common.pagination import paging_data
from backend.common.response.response_code import CustomErrorCode
from backend.common.security.data_scope import bypass_data_scope
from backend.common.security.jwt import get_token, jwt_decode
from backend.core.conf import settings
from backend.database.redis import redis_client
from backend.utils.serializers import select_join_serialize


class UserService:
    """用户服务类"""

    @staticmethod
    async def get_userinfo(*, db: AsyncSession, pk: int | None = None, username: str | None = None) -> User:
        """
        获取用户信息

        :param db: 数据库会话
        :param pk: 用户 ID
        :param username: 用户名
        :return:
        """
        user = await user_dao.get_join(db, user_id=pk, username=username)
        if not user:
            raise errors.NotFoundError(msg=t('error.user.not_found'))
        return user

    @staticmethod
    async def get_roles(*, db: AsyncSession, pk: int) -> Sequence[Role]:
        """
        获取用户所有角色

        :param db: 数据库会话
        :param pk: 用户 ID
        :return:
        """
        user = await user_dao.get_join(db, user_id=pk)
        if not user:
            raise errors.NotFoundError(msg=t('error.user.not_found'))
        return user.roles

    @staticmethod
    async def get_list(
        *, db: AsyncSession, dept: int, username: str, phone: str, status: int, role: int | None = None
    ) -> dict[str, Any]:
        """
        获取用户列表

        :param db: 数据库会话
        :param dept: 部门 ID
        :param username: 用户名
        :param phone: 手机号
        :param status: 状态
        :param role: 角色 ID
        :return:
        """
        user_select = await user_dao.get_select(dept=dept, username=username, phone=phone, status=status, role=role)
        data = await paging_data(db, user_select)
        if data['items']:
            # ⚠️ `return_as_dict=True` 是必须的：这个函数默认返回 **namedtuple**，
            # 而 namedtuple 不可变 —— 下面 `_attach_roles` 要往每条里塞 `roles`。
            # 响应模型是 `from_attributes=True`，dict 和 namedtuple 都能校验。
            serialized_items = select_join_serialize(
                data['items'], relationships=['User-m2o-Dept'], return_as_dict=True
            )
            # 确保返回的是列表，即使只有一个元素
            items = [serialized_items] if not isinstance(serialized_items, list) else serialized_items
            await UserService._attach_roles(db=db, items=items)
            data['items'] = items
        return data

    @staticmethod
    async def _attach_roles(*, db: AsyncSession, items: list[dict[str, Any]]) -> None:
        """给本页的每个用户补上角色列表（原地改 `items`）

        🔴 **必须在分页之后做，不能把 `sys_user_role` join 进分页的那个 Select。**
        角色是 m2m，join 会让一个挂 N 个角色的用户变成 N 行，而 `total` 和
        `LIMIT` 都作用在 join 后的行上 —— 原因和三个实测症状写在
        `crud_user.get_select` 里。

        一条查询覆盖整页，不是 N+1。

        ⚠️ 用 `GetRoleDetail` 而不是响应模型里那个 `GetRoleWithRelationDetail`：
        后者带 `menus` / `scopes` 两个关系字段，拿 ORM 对象去校验会触发
        **异步惰性加载** → `MissingGreenlet`。这两个字段在列表上一直是 `[]`
        （原来那个 join 也只填了 Role 自己的列），行为没变。

        :param db: 数据库会话
        :param items: 本页的用户字典列表
        :return:
        """
        by_user: dict[int, list[dict[str, Any]]] = {}
        stmt = (
            select(user_role.c.user_id, Role)
            .join(Role, and_(Role.id == user_role.c.role_id, Role.deleted == 0))
            .where(user_role.c.user_id.in_([int(item['id']) for item in items]))
        )
        for user_id, role_obj in (await db.execute(stmt)).all():
            by_user.setdefault(int(user_id), []).append(GetRoleDetail.model_validate(role_obj).model_dump())

        for item in items:
            # `roles` 在响应模型里是必填的，没有角色也要给一个空列表
            item['roles'] = by_user.get(int(item['id']), [])

    @staticmethod
    async def create(*, db: AsyncSession, obj: AddUserParam) -> None:
        """
        创建用户

        :param db: 数据库会话
        :param obj: 用户添加参数
        :return:
        """
        if await user_dao.get_by_username(db, obj.username):
            raise errors.ConflictError(msg=t('error.user.username_registered'))
        if obj.email and await user_dao.check_email(db, obj.email):
            raise errors.ConflictError(msg=t('error.user.email_bound'))
        if not obj.password:
            raise errors.RequestError(msg=t('error.user.password_required'))
        await validate_password_strength(db, obj.password)
        if not await dept_dao.get(db, obj.dept_id):
            raise errors.NotFoundError(msg=t('error.dept.not_found'))
        if obj.roles:
            roles = await role_dao.get_all_by_ids(db, list(set(obj.roles)))
            if {role.id for role in roles} != set(obj.roles):
                raise errors.NotFoundError(msg=t('error.role.not_found'))
        obj.nickname = obj.nickname or obj.username
        await user_dao.add(db, obj)

    @staticmethod
    async def update(*, db: AsyncSession, pk: int, obj: UpdateUserParam) -> int:
        """
        更新用户信息

        :param db: 数据库会话
        :param pk: 用户 ID
        :param obj: 用户更新参数
        :return:
        """
        user = await user_dao.get_join(db, user_id=pk)
        if not user:
            raise errors.NotFoundError(msg=t('error.user.not_found'))
        if obj.username != user.username and await user_dao.get_by_username(db, obj.username):
            raise errors.ConflictError(msg=t('error.user.username_registered'))
        if obj.email and obj.email != user.email:
            email_user = await user_dao.check_email(db, obj.email)
            if email_user:
                raise errors.ConflictError(msg=t('error.user.email_bound'))
        if obj.dept_id and obj.dept_id != user.dept_id and not await dept_dao.get(db, dept_id=obj.dept_id):
            raise errors.NotFoundError(msg=t('error.dept.not_found'))
        if obj.roles:
            roles = await role_dao.get_all_by_ids(db, list(set(obj.roles)))
            if {role.id for role in roles} != set(obj.roles):
                raise errors.NotFoundError(msg=t('error.role.not_found'))
        count = await user_dao.update(db, user.id, obj)
        await redis_client.delete(f'{settings.JWT_USER_REDIS_PREFIX}:{user.id}')
        return count

    @staticmethod
    async def update_permission(*, db: AsyncSession, request: Request, pk: int, type: UserPermissionType) -> int:  # ruff:ignore[complex-structure]
        """
        更新用户权限

        :param db: 数据库会话
        :param request: FastAPI 请求对象
        :param pk: 用户 ID
        :param type: 权限类型
        :return:
        """
        match type:
            case UserPermissionType.superuser:
                user = await user_dao.get(db, pk)
                if not user:
                    raise errors.NotFoundError(msg=t('error.user.not_found'))
                if pk == request.user.id:
                    raise errors.ForbiddenError(msg=t('error.user.self_permission_forbidden'))
                count = await user_dao.set_super(db, pk, is_super=not user.is_superuser)
            case UserPermissionType.staff:
                user = await user_dao.get(db, pk)
                if not user:
                    raise errors.NotFoundError(msg=t('error.user.not_found'))
                if pk == request.user.id:
                    raise errors.ForbiddenError(msg=t('error.user.self_permission_forbidden'))
                count = await user_dao.set_staff(db, pk, is_staff=not user.is_staff)
            case UserPermissionType.status:
                user = await user_dao.get(db, pk)
                if not user:
                    raise errors.NotFoundError(msg=t('error.user.not_found'))
                if pk == request.user.id:
                    raise errors.ForbiddenError(msg=t('error.user.self_permission_forbidden'))
                count = await user_dao.set_status(db, pk, 0 if user.status == 1 else 1)
            case UserPermissionType.multi_login:
                user = await user_dao.get(db, pk)
                if not user:
                    raise errors.NotFoundError(msg=t('error.user.not_found'))
                # 判据必须是「改的是不是自己」= pk == request.user.id。
                # 上游原本写的是 `pk != user.id` —— 而 user 就是按 pk 查出来的，
                # 这个条件恒为 False，于是永远拿**操作者自己**的 is_multi_login 去取反，
                # 改他人时接口返回 200 但值纹丝不动（实测：admin 的值是 True，
                # 去切一个 False 的用户，算出 not True = False，写回去等于没改）。
                # 下面 `if pk == user.id` 同理恒真，else 分支是死代码。
                is_self = pk == request.user.id
                multi_login = request.user.is_multi_login if is_self else user.is_multi_login
                new_multi_login = not multi_login
                count = await user_dao.set_multi_login(db, pk, multi_login=new_multi_login)
                token = get_token(request)
                token_payload = jwt_decode(token)
                if is_self:
                    # 修改自身时，除当前 token 外，其他 token 失效
                    if not new_multi_login:
                        key_prefix = f'{settings.TOKEN_REDIS_PREFIX}:{user.id}'
                        await redis_client.delete_by_prefix(
                            key_prefix,
                            exclude_keys=f'{key_prefix}:{token_payload.session_uuid}',
                        )
                else:
                    # 修改他人时，他人 token 全部失效
                    if not new_multi_login:
                        key_prefix = f'{settings.TOKEN_REDIS_PREFIX}:{user.id}'
                        await redis_client.delete_by_prefix(key_prefix)
            case _:
                raise errors.RequestError(msg=t('error.user.permission_type_not_found'))

        await redis_client.delete(f'{settings.JWT_USER_REDIS_PREFIX}:{user.id}')
        return count

    @staticmethod
    async def reset_password(*, db: AsyncSession, pk: int, password: str) -> int:
        """
        重置用户密码

        :param db: 数据库会话
        :param pk: 用户 ID
        :param password: 新密码
        :return:
        """
        user = await user_dao.get(db, pk)
        if not user:
            raise errors.NotFoundError(msg=t('error.user.not_found'))

        await validate_new_password(db, user.id, password)
        # 🔴 **旧 hash 必须在改之前抓住。** `user` 和 `reset_password` 动的是
        # **同一个 ORM 实例**，改完之后 `user.password` 已经是新 hash 了 ——
        # 于是历史表里存进去的是「刚设的那个密码」，而不是被换掉的那个。
        #
        # 实测（改一次密码后直接查 `sys_user_password_history`）：
        # 那一行 `password_verify(新密码, hash)` 是 **True**、
        # `password_verify(旧密码, hash)` 是 **False**。
        # 后果是「不许复用最近 N 个密码」这条控制**从来没生效过**：
        # 改回上一个密码照样通过（实测 code=200），而界面上没有任何异常。
        previous_password = user.password
        count = await user_dao.reset_password(db, user.id, password)

        history_obj = CreateUserPasswordHistoryParam(user_id=user.id, password=previous_password)
        await password_security_service.save_password_history(db, history_obj)
        await user_dao.update_password_changed_time(db, user.id)
        await redis_client.delete_by_prefix(f'{settings.TOKEN_REDIS_PREFIX}:{user.id}')
        await redis_client.delete_by_prefix(f'{settings.TOKEN_REFRESH_REDIS_PREFIX}:{user.id}')
        await redis_client.delete_by_prefix(f'{settings.JWT_USER_REDIS_PREFIX}:{user.id}')
        return count

    @staticmethod
    async def update_nickname(*, db: AsyncSession, user_id: int, nickname: str) -> int:
        """
        更新当前用户昵称

        :param db: 数据库会话
        :param user_id: 用户 ID
        :param nickname: 用户昵称
        :return:
        """
        count = await user_dao.update_nickname(db, user_id, nickname)
        await redis_client.delete(f'{settings.JWT_USER_REDIS_PREFIX}:{user_id}')
        return count

    @staticmethod
    async def update_avatar(*, db: AsyncSession, user_id: int, avatar: HttpUrl | None) -> int:
        """
        更新当前用户头像

        :param db: 数据库会话
        :param user_id: 头像地址为 None 时清空（写 NULL，**不要写空串** ——
            读取侧是 HttpUrl，空串会让登录 422）
        :param avatar: 头像地址
        :return:
        """
        count = await user_dao.update_avatar(db, user_id, str(avatar) if avatar else None)
        await redis_client.delete(f'{settings.JWT_USER_REDIS_PREFIX}:{user_id}')
        return count

    @staticmethod
    async def update_timezone(*, db: AsyncSession, user_id: int, tz: str) -> int:
        """
        更新当前用户显示时区

        清用户缓存这一步**不能省**：`/users/me` 读的是 `fba:user:<id>` 里那份
        序列化好的 DTO，不清的话前端存完立刻重取，拿回来还是旧时区，
        表现是「点了保存但没生效」，刷新也一样，要等 token 过期。

        :param db: 数据库会话
        :param user_id: 用户 ID
        :param tz: IANA 时区标识（已由 schema 校验过）
        :return:
        """
        count = await user_dao.update_timezone(db, user_id, tz)
        await redis_client.delete(f'{settings.JWT_USER_REDIS_PREFIX}:{user_id}')
        return count

    @staticmethod
    async def update_email(*, db: AsyncSession, user_id: int, captcha: str, email: str) -> int:
        """
        更新当前用户邮箱

        :param db: 数据库会话
        :param user_id: 用户 ID
        :param captcha: 邮箱验证码
        :param email: 邮箱
        :return:
        """
        captcha_code = await redis_client.get(f'{settings.EMAIL_CAPTCHA_REDIS_PREFIX}:{ctx.ip}')
        if not captcha_code:
            raise errors.RequestError(msg=t('error.user.captcha_expired'))
        if captcha != captcha_code:
            raise errors.CustomError(error=CustomErrorCode.CAPTCHA_ERROR)
        # 🔴 同理：唯一性检查也不是「展示」。`check_email` 走 scoped 的
        # `select_model_by_column`，邮箱被一个**当前用户看不见的人**占着时，
        # 这里查不到 → 冲突检查静默通过 → 落到数据库的唯一索引
        # （`uk_sys_user_email_deleted`）上 → IntegrityError → 500，
        # 而正确的表现应该是干净的 409。
        with bypass_data_scope():
            email_user = await user_dao.check_email(db, email)
        if email_user and email_user.id != user_id:
            raise errors.ConflictError(msg=t('error.user.email_bound'))
        await redis_client.delete(f'{settings.EMAIL_CAPTCHA_REDIS_PREFIX}:{ctx.ip}')
        count = await user_dao.update_email(db, user_id, email)
        await redis_client.delete(f'{settings.JWT_USER_REDIS_PREFIX}:{user_id}')
        return count

    @staticmethod
    async def update_password(*, db: AsyncSession, user_id: int, obj: ResetPasswordParam) -> int:
        """
        更新当前用户密码

        :param db: 数据库会话
        :param user_id: 用户 ID
        :param obj: 密码重置参数
        :return:
        """
        # 🔴 **读自己那一行必须豁免数据权限。** `user_dao` 是 `DataScopedCRUD`，
        # 而「开了范围过滤但一个范围都没配」的角色是 fail-closed（种子里的 STAFF
        # 就是这样）—— 那种用户**看不见自己**，`get()` 返回 None，下一句
        # `user.password` 直接 `AttributeError` → **500**。
        #
        # 实测：拿 STAFF 角色的账号打 `PUT /sys/users/me/password`，
        # 500 `AttributeError: 'NoneType' object has no attribute 'password'`。
        # 而 `/users/me`、`/me/nickname`、`/me/avatar` 都是 200 —— 只有这一条炸，
        # 因为只有它先 `get()` 了一次。
        #
        # 这次读的目的不是「把数据展示给用户」，是「验他自己的旧密码」，
        # 按可见范围过滤没有意义 —— 正是 `bypass_data_scope()` 注释里写的那种场景。
        with bypass_data_scope():
            user = await user_dao.get(db, user_id)
        if not user:
            raise errors.NotFoundError(msg=t('error.user.not_found'))

        if user.password and not password_verify(obj.old_password, user.password):
            raise errors.RequestError(msg=t('error.user.wrong_old_password'))

        if obj.new_password != obj.confirm_password:
            raise errors.RequestError(msg=t('error.user.password_mismatch'))

        await validate_new_password(db, user_id, obj.new_password)
        # 旧 hash 要在改之前抓住 —— 理由同 `reset_password`（同一个 ORM 实例）
        previous_password = user.password
        count = await user_dao.reset_password(db, user_id, obj.new_password)

        history_obj = CreateUserPasswordHistoryParam(user_id=user.id, password=previous_password)
        await password_security_service.save_password_history(db, history_obj)
        await user_dao.update_password_changed_time(db, user.id)
        await redis_client.delete_by_prefix(f'{settings.TOKEN_REDIS_PREFIX}:{user_id}')
        await redis_client.delete_by_prefix(f'{settings.TOKEN_REFRESH_REDIS_PREFIX}:{user_id}')
        await redis_client.delete_by_prefix(f'{settings.JWT_USER_REDIS_PREFIX}:{user_id}')
        return count

    @staticmethod
    async def delete(*, db: AsyncSession, pk: int) -> int:
        """
        删除用户

        :param db: 数据库会话
        :param pk: 用户 ID
        :return:
        """
        user = await user_dao.get(db, pk)
        if not user:
            raise errors.NotFoundError(msg=t('error.user.not_found'))
        count = await user_dao.delete(db, user.id)
        await redis_client.delete_by_prefix(f'{settings.TOKEN_REDIS_PREFIX}:{user.id}')
        await redis_client.delete_by_prefix(f'{settings.TOKEN_REFRESH_REDIS_PREFIX}:{user.id}')
        await redis_client.delete_by_prefix(f'{settings.JWT_USER_REDIS_PREFIX}:{user.id}')
        return count


user_service: UserService = UserService()
