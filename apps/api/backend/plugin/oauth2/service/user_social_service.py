from sqlalchemy.ext.asyncio import AsyncSession

from backend.common.exception import errors
from backend.common.i18n import t
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
        return await user_social_dao.delete(db, user_id, source.value)

    @staticmethod
    async def get_binding_auth_url(*, user_id: int, source: UserSocialType) -> str:
        match source:
            case UserSocialType.github:
                redirect_uri = settings.OAUTH2_GITHUB_REDIRECT_URI
            case UserSocialType.google:
                redirect_uri = settings.OAUTH2_GOOGLE_REDIRECT_URI
            case _:
                raise errors.ForbiddenError(msg=t('error.oauth2.binding_unsupported', source=source))
        # 返回的是后端 authorize 入口 + 一次性 ticket（= 绑定 state），cookie 在那一跳上下发（#227）
        state = await issue_state({'type': UserSocialAuthType.binding.value, 'user_id': user_id})
        return authorize_url(redirect_uri, ticket=state)


user_social_service: UserSocialService = UserSocialService()
