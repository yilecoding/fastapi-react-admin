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
from backend.common.security.session import EndReason, session_store
from backend.core.conf import settings
from backend.database.redis import redis_client
from backend.plugin.core import check_plugin_installed
from backend.utils.serializers import select_join_serialize
from backend.utils.timezone import timezone


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
            # 而 namedtuple 不可变 —— 下面 `attach_roles` 要往每条里塞 `roles`。
            # 响应模型是 `from_attributes=True`，dict 和 namedtuple 都能校验。
            serialized_items = select_join_serialize(
                data['items'], relationships=['User-m2o-Dept'], return_as_dict=True
            )
            # 确保返回的是列表，即使只有一个元素
            items = [serialized_items] if not isinstance(serialized_items, list) else serialized_items
            await UserService.attach_roles(db=db, items=items)
            data['items'] = items
        return data

    @staticmethod
    async def attach_roles(*, db: AsyncSession, items: list[dict[str, Any]]) -> None:
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
        if obj.phone and await user_dao.check_phone(db, obj.phone):
            raise errors.ConflictError(msg=t('error.user.phone_bound'))
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
        if obj.phone and obj.phone != user.phone and await user_dao.check_phone(db, obj.phone):
            raise errors.ConflictError(msg=t('error.user.phone_bound'))
        if obj.dept_id and obj.dept_id != user.dept_id and not await dept_dao.get(db, dept_id=obj.dept_id):
            raise errors.NotFoundError(msg=t('error.dept.not_found'))
        if obj.roles:
            roles = await role_dao.get_all_by_ids(db, list(set(obj.roles)))
            if {role.id for role in roles} != set(obj.roles):
                raise errors.NotFoundError(msg=t('error.role.not_found'))
        count = await user_dao.update(db, user.id, obj)
        if obj.phone != user.phone:
            # 管理员改的号码没经过本人验证：原来那次验证不再算数（issue #168）
            await user_dao.clear_phone_verification(db, user.id)
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
                if user.status == 1:
                    # 停用：会话当场结束并告诉对方原因（#138）。不撤的话请求会在取用户时 403，
                    # 但会话还挂在在线列表上，refresh 也照样换得出新 token
                    await session_store.revoke_user(pk, EndReason.disabled)
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
        await session_store.revoke_user(user.id, EndReason.password_changed)
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
        # 唯一性检查的豁免已经挪进 `user_dao.check_email` 内部了
        # （连同另外 6 个同类方法，见那里的注释）—— 这里不用再包一层
        email_user = await user_dao.check_email(db, email)
        if email_user and email_user.id != user_id:
            raise errors.ConflictError(msg=t('error.user.email_bound'))
        await redis_client.delete(f'{settings.EMAIL_CAPTCHA_REDIS_PREFIX}:{ctx.ip}')
        count = await user_dao.update_email(db, user_id, email)
        await redis_client.delete(f'{settings.JWT_USER_REDIS_PREFIX}:{user_id}')
        return count

    @staticmethod
    async def send_phone_captcha(*, db: AsyncSession, user_id: int, phone: str) -> None:
        """
        给要绑定的手机号发验证码（issue #168）

        :param db: 数据库会话
        :param user_id: 操作人（验证码按操作人 + 号码隔离）
        :param phone: 要绑定的手机号（schema 已校验格式）
        """
        if not check_plugin_installed('sms'):
            raise errors.RequestError(msg=t('error.user.sms_plugin_required'))
        # 已经是别人的号就不发了：发了也绑不上，白扣一条钱。登录态下说清楚「被占用」是可以的 ——
        # 要防枚举的是匿名的登录发码接口（第二步），不是这里
        other = await user_dao.check_phone(db, phone)
        if other and other.id != user_id:
            raise errors.ConflictError(msg=t('error.user.phone_bound'))
        from backend.plugin.sms.service.captcha_service import sms_captcha_service

        await sms_captcha_service.send(scene='bind', subject=str(user_id), phone=phone, user_id=user_id)

    @staticmethod
    async def update_phone(*, db: AsyncSession, user_id: int, captcha: str, phone: str) -> int:
        """
        用验证码绑定手机号（issue #168）：验证通过才写，并记下验证时间

        :param db: 数据库会话
        :param user_id: 用户 ID
        :param captcha: 发到这个号上的验证码
        :param phone: 手机号
        :return:
        """
        if not check_plugin_installed('sms'):
            raise errors.RequestError(msg=t('error.user.sms_plugin_required'))
        from backend.plugin.sms.service.captcha_service import sms_captcha_service

        verdict = await sms_captcha_service.verify(scene='bind', subject=str(user_id), phone=phone, code=captcha)
        if verdict == 'expired':
            raise errors.RequestError(msg=t('error.user.captcha_expired'))
        if verdict != 'ok':
            raise errors.CustomError(error=CustomErrorCode.CAPTCHA_ERROR)
        other = await user_dao.check_phone(db, phone)
        if other and other.id != user_id:
            raise errors.ConflictError(msg=t('error.user.phone_bound'))
        count = await user_dao.update_phone(db, user_id, phone, verified_time=timezone.now())
        await redis_client.delete(f'{settings.JWT_USER_REDIS_PREFIX}:{user_id}')
        return count

    @staticmethod
    async def unbind_phone(*, db: AsyncSession, user_id: int) -> int:
        """解绑手机号：号码和验证时间一起清掉"""
        count = await user_dao.update_phone(db, user_id, None, verified_time=None)
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
        await session_store.revoke_user(user_id, EndReason.password_changed)
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
        await session_store.revoke_user(user.id, EndReason.disabled)
        await redis_client.delete_by_prefix(f'{settings.JWT_USER_REDIS_PREFIX}:{user.id}')
        return count


user_service: UserService = UserService()
