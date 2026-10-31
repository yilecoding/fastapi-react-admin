import json

from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.admin.crud.crud_user_preference import user_preference_dao
from backend.app.admin.model.user_preference import UserPreference
from backend.app.admin.schema.user_preference import (
    USER_PREFERENCE_MAX_KEYS,
    GetUserPreferenceDetail,
    dump_preference_value,
)
from backend.common.exception import errors
from backend.common.i18n import t


def _detail(key: str, row: UserPreference | None) -> GetUserPreferenceDetail:
    if row is None:
        return GetUserPreferenceDetail(key=key)
    return GetUserPreferenceDetail(
        key=key,
        value=json.loads(row.value),
        # 插入时 `updated_time` 还是空的（`DateTimeMixin` 只在 UPDATE 时写它）
        updated_time=row.updated_time or row.created_time,
    )


class UserPreferenceService:
    """用户个人偏好服务类

    🔴 **只认 `user_id` 参数，接口层永远传 `request.user.id`。** 路径里没有用户 ID 这一段 ——
    「读写别人的偏好」在契约上就不存在，不是靠一道权限校验挡住的
    """

    @staticmethod
    async def get(*, db: AsyncSession, user_id: int, key: str) -> GetUserPreferenceDetail:
        return _detail(key, await user_preference_dao.get_one(db, user_id=user_id, key=key))

    @staticmethod
    async def put(*, db: AsyncSession, user_id: int, key: str, value: object) -> GetUserPreferenceDetail:
        text = dump_preference_value(value)  # schema 已经校验过一次，这里拿的是落库那一份文本
        existing = await user_preference_dao.get_one(db, user_id=user_id, key=key)
        if existing is None and await user_preference_dao.count_keys(db, user_id=user_id) >= USER_PREFERENCE_MAX_KEYS:
            raise errors.RequestError(msg=t('error.user.preference_too_many', limit=USER_PREFERENCE_MAX_KEYS))
        row = await user_preference_dao.save(db, existing=existing, user_id=user_id, key=key, value=text)
        return _detail(key, row)


user_preference_service: UserPreferenceService = UserPreferenceService()
