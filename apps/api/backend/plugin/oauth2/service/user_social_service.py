from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.admin.crud.crud_user import user_dao
from backend.app.admin.utils import password_set_grant
from backend.common.exception import errors
from backend.common.i18n import t
from backend.common.security.data_scope import bypass_data_scope
from backend.core.conf import settings
from backend.plugin.oauth2.crud.crud_user_social import user_social_dao
from backend.plugin.oauth2.enums import UserSocialAuthType, UserSocialType
from backend.plugin.oauth2.schema.user_social import CreateUserSocialParam
from backend.plugin.oauth2.state_binding import authorize_url, issue_state


class UserSocialService:
    @staticmethod
    async def get_bindings(*, db: AsyncSession, user_id: int) -> list[str]:
        """
        获取用户已绑定的社交账号

        :param db: 数据库会话
        :param user_id: 用户 ID
        :return: 绑定列表，每个元素包含 sid、source 等信息
        """
        bindings = await user_social_dao.get_by_user_id(db, user_id)
        return [binding.source for binding in bindings]

    @staticmethod
    async def binding_with_oauth2(
        *,
        db: AsyncSession,
        user_id: int,
        sid: str,
        source: UserSocialType,
    ) -> None:
        """
        通过 OAuth2 流程绑定用户社交账号

        :param db: 数据库会话
        :param user_id: 用户 ID
        :param sid: 社交账号唯一编码
        :param source: 绑定源
        :return:
        """
        if await user_social_dao.check_binding(db, user_id, source.value):
            raise errors.RequestError(msg=t('error.oauth2.account_bound', source=source.value))

        if await user_social_dao.get_by_sid(db, sid, source.value):
            raise errors.RequestError(msg=t('error.oauth2.account_bound_to_other', source=source.value))

        new_user_social = CreateUserSocialParam(sid=sid, source=source.value, user_id=user_id)
        await user_social_dao.create(db, new_user_social)

    @staticmethod
    async def unbinding(*, db: AsyncSession, user_id: int, source: UserSocialType) -> int:
        """
        解绑用户社交账号

        :param db: 数据库会话
        :param user_id: 用户 ID
        :param source: 解绑源
        :return:
        """
        bind = await user_social_dao.check_binding(db, user_id, source.value)
        if not bind:
            raise errors.NotFoundError(msg=t('error.oauth2.account_not_bound', source=source.value))
        # 🔴 没有密码的账号解绑最后一个第三方账号 = 再也登不进来，也没有东西能证明身份去设密码（#402）
        with bypass_data_scope():  # 读自己那一行，同 `user_service.update_password`
            user = await user_dao.get(db, user_id)
        if user and not user.password and len(await user_social_dao.get_by_user_id(db, user_id)) <= 1:
            raise errors.RequestError(msg=t('error.oauth2.last_login_unbind_forbidden'))
        return await user_social_dao.delete(db, user_id, source.value)

    @staticmethod
    def _redirect_uri(source: UserSocialType) -> str:
        match source:
            case UserSocialType.github:
                return settings.OAUTH2_GITHUB_REDIRECT_URI
            case UserSocialType.google:
                return settings.OAUTH2_GOOGLE_REDIRECT_URI
            case _:
                raise errors.ForbiddenError(msg=t('error.oauth2.binding_unsupported', source=source))

    async def get_binding_auth_url(self, *, user_id: int, source: UserSocialType) -> str:
        redirect_uri = self._redirect_uri(source)
        # 返回的是后端 authorize 入口 + 一次性 ticket（= 绑定 state），cookie 在那一跳上下发（#227）
        state = await issue_state({'type': UserSocialAuthType.binding.value, 'user_id': user_id})
        return authorize_url(redirect_uri, ticket=state)

    async def get_reauth_url(self, *, db: AsyncSession, user_id: int, source: UserSocialType) -> str:
        """无密码账号第一次设密码前：用**已绑定的**第三方账号重新授权一次，确认是本人（#402）

        链接形状同绑定（authorize 入口 + 一次性 ticket）。没绑这个来源就不给链接 ——
        走完授权也只会在回调里被拒，白跳一趟
        """
        redirect_uri = self._redirect_uri(source)
        if not await user_social_dao.check_binding(db, user_id, source.value):
            raise errors.RequestError(msg=t('error.oauth2.reauth_not_bound', source=source.value))
        state = await issue_state({'type': UserSocialAuthType.reauth.value, 'user_id': user_id})
        return authorize_url(redirect_uri, ticket=state)

    @staticmethod
    async def reauth_with_oauth2(*, db: AsyncSession, user_id: int, sid: str, source: UserSocialType) -> None:
        """回调：授权回来的第三方账号必须正是绑在 `user_id` 名下的那一个，才记下「身份已确认」

        🔴 只比「这个人绑过这个来源」不够 —— 那样随便哪个 GitHub 账号授权一下都算数。
        要按 `sid` 查到绑定、再核对它属于发起的人
        """
        binding = await user_social_dao.get_by_sid(db, sid, source.value)
        if not binding or int(binding.user_id) != int(user_id):
            raise errors.ForbiddenError(msg=t('error.oauth2.reauth_mismatch', source=source.value))
        await password_set_grant.grant(int(user_id))


user_social_service: UserSocialService = UserSocialService()
